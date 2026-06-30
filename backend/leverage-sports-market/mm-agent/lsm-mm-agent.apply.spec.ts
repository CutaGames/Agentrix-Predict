/**
 * LSM MM agent — live apply path (Req 28 · LSM_MM_AGENT_APPLY).
 * Verifies runOnce() writes decisions back to a user vault's existing enabled
 * subscriptions (capacity split + fee bid), halts by zeroing/disabling, and
 * no-ops when there are no subscriptions (e.g. protocol vault).
 */
import { LsmMmAgentService } from './lsm-mm-agent.service';

function makeAgent(vaultRows: any[], subs: any[]) {
  const vaults = { listVaults: jest.fn().mockResolvedValue(vaultRows) } as any;
  const upserts: any[] = [];
  const underwriting = {
    listSubscriptions: jest.fn().mockResolvedValue(subs),
    upsertSubscription: jest.fn(async (x: any) => { upserts.push(x); return x; }),
  } as any;
  const svc = new LsmMmAgentService(vaults, underwriting);
  return { svc, upserts, underwriting };
}

const userVault = (over: any = {}) => ({
  id: 'v-user', kind: 'user', asset: 'USDC', status: 'active',
  bankroll: 1_000_000, reserved: 0, nav: 1, utilizationBps: 0, ...over,
});

describe('LsmMmAgentService apply (Req 28)', () => {
  const OLD = process.env.LSM_MM_AGENT_APPLY;
  afterEach(() => { process.env.LSM_MM_AGENT_APPLY = OLD; });

  it('observe-only by default: no upserts when LSM_MM_AGENT_APPLY!=1', async () => {
    delete process.env.LSM_MM_AGENT_APPLY;
    const { svc, underwriting } = makeAgent([userVault()], [
      { scopeType: 'market', scopeValue: 'm1', enabled: true },
    ]);
    await svc.runOnce();
    expect(underwriting.upsertSubscription).not.toHaveBeenCalled();
  });

  it('expand: splits capacity across enabled subs + sets fee bid, enabled=true', async () => {
    process.env.LSM_MM_AGENT_APPLY = '1';
    const { svc, upserts } = makeAgent([userVault({ utilizationBps: 0, reserved: 0 })], [
      { scopeType: 'market', scopeValue: 'm1', enabled: true },
      { scopeType: 'league', scopeValue: 'EPL', enabled: true },
    ]);
    await svc.runOnce();
    expect(upserts).toHaveLength(2);
    // free=1_000_000, capCeiling=50% → 500_000, split across 2 subs → 250_000 each
    expect(upserts[0].capacity).toBe(250_000);
    expect(upserts.every((u) => u.enabled === true)).toBe(true);
    expect(upserts.every((u) => u.feeBidBps >= 0 && u.feeBidBps <= 2000)).toBe(true);
  });

  it('halt (insolvent): capacity 0 + disabled', async () => {
    process.env.LSM_MM_AGENT_APPLY = '1';
    const { svc, upserts } = makeAgent([userVault({ bankroll: 100, reserved: 200 })], [
      { scopeType: 'market', scopeValue: 'm1', enabled: true },
    ]);
    await svc.runOnce();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].capacity).toBe(0);
    expect(upserts[0].enabled).toBe(false);
  });

  it('no subscriptions (protocol vault) → no-op', async () => {
    process.env.LSM_MM_AGENT_APPLY = '1';
    const { svc, underwriting } = makeAgent(
      [{ id: 'v-proto', kind: 'protocol', asset: 'USDC', status: 'active', bankroll: 1e8, reserved: 0, nav: 1, utilizationBps: 0 }],
      [],
    );
    await svc.runOnce();
    expect(underwriting.upsertSubscription).not.toHaveBeenCalled();
  });
});
