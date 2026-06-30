/**
 * Shared UI primitives + helpers for the LSM "Predict" web app
 * (polymarket.agentrix.top → /lsm/*).
 *
 * Visual language matches the Agentrix dark theme used across the main site
 * (slate-950/900 surfaces, slate-800 borders, white text, violet/indigo +
 * cyan accents, rounded-2xl cards) — see `components/layout/L1TopNav.tsx` and
 * `components/marketplace/MarketplaceLayout.tsx`. Content/layout is inspired by
 * Polymarket / kmarket-style prediction markets. Pure presentation here — no
 * data/API logic lives in this module.
 */
import { ReactNode } from 'react';
import type { LsmMarketView, LsmOddsOutcome, LsmAsset } from '../../services/lsm';
import { LSM_CHAIN_LIST, type LsmChainId } from '../../services/lsmChains';

/** Tiny classnames joiner (avoids a dep; mirrors clsx usage in the repo). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Outcome labelling + ordering (2-way moneyline or 1X2 with draw)
// ---------------------------------------------------------------------------

/** Full outcome label: home / away team name, or 平局 for the draw (idx 2). */
export function outcomeLabel(m: LsmMarketView, idx: number): string {
  if (idx === 0) return m.homeTeam;
  if (idx === 1) return m.awayTeam;
  return '平局';
}

/** Short 1X2-style tag: 主 / 平 / 客. */
export function outcomeShort(m: LsmMarketView, idx: number): string {
  if (m.outcomeCount >= 3) {
    if (idx === 0) return '主';
    if (idx === 2) return '平';
    return '客';
  }
  return idx === 0 ? '主' : '客';
}

/** Display order: classic 1X2 puts the draw in the middle (主 / 平 / 客). */
function outcomeRank(outcomeCount: number, idx: number): number {
  if (outcomeCount >= 3) return idx === 0 ? 0 : idx === 2 ? 1 : 2;
  return idx;
}

/** Odds sorted for display (draw centered for 1X2). */
export function orderedOdds(m: LsmMarketView): LsmOddsOutcome[] {
  return [...m.odds].sort(
    (a, b) => outcomeRank(m.outcomeCount, a.outcomeIdx) - outcomeRank(m.outcomeCount, b.outcomeIdx),
  );
}

/** Implied probability from decimal odds, as a rounded percent string. */
export function impliedPct(odds: number): string {
  if (!odds || odds <= 0) return '—';
  return `${Math.round((1 / odds) * 100)}%`;
}

