import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LsmVault } from '../../entities/lsm-vault.entity';
import { LsmVaultPosition } from '../../entities/lsm-vault-position.entity';
import { LsmOrder, LsmOrderStatus } from '../../entities/lsm-order.entity';
import { LsmOrderLeg } from '../../entities/lsm-order-leg.entity';
import { UserStableBalance } from '../../entities/user-stable-balance.entity';
import { navFixed, equity, NAV_SCALE } from './lsm.vault-math';
import { ChainRegistry } from './onchain/chain-registry';
import { ChainProviderService } from './onchain/chain-provider.service';

/** 单链链上稳定币偿付核对行（需求 8）。 */
export interface OnchainSolvencyRow {
  chainId: number;
  name: string;
  /** RPC/合约是否可读（不可达时其余字段为 null）。 */
  reachable: boolean;
  /** 合约持有的 USDC（base unit）。 */
  onchainUsdcBase: string | null;
  /** 合约持有的 USDC 换算为内部单位（floor）。 */
  onchainUsdcInternal: number | null;
  /** 合约 totalLiabilities()（内部单位 = totalCollateral + totalVaultBankroll）。 */
  onchainLiabilities: number | null;
  /** 链下镜像总负债 Σ(available + reserved)（该链）。 */
  offchainMirrorLiabilities: number;
  /** 合约自报偿付（usdc.balanceOf >= toBase(totalLiabilities)）。 */
  onchainSolvent: boolean | null;
  /** 链上 USDC（内部）− 链下镜像负债；< 0 为负缺口。 */
  mirrorGap: number | null;
  issues: string[];
}

export interface OnchainSolvencyReport {
  generatedAt: number;
  chainCount: number;
  okChains: number;
  problemChains: number;
  rows: OnchainSolvencyRow[];
}

export interface VaultReconcileRow {
  vaultId: string;
  kind: string;
  status: string;
  bankroll: number;
  reserved: number;
  equity: number;
  totalShares: number;
  nav: number;
  utilizationBps: number;
  /** 偿付不变量 reserved ≤ bankroll */
  solvent: boolean;
  /** 各 OPEN 订单腿 reserveShare 之和（应 == reserved） */
  legReserveSum: number;
  reservedMatchesLegs: boolean;
  /** Σ持仓份额（应 == totalShares） */
  positionSharesSum: number;
  sharesMatch: boolean;
  /** 权益 = 份额×NAV 校验（整除余数容差内） */
  equityMatchesSharesNav: boolean;
  issues: string[];
}

export interface ReconcileReport {
  generatedAt: number;
  vaultCount: number;
  okVaults: number;
  problemVaults: number;
  rows: VaultReconcileRow[];
  global: {
    totalBankroll: number;
    totalReserved: number;
    totalEquity: number;
    /** 全部 OPEN 订单用户保证金之和（用户侧 escrow 视角） */
    openUserStake: number;
    /** 全部 OPEN 订单腿 reserveShare 之和（金库侧未结预留） */
    openLegReserve: number;
  };
}

export interface AntiCheatSignal {
  type: 'two_sided_same_market' | 'mirrored_amount_cluster' | 'rapid_repeat';
  severity: 'low' | 'medium' | 'high';
  marketId?: string;
  userIds: string[];
  detail: string;
}

/**
 * LSM 对账与反作弊（P4，task 19 / 需求 9.2、9.3）。
 *
 * 对账（只读，不改账）：逐金库校验
 *   - 偿付不变量 reserved ≤ bankroll；
 *   - reserved == 各 OPEN 订单腿 reserveShare 之和（预留=最坏赔付和）；
 *   - totalShares == Σ持仓份额；
 *   - 权益 == 份额×NAV（floor 余数容差内）。
 * 反作弊：基于订单数据的对敲/多账号启发式信号（非阻断，供运营研判）。
 */
@Injectable()
export class LsmReconciliationService {
  private readonly logger = new Logger(LsmReconciliationService.name);

