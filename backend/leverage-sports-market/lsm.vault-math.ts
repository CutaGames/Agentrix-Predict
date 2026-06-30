/**
 * LSM 金库 NAV / 份额 纯数学（无副作用，供属性测试）。
 *
 * 资金正确性原则：
 *  - 全整数 AXP / 整数份额，无浮点。
 *  - 净权益 E = bankroll − reserved（保守计量）。NAV = E / totalShares。
 *  - 铸/销份额用整数除法 floor 取整，**余数归金库**（计入留存权益），
 *    保证既有 LP 权益不被稀释（no-dilution）：取整只会让操作者少拿、其余 LP 受益或不变。
 *  - NAV 展示用定点 1e9 表示（navFixed），仅用于审计/高水位比较，不参与铸销。
 */

export const NAV_SCALE = 1_000_000_000; // 1e9 定点

/** 金库净权益 E = bankroll − reserved（≥0，由偿付不变量保证）。 */
export function equity(bankroll: number, reserved: number): number {
  return bankroll - reserved;
}

/** NAV 定点表示（E/shares × 1e9）；shares=0 时定义 NAV=1e9（1.0）。 */
export function navFixed(bankroll: number, reserved: number, totalShares: number): number {
  if (totalShares <= 0) return NAV_SCALE;
  const e = equity(bankroll, reserved);
  return Math.floor((e * NAV_SCALE) / totalShares);
}

export interface DepositResult {
  sharesMinted: number;
  newBankroll: number;
  newTotalShares: number;
}

/**
 * 存入 d（整数 AXP，>0）。
 * 首笔（totalShares=0 或 E<=0）：1:1 铸份额（sharesMinted=d）。
 * 否则：sharesMinted = floor(d × totalShares / E)；余数留存金库（不额外铸份额）。
 * bankroll += d（E 随之 += d，reserved 不变）。
 */
export function computeDeposit(
  d: number,
  bankroll: number,
  reserved: number,
  totalShares: number,
): DepositResult {
  if (!Number.isInteger(d) || d <= 0) throw new Error('deposit must be positive integer');
  const e = equity(bankroll, reserved);
  let sharesMinted: number;
  if (totalShares <= 0 || e <= 0) {
    sharesMinted = d; // 首笔或权益归零重启：1:1
  } else {
    sharesMinted = Math.floor((d * totalShares) / e);
  }
  return {
    sharesMinted,
    newBankroll: bankroll + d,
    newTotalShares: totalShares + sharesMinted,
  };
}

export interface RedeemResult {
  payout: number;
  sharesBurned: number;
  newBankroll: number;
  newTotalShares: number;
}

/**
 * 赎回 s 份额（整数，>0，≤ 用户持有且 ≤ totalShares）。
 * payout = floor(s × E / totalShares)；余数留存金库（利好剩余 LP）。
 * 因 payout ≤ E = bankroll − reserved，赎回从不挪用预留（流动性恒满足）。
 * bankroll −= payout；totalShares −= s。
 */
export function computeRedeem(
  s: number,
  bankroll: number,
  reserved: number,
  totalShares: number,
): RedeemResult {
  if (!Number.isInteger(s) || s <= 0) throw new Error('redeem shares must be positive integer');
  if (s > totalShares) throw new Error('redeem exceeds total shares');
  const e = equity(bankroll, reserved);
  const payout = totalShares > 0 ? Math.floor((s * e) / totalShares) : 0;
  return {
    payout: Math.max(0, payout),
    sharesBurned: s,
    newBankroll: bankroll - Math.max(0, payout),
    newTotalShares: totalShares - s,
  };
}

/**
 * 主理人高水位（HWM）利润分成计提（份额铸给主理人，稀释式计提）。
 *
 * 仅当当前 NAV > highWaterNav 时，对「超出高水位的权益增量」按 profitShareBps 计提，
 * 以「向主理人铸造等值份额」实现（不动 bankroll，存入方 NAV 反映扣费后净值）。
 * 返回应铸给主理人的份额与新高水位。亏损未回补（NAV ≤ HWM）时计提为 0。
 *
 * feeEquity = profitShareBps/10000 × (navNow − HWM)/navNow × E
 * leaderSharesMinted = floor(feeEquity × totalShares / (E − feeEquity))
 *   （等价于让主理人份额价值 = feeEquity，其余 LP 权益按比例摊薄到 navAfter）
 */
export interface ProfitFeeResult {
  leaderSharesMinted: number;
  newHighWaterNav: number;
  newTotalShares: number;
  feeEquity: number;
}

export function computeProfitFee(
  bankroll: number,
  reserved: number,
  totalShares: number,
  highWaterNavFixed: number,
  profitShareBps: number,
): ProfitFeeResult {
  const navNow = navFixed(bankroll, reserved, totalShares);
  if (totalShares <= 0 || profitShareBps <= 0 || navNow <= highWaterNavFixed) {
    return {
      leaderSharesMinted: 0,
      newHighWaterNav: Math.max(highWaterNavFixed, navNow),
      newTotalShares: totalShares,
      feeEquity: 0,
    };
  }
  const e = equity(bankroll, reserved);
  // 高水位以上的权益增量（整数 AXP）：(navNow − HWM)/1e9 × totalShares
  const gainAboveHwm = Math.floor(((navNow - highWaterNavFixed) * totalShares) / NAV_SCALE);
  const feeEquity = Math.floor((gainAboveHwm * profitShareBps) / 10000);
  let leaderSharesMinted = 0;
  if (feeEquity > 0 && e - feeEquity > 0) {
    leaderSharesMinted = Math.floor((feeEquity * totalShares) / (e - feeEquity));
  }
  const newTotalShares = totalShares + leaderSharesMinted;
  const newNav = navFixed(bankroll, reserved, newTotalShares);
  return {
    leaderSharesMinted,
    newHighWaterNav: newNav, // 计提后新高水位设为扣费后 NAV
    newTotalShares,
    feeEquity,
  };
}

/**
 * 按容量比例把整数 amount 拆分到各 leg，余数归最后一腿（兜底=官方金库腿）。
 * weights 为各腿权重（capacity），最后一项约定为官方金库兜底腿。
 * 返回每腿分得的整数额，Σ == amount。
 */
export function splitProRata(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map((_, i) => (i === weights.length - 1 ? amount : 0));
  const out: number[] = [];
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i === weights.length - 1) {
      out.push(amount - assigned); // 余数归兜底腿
    } else {
      const part = Math.floor((amount * weights[i]) / total);
      out.push(part);
      assigned += part;
    }
  }
  return out;
}
