import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  LsmVault,
  LsmVaultKind,
  LsmVaultStatus,
} from '../../entities/lsm-vault.entity';
import { LsmVaultPosition } from '../../entities/lsm-vault-position.entity';
import {
  LsmVaultEvent,
  LsmVaultEventType,
} from '../../entities/lsm-vault-event.entity';
import { AssetAdapterRegistry, LsmAsset, normalizeAsset } from './lsm-asset.adapter';
import {
  computeDeposit,
  computeRedeem,
  computeProfitFee,
  navFixed,
  equity,
  NAV_SCALE,
} from './lsm.vault-math';

const PROTOCOL_KEY = 'protocol';

/**
 * 官方公共金库初始做市资金（house 流动性）。
 * AXP 为平台内积分（不可提现），官方金库作为所有盘口的兜底对手方，
 * 由平台铸入足额 house 流动性，使无任何外部 LP 注资时也能承接下注、不影响用户体验。
 * bankroll 与 totalShares 等额 → NAV=1.0，用户后续按 NAV 公平存赎。
 */
const PROTOCOL_SEED_BANKROLL = 100_000_000;

/**
 * 官方金库单例锚点（singletonKey），按币种隔离（需求 22.3，不跨币种共享流动性）：
 *   - AXP  → 'protocol'（沿用历史值，向后兼容）。
 *   - USDC → 'protocol_usdc'。
 */
function protocolSingletonKey(asset: LsmAsset): string {
  return asset === 'AXP' ? PROTOCOL_KEY : `${PROTOCOL_KEY}_${asset.toLowerCase()}`;
}

export interface VaultView {
  id: string;
  kind: LsmVaultKind;
  name: string | null;
  leaderUserId: string | null;
  status: LsmVaultStatus;
  asset: string;
  bankroll: number;
  reserved: number;
  equity: number;
  totalShares: number;
  navFixed: number; // 1e9 定点
  nav: number; // 浮点展示
  utilizationBps: number;
  minLeaderShareBps: number;
  profitShareBps: number;
  depositLockSecs: number;
}

/**
 * LSM 金库服务（P2 官方金库 + P3 用户金库）。
 *
 * 资金正确性：全整数；偿付不变量 reserved ≤ bankroll（开仓时强校验）；
 * NAV 铸/销 floor 取整、余数归金库（no-dilution）；存赎幂等（event.idemKey）；
 * 每金库独立 bankroll/reserved（隔离）。counterparty 钩子接收 EntityManager，
 * 与 order-engine 在同一事务内原子完成。
 */
@Injectable()
export class LsmVaultService {
  private readonly logger = new Logger(LsmVaultService.name);

  constructor(
    @InjectRepository(LsmVault)
    private readonly vaults: Repository<LsmVault>,
    @InjectRepository(LsmVaultPosition)
    private readonly positions: Repository<LsmVaultPosition>,
    @InjectRepository(LsmVaultEvent)
    private readonly events: Repository<LsmVaultEvent>,
    private readonly registry: AssetAdapterRegistry,
    private readonly dataSource: DataSource,
  ) {}

  // ── 官方金库单例 ────────────────────────────────────────────

  async getOrCreateProtocolVault(asset: LsmAsset = 'AXP'): Promise<LsmVault> {
    const key = protocolSingletonKey(asset);
    let v = await this.vaults.findOne({ where: { singletonKey: key } });
    if (!v) {
      v = await this.vaults.save(
        this.vaults.create({
          kind: LsmVaultKind.PROTOCOL,
          singletonKey: key,
          name: asset === 'AXP' ? '官方金库 (Protocol Vault)' : `官方金库 (${asset})`,
          leaderUserId: null,
          status: LsmVaultStatus.ACTIVE,
          minLeaderShareBps: 0,
          profitShareBps: 0,
          depositLockSecs: 86400,
          highWaterNav: String(NAV_SCALE),
          assetUnit: asset,
          bankroll: String(PROTOCOL_SEED_BANKROLL),
          reserved: '0',
          totalShares: String(PROTOCOL_SEED_BANKROLL),
        }),
      );
    }
    return v;
  }

  // ── 用户金库创建（P3） ──────────────────────────────────────