  constructor(
    @InjectRepository(LsmVault)
    private readonly vaults: Repository<LsmVault>,
    @InjectRepository(LsmVaultPosition)
    private readonly positions: Repository<LsmVaultPosition>,
    @InjectRepository(LsmOrder)
    private readonly orders: Repository<LsmOrder>,
    @InjectRepository(LsmOrderLeg)
    private readonly legs: Repository<LsmOrderLeg>,
    @InjectRepository(UserStableBalance)
    private readonly stableBalances: Repository<UserStableBalance>,
    private readonly chainRegistry: ChainRegistry,
    private readonly chainProvider: ChainProviderService,
  ) {}

  async reconcile(): Promise<ReconcileReport> {
    const vaults = await this.vaults.find();
    const rows: VaultReconcileRow[] = [];

    for (const v of vaults) {
      const bankroll = Number(v.bankroll);
      const reserved = Number(v.reserved);
      const totalShares = Number(v.totalShares);
      const navF = navFixed(bankroll, reserved, totalShares);
      const e = equity(bankroll, reserved);
      const utilizationBps = bankroll > 0 ? Math.floor((reserved * 10000) / bankroll) : 0;

      // OPEN 订单腿 reserveShare 之和（该金库）
      const legAgg = await this.legs
        .createQueryBuilder('leg')
        .innerJoin(LsmOrder, 'o', 'o.id = leg.order_id')
        .select('COALESCE(SUM(leg.reserve_share),0)', 'sum')
        .where('leg.vault_id = :vid', { vid: v.id })
        .andWhere('o.status = :open', { open: LsmOrderStatus.OPEN })
        .getRawOne<{ sum: string }>();
      const legReserveSum = Number(legAgg?.sum ?? 0);

      // Σ持仓份额
      const posAgg = await this.positions
        .createQueryBuilder('p')
        .select('COALESCE(SUM(p.shares),0)', 'sum')
        .where('p.vault_id = :vid', { vid: v.id })
        .getRawOne<{ sum: string }>();
      const positionSharesSum = Number(posAgg?.sum ?? 0);

      const solvent = reserved <= bankroll;
      const reservedMatchesLegs = reserved === legReserveSum;
      const sharesMatch = totalShares === positionSharesSum;
      // 权益 == 份额×NAV：floor 取整，容差 = totalShares（每份额最多 1 单位定点误差换算回 AXP < 1）
      const reconstructedEquity =
        totalShares > 0 ? Math.floor((navF * totalShares) / NAV_SCALE) : 0;
      const equityMatchesSharesNav = Math.abs(reconstructedEquity - Math.max(0, e)) <= 1;

      const issues: string[] = [];
      if (!solvent) issues.push(`INSOLVENT reserved(${reserved})>bankroll(${bankroll})`);
      if (!reservedMatchesLegs)
        issues.push(`RESERVED_MISMATCH reserved(${reserved})!=legs(${legReserveSum})`);
      if (!sharesMatch)
        issues.push(`SHARES_MISMATCH total(${totalShares})!=positions(${positionSharesSum})`);
      if (!equityMatchesSharesNav)
        issues.push(`EQUITY_NAV_MISMATCH e(${e})!=sharesXnav(${reconstructedEquity})`);

      rows.push({
        vaultId: v.id,
        kind: v.kind,
        status: v.status,
        bankroll,
        reserved,
        equity: e,
        totalShares,
        nav: navF / NAV_SCALE,
        utilizationBps,
        solvent,
        legReserveSum,
        reservedMatchesLegs,
        positionSharesSum,
        sharesMatch,
        equityMatchesSharesNav,
        issues,
      });
    }

    const openStakeAgg = await this.orders
      .createQueryBuilder('o')
      .select('COALESCE(SUM(o.stake),0)', 'sum')
      .where('o.status = :open', { open: LsmOrderStatus.OPEN })
      .getRawOne<{ sum: string }>();
    const openLegAgg = await this.legs
      .createQueryBuilder('leg')
      .innerJoin(LsmOrder, 'o', 'o.id = leg.order_id')
      .select('COALESCE(SUM(leg.reserve_share),0)', 'sum')
      .where('o.status = :open', { open: LsmOrderStatus.OPEN })
      .getRawOne<{ sum: string }>();

    const problemVaults = rows.filter((r) => r.issues.length > 0).length;
    return {
      generatedAt: Date.now(),
      vaultCount: rows.length,
      okVaults: rows.length - problemVaults,
      problemVaults,
      rows,
      global: {
        totalBankroll: rows.reduce((a, r) => a + r.bankroll, 0),
        totalReserved: rows.reduce((a, r) => a + r.reserved, 0),
        totalEquity: rows.reduce((a, r) => a + r.equity, 0),
        openUserStake: Number(openStakeAgg?.sum ?? 0),
        openLegReserve: Number(openLegAgg?.sum ?? 0),
      },
    };
  }

