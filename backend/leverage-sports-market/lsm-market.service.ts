import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual } from 'typeorm';
import { LsmMarket, LsmMarketStatus } from '../../entities/lsm-market.entity';
import { LsmOddsSnapshot } from '../../entities/lsm-odds-snapshot.entity';
import { LsmFeedService } from './lsm-feed.service';

export interface LsmMarketView {
  id: string;
  externalMarketId: string;
  sport: string;
  league: string | null;
  homeTeam: string;
  awayTeam: string;
  outcomeCount: number;
  status: LsmMarketStatus;
  kickoffAt: number | null;
  lastOddsAt: number | null;
  tradable: boolean;
  stale: boolean;
  winningOutcomeIdx: number | null;
  homeScore: number | null;
  awayScore: number | null;
  /** 各 outcome 最新公允赔率（decimal），按 outcomeIdx 排序 */
  odds: Array<{ outcomeIdx: number; fairOdds: number }>;
}

/**
 * 只读盘口服务（P0）：列表/详情 + 当前赔率。下单/定价在 order-engine。
 */
@Injectable()
export class LsmMarketService {
  constructor(
    @InjectRepository(LsmMarket)
    private readonly markets: Repository<LsmMarket>,
    @InjectRepository(LsmOddsSnapshot)
    private readonly snapshots: Repository<LsmOddsSnapshot>,
    private readonly feed: LsmFeedService,
  ) {}

  /** 活跃盘口（pre/live），按开赛时间升序。 */
  async listLive(league?: string, limit = 50): Promise<LsmMarketView[]> {
    const qb = this.markets
      .createQueryBuilder('m')
      .where('m.status IN (:...st)', {
        st: [LsmMarketStatus.PRE, LsmMarketStatus.LIVE],
      })
      .orderBy('m.kickoff_at', 'ASC')
      .limit(Math.min(limit, 100));
    if (league) qb.andWhere('m.league = :lg', { lg: league });
    const rows = await qb.getMany();
    return this.toViews(rows);
  }

  /** 最近已结算盘口。 */
  async listRecentSettled(limit = 20): Promise<LsmMarketView[]> {
    const rows = await this.markets.find({
      where: { status: LsmMarketStatus.FINAL },
      order: { updatedAt: 'DESC' },
      take: Math.min(limit, 100),
    });
    return this.toViews(rows);
  }

  async getMarket(id: string): Promise<LsmMarketView> {
    const m = await this.markets.findOne({ where: { id } });
    if (!m) throw new NotFoundException('market not found');
    const [view] = await this.toViews([m]);
    return view;
  }

  /**
   * 赔率历史（mark-to-market 折线数据），供前端赔率变化图。
   * range：all / 30m / 10m / 5m。返回按 outcomeIdx 分组的时间序列（ts 升序）。
   * 只读，不修改任何数据；窗口内无快照返回空 series。
   */
  async oddsHistory(
    marketId: string,
    range: string,
  ): Promise<{
    marketId: string;
    range: string;
    series: Array<{ outcomeIdx: number; points: Array<{ ts: number; odds: number }> }>;
  }> {
    const m = await this.markets.findOne({ where: { id: marketId } });
    if (!m) throw new NotFoundException('market not found');

    const windowMin: Record<string, number | null> = {
      all: null,
      '30m': 30,
      '10m': 10,
      '5m': 5,
    };
    const mins = range in windowMin ? windowMin[range] : null;

    const where: Record<string, unknown> = { marketId };
    if (mins != null) {
      where.ts = MoreThanOrEqual(new Date(Date.now() - mins * 60_000));
    }
    const rows = await this.snapshots.find({
      where,
      order: { ts: 'ASC' },
      take: 2000,
    });

    const byOutcome = new Map<number, Array<{ ts: number; odds: number }>>();
    for (const s of rows) {
      if (!byOutcome.has(s.outcomeIdx)) byOutcome.set(s.outcomeIdx, []);
      byOutcome.get(s.outcomeIdx)!.push({ ts: s.ts.getTime(), odds: Number(s.fairOdds) });
    }
    const series = [...byOutcome.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([outcomeIdx, points]) => ({ outcomeIdx, points }));
    return { marketId, range: range in windowMin ? range : 'all', series };
  }

  /** 批量补齐各盘口最新赔率（每 outcome 取最新一条）。 */
  private async toViews(rows: LsmMarket[]): Promise<LsmMarketView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    // 取这些盘口的赔率快照（按时间倒序），在内存里取每 (market,outcome) 最新一条
    const snaps = await this.snapshots.find({
      where: { marketId: In(ids) },
      order: { ts: 'DESC' },
      take: ids.length * 12,
    });
    const latest = new Map<string, { outcomeIdx: number; fairOdds: number }>();
    for (const s of snaps) {
      const key = `${s.marketId}:${s.outcomeIdx}`;
      if (!latest.has(key)) {
        latest.set(key, { outcomeIdx: s.outcomeIdx, fairOdds: Number(s.fairOdds) });
      }
    }
    const now = new Date();
    return rows.map((m) => {
      const odds: Array<{ outcomeIdx: number; fairOdds: number }> = [];
      for (let i = 0; i < m.outcomeCount; i++) {
        const v = latest.get(`${m.id}:${i}`);
        if (v) odds.push(v);
      }
      odds.sort((a, b) => a.outcomeIdx - b.outcomeIdx);
      return {
        id: m.id,
        externalMarketId: m.externalMarketId,
        sport: m.sport,
        league: m.league,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        outcomeCount: m.outcomeCount,
        status: m.status,
        kickoffAt: m.kickoffAt?.getTime() ?? null,
        lastOddsAt: m.lastOddsAt?.getTime() ?? null,
        tradable: this.feed.isTradable(m, now),
        stale: this.feed.isStale(m, now),
        winningOutcomeIdx: m.winningOutcomeIdx,
        homeScore: m.homeScore ?? null,
        awayScore: m.awayScore ?? null,
        odds,
      };
    });
  }
}
