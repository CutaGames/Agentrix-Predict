/**
 * LSM feed-bridge — 与 KMarket 赔率采集内部 API 的数据契约（DTO）。
 *
 * Agentrix 不重做采集；feed-bridge 仅消费 KMarket 受信内部 API
 * （服务间令牌鉴权），把赛事/赔率快照落到本地 lsm_markets / lsm_odds_snapshots，
 * 并做 odds_stale / suspended 判定。
 */

/** 单个 outcome 的赔率（小数制）。 */
export interface FeedOutcomeOdds {
  /** 0=home,1=away,2=draw */
  outcomeIdx: number;
  /** 公允赔率（小数，如 1.85） */
  fairOdds: number;
}

/** KMarket 推送/返回的盘口快照。 */
export interface FeedMarketSnapshot {
  /** 采集侧唯一标识，用于幂等 upsert */
  externalMarketId: string;
  /** 赛事标识（同场比赛多盘口共享）；缺省时回退 externalMarketId */
  eventId?: string | null;
  sport: string;
  league?: string | null;
  homeTeam: string;
  awayTeam: string;
  /** 2=胜负，3=1X2（含平局） */
  outcomeCount: number;
  /** pre/live/suspended/final/voided（KMarket 侧状态，桥接后映射本地枚举） */
  status: string;
  kickoffAt?: string | null; // ISO
  /** 当前各 outcome 赔率 */
  odds: FeedOutcomeOdds[];
  /** 赔率时间戳（ISO），用于 odds_stale 判定 */
  oddsTs: string;
  /** 已结束时携带的获胜 outcome 序号 */
  winningOutcomeIdx?: number | null;
  /** 主/客比分（live/final 展示用），未知为 null */
  homeScore?: number | null;
  awayScore?: number | null;
}

/** 批量赔率推送负载。 */
export interface FeedBatchPayload {
  markets: FeedMarketSnapshot[];
  /** 服务间令牌（也可走 header，留作显式校验） */
  serviceToken?: string;
}

/** feed-bridge 配置。 */
export interface LsmFeedConfig {
  /** KMarket 内部 API base，如 http://kmarket-internal:PORT/internal/v1 */
  baseUrl: string;
  /** 服务间令牌 */
  serviceToken: string;
  /** 超过该秒数无新赔率 → odds_stale → 暂停下单 */
  staleAfterSecs: number;
}