  /**
   * 链上稳定币偿付对账（Phase B · 需求 8）。
   *
   * 对每条已配置链（ChainRegistry）只读核对：合约 USDC 余额（换算内部单位）≥ 链下镜像
   * 总负债 Σ(available + reserved)；并读取合约自报 `isSolvent()` / `totalLiabilities()`。
   * 出现负缺口（链上余额 < 内部负债）时产出 warning 日志，不静默、不阻塞主流程（read-only）。
   * RPC/合约不可达时该链标记 reachable=false 并记 issue，但不抛错（非阻塞）。
   */
  async reconcileOnchainSolvency(): Promise<OnchainSolvencyReport> {
    const chains = this.chainRegistry.listChains();
    const rows: OnchainSolvencyRow[] = [];

    for (const cfg of chains) {
      const issues: string[] = [];

      // 链下镜像总负债（该链）：Σ(available + reserved)。
      let offchainMirror = 0;
      try {
        const agg = await this.stableBalances
          .createQueryBuilder('b')
          .select('COALESCE(SUM(b.available),0)', 'avail')
          .addSelect('COALESCE(SUM(b.reserved),0)', 'resv')
          .where('b.chain_id = :cid', { cid: cfg.chainId })
          .getRawOne<{ avail: string; resv: string }>();
        offchainMirror = Number(agg?.avail ?? 0) + Number(agg?.resv ?? 0);
      } catch (e: any) {
        issues.push(`mirror_query_error:${e?.message}`);
      }

      // 链上读取（不可达时降级，不抛错）。
      const [usdcBase, liabilities, solvent] = await Promise.all([
        this.chainProvider.getVaultUsdcBalance(cfg.chainId),
        this.chainProvider.totalLiabilities(cfg.chainId),
        this.chainProvider.isSolvent(cfg.chainId),
      ]);

      const reachable = usdcBase !== null;
      let onchainUsdcInternal: number | null = null;
      let mirrorGap: number | null = null;
      if (usdcBase !== null) {
        onchainUsdcInternal = Number(usdcBase / BigInt(cfg.unitScale)); // floor
        mirrorGap = onchainUsdcInternal - offchainMirror;
        if (mirrorGap < 0) {
          issues.push(
            `NEGATIVE_GAP onchainUsdc(${onchainUsdcInternal}) < mirrorLiabilities(${offchainMirror}) gap=${mirrorGap}`,
          );
        }
      } else {
        issues.push(`chain_unreachable:${cfg.chainId}`);
      }
      if (solvent === false) {
        issues.push('CONTRACT_INSOLVENT isSolvent()=false');
      }

      if (issues.some((i) => i.startsWith('NEGATIVE_GAP') || i.startsWith('CONTRACT_INSOLVENT'))) {
        this.logger.warn(
          `[onchain-solvency] chainId=${cfg.chainId} 偿付告警: ${issues.join('; ')}`,
        );
      } else if (!reachable) {
        this.logger.warn(`[onchain-solvency] chainId=${cfg.chainId} 不可达（非阻塞）`);
      }

      rows.push({
        chainId: cfg.chainId,
        name: cfg.name,
        reachable,
        onchainUsdcBase: usdcBase !== null ? usdcBase.toString() : null,
        onchainUsdcInternal,
        onchainLiabilities: liabilities !== null ? Number(liabilities) : null,
        offchainMirrorLiabilities: offchainMirror,
        onchainSolvent: solvent,
        mirrorGap,
        issues,
      });
    }

    const problemChains = rows.filter((r) => r.issues.length > 0).length;
    return {
      generatedAt: Date.now(),
      chainCount: rows.length,
      okChains: rows.length - problemChains,
      problemChains,
      rows,
    };
  }

