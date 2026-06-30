import { evaluateRisk, capFor, DEFAULT_RISK_CONFIG } from './lsm.risk-math';

/**
 * task 12 验证：单盘 5% / 单赛事 15% / 全局 50% 三层敞口上限（基数=金库风险资本 C）。
 */
describe('lsm.risk-math evaluateRisk (task 12 三层敞口上限)', () => {
  const cfg = DEFAULT_RISK_CONFIG; // market 500 / event 1500 / global 5000 bps

  it('capFor 按 bps×capital/10000 floor，capital<=0 为 0', () => {
    expect(capFor(500, 100000)).toBe(5000); // 5%
    expect(capFor(1500, 100000)).toBe(15000); // 15%
    expect(capFor(5000, 100000)).toBe(50000); // 50%
    expect(capFor(500, 0)).toBe(0);
    expect(capFor(500, -10)).toBe(0);
  });

  it('单盘上限：超过 5% 被拒（reason=market）', () => {
    const capital = 100000; // marketCap=5000
    const ok = evaluateRisk(
      { capital, netExposureMarket: 4000, netExposureEvent: 4000, netExposureGlobal: 4000, addNet: 1000 },
      cfg,
    );
    expect(ok.ok).toBe(true);
    const bad = evaluateRisk(
      { capital, netExposureMarket: 4000, netExposureEvent: 4000, netExposureGlobal: 4000, addNet: 1001 },
      cfg,
    );
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe('market');
  });

  it('单赛事上限：单盘未破但赛事聚合破 15%（reason=event）', () => {
    const capital = 100000; // eventCap=15000, marketCap=5000
    const r = evaluateRisk(
      {
        capital,
        netExposureMarket: 0, // 本盘未破
        netExposureEvent: 14600,
        netExposureGlobal: 14600,
        addNet: 500, // 单盘 OK(<=5000)，赛事 14600+500=15100>15000
      },
      cfg,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('event');
  });

  it('全局利用率上限：单盘/赛事 OK 但全局破 50%（reason=global）', () => {
    const capital = 100000; // globalCap=50000
    const r = evaluateRisk(
      {
        capital,
        netExposureMarket: 0,
        netExposureEvent: 0,
        netExposureGlobal: 49900,
        addNet: 200, // 全局 49900+200=50100>50000
      },
      cfg,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('global');
  });

  it('availableForNewRisk = 三层剩余额度取最小且≥0', () => {
    const capital = 100000; // market5000/event15000/global50000
    const r = evaluateRisk(
      { capital, netExposureMarket: 4800, netExposureEvent: 1000, netExposureGlobal: 1000, addNet: 0 },
      cfg,
    );
    // marketAvail=200, eventAvail=14000, globalAvail=49000 → min=200
    expect(r.availableForNewRisk).toBe(200);
  });

  it('addNet<=0（纯减仓/输赢释放）始终放行', () => {
    const r = evaluateRisk(
      { capital: 1000, netExposureMarket: 999, netExposureEvent: 999, netExposureGlobal: 999, addNet: 0 },
      cfg,
    );
    expect(r.ok).toBe(true);
  });

  it('capital<=0（金库无风险资本）任何新增净敞口被拒', () => {
    const r = evaluateRisk(
      { capital: 0, netExposureMarket: 0, netExposureEvent: 0, netExposureGlobal: 0, addNet: 1 },
      cfg,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('market');
  });
});