  async createUserVault(input: {
    leaderUserId: string;
    name: string;
    initialDeposit: number;
    asset?: string;
    minLeaderShareBps?: number;
    profitShareBps?: number;
    depositLockSecs?: number;
  }): Promise<LsmVault> {
    if (!Number.isInteger(input.initialDeposit) || input.initialDeposit <= 0) {
      throw new BadRequestException('initialDeposit must be a positive integer AXP');
    }
    const asset = this.registry.resolveOffered(input.asset);
    // 平台固定：用户自建金库利润分成固定为 10%（1000 bps），忽略客户端任何传入值。
    // 官方公共金库（protocol）无主理人、对用户 0 分成。
    const profitShareBps = 1000;
    const minLeaderShareBps = input.minLeaderShareBps ?? 500;
    const vault = await this.vaults.save(
      this.vaults.create({
        kind: LsmVaultKind.USER,
        singletonKey: null,
        name: input.name,
        leaderUserId: input.leaderUserId,
        status: LsmVaultStatus.ACTIVE,
        minLeaderShareBps,
        profitShareBps,
        depositLockSecs: input.depositLockSecs ?? 86400,
        highWaterNav: String(NAV_SCALE),
        assetUnit: asset,
        bankroll: '0',
        reserved: '0',
        totalShares: '0',
      }),
    );
    // 主理人初始出资（skin-in-game），标记 isLeader
    await this.deposit(vault.id, input.leaderUserId, input.initialDeposit, {
      asLeader: true,
    });
    return this.vaults.findOneOrFail({ where: { id: vault.id } });
  }

  // ── LP 存入 ─────────────────────────────────────────────────