  /**
   * 反作弊信号（启发式，最近 N 笔订单）：
   *  - two_sided_same_market：同一用户在同一盘口对多个结果下注（对敲嫌疑）。
   *  - mirrored_amount_cluster：同一盘口不同用户、相同保证金+杠杆、对立结果，时间相近（多账号对敲嫌疑）。
   *  - rapid_repeat：同一用户短时间内大量同额下注。
   */
  async antiCheatSignals(lookback = 500): Promise<AntiCheatSignal[]> {
    const recent = await this.orders.find({
      order: { createdAt: 'DESC' },
      take: Math.min(lookback, 2000),
    });
    const signals: AntiCheatSignal[] = [];

    // 1) 同用户同盘口多结果
    const byUserMarket = new Map<string, Set<number>>();
    for (const o of recent) {
      const key = `${o.userId}|${o.marketId}`;
      if (!byUserMarket.has(key)) byUserMarket.set(key, new Set());
      byUserMarket.get(key)!.add(o.outcomeIdx);
    }
    for (const [key, outcomes] of byUserMarket) {
      if (outcomes.size >= 2) {
        const [userId, marketId] = key.split('|');
        signals.push({
          type: 'two_sided_same_market',
          severity: outcomes.size >= 3 ? 'high' : 'medium',
          marketId,
          userIds: [userId],
          detail: `user bet ${outcomes.size} outcomes of same market`,
        });
      }
    }

    // 2) 同盘口、相同 (stake,leverage)、对立结果、不同用户、5 分钟内
    const byMarket = new Map<string, LsmOrder[]>();
    for (const o of recent) {
      if (!byMarket.has(o.marketId)) byMarket.set(o.marketId, []);
      byMarket.get(o.marketId)!.push(o);
    }
    for (const [marketId, list] of byMarket) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (
            a.userId !== b.userId &&
            a.outcomeIdx !== b.outcomeIdx &&
            a.stake === b.stake &&
            a.leverage === b.leverage &&
            Math.abs(a.createdAt.getTime() - b.createdAt.getTime()) <= 5 * 60 * 1000
          ) {
            signals.push({
              type: 'mirrored_amount_cluster',
              severity: 'high',
              marketId,
              userIds: [a.userId, b.userId],
              detail: `mirrored opposing bets stake=${a.stake} lev=${a.leverage}x within 5m`,
            });
          }
        }
      }
    }

    // 3) 同用户短时同额高频
    const byUser = new Map<string, LsmOrder[]>();
    for (const o of recent) {
      if (!byUser.has(o.userId)) byUser.set(o.userId, []);
      byUser.get(o.userId)!.push(o);
    }
    for (const [userId, list] of byUser) {
      const sameAmt = new Map<string, number>();
      for (const o of list) {
        const k = `${o.stake}`;
        sameAmt.set(k, (sameAmt.get(k) ?? 0) + 1);
      }
      for (const [amt, cnt] of sameAmt) {
        if (cnt >= 10) {
          signals.push({
            type: 'rapid_repeat',
            severity: cnt >= 25 ? 'high' : 'low',
            userIds: [userId],
            detail: `${cnt} bets of stake=${amt} in recent window`,
          });
        }
      }
    }

    // 去重（按 type+market+users）
    const seen = new Set<string>();
    return signals.filter((s) => {
      const k = `${s.type}|${s.marketId ?? ''}|${[...s.userIds].sort().join(',')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
}
