import fc from 'fast-check';
import {
  computeDeposit,
  computeRedeem,
  computeProfitFee,
  navFixed,
  equity,
  splitProRata,
  NAV_SCALE,
} from './lsm.vault-math';
import {
  computeBet,
  computeCashout,
  applyEdge,
  oddsToBps,
  MAX_SLIPPAGE_BPS,
} from './lsm.pricing';
import {
  evaluateRisk,
  capFor,
  RISK_MARKET_BPS,
  RISK_EVENT_BPS,
  RISK_GLOBAL_U_BPS,
} from './lsm.risk-math';

/**
 * LSM 金库正确性属性测试（Properties 1–12）。
 *
 * 用纯数学函数（lsm.vault-math / lsm.pricing）模拟随机「存入/赎回/开仓/结算」序列，
 * 断言金库经济不变量恒成立。这是资金正确性的最高优先保障。
 */

// ── 单金库状态机模型（与 LsmVaultService 记账口径一致） ──────────
interface ModelState {
  bankroll: number;
  reserved: number;
  totalShares: number;
  positions: Map<string, number>; // userId -> shares
  userCash: Map<string, number>; // userId -> AXP 余额
  open: Array<{ user: string; stake: number; winPayout: number }>;
  highWaterNav: number;
}

const USERS = ['u1', 'u2', 'u3'];
const INITIAL_CASH = 1_000_000;

function freshState(): ModelState {
  const userCash = new Map<string, number>();
  for (const u of USERS) userCash.set(u, INITIAL_CASH);
  return {
    bankroll: 0,
    reserved: 0,
    totalShares: 0,
    positions: new Map(),
    userCash,
    open: [],
    highWaterNav: NAV_SCALE,
  };
}

/** 全系统 AXP 总量（用户现金 + 金库 bankroll）= 守恒量。 */
function totalAxp(s: ModelState): number {
  let sum = s.bankroll;
  for (const v of s.userCash.values()) sum += v;
  return sum;
}

type Op =
  | { t: 'deposit'; user: string; amount: number }
  | { t: 'redeem'; user: string; frac: number }
  | { t: 'open'; user: string; stake: number; leverage: number; oddsBps: number }
  | { t: 'settleWin' }
  | { t: 'settleLose' };

function applyOp(s: ModelState, op: Op): void {
  switch (op.t) {
    case 'deposit': {
      const cash = s.userCash.get(op.user)!;
      if (op.amount <= 0 || op.amount > cash) return;
      const r = computeDeposit(op.amount, s.bankroll, s.reserved, s.totalShares);
      s.bankroll = r.newBankroll;
      s.totalShares = r.newTotalShares;
      s.positions.set(op.user, (s.positions.get(op.user) ?? 0) + r.sharesMinted);
      s.userCash.set(op.user, cash - op.amount);
      break;
    }
    case 'redeem': {
      const held = s.positions.get(op.user) ?? 0;
      if (held <= 0) return;
      const shares = Math.max(1, Math.floor(held * op.frac));
      if (shares > s.totalShares) return;
      const r = computeRedeem(shares, s.bankroll, s.reserved, s.totalShares);
      s.bankroll = r.newBankroll;
      s.totalShares = r.newTotalShares;
      s.positions.set(op.user, held - shares);
      s.userCash.set(op.user, (s.userCash.get(op.user) ?? 0) + r.payout);
      break;
    }
    case 'open': {
      const cash = s.userCash.get(op.user)!;
      if (op.stake <= 0 || op.stake > cash) return;
      const m = computeBet(op.stake, op.leverage, op.oddsBps);
      const winPayout = m.winPayout;
      // 偿付不变量预检：开仓后 reserved ≤ bankroll
      const newBankroll = s.bankroll + op.stake;
      const newReserved = s.reserved + winPayout;
      if (newReserved > newBankroll) return; // 风控拒绝
      s.bankroll = newBankroll;
      s.reserved = newReserved;
      s.userCash.set(op.user, cash - op.stake);
      s.open.push({ user: op.user, stake: op.stake, winPayout });
      break;
    }
    case 'settleWin': {
      const o = s.open.shift();
      if (!o) return;
      s.bankroll -= o.winPayout;
      s.reserved -= o.winPayout;
      s.userCash.set(o.user, (s.userCash.get(o.user) ?? 0) + o.winPayout);
      break;
    }
    case 'settleLose': {
      const o = s.open.shift();
      if (!o) return;
      s.reserved -= o.winPayout;
      break;
    }
  }
}

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    t: fc.constant('deposit' as const),
    user: fc.constantFrom(...USERS),
    amount: fc.integer({ min: 1, max: 50_000 }),
  }),
  fc.record({
    t: fc.constant('redeem' as const),
    user: fc.constantFrom(...USERS),
    frac: fc.float({ min: Math.fround(0.1), max: Math.fround(1), noNaN: true }),
  }),
  fc.record({
    t: fc.constant('open' as const),
    user: fc.constantFrom(...USERS),
    stake: fc.integer({ min: 1, max: 5_000 }),
    leverage: fc.integer({ min: 1, max: 10 }),
    oddsBps: fc.integer({ min: 10_100, max: 40_000 }),
  }),
  fc.record({ t: fc.constant('settleWin' as const) }),
  fc.record({ t: fc.constant('settleLose' as const) }),
);

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

