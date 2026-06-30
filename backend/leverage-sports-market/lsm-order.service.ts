import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { LsmMarket, LsmMarketStatus } from '../../entities/lsm-market.entity';
import { LsmOrder, LsmOrderStatus } from '../../entities/lsm-order.entity';
import { LsmOrderLeg } from '../../entities/lsm-order-leg.entity';
import { LsmFeedService } from './lsm-feed.service';
import { AssetAdapterRegistry, LsmAsset, normalizeAsset } from './lsm-asset.adapter';
import { LsmVaultService } from './lsm-vault.service';
import { LsmUnderwritingService, Allocation } from './lsm-underwriting.service';
import { LsmRiskService } from './lsm-risk.service';
import { LsmSystemModeService } from './lsm-system-mode.service';
import { LsmComplianceService } from './lsm-compliance.service';
import {
  applyEdge,
  computeBet,
  computeCashout,
  oddsToBps,
  bpsToOdds,
  withinSlippage,
  DEFAULT_EDGE_BPS,
  dynamicEdgeBps,
  BPS_DENOM,
} from './lsm.pricing';
import { splitProRata } from './lsm.vault-math';
export interface PreviewInput {
  marketId: string;
  outcomeIdx: number;
  stake: number;
  leverage: number;
  /** 资金标的（币种）。未指定按灰度默认（AXP）。需求 22。 */
  asset?: string;
}

export interface PreviewResult {
  marketId: string;
  outcomeIdx: number;
  stake: number;
  leverage: number;
  asset: LsmAsset;
  fairOdds: number;
  tradableOdds: number;
  notional: number;
  maxProfit: number;
  maxLoss: number;
  winPayout: number;
  tradable: boolean;
  slippageBps: number;
}

export interface PlaceInput extends PreviewInput {
  userId: string;
  quotedOdds: number;
  idemKey: string;
  /** 下单方所在国家码（CDN/请求头注入），用于地域门禁 */
  country?: string | null;
}

/**
 * order-engine（P2/P3：金库为对手方）。
 *
 * 资金正确性：
 *  - 整数 AXP 全程，pricing 纯函数 floor 取整（不高估用户盈利）。
 *  - 偿付不变量：每承接金库腿 reserved ≤ bankroll（LsmVaultService.reserveOpenLeg 强校验）。
 *  - 幂等：order.idemKey 唯一；AXP 动作 refId=idemKey 派生键；结算按订单状态机幂等。
 *  - 多金库分摊（P3）：按 allocBps 拆 stake/winPayout，余数归官方金库腿；各腿独立预留/结算（隔离）。
 *  - 用户侧 AXP 经单次 AxpService 调用原子完成；金库腿在自有事务更新，失败补偿（release）。
 */
@Injectable()
export class LsmOrderService {
  private readonly logger = new Logger(LsmOrderService.name);

  constructor(
    @InjectRepository(LsmMarket)
    private readonly markets: Repository<LsmMarket>,
    @InjectRepository(LsmOrder)
    private readonly orders: Repository<LsmOrder>,
    @InjectRepository(LsmOrderLeg)
    private readonly legs: Repository<LsmOrderLeg>,
    private readonly feed: LsmFeedService,
    private readonly registry: AssetAdapterRegistry,
    private readonly vaultSvc: LsmVaultService,
    private readonly underwriting: LsmUnderwritingService,
    private readonly risk: LsmRiskService,
    private readonly systemMode: LsmSystemModeService,
    private readonly compliance: LsmComplianceService,
    private readonly dataSource: DataSource,
  ) {}

  // ── Pricing helpers ─────────────────────────────────────────

  /** 可成交赔率（decimal）：基础 edge + 对应币种官方金库利用率动态加成。 */
  private async tradableOddsFor(
    marketId: string,
    outcomeIdx: number,
    asset: LsmAsset = 'AXP',
  ): Promise<number | null> {
    const fair = await this.feed.latestFairOdds(marketId, outcomeIdx);
    if (fair == null) return null;
    const protocol = await this.vaultSvc.getOrCreateProtocolVault(asset);
    const bankroll = Number(protocol.bankroll);
    const reserved = Number(protocol.reserved);
    const utilBps = bankroll > 0 ? Math.floor((reserved * BPS_DENOM) / bankroll) : 0;
    const edgeBps = dynamicEdgeBps(DEFAULT_EDGE_BPS, utilBps);
    const tradableBps = applyEdge(oddsToBps(fair), edgeBps);
    return bpsToOdds(tradableBps);
  }

  // ── Preview ─────────────────────────────────────────────────

