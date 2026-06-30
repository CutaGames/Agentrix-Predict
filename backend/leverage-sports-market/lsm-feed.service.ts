import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { LsmMarket, LsmMarketStatus } from '../../entities/lsm-market.entity';
import { LsmOddsSnapshot } from '../../entities/lsm-odds-snapshot.entity';
import {
  FeedMarketSnapshot,
  FeedBatchPayload,
  LsmFeedConfig,
} from './lsm-feed.types';

/**
 * feed-bridge：消费 KMarket 内部赔率 API，落地盘口与赔率快照，做新鲜度判定。
 *
 * P0：提供 ingest（被内部 webhook/轮询调用）+ 新鲜度查询。实时 WS 订阅在 P0 之后接。
 * 资金口径不在本层（仅元数据 + decimal 赔率）。
 */
@Injectable()
export class LsmFeedService {
  private readonly logger = new Logger(LsmFeedService.name);

  /** 默认配置；生产经 env 覆盖（KMARKET_INTERNAL_*）。 */
  private readonly config: LsmFeedConfig = {
    baseUrl: process.env.KMARKET_INTERNAL_BASE_URL || '',
    serviceToken: process.env.KMARKET_INTERNAL_TOKEN || '',
    staleAfterSecs: Number(process.env.LSM_ODDS_STALE_SECS || 30),
  };

  constructor(
    @InjectRepository(LsmMarket)
    private readonly markets: Repository<LsmMarket>,
    @InjectRepository(LsmOddsSnapshot)
    private readonly snapshots: Repository<LsmOddsSnapshot>,
    private readonly dataSource: DataSource,
  ) {}

  /** 校验服务间令牌。未配置令牌时（本地/测试）放行并告警。 */
  verifyServiceToken(token?: string): boolean {
    if (!this.config.serviceToken) {
      this.logger.warn('KMARKET_INTERNAL_TOKEN not set — accepting feed without auth');
      return true;
    }
    return token === this.config.serviceToken;
  }

  /** KMarket 侧状态字符串 → 本地枚举。 */
  private mapStatus(s: string): LsmMarketStatus {
    switch ((s || '').toLowerCase()) {
      case 'live':
      case 'inplay':
        return LsmMarketStatus.LIVE;
      case 'suspended':
        return LsmMarketStatus.SUSPENDED;
      case 'final':
      case 'finished':
      case 'settled':
        return LsmMarketStatus.FINAL;
      case 'voided':
      case 'cancelled':
      case 'canceled':
        return LsmMarketStatus.VOIDED;
      case 'pre':
      case 'prematch':
      default:
        return LsmMarketStatus.PRE;
    }
  }

  /**
   * 批量摄取盘口快照：upsert 盘口 + 落赔率快照 + 更新 lastOddsAt。
   * 幂等：按 externalMarketId upsert；赔率快照 append-only。
   */
  async ingest(payload: FeedBatchPayload): Promise<{ upserted: number; snapshots: number }> {
    let upserted = 0;
    let snapCount = 0;
    for (const snap of payload.markets) {
      const { snapshots } = await this.ingestOne(snap);
      upserted += 1;
      snapCount += snapshots;
    }
    return { upserted, snapshots: snapCount };
  }

  private async ingestOne(
    snap: FeedMarketSnapshot,
  ): Promise<{ marketId: string; snapshots: number }> {
    return this.dataSource.transaction(async (manager) => {
      let market = await manager.findOne(LsmMarket, {
        where: { externalMarketId: snap.externalMarketId },
      });
      const oddsTs = snap.oddsTs ? new Date(snap.oddsTs) : new Date();
      const status = this.mapStatus(snap.status);
      if (!market) {
        market = manager.create(LsmMarket, {
          externalMarketId: snap.externalMarketId,
          eventId: snap.eventId ?? snap.externalMarketId,
          sport: snap.sport || 'soccer',
          league: snap.league ?? null,
          homeTeam: snap.homeTeam,
          awayTeam: snap.awayTeam,
          outcomeCount: snap.outcomeCount || 2,
          status,
          kickoffAt: snap.kickoffAt ? new Date(snap.kickoffAt) : null,
          lastOddsAt: oddsTs,
          winningOutcomeIdx: snap.winningOutcomeIdx ?? null,
          homeScore: snap.homeScore ?? null,
          awayScore: snap.awayScore ?? null,
        });
      } else {
        market.sport = snap.sport || market.sport;
        if (snap.eventId) market.eventId = snap.eventId;
        market.league = snap.league ?? market.league;
        market.homeTeam = snap.homeTeam || market.homeTeam;
        market.awayTeam = snap.awayTeam || market.awayTeam;
        market.outcomeCount = snap.outcomeCount || market.outcomeCount;
        market.status = status;
        if (snap.kickoffAt) market.kickoffAt = new Date(snap.kickoffAt);
        market.lastOddsAt = oddsTs;
        if (snap.winningOutcomeIdx != null) {
          market.winningOutcomeIdx = snap.winningOutcomeIdx;
        }
        if (snap.homeScore != null) market.homeScore = snap.homeScore;
        if (snap.awayScore != null) market.awayScore = snap.awayScore;
      }
      await manager.save(market);

      let snaps = 0;
      for (const o of snap.odds || []) {
        const row = manager.create(LsmOddsSnapshot, {
          marketId: market.id,
          outcomeIdx: o.outcomeIdx,
          fairOdds: o.fairOdds.toFixed(4),
          source: snap.sport ? `kmarket:${snap.sport}` : 'kmarket',
          ts: oddsTs,
        });
        await manager.save(row);
        snaps += 1;
      }
      return { marketId: market.id, snapshots: snaps };
    });
  }

  /**
   * 赔率新鲜度判定：超过 staleAfterSecs 无更新 → stale（禁止下单）。
   * suspended/voided/final 同样视为不可成交。
   */
  isStale(market: LsmMarket, now: Date = new Date()): boolean {
    if (!market.lastOddsAt) return true;
    const ageSecs = (now.getTime() - market.lastOddsAt.getTime()) / 1000;
    return ageSecs > this.config.staleAfterSecs;
  }

  isTradable(market: LsmMarket, now: Date = new Date()): boolean {
    if (market.status !== LsmMarketStatus.LIVE && market.status !== LsmMarketStatus.PRE) {
      return false;
    }
    return !this.isStale(market, now);
  }

  /** 取盘口某 outcome 最新公允赔率（decimal）。 */
  async latestFairOdds(marketId: string, outcomeIdx: number): Promise<number | null> {
    const row = await this.snapshots.findOne({
      where: { marketId, outcomeIdx },
      order: { ts: 'DESC' },
    });
    return row ? Number(row.fairOdds) : null;
  }
}
