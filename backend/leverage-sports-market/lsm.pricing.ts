/**
 * LSM pricing — 纯函数定价引擎（无副作用，便于属性/单元测试）。
 *
 * 资金正确性第一原则：
 *  - 资金量（stake/notional/maxProfit/payout）一律整数 AXP，无浮点。
 *  - 赔率为小数制（decimal odds），以 bps（万分之）做整数化的中间换算，
 *    乘法后用 floor 向下取整，保证「庄家不吃亏向下取整」（用户盈利不被高估）。
 *  - 滑点带宽固定 MAX_SLIPPAGE_BPS=500（±5%），不放宽。
 *
 * 赔率内部表示：oddsBps = round(odds × 10000)。如 1.92 → 19200。
 */

/** 固定滑点带宽（万分之），全局常量，禁止放宽。 */
export const MAX_SLIPPAGE_BPS = 500;

/** 万分之分母。 */
export const BPS_DENOM = 10000;

/** 默认庄家边际（overround，万分之），design 默认 4–6%，取 500=5%。 */
export const DEFAULT_EDGE_BPS = 500;

/** decimal odds → oddsBps（整数，万分之）。 */
export function oddsToBps(odds: number): number {
  return Math.round(odds * BPS_DENOM);
}

/** oddsBps → decimal odds（展示用）。 */
export function bpsToOdds(oddsBps: number): number {
  return oddsBps / BPS_DENOM;
}

/**
 * 对公允赔率施加庄家 edge，得到可成交赔率（整数 oddsBps）。
 *
 * 思路：公允赔率隐含概率 p = 1/fair。施加 edge 后赔付倍率收缩：
 *   tradable = 1 + (fair − 1) × (1 − edgeBps/DENOM)
 * 即只压缩「净盈利倍率」部分，本金返还不变，保证 tradable ≥ 1。
 * 结果向下取整（floor），对用户保守（赔率更低 → 庄家更有利）。
 */
export function applyEdge(fairOddsBps: number, edgeBps: number = DEFAULT_EDGE_BPS): number {
  if (fairOddsBps <= BPS_DENOM) return BPS_DENOM; // 赔率不应 < 1
  const netProfitBps = fairOddsBps - BPS_DENOM; // 净盈利倍率部分（万分之）
  const shrunk = Math.floor((netProfitBps * (BPS_DENOM - edgeBps)) / BPS_DENOM);
  return BPS_DENOM + shrunk;
}

/**
 * 利用率动态加成：利用率越高，edge 越高（设上限），保证金库长期正期望。
 * utilizationBps = reserved/bankroll（万分之）。surcharge = util×factor，封顶 maxBps。
 */
export function dynamicEdgeBps(
  baseEdgeBps: number,
  utilizationBps: number,
  factorBps = 2000, // util 的 20% 计入加成
  maxEdgeBps = 1200, // edge 上限 12%
): number {
  const surcharge = Math.floor((utilizationBps * factorBps) / BPS_DENOM);
  return Math.min(maxEdgeBps, baseEdgeBps + surcharge);
}

/** 滑点带宽：返回 [下界, 上界]（oddsBps），用户可接受成交区间。 */
export function slippageBand(
  oddsBps: number,
  bps: number = MAX_SLIPPAGE_BPS,
): { minBps: number; maxBps: number } {
  const minBps = Math.floor((oddsBps * (BPS_DENOM - bps)) / BPS_DENOM);
  const maxBps = Math.ceil((oddsBps * (BPS_DENOM + bps)) / BPS_DENOM);
  return { minBps, maxBps };
}

/**
 * 校验成交赔率是否在用户报价的可接受滑点带内。
 * quotedBps = 用户下单时看到的赔率；actualBps = 引擎成交赔率。
 */
export function withinSlippage(
  quotedBps: number,
  actualBps: number,
  bps: number = MAX_SLIPPAGE_BPS,
): boolean {
  const { minBps, maxBps } = slippageBand(quotedBps, bps);
  return actualBps >= minBps && actualBps <= maxBps;
}

export interface BetMath {
  /** 名义敞口 N = stake × leverage（整数 AXP） */
  notional: number;
  /** 用户最大盈利 = N×(odds−1)（整数 AXP，floor） */
  maxProfit: number;
  /** 用户最大可亏 = stake（杠杆固定赔率，输则全损保证金） */
  maxLoss: number;
  /** 庄家最坏赔付预留 = maxProfit（赢时庄家净付） */
  reserve: number;
  /** 用户赢时派彩（含本金）= stake + maxProfit */
  winPayout: number;
}

/**
 * 杠杆固定赔率下单数学（全整数 AXP）。
 * @param stake 保证金（整数 AXP，>0）
 * @param leverage 杠杆倍数（整数 ≥1）
 * @param tradableOddsBps 可成交赔率（oddsBps，已含 edge，≥10000）
 */