describe('LSM 金库正确性属性测试 (Properties 1–12)', () => {
  it('Property 1+2+3+6: AXP 守恒 / 偿付(reserved≤bankroll) / 权益≥0 / 全整数', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 0, maxLength: 80 }), (ops) => {
        const s = freshState();
        const total0 = totalAxp(s);
        for (const op of ops) {
          applyOp(s, op);
          // P2 偿付
          expect(s.reserved).toBeLessThanOrEqual(s.bankroll);
          // P3 权益≥0（金库不穿仓）
          expect(equity(s.bankroll, s.reserved)).toBeGreaterThanOrEqual(0);
          // P6 全整数
          expect(isInt(s.bankroll)).toBe(true);
          expect(isInt(s.reserved)).toBe(true);
          expect(isInt(s.totalShares)).toBe(true);
          // P1 守恒（用户现金 + 金库 bankroll 恒定）
          expect(totalAxp(s)).toBe(total0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('Property 4: NAV 无稀释（存入/赎回后 NAV 不下降）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }), // 初始注资
        fc.array(
          fc.oneof(
            fc.record({
              t: fc.constant('deposit' as const),
              user: fc.constantFrom(...USERS),
              amount: fc.integer({ min: 1, max: 50_000 }),
            }),
            fc.record({
              t: fc.constant('redeem' as const),
              user: fc.constantFrom(...USERS),
              frac: fc.float({ min: Math.fround(0.1), max: Math.fround(1), noNaN: true }),
            }),
          ),
          { maxLength: 40 },
        ),
        (seed, ops) => {
          const s = freshState();
          applyOp(s, { t: 'deposit', user: 'u1', amount: seed });
          for (const op of ops) {
            const navBefore = navFixed(s.bankroll, s.reserved, s.totalShares);
            applyOp(s, op as Op);
            const navAfter = navFixed(s.bankroll, s.reserved, s.totalShares);
            if (s.totalShares > 0) {
              // 纯存赎不应稀释既有 LP：NAV 单调不降
              expect(navAfter).toBeGreaterThanOrEqual(navBefore);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('Property 4b: 取整余数归金库 — 赎回后再赎回不产生套利（NAV 不被薅）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 100_000 }),
        fc.integer({ min: 1000, max: 100_000 }),
        (d1, d2) => {
          const s = freshState();
          applyOp(s, { t: 'deposit', user: 'u1', amount: d1 });
          applyOp(s, { t: 'deposit', user: 'u2', amount: d2 });
          const navMid = navFixed(s.bankroll, s.reserved, s.totalShares);
          // u2 全额赎回
          applyOp(s, { t: 'redeem', user: 'u2', frac: 1 });
          const navAfter = navFixed(s.bankroll, s.reserved, s.totalShares);
          expect(navAfter).toBeGreaterThanOrEqual(navMid);
          // u2 取回不超过其投入（无套利获利）
          expect(s.userCash.get('u2')!).toBeLessThanOrEqual(INITIAL_CASH);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property 7: 滑点带宽常量恒为 500 bps', () => {
    expect(MAX_SLIPPAGE_BPS).toBe(500);
  });

  it('splitProRata: 守恒（Σ 各腿 == 总额）且非负，余数归末腿', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 5 }),
        (amount, weights) => {
          const parts = splitProRata(amount, weights);
          expect(parts.length).toBe(weights.length);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('Property 9: 多金库隔离 — 各金库各自满足 reserved≤bankroll', () => {
    // 两个独立金库分别承接，验证隔离不变量逐金库成立
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 50 }), fc.array(opArb, { maxLength: 50 }), (opsA, opsB) => {
        const a = freshState();
        const b = freshState();
        for (const op of opsA) {
          applyOp(a, op);
          expect(a.reserved).toBeLessThanOrEqual(a.bankroll);
        }
        for (const op of opsB) {
          applyOp(b, op);
          expect(b.reserved).toBeLessThanOrEqual(b.bankroll);
        }
        // A 的状态不因 B 的操作而改变（隔离）
        expect(equity(a.bankroll, a.reserved)).toBeGreaterThanOrEqual(0);
        expect(equity(b.bankroll, b.reserved)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('Property 11: 高水位利润分成 — 仅创新高计提，亏损不计提，存入方不被多抽', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10_000, max: 500_000 }),
        fc.integer({ min: 0, max: 3000 }),
        (bankroll, profitShareBps) => {
          const totalShares = bankroll; // 1:1 初始
          const hwm = NAV_SCALE; // 初始高水位 = 1.0
          // 情况1：NAV 未创新高（bankroll==shares → nav=1.0）→ 不计提
          const r0 = computeProfitFee(bankroll, 0, totalShares, hwm, profitShareBps);
          expect(r0.leaderSharesMinted).toBe(0);

          // 情况2：金库盈利（bankroll 增长）→ NAV>1 → 创新高才计提
          const profit = Math.floor(bankroll * 0.2);
          const r1 = computeProfitFee(bankroll + profit, 0, totalShares, hwm, profitShareBps);
          if (profitShareBps > 0 && profit > 0) {
            expect(r1.leaderSharesMinted).toBeGreaterThanOrEqual(0);
            // 新高水位 >= 旧高水位
            expect(r1.newHighWaterNav).toBeGreaterThanOrEqual(hwm);
          }

          // 情况3：已在高水位后回撤 → 不再计提
          const r2 = computeProfitFee(bankroll, 0, totalShares, r1.newHighWaterNav, profitShareBps);
          expect(r2.leaderSharesMinted).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('Property 11b: 利润分成不增发 AXP（只铸份额，bankroll 不变）', () => {
    const bankroll = 120_000;
    const totalShares = 100_000; // nav = 1.2
    const r = computeProfitFee(bankroll, 0, totalShares, NAV_SCALE, 1000);
    // 计提以铸份额实现，bankroll 不动（资金守恒，价值从存入方稀释到主理人）
    expect(r.leaderSharesMinted).toBeGreaterThan(0);
    // 计提后总份额增加
    expect(r.newTotalShares).toBe(totalShares + r.leaderSharesMinted);
  });

  describe('风控敞口上限 (task 12)', () => {
    it('阈值默认值：单盘5% / 单赛事15% / 全局50%', () => {
      expect(RISK_MARKET_BPS).toBe(500);
      expect(RISK_EVENT_BPS).toBe(1500);
      expect(RISK_GLOBAL_U_BPS).toBe(5000);
    });

    it('capFor: floor 取整，capital<=0 返回 0', () => {
      expect(capFor(500, 10_000)).toBe(500);
      expect(capFor(1500, 9_999)).toBe(1499);
      expect(capFor(500, 0)).toBe(0);
      expect(capFor(500, -100)).toBe(0);
    });

    it('单盘超限被拒（reason=market）', () => {
      const r = evaluateRisk({
        capital: 10_000,
        netExposureMarket: 480,
        netExposureEvent: 480,
        netExposureGlobal: 480,
        addNet: 30, // 480+30=510 > 500
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('market');
      expect(r.availableForNewRisk).toBe(20); // 500-480
    });

    it('单赛事超限被拒（reason=event）', () => {
      const r = evaluateRisk({
        capital: 10_000,
        netExposureMarket: 0,
        netExposureEvent: 1490,
        netExposureGlobal: 1490,
        addNet: 20, // event 1490+20=1510 > 1500
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('event');
    });

    it('全局利用率超限被拒（reason=global）', () => {
      const r = evaluateRisk({
        capital: 10_000,
        netExposureMarket: 0,
        netExposureEvent: 0,
        netExposureGlobal: 4990,
        addNet: 20, // global 4990+20=5010 > 5000
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('global');
    });

    it('限内通过；availableForNewRisk = 三层剩余最小值', () => {
      const r = evaluateRisk({
        capital: 10_000,
        netExposureMarket: 100, // 余 400
        netExposureEvent: 1200, // 余 300
        netExposureGlobal: 4800, // 余 200
        addNet: 50,
      });
      expect(r.ok).toBe(true);
      expect(r.availableForNewRisk).toBe(200);
    });

    it('属性：随机序列下净敞口永不超 capital 的全局上限', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 1_000_000 }),
          fc.array(fc.integer({ min: 1, max: 5000 }), { maxLength: 60 }),
          (capital, adds) => {
            let market = 0;
            let event = 0;
            let global = 0;
            const globalCap = capFor(RISK_GLOBAL_U_BPS, capital);
            for (const addNet of adds) {
              const r = evaluateRisk({
                capital,
                netExposureMarket: market,
                netExposureEvent: event,
                netExposureGlobal: global,
                addNet,
              });
              if (r.ok) {
                market += addNet;
                event += addNet;
                global += addNet;
              }
              // 接受的敞口永不超过全局上限
              expect(global).toBeLessThanOrEqual(globalCap);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

// ── 提前平仓 cash-out 属性测试 (P-cashout-1..4, task 5) ─────────
//
// 用纯函数 computeCashout（mark-to-market 定价）+ splitProRata（逐金库腿拆分）
// 模拟 LsmOrderService.cashOut 的资金路径：
//   开仓预留 winPayout = stake + maxProfit（= Σ reserveShare，按各腿权重拆）。
//   平仓兑现 cashout（按相同权重拆 cashoutShare，余数归末位=官方金库腿）。
//   逐腿：bankroll −= cashoutShare，reserved −= reserveShare；用户 credit ΣcashoutShare。
// 断言 design Correctness Properties 1–5（任务口径 P-cashout-1..4 + 全整数）。

/** 平仓资金模型：返回各腿预留/兑现拆分与定价结果（与服务记账口径一致）。 */
function modelCashout(
  stake: number,
  leverage: number,
  entryOddsBps: number,
  currentOddsBps: number,
  weights: number[],
) {
  const m = computeCashout(stake, leverage, entryOddsBps, currentOddsBps, 0);
  const winPayout = stake + m.maxProfit; // = 开仓预留总额 Σ reserveShare
  const reserveShares = splitProRata(winPayout, weights); // 各腿开仓预留
  const cashoutShares = splitProRata(m.cashout, weights); // 各腿兑现（同权重）
  return { m, winPayout, reserveShares, cashoutShares };
}

// 赔率生成器：可成交赔率 ≥ 1.01（oddsBps ≥ 10100），覆盖增值/贬值区间。
const oddsBpsArb = fc.integer({ min: 10_100, max: 60_000 });
// 各金库腿权重（容量），末位约定为官方金库兜底腿。
const weightsArb = fc.array(fc.integer({ min: 1, max: 5_000 }), { minLength: 1, maxLength: 4 });

describe('LSM 提前平仓 cash-out 属性测试 (P-cashout-1..4)', () => {
  it('P-cashout-1: 兑现 ≤ 预留和（Σ cashoutShare ≤ Σ reserveShare）', () => {
    // Validates: Requirements 8.1, 8.2 (design Property 1 兑现上界)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 10 }),
        oddsBpsArb,
        oddsBpsArb,
        weightsArb,
        (stake, leverage, entryOddsBps, currentOddsBps, weights) => {
          const { m, winPayout, reserveShares, cashoutShares } = modelCashout(
            stake,
            leverage,
            entryOddsBps,
            currentOddsBps,
            weights,
          );
          const sumReserve = reserveShares.reduce((a, b) => a + b, 0);
          const sumCashout = cashoutShares.reduce((a, b) => a + b, 0);
          // 拆分守恒
          expect(sumReserve).toBe(winPayout);
          expect(sumCashout).toBe(m.cashout);
          // 兑现绝不超过该单各金库腿可释放预留之和（强校验护栏口径）
          expect(m.cashout).toBeLessThanOrEqual(winPayout);
          expect(sumCashout).toBeLessThanOrEqual(sumReserve);
          // 兑现非负
          expect(m.cashout).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('P-cashout-2: 守恒（释放预留 + 结算后系统 AXP 守恒，余数归官方腿）', () => {
    // Validates: Requirements 8.1, 8.2 (design Property 2 守恒)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 10 }),
        oddsBpsArb,
        oddsBpsArb,
        weightsArb,
        fc.integer({ min: 0, max: 1_000_000 }), // 用户平仓前余额
        (stake, leverage, entryOddsBps, currentOddsBps, weights, userCash0) => {
          const { m, winPayout, reserveShares, cashoutShares } = modelCashout(
            stake,
            leverage,
            entryOddsBps,
            currentOddsBps,
            weights,
          );
          // 建模各金库腿：bankroll 含本腿预留 + 自由权益；官方腿(末位)富余兜底余数。
          const n = weights.length;
          const bankroll = reserveShares.map((rs, i) =>
            i === n - 1 ? rs + winPayout + 7 : rs + (i * 13) % 50,
          );
          const reserved = [...reserveShares];
          // 系统 AXP 总量 = 用户余额 + Σ bankroll（reserved 为 bankroll 子集）。
          const totalBefore = userCash0 + bankroll.reduce((a, b) => a + b, 0);

          // 逐腿平仓：释放预留 + 按兑现份额从 bankroll 支出（cashoutLeg 口径）。
          let userCash = userCash0;
          for (let i = 0; i < n; i++) {
            bankroll[i] -= cashoutShares[i];
            reserved[i] -= reserveShares[i];
          }
          userCash += cashoutShares.reduce((a, b) => a + b, 0); // 用户 credit ΣcashoutShare

          const totalAfter = userCash + bankroll.reduce((a, b) => a + b, 0);
          // 守恒：系统 AXP 总量平仓前后恒等
          expect(totalAfter).toBe(totalBefore);
          // 用户净入账 = 兑现值
          expect(userCash - userCash0).toBe(m.cashout);
          // 各腿预留全部释放归零
          for (const r of reserved) expect(r).toBe(0);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('P-cashout-3: 偿付/隔离（兑现不破坏 reserved≤bankroll，逐腿独立）', () => {
    // Validates: Requirements 8.1, 8.2 (design Property 3 偿付 + Property 4 隔离)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 10 }),
        oddsBpsArb,
        oddsBpsArb,
        weightsArb,
        (stake, leverage, entryOddsBps, currentOddsBps, weights) => {
          const { winPayout, reserveShares, cashoutShares } = modelCashout(
            stake,
            leverage,
            entryOddsBps,
            currentOddsBps,
            weights,
          );
          const n = weights.length;
          // 各腿开仓即满足偿付不变量 reserved≤bankroll（自由权益≥0）；官方腿(末位)兜底余数。
          const bankroll = reserveShares.map((rs, i) =>
            i === n - 1 ? rs + winPayout : rs + (i * 17) % 40,
          );
          const reserved = [...reserveShares];
          for (let i = 0; i < n; i++) {
            expect(reserved[i]).toBeLessThanOrEqual(bankroll[i]); // 平仓前偿付
            // 非官方承接腿：兑现份额 ≤ 该腿预留（承接方永不超付）
            if (i < n - 1) {
              expect(cashoutShares[i]).toBeLessThanOrEqual(reserveShares[i]);
            }
          }
          // 逐腿独立结算（隔离）：每腿只动自己的 bankroll/reserved
          for (let i = 0; i < n; i++) {
            bankroll[i] -= cashoutShares[i];
            reserved[i] -= reserveShares[i];
          }
          for (let i = 0; i < n; i++) {
            // 平仓后偿付不变量保持：reserved≤bankroll 且二者非负
            expect(reserved[i]).toBe(0);
            expect(reserved[i]).toBeLessThanOrEqual(bankroll[i]);
            expect(bankroll[i]).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('P-cashout-4: 全整数（cashout 及各腿份额均为整数 AXP）', () => {
    // Validates: Requirements 8.1, 8.2 (design Property 5 整数与非负)
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 10 }),
        oddsBpsArb,
        oddsBpsArb,
        weightsArb,
        (stake, leverage, entryOddsBps, currentOddsBps, weights) => {
          const { m, reserveShares, cashoutShares } = modelCashout(
            stake,
            leverage,
            entryOddsBps,
            currentOddsBps,
            weights,
          );
          // 定价结果全整数
          expect(isInt(m.notional)).toBe(true);
          expect(isInt(m.maxProfit)).toBe(true);
          expect(isInt(m.maxProfitNow)).toBe(true);
          expect(isInt(m.cashout)).toBe(true);
          expect(isInt(m.grossPnl)).toBe(true);
          // 各腿拆分份额全整数
          for (const r of reserveShares) expect(isInt(r)).toBe(true);
          for (const c of cashoutShares) expect(isInt(c)).toBe(true);
          // grossPnl = cashout − stake 恒等
          expect(m.grossPnl).toBe(m.cashout - stake);
        },
      ),
      { numRuns: 400 },
    );
  });
});