  async deposit(
    vaultId: string,
    userId: string,
    amount: number,
    opts: { asLeader?: boolean } = {},
  ): Promise<{ sharesMinted: number; nav: number }> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive integer AXP');
    }
    const vault = await this.vaults.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException('vault not found');
    if (vault.status !== LsmVaultStatus.ACTIVE) {
      throw new BadRequestException('vault not accepting deposits');
    }

    const idemKey = `lsm:vd:${randomUUID()}`;
    const adapter = this.registry.forAsset(vault.assetUnit);
    // 1) 扣减用户余额（出资，按金库币种路由 AXP/USDC）
    await adapter.debit(userId, amount, { idemKey, kind: 'vault_deposit' });

    // 2) 铸份额（金库事务）
    try {
      return await this.dataSource.transaction(async (manager) => {
        const v = await manager.findOne(LsmVault, {
          where: { id: vaultId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!v) throw new Error('vault missing');
        const bankroll = Number(v.bankroll);
        const reserved = Number(v.reserved);
        const totalShares = Number(v.totalShares);
        const r = computeDeposit(amount, bankroll, reserved, totalShares);
        await manager.update(
          LsmVault,
          { id: vaultId },
          { bankroll: String(r.newBankroll), totalShares: String(r.newTotalShares) },
        );
        await this.upsertPosition(manager, vaultId, userId, {
          sharesDelta: r.sharesMinted,
          costDelta: amount,
          lockSecs: v.depositLockSecs,
          isLeader: opts.asLeader === true,
        });
        const navAt = navFixed(r.newBankroll, reserved, r.newTotalShares);
        await manager.save(
          manager.create(LsmVaultEvent, {
            vaultId,
            type: LsmVaultEventType.DEPOSIT,
            userId,
            amount: String(amount),
            sharesDelta: String(r.sharesMinted),
            navAt: String(navAt),
            idemKey,
          }),
        );
        return { sharesMinted: r.sharesMinted, nav: navAt / NAV_SCALE };
      });
    } catch (e) {
      // 补偿：铸份额事务失败 → 退还出资
      try {
        await adapter.release(userId, amount, {
          idemKey: `${idemKey}:compensate`,
          kind: 'vault_deposit_rollback',
        });
      } catch (ce) {
        this.logger.error(`deposit compensation failed ${idemKey}: ${(ce as Error).message}`);
      }
      throw e;
    }
  }

  // ── LP 赎回 ─────────────────────────────────────────────────

  async redeem(
    vaultId: string,
    userId: string,
    shares: number,
  ): Promise<{ payout: number; sharesBurned: number; nav: number }> {
    if (!Number.isInteger(shares) || shares <= 0) {
      throw new BadRequestException('shares must be a positive integer');
    }
    const idemKey = `lsm:vault-redeem:${vaultId}:${userId}:${Date.now()}`;

    // 金库事务：校验锁定期/主理人 skin-in-game/份额，销份额并算 payout，更新 bankroll
    const result = await this.dataSource.transaction(async (manager) => {
      const v = await manager.findOne(LsmVault, {
        where: { id: vaultId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!v) throw new NotFoundException('vault not found');
      const pos = await manager.findOne(LsmVaultPosition, {
        where: { vaultId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!pos || Number(pos.shares) < shares) {
        throw new BadRequestException('insufficient shares');
      }
      // 锁定期
      if (pos.lockedUntil && pos.lockedUntil.getTime() > Date.now()) {
        throw new BadRequestException('VAULT_DEPOSIT_LOCKED');
      }
      const totalShares = Number(v.totalShares);
      const bankroll = Number(v.bankroll);
      const reserved = Number(v.reserved);

      // 主理人 skin-in-game：active 金库下，主理人赎回不得使自有份额占比 < min（除 closing）
      if (
        v.kind === LsmVaultKind.USER &&
        pos.isLeader &&
        v.status === LsmVaultStatus.ACTIVE
      ) {
        const remainingLeaderShares = Number(pos.shares) - shares;
        const remainingTotal = totalShares - shares;
        if (
          remainingTotal > 0 &&
          remainingLeaderShares * 10000 < v.minLeaderShareBps * remainingTotal
        ) {
          throw new ForbiddenException('LEADER_MIN_SHARE_VIOLATION');
        }
      }

      const r = computeRedeem(shares, bankroll, reserved, totalShares);
      await manager.update(
        LsmVault,
        { id: vaultId },
        { bankroll: String(r.newBankroll), totalShares: String(r.newTotalShares) },
      );
      await this.upsertPosition(manager, vaultId, userId, {
        sharesDelta: -shares,
        costDelta: 0,
      });
      const navAt = navFixed(r.newBankroll, reserved, r.newTotalShares);
      await manager.save(
        manager.create(LsmVaultEvent, {
          vaultId,
          type: LsmVaultEventType.REDEEM,
          userId,
          amount: String(r.payout),
          sharesDelta: String(-shares),
          navAt: String(navAt),
          idemKey,
        }),
      );
      return { payout: r.payout, sharesBurned: shares, nav: navAt / NAV_SCALE, asset: v.assetUnit };
    });

    // 提交后给用户入账（earn，按金库币种路由）。失败仅记录对账（罕见）。
    if (result.payout > 0) {
      try {
        await this.registry.forAsset(result.asset).credit(userId, result.payout, {
          idemKey,
          kind: 'vault_redeem',
        });
      } catch (e) {
        this.logger.error(
          `redeem credit failed ${idemKey} (payout=${result.payout}); needs reconcile: ${(e as Error).message}`,
        );
      }
    }
    return result;
  }

  // ── counterparty 钩子（供 order-engine 在同一事务内调用） ───

  /** 开仓：本腿 bankroll += stakeShare，reserved += winPayoutShare；强校验 reserved ≤ bankroll。 */
  async reserveOpenLeg(
    manager: EntityManager,
    vaultId: string,
    stakeShare: number,
    winPayoutShare: number,
  ): Promise<void> {
    const v = await manager.findOne(LsmVault, {
      where: { id: vaultId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!v) throw new Error('vault missing');
    const newBankroll = Number(v.bankroll) + stakeShare;
    const newReserved = Number(v.reserved) + winPayoutShare;
    if (newReserved > newBankroll) {
      throw new BadRequestException('RISK_LIMIT_EXCEEDED');
    }
    await manager.update(
      LsmVault,
      { id: vaultId },
      { bankroll: String(newBankroll), reserved: String(newReserved) },
    );
  }

  /** 用户赢：本腿 bankroll −= winPayoutShare，reserved −= winPayoutShare。 */
  async settleLegWin(
    manager: EntityManager,
    vaultId: string,
    winPayoutShare: number,
  ): Promise<void> {
    const v = await manager.findOne(LsmVault, {
      where: { id: vaultId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!v) throw new Error('vault missing');
    await manager.update(
      LsmVault,
      { id: vaultId },
      {
        bankroll: String(Number(v.bankroll) - winPayoutShare),
        reserved: String(Number(v.reserved) - winPayoutShare),
      },
    );
  }

  /** 用户输：本腿仅释放 reserved（bankroll 留存已收 stakeShare）。 */
  async settleLegLose(
    manager: EntityManager,
    vaultId: string,
    winPayoutShare: number,
  ): Promise<void> {
    const v = await manager.findOne(LsmVault, {
      where: { id: vaultId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!v) throw new Error('vault missing');
    await manager.update(
      LsmVault,
      { id: vaultId },
      { reserved: String(Number(v.reserved) - winPayoutShare) },
    );
  }

  /**
   * 提前平仓（cash-out）：释放本腿全部预留并按兑现份额结算（同一事务内由 order-engine 调用）。
   *  - reserved −= reserveShare（释放该腿全部最坏赔付预留）。
   *  - bankroll −= cashoutShare（向用户兑付本腿份额）。
   * 本腿净盈亏 = stakeShare − cashoutShare（由 order-engine 写入 leg.pnlShare）。
   * 余数归官方金库腿（排末位）兜底，全局强校验 ΣcashoutShare ≤ ΣreserveShare 由调用方保证。
   */
  async cashoutLeg(
    manager: EntityManager,
    vaultId: string,
    reserveShare: number,
    cashoutShare: number,
  ): Promise<void> {
    const v = await manager.findOne(LsmVault, {
      where: { id: vaultId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!v) throw new Error('vault missing');
    await manager.update(
      LsmVault,
      { id: vaultId },
      {
        bankroll: String(Number(v.bankroll) - cashoutShare),
        reserved: String(Number(v.reserved) - reserveShare),
      },
    );
  }

  /** 退款：本腿 bankroll −= stakeShare，reserved −= winPayoutShare。 */
  async refundLeg(
    manager: EntityManager,
    vaultId: string,
    stakeShare: number,
    winPayoutShare: number,
  ): Promise<void> {
    const v = await manager.findOne(LsmVault, {
      where: { id: vaultId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!v) throw new Error('vault missing');
    await manager.update(
      LsmVault,
      { id: vaultId },
      {
        bankroll: String(Number(v.bankroll) - stakeShare),
        reserved: String(Number(v.reserved) - winPayoutShare),
      },
    );
  }

  // ── 主理人利润分成（高水位，P3） ────────────────────────────

  async accrueProfitFee(vaultId: string): Promise<{ leaderSharesMinted: number }> {
    return this.dataSource.transaction(async (manager) => {
      const v = await manager.findOne(LsmVault, {
        where: { id: vaultId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!v) throw new NotFoundException('vault not found');
      if (v.kind !== LsmVaultKind.USER || !v.leaderUserId) {
        return { leaderSharesMinted: 0 };
      }
      const bankroll = Number(v.bankroll);
      const reserved = Number(v.reserved);
      const totalShares = Number(v.totalShares);
      const r = computeProfitFee(
        bankroll,
        reserved,
        totalShares,
        Number(v.highWaterNav),
        v.profitShareBps,
      );
      if (r.leaderSharesMinted > 0) {
        await manager.update(
          LsmVault,
          { id: vaultId },
          {
            totalShares: String(r.newTotalShares),
            highWaterNav: String(r.newHighWaterNav),
          },
        );
        await this.upsertPosition(manager, vaultId, v.leaderUserId, {
          sharesDelta: r.leaderSharesMinted,
          costDelta: 0,
          isLeader: true,
        });
        await manager.save(
          manager.create(LsmVaultEvent, {
            vaultId,
            type: LsmVaultEventType.PROFIT_FEE,
            userId: v.leaderUserId,
            amount: String(r.feeEquity),
            sharesDelta: String(r.leaderSharesMinted),
            navAt: String(r.newHighWaterNav),
            idemKey: `lsm:profit-fee:${vaultId}:${Date.now()}`,
          }),
        );
      } else {
        // 仅更新高水位（NAV 创新高但分成取整为 0，或 profitShare=0）
        await manager.update(
          LsmVault,
          { id: vaultId },
          { highWaterNav: String(r.newHighWaterNav) },
        );
      }
      return { leaderSharesMinted: r.leaderSharesMinted };
    });
  }

  // ── 关闭金库编排（P3，task 16 / 需求 11.7） ──────────────────

  /**
   * 主理人发起关闭金库：active → closing。
   * 进入 closing 后承接路由不再分配新盘（LsmUnderwritingService 已排除），
   * 存量未结订单仍按既定腿结算；待 reserved 归零后由 finalizeCloseIfReady 清算。
   * 仅主理人本人可发起；官方金库不可关闭。
   */
  async closeVault(vaultId: string, leaderUserId: string): Promise<VaultView> {
    const v = await this.vaults.findOne({ where: { id: vaultId } });
    if (!v) throw new NotFoundException('vault not found');
    if (v.kind !== LsmVaultKind.USER) {
      throw new BadRequestException('only user vaults can be closed');
    }
    if (v.leaderUserId !== leaderUserId) {
      throw new ForbiddenException('only the leader can close the vault');
    }
    if (v.status === LsmVaultStatus.CLOSED) {
      throw new BadRequestException('vault already closed');
    }
    if (v.status !== LsmVaultStatus.CLOSING) {
      await this.vaults.update({ id: vaultId }, { status: LsmVaultStatus.CLOSING });
    }
    // 若已无未结预留，立即尝试清算
    await this.finalizeCloseIfReady(vaultId);
    return this.getVault(vaultId);
  }

  /**
   * 清算结算：若 closing 金库 reserved==0（无未结敞口），按 NAV 把全部存入方份额
   * 兑付为 AXP（含主理人，关闭流程豁免最低自有份额），totalShares 归零，status→closed。
   * 幂等：仅处理 status=closing 且 reserved=0；payout 用 event.idemKey 防重复入账。
   * 返回是否完成清算。
   */
  async finalizeCloseIfReady(vaultId: string): Promise<{ closed: boolean; payouts: number }> {
    // 1) 事务内校验并销毁全部份额、置 closed，收集每个 LP 的应付
    const plan = await this.dataSource.transaction(async (manager) => {
      const v = await manager.findOne(LsmVault, {
        where: { id: vaultId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!v || v.status !== LsmVaultStatus.CLOSING) return null;
      if (Number(v.reserved) !== 0) return null; // 仍有未结敞口，等待结算
      const totalShares = Number(v.totalShares);
      const bankroll = Number(v.bankroll);
      const reserved = Number(v.reserved);
      const positions = await manager.find(LsmVaultPosition, {
        where: { vaultId },
        lock: { mode: 'pessimistic_write' },
      });
      const active = positions.filter((p) => Number(p.shares) > 0);

      const payouts: Array<{ userId: string; amount: number; shares: number }> = [];
      let remainingShares = totalShares;
      let remainingEquity = equity(bankroll, reserved);
      // 逐 LP 按 NAV 销份额兑付，最后一名拿尽余额（余数归最后一位，避免整除残留）
      active.forEach((p, idx) => {
        const s = Number(p.shares);
        let payout: number;
        if (idx === active.length - 1) {
          payout = Math.max(0, remainingEquity);
        } else {
          payout =
            remainingShares > 0
              ? Math.floor((s * remainingEquity) / remainingShares)
              : 0;
        }
        payouts.push({ userId: p.userId, amount: payout, shares: s });
        remainingShares -= s;
        remainingEquity -= payout;
      });

      // 份额清零 + bankroll 清零（全部兑付）+ status closed
      for (const p of active) {
        await manager.update(
          LsmVaultPosition,
          { vaultId, userId: p.userId },
          { shares: '0' },
        );
      }
      await manager.update(
        LsmVault,
        { id: vaultId },
        { status: LsmVaultStatus.CLOSED, totalShares: '0', bankroll: '0' },
      );
      // 审计事件（每 LP 一条）
      for (const po of payouts) {
        await manager.save(
          manager.create(LsmVaultEvent, {
            vaultId,
            type: LsmVaultEventType.CLOSE,
            userId: po.userId,
            amount: String(po.amount),
            sharesDelta: String(-po.shares),
            navAt: String(navFixed(bankroll, reserved, totalShares)),
            idemKey: `lsm:vault-close:${vaultId}:${po.userId}`,
          }),
        );
      }
      return { payouts, asset: v.assetUnit };
    });

    if (!plan) return { closed: false, payouts: 0 };

    // 2) 事务外给各 LP 入账（按金库币种路由，幂等键防重复）。失败仅记录对账。
    const adapter = this.registry.forAsset(plan.asset);
    let credited = 0;
    for (const po of plan.payouts) {
      if (po.amount <= 0) continue;
      try {
        await adapter.credit(po.userId, po.amount, {
          idemKey: `lsm:vault-close:${vaultId}:${po.userId}`,
          kind: 'vault_close',
        });
        credited += 1;
      } catch (e) {
        this.logger.error(
          `vault-close credit failed ${vaultId}/${po.userId} amount=${po.amount}: ${(e as Error).message}`,
        );
      }
    }
    this.logger.warn(`vault ${vaultId} closed; ${credited} LP payouts settled`);
    return { closed: true, payouts: credited };
  }

  /** 列出处于 closing 状态的金库 id（供调度器清算扫描）。 */
  async listClosingVaultIds(): Promise<string[]> {
    const rows = await this.vaults.find({
      where: { status: LsmVaultStatus.CLOSING },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** 列出 active 用户金库 id（供调度器分成计提）。 */
  async listActiveUserVaultIds(): Promise<string[]> {
    const rows = await this.vaults.find({
      where: { kind: LsmVaultKind.USER, status: LsmVaultStatus.ACTIVE },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // ── 视图 ─────────────────────────────────────────────────────

  async listVaults(kind?: LsmVaultKind, asset?: string): Promise<VaultView[]> {
    const where: Record<string, unknown> = {};
    if (kind) where.kind = kind;
    if (asset != null && asset !== '') where.assetUnit = normalizeAsset(asset);
    const rows = await this.vaults.find({
      where,
      order: { kind: 'ASC', createdAt: 'ASC' },
    });
    return rows.map((v) => this.toView(v));
  }

  async getVault(id: string): Promise<VaultView> {
    const v = await this.vaults.findOne({ where: { id } });
    if (!v) throw new NotFoundException('vault not found');
    return this.toView(v);
  }

  private toView(v: LsmVault): VaultView {
    const bankroll = Number(v.bankroll);
    const reserved = Number(v.reserved);
    const totalShares = Number(v.totalShares);
    const navF = navFixed(bankroll, reserved, totalShares);
    const utilizationBps = bankroll > 0 ? Math.floor((reserved * 10000) / bankroll) : 0;
    return {
      id: v.id,
      kind: v.kind,
      name: v.name,
      leaderUserId: v.leaderUserId,
      status: v.status,
      asset: v.assetUnit,
      bankroll,
      reserved,
      equity: equity(bankroll, reserved),
      totalShares,
      navFixed: navF,
      nav: navF / NAV_SCALE,
      utilizationBps,
      minLeaderShareBps: v.minLeaderShareBps,
      profitShareBps: v.profitShareBps,
      depositLockSecs: v.depositLockSecs,
    };
  }

  async myPositions(userId: string): Promise<
    Array<{ vaultId: string; shares: number; costBasis: number; isLeader: boolean; lockedUntil: number | null }>
  > {
    const rows = await this.positions.find({ where: { userId } });
    return rows
      .filter((p) => Number(p.shares) > 0)
      .map((p) => ({
        vaultId: p.vaultId,
        shares: Number(p.shares),
        costBasis: Number(p.costBasis),
        isLeader: p.isLeader,
        lockedUntil: p.lockedUntil?.getTime() ?? null,
      }));
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private async upsertPosition(
    manager: EntityManager,
    vaultId: string,
    userId: string,
    diff: { sharesDelta: number; costDelta: number; lockSecs?: number; isLeader?: boolean },
  ): Promise<void> {
    const existing = await manager.findOne(LsmVaultPosition, {
      where: { vaultId, userId },
    });
    const lockedUntil =
      diff.lockSecs != null ? new Date(Date.now() + diff.lockSecs * 1000) : undefined;
    if (!existing) {
      await manager.save(
        manager.create(LsmVaultPosition, {
          vaultId,
          userId,
          shares: String(Math.max(0, diff.sharesDelta)),
          costBasis: String(Math.max(0, diff.costDelta)),
          lockedUntil: lockedUntil ?? null,
          isLeader: diff.isLeader === true,
        }),
      );
      return;
    }
    const newShares = Number(existing.shares) + diff.sharesDelta;
    const update: Partial<LsmVaultPosition> = {
      shares: String(Math.max(0, newShares)),
      costBasis: String(Number(existing.costBasis) + diff.costDelta),
    };
    if (lockedUntil) update.lockedUntil = lockedUntil;
    if (diff.isLeader === true) update.isLeader = true;
    await manager.update(LsmVaultPosition, { vaultId, userId }, update);
  }
}
