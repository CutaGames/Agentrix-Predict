/**
 * LSM 风控敞口上限 纯数学（无副作用，供单元测试）。
 *
 * 资本基数 C = 金库风险资本 = bankroll − 本金库未结保证金之和
 *   （= LP 出资 + 已实现留存，剔除暂存的用户保证金，随结算收敛到真实净资产）。
 * 净敞口以「最大盈利 maxProfit」计量（金库真实可亏部分，剔除已收保证金）：
 *   legNetExposure = reserveShare − stakeShare = maxProfitShare。
 *
 * 上限（占 C 的 bps，可配置；随 bankroll 自适应）：
 *   - 单盘最大净敞口  RISK_MARKET_BPS = 500  (5%)
 *   - 单赛事聚合敞口  RISK_EVENT_BPS  = 1500 (15%)
 *   - 全局利用率上限  RISK_GLOBAL_U_BPS = 5000 (50%)
 */

export const RISK_MARKET_BPS = 500;
export const RISK_EVENT_BPS = 1500;
export const RISK_GLOBAL_U_BPS = 5000;

export interface RiskConfig {
  marketBps: number;
  eventBps: number;
  globalUBps: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  marketBps: RISK_MARKET_BPS,
  eventBps: RISK_EVENT_BPS,
  globalUBps: RISK_GLOBAL_U_BPS,
};

/** 上限额度 = floor(bps × capital / 10000)，capital≤0 时为 0。 */
export function capFor(bps: number, capital: number): number {
  if (capital <= 0) return 0;
  return Math.floor((bps * capital) / 10000);
}

export interface RiskInput {
  /** 金库风险资本 C（整数 AXP） */
  capital: number;
  /** 本盘口当前净敞口（maxProfit 之和，未含本笔） */
  netExposureMarket: number;
  /** 本赛事当前聚合净敞口（未含本笔） */
  netExposureEvent: number;
  /** 全局当前净敞口（未含本笔） */
  netExposureGlobal: number;
  /** 本笔新增净敞口（maxProfitShare） */
  addNet: number;
}

export interface RiskResult {
  ok: boolean;
  reason: 'market' | 'event' | 'global' | null;
  /** 在不破限前提下本笔最多可新增净敞口（用于提示可下注上限） */
  availableForNewRisk: number;
}

/**
 * 判定一笔新增净敞口是否在三层上限内，并给出可用额度。
 */
export function evaluateRisk(input: RiskInput, cfg: RiskConfig = DEFAULT_RISK_CONFIG): RiskResult {
  const marketCap = capFor(cfg.marketBps, input.capital);
  const eventCap = capFor(cfg.eventBps, input.capital);
  const globalCap = capFor(cfg.globalUBps, input.capital);

  const marketAvail = marketCap - input.netExposureMarket;
  const eventAvail = eventCap - input.netExposureEvent;
  const globalAvail = globalCap - input.netExposureGlobal;
  const availableForNewRisk = Math.max(0, Math.min(marketAvail, eventAvail, globalAvail));

  if (input.addNet <= 0) {
    return { ok: true, reason: null, availableForNewRisk };
  }
  if (input.netExposureMarket + input.addNet > marketCap) {
    return { ok: false, reason: 'market', availableForNewRisk };
  }
  if (input.netExposureEvent + input.addNet > eventCap) {
    return { ok: false, reason: 'event', availableForNewRisk };
  }
  if (input.netExposureGlobal + input.addNet > globalCap) {
    return { ok: false, reason: 'global', availableForNewRisk };
  }
  return { ok: true, reason: null, availableForNewRisk };
}
