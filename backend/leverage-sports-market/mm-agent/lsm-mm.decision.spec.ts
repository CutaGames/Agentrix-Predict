/**
 * LSM AI market-making decision engine — unit tests (Req 28 / Property G5).
 * Asserts: utilization band drives expand/derisk/hold; capacity never exceeds
 * free equity; insolvent or non-active vaults always halt; fee bid stays in band.
 */
import { decideMmAction, DEFAULT_MM_CONFIG, MmVaultSnapshot } from './lsm-mm.decision';

const base = (over: Partial<MmVaultSnapshot> = {}): MmVaultSnapshot => ({
  vaultId: 'v1',
  kind: 'protocol',
  asset: 'USDC',
  bankroll: 1_000_000,
  reserved: 500_000,
  nav: 1,
  utilizationBps: 5000,
  status: 'active',
  ...over,
});

describe('decideMmAction (Req 28 / Property G5)', () => {
  it('expands when under-utilized (tighten overround, offer capacity)', () => {
    const d = decideMmAction(base({ utilizationBps: 1000, reserved: 100_000 }));
    expect(d.action).toBe('expand');
    expect(d.feeBidBps).toBe(DEFAULT_MM_CONFIG.minFeeBidBps);
    expect(d.capacity).toBeGreaterThan(0);
  });

  it('de-risks when over-utilized (widen overround, shrink capacity)', () => {
    const d = decideMmAction(base({ utilizationBps: 9000, reserved: 900_000 }));
    expect(d.action).toBe('derisk');
    expect(d.feeBidBps).toBe(DEFAULT_MM_CONFIG.maxFeeBidBps);
  });

  it('holds within the target band', () => {
    const d = decideMmAction(base({ utilizationBps: 5000 }));
    expect(d.action).toBe('hold');
  });

  it('capacity never exceeds free equity (solvency-safe)', () => {
    for (const util of [0, 1000, 3000, 5000, 7000, 9000, 9999]) {
      const bankroll = 1_000_000;
      const reserved = Math.floor((bankroll * util) / 10000);
      const d = decideMmAction(base({ utilizationBps: util, bankroll, reserved }));
      expect(d.capacity).toBeLessThanOrEqual(bankroll - reserved);
      expect(d.capacity).toBeGreaterThanOrEqual(0);
      expect(d.feeBidBps).toBeGreaterThanOrEqual(DEFAULT_MM_CONFIG.minFeeBidBps);
      expect(d.feeBidBps).toBeLessThanOrEqual(DEFAULT_MM_CONFIG.maxFeeBidBps);
    }
  });

  it('halts when insolvent (bankroll < reserved) — never underwrites', () => {
    const d = decideMmAction(base({ bankroll: 100, reserved: 200 }));
    expect(d.action).toBe('halt');
    expect(d.capacity).toBe(0);
    expect(d.solvent).toBe(false);
  });

  it('halts when vault not active', () => {
    const d = decideMmAction(base({ status: 'closing' }));
    expect(d.action).toBe('halt');
    expect(d.capacity).toBe(0);
  });
});
