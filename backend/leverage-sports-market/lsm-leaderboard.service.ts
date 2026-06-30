import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LsmOrder, LsmOrderStatus } from '../../entities/lsm-order.entity';

export interface LeaderboardRow {
  rank: number;
  userId: string;
  value: number;
  bets: number;
}

/**
 * LSM 排行榜（P4，task 20 / 需求 1.2）。复用 KMarket 大赛/排行榜思路，作为 LSM 内运营位。
 *
 * 两类榜单（基于已结算订单，整数 AXP）：
 *  - pnl：按已实现盈亏 Σ(close_pnl) 降序（盈利王）。
 *  - volume：按名义敞口 Σ(notional) 降序（成交量王）。
 * 周期：all（全期）/ week（近 7 日 created_at）。
 */
@Injectable()
export class LsmLeaderboardService {
  constructor(
    @InjectRepository(LsmOrder)
    private readonly orders: Repository<LsmOrder>,
  ) {}

  async leaderboard(
    board: 'pnl' | 'volume' = 'pnl',
    period: 'all' | 'week' = 'all',
    limit = 20,
  ): Promise<{ board: string; period: string; items: LeaderboardRow[] }> {
    const valueExpr =
      board === 'volume' ? 'COALESCE(SUM(o.notional),0)' : 'COALESCE(SUM(o.close_pnl),0)';
    const qb = this.orders
      .createQueryBuilder('o')
      .select('o.user_id', 'userId')
      .addSelect(valueExpr, 'value')
      .addSelect('COUNT(*)', 'bets')
      // 仅计入已结算订单（won/lost/refunded）
      .where('o.status IN (:...settled)', {
        settled: [LsmOrderStatus.WON, LsmOrderStatus.LOST, LsmOrderStatus.REFUNDED],
      })
      .groupBy('o.user_id')
      .orderBy('value', 'DESC')
      .limit(Math.max(1, Math.min(100, limit)));

    if (period === 'week') {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      qb.andWhere('o.created_at >= :since', { since });
    }

    const rows = await qb.getRawMany<{ userId: string; value: string; bets: string }>();
    return {
      board,
      period,
      items: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        value: Number(r.value),
        bets: Number(r.bets),
      })),
    };
  }
}