/** Per-outcome accent (home cyan / draw violet / away amber) in slate theme. */
export function outcomeAccent(m: LsmMarketView, idx: number): {
  text: string;
  ring: string;
  bg: string;
  dot: string;
} {
  const draw = m.outcomeCount >= 3 && idx === 2;
  if (idx === 0)
    return { text: 'text-cyan-300', ring: 'ring-cyan-500/60', bg: 'bg-cyan-500', dot: 'bg-cyan-400' };
  if (draw)
    return { text: 'text-violet-300', ring: 'ring-violet-500/60', bg: 'bg-violet-500', dot: 'bg-violet-400' };
  return { text: 'text-amber-300', ring: 'ring-amber-500/60', bg: 'bg-amber-500', dot: 'bg-amber-400' };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format an integer-ish USDC amount with thousands separators. */
export function fmtUsdc(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Relative / clock label for a kickoff timestamp (ms). */
export function kickoffLabel(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = Date.now();
  const diff = ts - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 60) return diff >= 0 ? `${mins} 分钟后` : `${mins} 分钟前`;
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `今天 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// ---------------------------------------------------------------------------
// Status pills + live indicator
// ---------------------------------------------------------------------------

const STATUS_META: Record<string, { t: string; cls: string }> = {
  live: { t: '滚球', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
  pre: { t: '赛前', cls: 'bg-cyan-500/12 text-cyan-300 border-cyan-500/25' },
  suspended: { t: '暂停', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  final: { t: '完场', cls: 'bg-white/5 text-slate-400 border-slate-700' },
  voided: { t: '作废', cls: 'bg-white/5 text-slate-400 border-slate-700' },
};

/** Pulsing red dot used for live markets. */
export function LiveDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
    </span>
  );
}

export function StatusBadge({ m }: { m: LsmMarketView }) {
  const stale = m.stale && m.status === 'live';
  const meta = stale
    ? { t: '赔率过期', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }
    : STATUS_META[m.status] || STATUS_META.pre;
  const isLive = m.status === 'live' && !stale;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold',
        meta.cls,
      )}
    >
      {isLive && <LiveDot />}
      {meta.t}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Generic surfaces
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  hover,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-slate-800 bg-slate-900/80 shadow-lg shadow-black/20',
        hover && 'transition-all hover:border-violet-500/40 hover:shadow-violet-500/10',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  live,
  right,
}: {
  children: ReactNode;
  live?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-base font-bold text-white">
        {live && <LiveDot />}
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Shared dark input style for the LSM app. */
export const inputClass =
  'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500/40 transition-colors';

/**
 * AssetToggle — segmented AXP | USDC control for picking the settlement asset.
 *
 *  - `AXP`  = free play (软积分, 引流) — the default.
 *  - `USDC` = real on-chain settlement (testnet).
 *
 * Controlled component (value + onChange). Matches the Agentrix dark theme:
 * a slate-950 track with a violet/cyan active segment. `size="sm"` renders a
 * compact variant for headers; `size="md"` (default) fits in-panel.
 */
export function AssetToggle({
  value,
  onChange,
  size = 'md',
  className,
}: {
  value: LsmAsset;
  onChange: (next: LsmAsset) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sm = size === 'sm';
  const seg = (asset: LsmAsset) => {
    const on = value === asset;
    const usdc = asset === 'USDC';
    return (
      <button
        key={asset}
        type="button"
        aria-pressed={on}
        onClick={() => onChange(asset)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg font-bold transition-colors',
          sm ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
          on
            ? usdc
              ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/30'
              : 'bg-violet-600 text-white shadow-sm shadow-violet-500/30'
            : 'text-slate-400 hover:text-white',
        )}
      >
        <span
          className={cn(
            'grid place-items-center rounded-full font-black',
            sm ? 'h-3.5 w-3.5 text-[8px]' : 'h-4 w-4 text-[9px]',
            usdc ? 'bg-cyan-400 text-slate-950' : 'bg-violet-400 text-slate-950',
            on ? '' : 'opacity-70',
          )}
        >
          {usdc ? '$' : 'A'}
        </span>
        {asset}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="结算币种"
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-950',
        sm ? 'p-0.5' : 'p-1',
        className,
      )}
    >
      {seg('AXP')}
      {seg('USDC')}
    </div>
  );
}

/**
 * ChainSelector — segmented control for picking the USDC settlement chain.
 *
 * Multichain UX: the LSM backend settles USDC on two testnet chains
 * (Injective EVM testnet | BSC testnet). AXP (off-chain soft-points) is
 * unaffected by this selection — chain only matters for USDC. Controlled
 * component (value + onChange). Matches the Agentrix dark theme: a slate-950
 * track with a cyan active segment (USDC accent). `size="sm"` renders a
 * compact variant; `size="md"` (default) fits in-panel.
 */
export function ChainSelector({
  value,
  onChange,
  size = 'md',
  className,
}: {
  value: LsmChainId;
  onChange: (next: LsmChainId) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sm = size === 'sm';
  return (
    <div
      role="group"
      aria-label="结算链"
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-950',
        sm ? 'p-0.5' : 'p-1',
        className,
      )}
    >
      {LSM_CHAIN_LIST.map((chain) => {
        const on = value === chain.id;
        return (
          <button
            key={chain.id}
            type="button"
            aria-pressed={on}
            title={`${chain.name} · ${chain.nativeSymbol}`}
            onClick={() => onChange(chain.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg font-bold transition-colors',
              sm ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
              on
                ? 'bg-cyan-600 text-white shadow-sm shadow-cyan-500/30'
                : 'text-slate-400 hover:text-white',
            )}
          >
            <span
              className={cn(
                'grid place-items-center rounded-full bg-cyan-400 font-black text-slate-950',
                sm ? 'h-3.5 w-3.5 text-[8px]' : 'h-4 w-4 text-[9px]',
                on ? '' : 'opacity-70',
              )}
            >
              {chain.nativeSymbol.slice(0, 1)}
            </span>
            {chain.name}
          </button>
        );
      })}
    </div>
  );
}

/** Small AXP / USDC asset badge for list rows (orders, vaults). */
export function AssetBadge({ asset, className }: { asset: LsmAsset; className?: string }) {
  const usdc = asset === 'USDC';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold',
        usdc ? 'bg-cyan-500/20 text-cyan-300' : 'bg-violet-500/20 text-violet-300',
        className,
      )}
    >
      <span
        className={cn(
          'grid h-3 w-3 place-items-center rounded-full text-[8px] font-black text-slate-950',
          usdc ? 'bg-cyan-400' : 'bg-violet-400',
        )}
      >
        {usdc ? '$' : 'A'}
      </span>
      {asset}
    </span>
  );
}
