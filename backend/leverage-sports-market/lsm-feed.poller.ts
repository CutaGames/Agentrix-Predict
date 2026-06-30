import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LsmFeedService } from './lsm-feed.service';
import { FeedBatchPayload, FeedMarketSnapshot } from './lsm-feed.types';

/**
 * LSM feed poller — 周期性从 KMarket 内部赔率 API 拉取赛事/赔率快照并 ingest 落库。
 *
 * KMarket 不主动推送，Agentrix 主动轮询 `GET {base}/api/v1/internal/lsm/snapshots`
 * （`X-Internal-Token` 服务间令牌），返回形如：
 *   { success, data: { markets: FeedMarketSnapshot[], count, servedAt }, ... }
 * 经 `LsmFeedService.ingest` upsert 盘口 + 落赔率快照。
 *
 * 频率：live 每 30s（小批量）/ 全量每 5min（大批量）。KMarket 端点暂无 scope/live
 * 过滤参数，两路均做全量拉取，仅 limit 不同（风险：见 design「先全量拉取」）。
 *
 * 失败隔离：超时（AbortController）+ try/catch，失败仅告警不抛、不阻塞主流程。
 * 未配置 `KMARKET_INTERNAL_BASE_URL` → 静默跳过（本地/未接源环境无噪声）。
 * `LSM_FEED_POLL_DISABLED=1` 可整体停用（灰度/演练）。
 */
@Injectable()
export class LsmFeedPoller {
  private readonly logger = new Logger(LsmFeedPoller.name);
  private static readonly SNAPSHOTS_PATH = '/api/v1/internal/lsm/snapshots';

  constructor(private readonly feed: LsmFeedService) {}

  /** KMarket 内部 API base（去尾斜杠）；未配置则轮询静默跳过。 */
  private get baseUrl(): string {
    return (process.env.KMARKET_INTERNAL_BASE_URL || '').replace(/\/+$/, '');
  }

  /** 服务间令牌；未配置时不带头（KMarket 侧会以 dev 模式放行并告警）。 */
  private get token(): string {
    return process.env.KMARKET_INTERNAL_TOKEN || '';
  }

  private get disabled(): boolean {
    return process.env.LSM_FEED_POLL_DISABLED === '1';
  }

  /** HTTP 超时（毫秒），可经 env 覆盖。 */
  private get timeoutMs(): number {
    const n = Number(process.env.LSM_FEED_POLL_TIMEOUT_MS || 8000);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  }

  /** live 盘口高频轮询：每 30s，小批量。 */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'lsm-feed-poll' })
  async pollLive(): Promise<void> {
    await this.poll(200, 'live');
  }

  /** 全量低频轮询：每 5min，大批量（覆盖赛前/空闲盘口）。 */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'lsm-feed-poll-all' })
  async pollAll(): Promise<void> {
    await this.poll(1000, 'all');
  }

  /**
   * 拉取并 ingest 一批快照。返回 ingest 结果；未配置/禁用/失败返回 null（不抛）。
   * 公开以便测试直驱与按需触发。
   */
  async poll(
    limit: number,
    label: string,
  ): Promise<{ upserted: number; snapshots: number } | null> {
    if (this.disabled) return null;
    const base = this.baseUrl;
    if (!base) return null; // 未配置 env → 静默跳过

    const url = `${base}${LsmFeedPoller.SNAPSHOTS_PATH}?limit=${limit}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.token) headers['X-Internal-Token'] = this.token;

      const res = await fetch(url, { signal: ctrl.signal, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body: unknown = await res.json();
      const markets = this.extractMarkets(body);
      if (markets.length === 0) {
        this.logger.debug(`[${label}] feed returned 0 markets`);
        return { upserted: 0, snapshots: 0 };
      }

      const payload: FeedBatchPayload = { markets };
      const r = await this.feed.ingest(payload);
      this.logger.log(
        `[${label}] ingested markets=${r.upserted} snapshots=${r.snapshots}`,
      );
      return r;
    } catch (e) {
      // 失败仅告警，不抛、不阻塞主流程（下一周期重试）。
      this.logger.warn(`[${label}] feed poll failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 从响应中抽取 markets 数组，兼容两种形态：
   *  - ApiResponse 包裹：`{ data: { markets: [...] } }`
   *  - 裸 payload：`{ markets: [...] }` 或直接数组。
   */
  private extractMarkets(body: unknown): FeedMarketSnapshot[] {
    const b = body as Record<string, unknown> | null;
    const container = (b?.data ?? b) as Record<string, unknown> | unknown[] | null;
    if (Array.isArray(container)) return container as FeedMarketSnapshot[];
    const markets = (container as Record<string, unknown> | null)?.markets;
    return Array.isArray(markets) ? (markets as FeedMarketSnapshot[]) : [];
  }
}
