import {
  MAX_SLIPPAGE_BPS,
  BPS_DENOM,
  oddsToBps,
  bpsToOdds,
  applyEdge,
  dynamicEdgeBps,
  slippageBand,
  withinSlippage,
  computeBet,
  computeCashout,
} from './lsm.pricing';

describe('LSM pricing — 货币数学正确性', () => {
  describe('oddsToBps / bpsToOdds', () => {
    it('round-trips common odds', () => {
      expect(oddsToBps(1.92)).toBe(19200);
      expect(oddsToBps(2.0)).toBe(20000);
      expect(bpsToOdds(19200)).toBeCloseTo(1.92, 4);
    });
  });

  describe('applyEdge', () => {
    it('压缩净盈利倍率，返还本金不变，结果 >= 1.0', () => {
      const fair = oddsToBps(2.0); // 20000, netProfit=10000
      const tradable = applyEdge(fair, 500); // 5% edge
      // shrunk = floor(10000 * 9500 / 10000) = 9500 → 19500 = 1.95
      expect(tradable).toBe(19500);
      expect(tradable).toBeGreaterThanOrEqual(BPS_DENOM);
    });

    it('edge 越大成交赔率越低（对庄家更有利）', () => {
      const fair = oddsToBps(2.5);
      expect(applyEdge(fair, 600)).toBeLessThan(applyEdge(fair, 300));
    });

    it('赔率 <= 1 时夹到 1.0', () => {
      expect(applyEdge(9000, 500)).toBe(BPS_DENOM);
    });

    it('floor 取整：永不高估用户赔率', () => {
      const fair = oddsToBps(1.333); // 13330, net=3330
      const tradable = applyEdge(fair, 500);
      // floor(3330*9500/10000)=floor(3163.5)=3163 → 13163
      expect(tradable).toBe(13163);
    });
  });

  describe('dynamicEdgeBps', () => {
    it('利用率为 0 时等于基础 edge', () => {
      expect(dynamicEdgeBps(500, 0)).toBe(500);
    });
    it('利用率升高时 edge 增加', () => {
      expect(dynamicEdgeBps(500, 5000)).toBeGreaterThan(500);
    });
    it('封顶 maxEdgeBps', () => {
      expect(dynamicEdgeBps(500, 10000, 2000, 1200)).toBe(1200);
    });
  });

  describe('slippageBand / withinSlippage', () => {
    it('带宽固定 ±5% (MAX_SLIPPAGE_BPS=500)', () => {
      expect(MAX_SLIPPAGE_BPS).toBe(500);
      const { minBps, maxBps } = slippageBand(20000);
      expect(minBps).toBe(19000); // floor(20000*9500/10000)
      expect(maxBps).toBe(21000); // ceil(20000*10500/10000)
    });

    it('成交赔率在带内通过，带外拒绝', () => {
      expect(withinSlippage(20000, 19500)).toBe(true);
      expect(withinSlippage(20000, 21000)).toBe(true);
      expect(withinSlippage(20000, 18999)).toBe(false);
      expect(withinSlippage(20000, 21001)).toBe(false);
    });
  });

  describe('computeBet — 杠杆固定赔率全整数', () => {
    it('基础口径：stake 100 × 杠杆 5 @ 1.95', () => {
      const m = computeBet(100, 5, 19500);
      expect(m.notional).toBe(500);
      // maxProfit = floor(500 * 9500 / 10000) = floor(475) = 475
      expect(m.maxProfit).toBe(475);
      expect(m.maxLoss).toBe(100);
      expect(m.reserve).toBe(475);
      expect(m.winPayout).toBe(575);
    });

    it('结果恒为整数（无浮点泄漏）', () => {
      const m = computeBet(333, 7, 13163);
      expect(Number.isInteger(m.notional)).toBe(true);
      expect(Number.isInteger(m.maxProfit)).toBe(true);
      expect(Number.isInteger(m.maxLoss)).toBe(true);
      expect(Number.isInteger(m.reserve)).toBe(true);
      expect(Number.isInteger(m.winPayout)).toBe(true);
    });

    it('maxProfit 向下取整（庄家保守，不高估用户盈利）', () => {
      // notional=7*333=2331, net=3163 → floor(2331*3163/10000)=floor(737.3...)=737
      const m = computeBet(333, 7, 13163);
      expect(m.maxProfit).toBe(737);
      expect(m.winPayout).toBe(333 + 737);
    });

    it('守恒：winPayout = stake + maxProfit；reserve = maxProfit', () => {
      for (const [s, l, o] of [
        [100, 1, 25000],
        [50, 10, 18000],
        [1, 3, 30000],
        [9999, 2, 11111],
      ] as Array<[number, number, number]>) {
        const m = computeBet(s, l, o);
        expect(m.winPayout).toBe(m.maxLoss + m.maxProfit);
        expect(m.reserve).toBe(m.maxProfit);
        expect(m.notional).toBe(s * l);
      }
    });

    it('非法输入抛错', () => {
      expect(() => computeBet(0, 1, 20000)).toThrow();
      expect(() => computeBet(100.5, 1, 20000)).toThrow();
      expect(() => computeBet(100, 0, 20000)).toThrow();
      expect(() => computeBet(100, 1, 9999)).toThrow();
    });
  });

  describe('computeCashout — 平仓 mark-to-market 全整数', () => {
    // 基准单：stake 100 × 杠杆 5 @ 入场 1.95（19500）。
    // notional=500, maxProfit=floor(500*9500/10000)=475, winPayout 上界=575。
    it('赔率不变（o_c=o_e）→ 兑现回本金（pnl=0）', () => {
      const m = computeCashout(100, 5, 19500, 19500);
      expect(m.notional).toBe(500);
      expect(m.maxProfit).toBe(475);
      expect(m.maxProfitNow).toBe(0);
      expect(m.cashout).toBe(100);
      expect(m.grossPnl).toBe(0);
    });

    it('o_c 下跌（持仓增值）→ 兑现 > 本金', () => {
      // o_c=1.50(15000): maxProfitNow=floor(500*(19500-15000)/15000)=floor(150)=150
      const m = computeCashout(100, 5, 19500, 15000);
      expect(m.maxProfitNow).toBe(150);
      expect(m.cashout).toBe(250);
      expect(m.grossPnl).toBe(150);
    });

    it('o_c 上涨（持仓贬值）→ 兑现 < 本金，可触及 0 下界', () => {
      // o_c=3.00(30000): maxProfitNow=floor(500*(19500-30000)/30000)=floor(-175)=-175
      const m = computeCashout(100, 5, 19500, 30000);
      expect(m.maxProfitNow).toBe(-175);
      expect(m.cashout).toBe(0); // clamp(100-175,0,575)=0
      expect(m.grossPnl).toBe(-100);
    });

    it('上界封顶：兑现绝不超过 winPayout = stake + maxProfit', () => {
      // o_c→1.01(10100): maxProfitNow=floor(500*(19500-10100)/10100)=floor(465.3)=465
      const m = computeCashout(100, 5, 19500, 10100);
      expect(m.maxProfitNow).toBe(465);
      expect(m.cashout).toBe(565); // < 575 上界
      expect(m.cashout).toBeLessThanOrEqual(100 + m.maxProfit);
    });

    it('o_c=1.0（10000）→ maxProfitNow 恰等于 maxProfit，兑现达上界 winPayout', () => {
      const m = computeCashout(100, 5, 19500, 10000);
      expect(m.maxProfitNow).toBe(m.maxProfit); // 475
      expect(m.cashout).toBe(575); // = stake + maxProfit
    });

    it('floor 向下取整（负向向 −∞，对金库保守）', () => {
      // stake=333,L=7 @ 1.95(19500): notional=2331
      // o_c=2.00(20000): maxProfitNow=floor(2331*(19500-20000)/20000)=floor(-58.275)=-59
      const m = computeCashout(333, 7, 19500, 20000);
      expect(m.maxProfitNow).toBe(-59);
      expect(Number.isInteger(m.cashout)).toBe(true);
      expect(Number.isInteger(m.maxProfitNow)).toBe(true);
    });

    it('结果恒为整数且 cashout ≥ 0', () => {
      for (const [s, l, oe, oc] of [
        [100, 1, 25000, 18000],
        [50, 10, 18000, 30000],
        [1, 3, 30000, 12000],
        [9999, 2, 11111, 40000],
      ] as Array<[number, number, number, number]>) {
        const m = computeCashout(s, l, oe, oc);
        expect(Number.isInteger(m.cashout)).toBe(true);
        expect(Number.isInteger(m.maxProfitNow)).toBe(true);
        expect(m.cashout).toBeGreaterThanOrEqual(0);
        expect(m.cashout).toBeLessThanOrEqual(s + m.maxProfit);
      }
    });

    it('退出 edge（cashoutEdgeBps>0）仅收缩正向盈利，不加税亏损', () => {
      // 增值场景：o_c=15000 → maxProfitNow=150；edge 1000bps → floor(150*9000/10000)=135
      const gain = computeCashout(100, 5, 19500, 15000, 1000);
      expect(gain.maxProfitNow).toBe(135);
      expect(gain.cashout).toBe(235);
      // 贬值场景：maxProfitNow<0 不受 edge 影响
      const loss = computeCashout(100, 5, 19500, 30000, 1000);
      expect(loss.maxProfitNow).toBe(-175);
      expect(loss.cashout).toBe(0);
    });

    it('默认 edge=0 不抽（与不传等价）', () => {
      const a = computeCashout(100, 5, 19500, 15000);
      const b = computeCashout(100, 5, 19500, 15000, 0);
      expect(a.cashout).toBe(b.cashout);
    });

    it('非法输入抛错', () => {
      expect(() => computeCashout(0, 1, 20000, 20000)).toThrow();
      expect(() => computeCashout(100.5, 1, 20000, 20000)).toThrow();
      expect(() => computeCashout(100, 0, 20000, 20000)).toThrow();
      expect(() => computeCashout(100, 1, 9999, 20000)).toThrow();
      expect(() => computeCashout(100, 1, 20000, 9999)).toThrow();
    });
  });
});