export function computeBet(
  stake: number,
  leverage: number,
  tradableOddsBps: number,
): BetMath {
  if (!Number.isInteger(stake) || stake <= 0) {
    throw new Error('stake must be a positive integer AXP');
  }
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new Error('leverage must be an integer >= 1');
  }
  if (tradableOddsBps < BPS_DENOM) {
    throw new Error('odds must be >= 1.0');
  }
  const notional = stake * leverage;
  const netBps = tradableOddsBps - BPS_DENOM; // (odds−1) 的万分之表示
  // maxProfit = notional × (odds−1)，floor 取整（对庄家保守）
  const maxProfit = Math.floor((notional * netBps) / BPS_DENOM);
  return {
    notional,
    maxProfit,
    maxLoss: stake,
    reserve: maxProfit,
    winPayout: stake + maxProfit,
  };
}

export interface CashoutMath {
  /** 名义敞口 N = stake × leverage（整数 AXP） */
  notional: number;
  /** 入场口径用户最大盈利 = floor(N×(o_e−1))，作为兑现上界的盈利部分（整数 AXP） */
  maxProfit: number;
  /** 当前可成交赔率下的 mark-to-market 最大盈利 = floor(N×(o_e/o_c−1))（带符号，整数 AXP） */
  maxProfitNow: number;
  /** 兑现值 = clamp(stake + maxProfitNow, 0, stake + maxProfit)（整数 AXP，≥0） */
  cashout: number;
  /** 用户平仓已实现盈亏 = cashout − stake（带符号，整数 AXP） */
  grossPnl: number;
}

/**
 * 提前平仓（cash-out）定价 — 按当前可成交赔率 mark-to-market（全整数 AXP，floor 不高估用户）。
 *
 * 口径（沿用杠杆固定赔率模型）：
 *   名义 N = stake × leverage；入场赔率 o_e、当前可成交赔率 o_c（均已含 edge，与开仓同源）。
 *   入场最大盈利 maxProfit = floor(N×(o_e−1))（= 订单存储口径）。
 *   当前最大盈利 maxProfitNow = floor(N×(o_e/o_c − 1)) = floor(N×(o_e−o_c)/o_c)。
 *     - o_c 下跌（本方更被看好）→ maxProfitNow 增大（持仓增值）。
 *     - o_c 上涨（本方更不被看好）→ maxProfitNow 减小甚至为负（持仓贬值）。
 *   兑现值 cashout = clamp(stake + maxProfitNow, 0, stake + maxProfit)。
 *     - 下界 0：贬值至本金尽失则兑现 0（不向用户倒贴）。
 *     - 上界 stake+maxProfit（= winPayout）：兑现绝不超过赢盘派彩 / 金库预留。
 *   floor 向下取整（含负数向 −∞）对金库保守，永不高估用户兑现值。
 *
 * 退出 edge（cashoutEdgeBps，默认 0，v1 不抽）：仅对正向盈利部分按比例收缩，
 *   maxProfitNow > 0 时 maxProfitNow = floor(maxProfitNow × (DENOM−edge)/DENOM)，
 *   亏损/持平不受影响（不向贬值持仓二次加税）。
 *
 * @param stake 保证金 M（整数 AXP，>0）
 * @param leverage 杠杆倍数（整数 ≥1）
 * @param entryOddsBps 入场可成交赔率 o_e（oddsBps，≥10000）
 * @param currentOddsBps 当前可成交赔率 o_c（oddsBps，≥10000）
 * @param cashoutEdgeBps 退出 edge（万分之，默认 0）
 */
export function computeCashout(
  stake: number,
  leverage: number,
  entryOddsBps: number,
  currentOddsBps: number,
  cashoutEdgeBps = 0,
): CashoutMath {
  if (!Number.isInteger(stake) || stake <= 0) {
    throw new Error('stake must be a positive integer AXP');
  }
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new Error('leverage must be an integer >= 1');
  }
  if (entryOddsBps < BPS_DENOM) {
    throw new Error('entry odds must be >= 1.0');
  }
  if (currentOddsBps < BPS_DENOM) {
    throw new Error('current odds must be >= 1.0');
  }
  const notional = stake * leverage;
  // 入场最大盈利（= 订单存储 maxProfit），作为兑现上界的盈利部分
  const maxProfit = Math.floor((notional * (entryOddsBps - BPS_DENOM)) / BPS_DENOM);
  // 当前 mark-to-market 最大盈利：floor(N×(o_e−o_c)/o_c)，负数向 −∞ 取整（对金库保守）
  let maxProfitNow = Math.floor(
    (notional * (entryOddsBps - currentOddsBps)) / currentOddsBps,
  );
  // 退出 edge：仅对正向盈利收缩（默认 0 不抽）
  if (cashoutEdgeBps > 0 && maxProfitNow > 0) {
    maxProfitNow = Math.floor((maxProfitNow * (BPS_DENOM - cashoutEdgeBps)) / BPS_DENOM);
  }
  const upper = stake + maxProfit; // = winPayout，兑现绝不超过此值
  const cashout = Math.min(upper, Math.max(0, stake + maxProfitNow));
  return {
    notional,
    maxProfit,
    maxProfitNow,
    cashout,
    grossPnl: cashout - stake,
  };
}
