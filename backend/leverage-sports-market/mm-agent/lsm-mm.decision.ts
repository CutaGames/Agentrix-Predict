/**
 * LSM AI market-making decision engine (LSM Phase G · Req 28, HLP-style).
 *
 * Pure, side-effect-free policy: given a vault snapshot + config, decide how the
 * AI market-maker should adjust the vault's underwriting stance — target
 * utilization band drives capacity up/down and the fee bid (overround) — while
 * NEVER violating the solvency invariant (bankroll ≥ reserved) and always
 * clamping within risk limits. Being pure makes it unit-testable and lets the
 * scheduler run it in observe-only (dry-run) mode safely (Property G5).
 */

export interface MmVaultSnapshot {
  vaultId: string;
  kind: 'protocol' | 'user';
  asset: string; // 'USDC' | 'AXP'
  bankroll: number; // integer minor units
  reserved: number; // integer minor units
  nav: number;
  utilizationBps: number; // reserved/bankroll in bps (0..10000)
  status: 'active' | 'closing' | 'closed';
}

export interface MmConfig {
  /** Target utilization band (bps). Below low → expand; above high → de-risk. */
  targetLowBps: number; // e.g. 3000 (30%)
  targetHighBps: number; // e.g. 7000 (70%)
  /** Max fraction of free equity to offer as new underwriting capacity (bps). */
  maxCapacityOfFreeBps: number; // e.g. 5000 (50%)
  /** Fee bid (overround) band in bps applied to attract/repel flow. */
  minFeeBidBps: number; // e.g. 100 (1%)
  maxFeeBidBps: number; // e.g. 2000 (20%)
}

export const DEFAULT_MM_CONFIG: MmConfig = {
  targetLowBps: 3000,
  targetHighBps: 7000,
  maxCapacityOfFreeBps: 5000,
  minFeeBidBps: 100,
  maxFeeBidBps: 2000,
};

export type MmAction = 'expand' | 'derisk' | 'hold' | 'halt';

export interface MmDecision {
  vaultId: string;
  action: MmAction;
  /** Suggested new underwriting capacity (integer minor units). */
  capacity: number;
  /** Suggested fee bid / overround (bps). Lower attracts flow, higher repels. */
  feeBidBps: number;
  reason: string;
  /** Always true here — the engine refuses any solvency-violating suggestion. */
  solvent: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Decide the market-making adjustment for one vault.
 * Guarantees: `capacity ≤ freeEquity` (never reserves beyond what's free → never
 * breaks bankroll≥reserved), `feeBid ∈ [min,max]`, and `halt` when not solvent
 * or not active.
 */
export function decideMmAction(snap: MmVaultSnapshot, cfg: MmConfig = DEFAULT_MM_CONFIG): MmDecision {
  const free = Math.max(0, snap.bankroll - snap.reserved);
  const solvent = snap.bankroll >= snap.reserved;

  // Hard stops: insolvent (should never happen) or non-active vault → halt MM.
  if (!solvent || snap.status !== 'active') {
    return {
      vaultId: snap.vaultId,
      action: 'halt',
      capacity: 0,
      feeBidBps: cfg.maxFeeBidBps,
      reason: !solvent ? 'insolvent: bankroll < reserved (halt underwriting)' : `vault ${snap.status} (halt)`,
      solvent,
    };
  }

  const util = snap.utilizationBps;
  const capCeiling = Math.floor((free * cfg.maxCapacityOfFreeBps) / 10000);

  let action: MmAction;
  let capacity: number;
  let feeBidBps: number;
  let reason: string;

  if (util > cfg.targetHighBps) {
    // Over-utilized → de-risk: shrink offered capacity, widen overround to repel flow.
    action = 'derisk';
    capacity = Math.floor(capCeiling * 0.3);
    feeBidBps = cfg.maxFeeBidBps;
    reason = `utilization ${(util / 100).toFixed(1)}% > target ${(cfg.targetHighBps / 100).toFixed(0)}% — shrink capacity, widen overround`;
  } else if (util < cfg.targetLowBps) {
    // Under-utilized → expand: offer more capacity, tighten overround to attract flow.
    action = 'expand';
    capacity = capCeiling;
    feeBidBps = cfg.minFeeBidBps;
    reason = `utilization ${(util / 100).toFixed(1)}% < target ${(cfg.targetLowBps / 100).toFixed(0)}% — expand capacity, tighten overround`;
  } else {
    // In band → hold steady with a mid overround.
    action = 'hold';
    capacity = Math.floor(capCeiling * 0.6);
    feeBidBps = Math.floor((cfg.minFeeBidBps + cfg.maxFeeBidBps) / 2);
    reason = `utilization ${(util / 100).toFixed(1)}% within target band — hold`;
  }

  // Final invariant clamps: capacity can never exceed free equity (solvency-safe).
  capacity = clamp(capacity, 0, free);
  feeBidBps = clamp(feeBidBps, cfg.minFeeBidBps, cfg.maxFeeBidBps);

  return { vaultId: snap.vaultId, action, capacity, feeBidBps, reason, solvent: true };
}