  async preview(input: PreviewInput): Promise<PreviewResult> {
    const market = await this.markets.findOne({ where: { id: input.marketId } });
    if (!market) throw new NotFoundException('market not found');
    const asset = this.registry.resolveOffered(input.asset);
    this.validateStake(input.stake, input.leverage, input.outcomeIdx, market);

    const fair = await this.feed.latestFairOdds(input.marketId, input.outcomeIdx);
    if (fair == null) throw new BadRequestException('ODDS_UNAVAILABLE');
    const tradableOdds = (await this.tradableOddsFor(input.marketId, input.outcomeIdx, asset))!;
    const m = computeBet(input.stake, input.leverage, oddsToBps(tradableOdds));
    return {
      marketId: input.marketId,
      outcomeIdx: input.outcomeIdx,
      stake: input.stake,
      leverage: input.leverage,
      asset,
      fairOdds: fair,
      tradableOdds,
      notional: m.notional,
      maxProfit: m.maxProfit,
      maxLoss: m.maxLoss,
      winPayout: m.winPayout,
      tradable: this.feed.isTradable(market),
      slippageBps: 500,
    };
  }

  private validateStake(
    stake: number,
    leverage: number,
    outcomeIdx: number,
    market: LsmMarket,
  ) {
    if (!Number.isInteger(stake) || stake <= 0) {
      throw new BadRequestException('stake must be a positive integer AXP');
    }
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) {
      throw new BadRequestException('leverage out of range');
    }
    if (outcomeIdx < 0 || outcomeIdx >= market.outcomeCount) {
      throw new BadRequestException('invalid outcomeIdx');
    }
  }

  // ── Place ───────────────────────────────────────────────────

  async place(input: PlaceInput): Promise<LsmOrder> {
    const existing = await this.orders.findOne({ where: { idemKey: input.idemKey } });
    if (existing) return existing;

    // 全局熔断（system-mode）：halted/reduce_only 禁止开新仓（task 12 / 需求 4.4、6.4）
    this.systemMode.assertCanOpen();
    // 准入/地域门禁（task 8 / 需求 8.2）：受限主体禁止下注
    await this.compliance.assertCanBet(input.userId, input.country);

    // 币种解析 + 灰度校验（需求 22.2/22.6）：未指定按默认；不在 LSM_ASSET_MODE 提供集合内抛错。
    const asset = this.registry.resolveOffered(input.asset);

    const market = await this.markets.findOne({ where: { id: input.marketId } });
    if (!market) throw new NotFoundException('market not found');
    this.validateStake(input.stake, input.leverage, input.outcomeIdx, market);

    if (!this.feed.isTradable(market)) {
      throw new BadRequestException(
        this.feed.isStale(market) ? 'ODDS_STALE' : 'MARKET_SUSPENDED',
      );
    }

    const tradableOdds = await this.tradableOddsFor(input.marketId, input.outcomeIdx, asset);
    if (tradableOdds == null) throw new BadRequestException('ODDS_UNAVAILABLE');
    if (!withinSlippage(oddsToBps(input.quotedOdds), oddsToBps(tradableOdds))) {
      throw new BadRequestException(`SLIPPAGE_EXCEEDED:${tradableOdds}`);
    }

    const m = computeBet(input.stake, input.leverage, oddsToBps(tradableOdds));
    const winPayout = m.winPayout;

    // 承接配比（P3）：按币种过滤金库（同币种金库承接同币种下注），官方金库腿排末位作为余数兜底
    const allocations = await this.underwriting.getAllocations(input.marketId, asset);
    const weights = allocations.map((a) => a.allocBps);
    const stakeShares = splitProRata(input.stake, weights);
    const winShares = splitProRata(winPayout, weights);

    // 1) 用户侧 escrow 保证金（按币种路由 AXP/USDC，原子；余额不足抛错）
    const adapter = this.registry.forAsset(asset);
    await adapter.escrow(input.userId, input.stake, {
      idemKey: `lsm:stake:${input.idemKey}`,
      kind: 'lsm_open',
      metadata: { marketId: input.marketId, outcomeIdx: input.outcomeIdx, asset },
    });

    // 2) 各金库腿预留 + 订单 + 订单腿（同事务，偿付不变量逐腿强校验）
    try {
      return await this.dataSource.transaction(async (manager) => {
        const order = manager.create(LsmOrder, {
          userId: input.userId,
          marketId: input.marketId,
          outcomeIdx: input.outcomeIdx,
          asset,
          stake: String(input.stake),
          leverage: input.leverage,
          entryOdds: tradableOdds.toFixed(4),
          notional: String(m.notional),
          maxProfit: String(m.maxProfit),
          status: LsmOrderStatus.OPEN,
          payout: '0',
          closePnl: '0',
          idemKey: input.idemKey,
        });
        const savedOrder = await manager.save(order);

        for (let i = 0; i < allocations.length; i++) {
          const a = allocations[i];
          const stakeShare = stakeShares[i];
          const winShare = winShares[i];
          if (stakeShare === 0 && winShare === 0) continue;
          // task 12 风控：逐金库腿三层敞口上限（单盘/赛事/全局），超限抛 RISK_LIMIT_EXCEEDED
          await this.risk.assertLegWithinLimits(
            manager,
            a.vaultId,
            input.marketId,
            stakeShare,
            winShare,
          );
          await this.vaultSvc.reserveOpenLeg(manager, a.vaultId, stakeShare, winShare);
          await manager.save(
            manager.create(LsmOrderLeg, {
              orderId: savedOrder.id,
              vaultId: a.vaultId,
              allocBps: a.allocBps,
              stakeShare: String(stakeShare),
              reserveShare: String(winShare),
              pnlShare: '0',
            }),
          );
        }
        return savedOrder;
      });
    } catch (e) {
      try {
        await adapter.release(input.userId, input.stake, {
          idemKey: `lsm:stake-compensate:${input.idemKey}`,
          kind: 'lsm_open_rollback',
        });
      } catch (ce) {
        this.logger.error(
          `compensation failed for idemKey=${input.idemKey}: ${(ce as Error).message}`,
        );
      }
      throw e;
    }
  }

  // ── Settle ──────────────────────────────────────────────────

  async settleMarket(
    marketId: string,
    winningOutcomeIdx: number,
  ): Promise<{ won: number; lost: number }> {
    const open = await this.orders.find({
      where: { marketId, status: LsmOrderStatus.OPEN },
    });
    let won = 0;
    let lost = 0;
    for (const order of open) {
      const isWin = order.outcomeIdx === winningOutcomeIdx;
      await this.settleOne(order, isWin);
      if (isWin) won += 1;
      else lost += 1;
    }
    return { won, lost };
  }

  async refundMarket(marketId: string): Promise<{ refunded: number }> {
    const open = await this.orders.find({
      where: { marketId, status: LsmOrderStatus.OPEN },
    });
    let refunded = 0;
    for (const order of open) {
      await this.refundOne(order);
      refunded += 1;
    }
    return { refunded };
  }

  private async settleOne(order: LsmOrder, isWin: boolean): Promise<void> {
    const stake = Number(order.stake);
    const maxProfit = Number(order.maxProfit);
    const winPayout = stake + maxProfit;

    await this.dataSource.transaction(async (manager) => {
      const fresh = await manager.findOne(LsmOrder, {
        where: { id: order.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== LsmOrderStatus.OPEN) return; // 幂等
      const legs = await manager.find(LsmOrderLeg, { where: { orderId: order.id } });
      for (const leg of legs) {
        const winShare = Number(leg.reserveShare);
        const stakeShare = Number(leg.stakeShare);
        if (isWin) {
          await this.vaultSvc.settleLegWin(manager, leg.vaultId, winShare);
          leg.pnlShare = String(stakeShare - winShare); // 金库本腿净盈亏（负=赔付）
        } else {
          await this.vaultSvc.settleLegLose(manager, leg.vaultId, winShare);
          leg.pnlShare = String(stakeShare); // 金库本腿净盈（收保证金份额）
        }
        await manager.save(leg);
      }
      if (isWin) {
        fresh.status = LsmOrderStatus.WON;
        fresh.payout = String(winPayout);
        fresh.closePnl = String(maxProfit);
      } else {
        fresh.status = LsmOrderStatus.LOST;
        fresh.payout = '0';
        fresh.closePnl = String(-stake);
      }
      fresh.settledAt = new Date();
      await manager.save(fresh);
    });

    if (isWin) {
      await this.registry.forAsset(order.asset).credit(order.userId, winPayout, {
        idemKey: `lsm:payout:${order.id}`,
        kind: 'lsm_settle_win',
        metadata: { marketId: order.marketId, orderId: order.id },
      });
    }
  }

  private async refundOne(order: LsmOrder): Promise<void> {
    const stake = Number(order.stake);
    await this.dataSource.transaction(async (manager) => {
      const fresh = await manager.findOne(LsmOrder, {
        where: { id: order.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== LsmOrderStatus.OPEN) return; // 幂等
      const legs = await manager.find(LsmOrderLeg, { where: { orderId: order.id } });
      for (const leg of legs) {
        await this.vaultSvc.refundLeg(
          manager,
          leg.vaultId,
          Number(leg.stakeShare),
          Number(leg.reserveShare),
        );
        leg.pnlShare = '0';
        await manager.save(leg);
      }
      fresh.status = LsmOrderStatus.REFUNDED;
      fresh.payout = String(stake);
      fresh.closePnl = '0';
      fresh.settledAt = new Date();
      await manager.save(fresh);
    });
    await this.registry.forAsset(order.asset).release(order.userId, stake, {
      idemKey: `lsm:refund:${order.id}`,
      kind: 'lsm_refund',
      metadata: { marketId: order.marketId, orderId: order.id },
    });
  }

  // ── Cash-out（提前平仓，P2+） ────────────────────────────────

  /**
   * 提前平仓：按当前可成交赔率 mark-to-market 兑现持仓盈亏（整数 AXP、幂等、同事务）。
   *
   * 门禁：盘口 tradable（非 stale/suspended）+ systemMode.assertCanOpen()
   *   （主动平仓属"改变风险敞口"，结算路径不受此限，但平仓按只读/暂停拒绝）。
   * 定价：computeCashout（floor 不高估用户，cashout ≤ winPayout = Σ reserveShare）。
   * 金库：splitProRata(cashout, 各腿 reserveShare 权重)，余数归官方腿（排末位）兜底；
   *   逐腿释放全部预留 + 兑付 cashoutShare；强校验 Σ cashoutShare ≤ Σ reserveShare。
   * 用户 credit（幂等键 lsm:cashout:<id>）在事务提交后入账（cashout=0 不入账）。
   */
  async cashOut(orderId: string, userId: string): Promise<LsmOrder> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('order not found');
    if (order.userId !== userId) throw new ForbiddenException('NOT_ORDER_OWNER');
    // 幂等：已平仓直接返回；其它终态拒绝
    if (order.status === LsmOrderStatus.CASHED_OUT) return order;
    if (order.status !== LsmOrderStatus.OPEN) {
      throw new BadRequestException('ORDER_NOT_OPEN');
    }

    // 全局熔断（system-mode）：halted/reduce_only 禁止主动平仓（改变敞口）
    this.systemMode.assertCanOpen();

    const market = await this.markets.findOne({ where: { id: order.marketId } });
    if (!market) throw new NotFoundException('market not found');
    if (!this.feed.isTradable(market)) {
      throw new BadRequestException(
        this.feed.isStale(market) ? 'ODDS_STALE' : 'MARKET_SUSPENDED',
      );
    }

    const currentOdds = await this.tradableOddsFor(
      order.marketId,
      order.outcomeIdx,
      normalizeAsset(order.asset),
    );
    if (currentOdds == null) throw new BadRequestException('ODDS_UNAVAILABLE');

    const cashoutEdgeBps = Number(process.env.LSM_CASHOUT_EDGE_BPS || 0);
    const m = computeCashout(
      Number(order.stake),
      order.leverage,
      oddsToBps(Number(order.entryOdds)),
      oddsToBps(currentOdds),
      cashoutEdgeBps,
    );
    const cashout = m.cashout;

    await this.dataSource.transaction(async (manager) => {
      const fresh = await manager.findOne(LsmOrder, {
        where: { id: order.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== LsmOrderStatus.OPEN) return; // 幂等（并发兜底）
      const legs = await manager.find(LsmOrderLeg, { where: { orderId: order.id } });

      // 按各腿预留权重拆兑现值，余数归官方金库腿（排末位）
      const weights = legs.map((l) => Number(l.reserveShare));
      const totalReserve = weights.reduce((a, b) => a + b, 0);
      const cashoutShares = splitProRata(cashout, weights);

      // 强校验：兑现不超过该单各金库腿可释放预留之和（偿付不变量护栏）
      if (cashout > totalReserve) {
        throw new BadRequestException('CASHOUT_EXCEEDS_RESERVE');
      }

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const reserveShare = Number(leg.reserveShare);
        const cashoutShare = cashoutShares[i];
        await this.vaultSvc.cashoutLeg(manager, leg.vaultId, reserveShare, cashoutShare);
        // 本腿净盈亏 = 承接保证金份额 − 兑付份额（正=金库净盈，负=净付）
        leg.pnlShare = String(Number(leg.stakeShare) - cashoutShare);
        await manager.save(leg);
      }

      fresh.status = LsmOrderStatus.CASHED_OUT;
      fresh.payout = String(cashout);
      fresh.closePnl = String(cashout - Number(order.stake));
      fresh.settledAt = new Date();
      await manager.save(fresh);
    });

    // 提交后给用户入账（幂等键防重复）。cashout=0（持仓贬值至尽）不入账。
    if (cashout > 0) {
      await this.registry.forAsset(order.asset).credit(order.userId, cashout, {
        idemKey: `lsm:cashout:${order.id}`,
        kind: 'lsm_cashout',
        metadata: { marketId: order.marketId, orderId: order.id },
      });
    }

    return this.orders.findOneOrFail({ where: { id: order.id } });
  }

  // ── Queries ─────────────────────────────────────────────────

  async myOrders(userId: string, limit = 50): Promise<LsmOrder[]> {
    return this.orders.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }

  /**
   * OPEN 订单当前实时可兑现值（mark-to-market，整数 AXP），供持仓视图展示。
   *
   * 与 cashOut 同源定价（同 computeCashout + tradableOddsFor + LSM_CASHOUT_EDGE_BPS），
   * 仅作只读估值、不改任何状态。任何"无法兑现"场景一律返回 null（不抛错）：
   *   - 订单非 OPEN（已结算/已平仓无需现值）；
   *   - 盘口不存在 / 不可交易（stale / suspended）；
   *   - 当前赔率不可用（feed 缺该结果）。
   */
  async currentCashoutValue(order: LsmOrder): Promise<number | null> {
    try {
      if (order.status !== LsmOrderStatus.OPEN) return null;
      const market = await this.markets.findOne({ where: { id: order.marketId } });
      if (!market || !this.feed.isTradable(market)) return null;
      const currentOdds = await this.tradableOddsFor(
        order.marketId,
        order.outcomeIdx,
        normalizeAsset(order.asset),
      );
      if (currentOdds == null) return null;
      const cashoutEdgeBps = Number(process.env.LSM_CASHOUT_EDGE_BPS || 0);
      const m = computeCashout(
        Number(order.stake),
        order.leverage,
        oddsToBps(Number(order.entryOdds)),
        oddsToBps(currentOdds),
        cashoutEdgeBps,
      );
      return m.cashout;
    } catch (e) {
      this.logger.warn(
        `currentCashoutValue failed for order ${order.id}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  // ── Settlement orchestration（结算编排，供调度器/admin 触发） ──

  /**
   * 扫描需要结算/退款的盘口并执行（幂等）。
   *  - FINAL 且 winningOutcomeIdx 非空、仍有 OPEN 订单 → settleMarket。
   *  - VOIDED 仍有 OPEN 订单 → refundMarket（取消/作废退保证金）。
   * 返回处理统计。逐盘 try/catch 隔离，单盘失败不影响其余。
   */
  async sweepSettlements(limit = 200): Promise<{
    settledMarkets: number;
    refundedMarkets: number;
    wonOrders: number;
    lostOrders: number;
    refundedOrders: number;
    errors: number;
  }> {
    const stats = {
      settledMarkets: 0,
      refundedMarkets: 0,
      wonOrders: 0,
      lostOrders: 0,
      refundedOrders: 0,
      errors: 0,
    };

    // 待结算：FINAL + 已知赛果 + 仍有 OPEN 订单
    const openMarketIds = await this.orders
      .createQueryBuilder('o')
      .select('DISTINCT o.market_id', 'marketId')
      .where('o.status = :open', { open: LsmOrderStatus.OPEN })
      .limit(limit)
      .getRawMany<{ marketId: string }>();

    for (const { marketId } of openMarketIds) {
      try {
        const market = await this.markets.findOne({ where: { id: marketId } });
        if (!market) continue;
        if (
          market.status === LsmMarketStatus.FINAL &&
          market.winningOutcomeIdx != null
        ) {
          const r = await this.settleMarket(marketId, market.winningOutcomeIdx);
          if (r.won + r.lost > 0) {
            stats.settledMarkets += 1;
            stats.wonOrders += r.won;
            stats.lostOrders += r.lost;
          }
        } else if (market.status === LsmMarketStatus.VOIDED) {
          const r = await this.refundMarket(marketId);
          if (r.refunded > 0) {
            stats.refundedMarkets += 1;
            stats.refundedOrders += r.refunded;
          }
        }
      } catch (e) {
        stats.errors += 1;
        this.logger.error(
          `sweepSettlements failed for market ${marketId}: ${(e as Error).message}`,
        );
      }
    }
    return stats;
  }
}
