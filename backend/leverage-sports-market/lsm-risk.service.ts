import { Injectable, BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LsmVault } from '../../entities/lsm-vault.entity';
import { LsmOrderLeg } from '../../entities/lsm-order-leg.entity';
import { LsmOrder } from '../../entities/lsm-order.entity';
import { LsmMarket } from '../../entities/lsm-market.entity';
import {
  evaluateRisk,
  DEFAULT_RISK_CONFIG,
  RiskConfig,
} from './lsm.risk-math';

/**
 * 风控敞口上限（task 12，每金库独立）。
 *
 * 在开仓事务内、reserveOpenLeg 之前对**每个承接金库腿**校验三层上限：
 *   单盘 5% / 单赛事 15% / 全局利用率 U*=50%，基数为金库风险资本 C。
 * 净敞口以 maxProfit（reserveShare − stakeShare）计量。超限抛 RISK_LIMIT_EXCEEDED。
 *
 * 阈值经 env 可覆盖（LSM_RISK_*_BPS），随 bankroll 自适应（按比例）。
 */
@Injectable()
export class LsmRiskService {
  private readonly cfg: RiskConfig = {
    marketBps: Number(process.env.LSM_RISK_MARKET_BPS || DEFAULT_RISK_CONFIG.marketBps),
    eventBps: Number(process.env.LSM_RISK_EVENT_BPS || DEFAULT_RISK_CONFIG.eventBps),
    globalUBps: Number(process.env.LSM_RISK_GLOBAL_U_BPS || DEFAULT_RISK_CONFIG.globalUBps),
  };

  /**
   * 校验某金库腿新增净敞口是否在上限内（在 manager 事务中，含本金库未结）。
   * @param addStakeShare 本腿新增保证金份额
   * @param addReserveShare 本腿新增预留（winPayout 份额）= addStakeShare + addNet
   */
  async assertLegWithinLimits(
    manager: EntityManager,
    vaultId: string,
    marketId: string,
    addStakeShare: number,
    addReserveShare: number,
  ): Promise<void> {
    const addNet = addReserveShare - addStakeShare; // = maxProfitShare
    if (addNet <= 0) return;

    const vault = await manager.findOne(LsmVault, { where: { id: vaultId } });
    if (!vault) throw new Error('vault missing');
    const bankroll = Number(vault.bankroll);

    // 本金库未结保证金/预留聚合（全局、单盘、单赛事）
    const market = await manager.findOne(LsmMarket, { where: { id: marketId } });
    const eventId = market?.eventId ?? marketId;

    const global = await this.sumLegs(manager, vaultId, null, null);
    const perMarket = await this.sumLegs(manager, vaultId, marketId, null);
    const perEvent = await this.sumLegs(manager, vaultId, null, eventId);

    // 风险资本 C = bankroll − 本金库全局未结保证金
    const capital = bankroll - global.stake;

    const result = evaluateRisk(
      {
        capital,
        netExposureMarket: perMarket.reserve - perMarket.stake,
        netExposureEvent: perEvent.reserve - perEvent.stake,
        netExposureGlobal: global.reserve - global.stake,
        addNet,
      },
      this.cfg,
    );

    if (!result.ok) {
      throw new BadRequestException(
        `RISK_LIMIT_EXCEEDED:${result.reason}:avail=${result.availableForNewRisk}`,
      );
    }
  }

  /**
   * 聚合本金库 OPEN 订单腿的 stakeShare / reserveShare。
   * - marketId 非空：限定该盘口
   * - eventId 非空：限定该赛事（关联 lsm_markets.event_id）
   */
  private async sumLegs(
    manager: EntityManager,
    vaultId: string,
    marketId: string | null,
    eventId: string | null,
  ): Promise<{ stake: number; reserve: number }> {
    const qb = manager
      .createQueryBuilder(LsmOrderLeg, 'leg')
      .innerJoin(LsmOrder, 'o', 'o.id = leg.order_id')
      .select('COALESCE(SUM(leg.stake_share),0)', 'stake')
      .addSelect('COALESCE(SUM(leg.reserve_share),0)', 'reserve')
      .where('leg.vault_id::text = :vaultId', { vaultId })
      .andWhere("o.status = 'open'");

    if (marketId) {
      qb.andWhere('o.market_id::text = :marketId', { marketId });
    }
    if (eventId) {
      qb.innerJoin(LsmMarket, 'm', 'm.id::text = o.market_id').andWhere('m.event_id = :eventId', {
        eventId,
      });
    }

    const row = await qb.getRawOne<{ stake: string; reserve: string }>();
    return {
      stake: Number(row?.stake ?? 0),
      reserve: Number(row?.reserve ?? 0),
    };
  }
}
