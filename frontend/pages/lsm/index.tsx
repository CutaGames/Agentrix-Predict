/**
 * /lsm — live + upcoming + recent markets (polymarket.agentrix.top home).
 * Anonymous-viewable. Polymarket/kmarket-style responsive grid of market cards;
 * clicking an outcome opens the market detail / order page. Auto-refreshes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import {
  Card,
  StatusBadge,
  cn,
  orderedOdds,
  outcomeLabel,
  outcomeShort,
  outcomeAccent,
  impliedPct,
  kickoffLabel,
} from '../../components/lsm/ui';
import { lsm, type LsmMarketView } from '../../services/lsm';

type Filter = 'live' | 'pre' | 'recent';

const FILTERS: Array<{ key: Filter; label: string; live?: boolean }> = [
  { key: 'live', label: '进行中', live: true },
  { key: 'pre', label: '即将开始' },
  { key: 'recent', label: '已结束' },
];

function MarketCard({ m }: { m: LsmMarketView }) {
  const odds = orderedOdds(m);
  const ko = kickoffLabel(m.kickoffAt);
  const isLive = m.status === 'live';
  const showScore = m.homeScore != null || m.awayScore != null;

  return (
    <Card hover className="flex flex-col p-5">
      {/* Header: sport/league tag + status */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate rounded-md bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
            {m.league || m.sport || '赛事'}
          </span>
          {ko && <span className="shrink-0 text-[11px] text-slate-500">{ko}</span>}
        </div>
        <StatusBadge m={m} />
      </div>

      {/* Teams + score */}
      <Link href={`/lsm/market/${m.id}`} className="group mb-4 block">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-base font-bold text-white group-hover:text-violet-300">
            {m.homeTeam}
          </span>
          {showScore ? (
            <span className="shrink-0 rounded-lg bg-slate-800 px-2 py-0.5 text-sm font-extrabold text-cyan-300">
              {m.homeScore ?? 0} : {m.awayScore ?? 0}
            </span>
          ) : (
            <span className="shrink-0 text-xs font-semibold text-slate-600">vs</span>
          )}
          <span className="truncate text-right text-base font-bold text-white group-hover:text-violet-300">
            {m.awayTeam}
          </span>
        </div>
      </Link>

      {/* 1X2 / 2-way outcome buttons: odds + implied % */}
      <div
        className="mt-auto grid gap-2"
        style={{ gridTemplateColumns: `repeat(${odds.length}, minmax(0, 1fr))` }}
      >
        {odds.map((o) => {
          const acc = outcomeAccent(m, o.outcomeIdx);
          return (
            <Link
              key={o.outcomeIdx}
              href={`/lsm/market/${m.id}?o=${o.outcomeIdx}`}
              className="rounded-xl border border-slate-800 bg-slate-950 px-2 py-2.5 text-center transition-colors hover:border-violet-500/50 hover:bg-slate-800/60"
            >
              <div className="flex items-center justify-center gap-1 text-[11px] text-slate-400">
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', acc.dot)} />
                <span className="truncate">{outcomeShort(m, o.outcomeIdx)}</span>
              </div>
              <div className={cn('text-lg font-extrabold', acc.text)}>{o.fairOdds.toFixed(2)}</div>
              <div className="text-[10px] text-slate-500">{impliedPct(o.fairOdds)}</div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function Grid({ items, empty }: { items: LsmMarketView[]; empty: string }) {
  if (items.length === 0) {
    return <p className="py-16 text-center text-slate-500">{empty}</p>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((m) => (
        <MarketCard key={m.id} m={m} />
      ))}
    </div>
  );
}

export default function LsmHome() {
  const [active, setActive] = useState<LsmMarketView[]>([]);
  const [recent, setRecent] = useState<LsmMarketView[]>([]);
  const [filter, setFilter] = useState<Filter>('live');
  const [loading, setLoading] = useState(true);
  const [autoPicked, setAutoPicked] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([
        lsm.listLive(undefined, 60).catch(() => [] as LsmMarketView[]),
        lsm.listRecent(30).catch(() => [] as LsmMarketView[]),
      ]);
      setActive(l);
      setRecent(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const live = useMemo(() => active.filter((m) => m.status === 'live'), [active]);
  const pre = useMemo(
    () => active.filter((m) => m.status === 'pre' || m.status === 'suspended'),
    [active],
  );

  const counts: Record<Filter, number> = {
    live: live.length,
    pre: pre.length,
    recent: recent.length,
  };

  // After the first load, if the default "live" tab is empty, auto-select the
  // first non-empty section (live → pre → recent) so users immediately see
  // markets (世界杯盘口多为未开赛 'pre'，无正在直播的 'live' 时不应显示空白)。
  // Runs once; never overrides a manual selection thereafter.
  useEffect(() => {
    if (loading || autoPicked) return;
    setAutoPicked(true);
    if (counts.live === 0) {
      if (counts.pre > 0) setFilter('pre');
      else if (counts.recent > 0) setFilter('recent');
    }
  }, [loading, autoPicked, counts.live, counts.pre, counts.recent]);

  return (
    <LsmLayout title="盘口" active="/lsm">
      <header className="mb-6">
        <h1 className="bg-gradient-to-r from-violet-400 via-indigo-300 to-cyan-300 bg-clip-text text-2xl font-extrabold text-transparent md:text-3xl">
          链上滚球预测市场
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          实时滚球盘口 · 杠杆固定赔率 · Hyperliquid 式 LP 金库做市。下注与结算以 USDC 计价（Injective EVM 测试网）。
        </p>
      </header>

      {/* Section filter tabs */}
      <div className="mb-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors',
                on
                  ? 'border-violet-500/50 bg-violet-600/20 text-white'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-white',
              )}
            >
              {f.live && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
              )}
              {f.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-[11px] font-bold',
                  on ? 'bg-violet-500/30 text-violet-100' : 'bg-slate-800 text-slate-400',
                )}
              >
                {counts[f.key]}
              </span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : filter === 'live' ? (
        <Grid items={live} empty="暂无进行中的盘口" />
      ) : filter === 'pre' ? (
        <Grid items={pre} empty="暂无即将开始的盘口" />
      ) : (
        <Grid items={recent} empty="暂无已结束的盘口" />
      )}
    </LsmLayout>
  );
}
