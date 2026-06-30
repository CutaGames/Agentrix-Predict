/**
 * LsmMmAgentService — AI market-making vault agent (LSM Phase G · Req 28, HLP范式).
 *
 * Periodically reads active USDC vaults and runs the pure decision engine
 * (`decideMmAction`) to produce market-making adjustments (capacity / overround)
 * within risk + solvency guardrails. Decisions are recorded in a ring buffer for
 * the observability view (`getRecentDecisions`) and logged.
 *
 * Safety:
 *  - Gated by `LSM_MM_AGENT_ENABLED=1` (default OFF — no loop, zero impact).
 *  - **Observe-only by default**: it only computes + records decisions. Actually
 *    applying them to underwriting subscriptions requires `LSM_MM_AGENT_APPLY=1`
 *    AND is still solvency-clamped by the decision engine. Testnet only.
 *  - The decision engine never proposes capacity beyond free equity, so the
 *    bankroll ≥ reserved invariant is preserved (Property G5).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LsmVaultService } from '../lsm-vault.service';
import { LsmUnderwritingService } from '../lsm-underwriting.service';
import {
  DEFAULT_MM_CONFIG,
  decideMmAction,
  MmDecision,
  MmVaultSnapshot,
} from './lsm-mm.decision';

interface RecordedDecision extends MmDecision {
  ts: number;
  utilizationBps: number;
  bankroll: number;
  reserved: number;
  applied: boolean;
}

@Injectable()
export class LsmMmAgentService {
  private readonly logger = new Logger(LsmMmAgentService.name);
  private readonly recent: RecordedDecision[] = [];
  private readonly RING = 200;

  constructor(
    private readonly vaults: LsmVaultService,
    private readonly underwriting: LsmUnderwritingService,
  ) {}

  private get enabled(): boolean {
    return process.env.LSM_MM_AGENT_ENABLED === '1';
  }
  private get apply(): boolean {
    return process.env.LSM_MM_AGENT_APPLY === '1';
  }
  private get intervalMs(): number {
    const n = Number(process.env.LSM_MM_AGENT_INTERVAL_MS || 60000);
    return Number.isFinite(n) && n >= 10000 ? n : 60000;
  }

  /** Recent MM decisions for the observability view (newest last). */
  getRecentDecisions(limit = 50): RecordedDecision[] {
    return this.recent.slice(-Math.max(1, Math.min(limit, this.RING)));
  }

  // Fixed 60s cadence; the loop early-returns unless explicitly enabled.
  @Interval('lsm-mm-agent', 60000)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.runOnce();
    } catch (e: any) {
      this.logger.warn(`MM agent tick failed: ${e?.message}`);
    }
  }

  /** One market-making pass over active USDC vaults. Returns the decisions made. */
  async runOnce(): Promise<MmDecision[]> {
    // USDC vaults only — AI market-making operates on real on-chain value (testnet).
    const list: any[] = await this.vaults.listVaults(undefined, 'USDC').catch(() => []);
    const decisions: MmDecision[] = [];
    for (const v of list) {
      if (v.status !== 'active') continue;
      const snap: MmVaultSnapshot = {
        vaultId: v.id,
        kind: v.kind,
        asset: v.asset || 'USDC',
        bankroll: Number(v.bankroll) || 0,
        reserved: Number(v.reserved) || 0,
        nav: Number(v.nav) || 0,
        utilizationBps: Number(v.utilizationBps) || 0,
        status: v.status,
      };
      const decision = decideMmAction(snap, DEFAULT_MM_CONFIG);
      decisions.push(decision);
      let applied = false;
      // Applying to live underwriting (LSM_MM_AGENT_APPLY=1): tune the vault's
      // EXISTING enabled subscriptions only (user vaults; protocol vault has
      // none → no-op). Solvency is double-guarded: the decision caps
      // capacity ≤ free equity, and LsmRiskService re-checks每 leg at order time.
      if (this.apply) {
        applied = await this.applyDecision(decision).catch((e) => {
          this.logger.warn(`[mm] apply error vault=${decision.vaultId}: ${e?.message}`);
          return false;
        });
      }
      this.record(decision, snap, applied);
      this.logger.debug(
        `[mm] vault=${decision.vaultId} ${decision.action} cap=${decision.capacity} fee=${decision.feeBidBps}bps applied=${applied} :: ${decision.reason}`,
      );
    }
    return decisions;
  }

  /**
   * Apply a decision to the vault's existing enabled underwriting subscriptions.
   * Distributes the (solvency-capped) capacity across enabled subscriptions and
   * sets the fee bid (overround). `halt` → capacity 0 + disable (stop承接).
   * Returns true if at least one subscription was updated.
   */
  private async applyDecision(d: MmDecision): Promise<boolean> {
    const subs: any[] = await this.underwriting.listSubscriptions(d.vaultId).catch(() => []);
    const enabled = subs.filter((s) => s.enabled || d.action === 'halt');
    if (enabled.length === 0) return false; // protocol vault / no subscriptions → nothing to tune
    const isHalt = d.action === 'halt';
    const perMarketCap = isHalt ? 0 : Math.floor(d.capacity / enabled.length);
    const feeBid = Math.max(0, Math.min(2000, d.feeBidBps));
    let applied = false;
    for (const s of enabled) {
      try {
        await this.underwriting.upsertSubscription({
          vaultId: d.vaultId,
          scopeType: s.scopeType,
          scopeValue: s.scopeValue,
          capacity: perMarketCap,
          feeBidBps: feeBid,
          enabled: !isHalt,
        });
        applied = true;
      } catch (e: any) {
        this.logger.warn(`[mm] upsert failed vault=${d.vaultId} scope=${s.scopeValue}: ${e?.message}`);
      }
    }
    return applied;
  }

  private record(d: MmDecision, snap: MmVaultSnapshot, applied: boolean): void {
    this.recent.push({
      ...d,
      ts: Date.now(),
      utilizationBps: snap.utilizationBps,
      bankroll: snap.bankroll,
      reserved: snap.reserved,
      applied,
    });
    if (this.recent.length > this.RING) this.recent.splice(0, this.recent.length - this.RING);
  }
}
