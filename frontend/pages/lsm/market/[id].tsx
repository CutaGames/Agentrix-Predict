/**
 * /lsm/market/[id] — market detail + odds-history chart (range toggle) + bet
 * panel (outcome select + stake + leverage slider + preview → place with
 * SLIPPAGE_EXCEEDED retry) + quick cash-out of open positions.
 * Viewing is anonymous; placing an order requires login.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { Loader2 } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import LsmLayout from '../../../components/lsm/LsmLayout';
import {
  Card,
  StatusBadge,
  AssetToggle,
  AssetBadge,
  cn,
  inputClass,
  outcomeLabel,
  outcomeAccent,
  impliedPct,
} from '../../../components/lsm/ui';
import { isLoggedIn, gotoLogin } from '../../../components/lsm/auth';
import {
  lsm,
  lsmErrorMessage,
  formatAsset,
  type LsmAsset,
  type LsmMarketView,
  type LsmPreview,
  type LsmOddsHistory,
  type LsmOrder,
} from '../../../services/lsm';

const LEVERAGES = [1, 2, 5, 10, 20];
const RANGES: Array<'all' | '30m' | '10m' | '5m'> = ['all', '30m', '10m', '5m'];
const SERIES_COLORS = ['#22d3ee', '#fbbf24', '#a78bfa', '#34d399'];

function OddsChart({ history, market }: { history: LsmOddsHistory | null; market: LsmMarketView }) {
  const data = useMemo(() => {
    if (!history?.series?.length) return [];
    const byTs = new Map<number, any>();
    for (const s of history.series) {
      for (const p of s.points) {
        const row = byTs.get(p.ts) || { ts: p.ts };
        row[`o${s.outcomeIdx}`] = p.odds;
        byTs.set(p.ts, row);
      }
    }
    return Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  }, [history]);

  if (!history?.series?.length || data.length === 0) {
    return <p className="py-10 text-center text-sm text-slate-500">暂无赔率历史</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="ts"
          tickFormatter={(ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          stroke="#64748b"
          fontSize={11}
        />
        <YAxis stroke="#64748b" fontSize={11} domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, color: '#fff' }}
          labelFormatter={(ts) => new Date(Number(ts)).toLocaleString()}
        />
        {history.series.map((s, i) => (
          <Line
            key={s.outcomeIdx}
            type="monotone"
            dataKey={`o${s.outcomeIdx}`}
            name={outcomeLabel(market, s.outcomeIdx)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            dot={false}
            strokeWidth={2}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function PreviewLine({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={cn(color || 'text-white', bold ? 'font-extrabold' : 'font-semibold')}>{value}</span>
    </div>
  );
}

function BetPanel({ market, initialOutcome }: { market: LsmMarketView; initialOutcome: number }) {
  const [asset, setAsset] = useState<LsmAsset>('AXP');
  const [outcomeIdx, setOutcomeIdx] = useState(initialOutcome);
  const [stake, setStake] = useState('100');
  const [leverage, setLeverage] = useState(2);
  const [preview, setPreview] = useState<LsmPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [retryOdds, setRetryOdds] = useState<number | null>(null);

  useEffect(() => setOutcomeIdx(initialOutcome), [initialOutcome]);

  const stakeNum = Math.max(0, Math.floor(Number(stake) || 0));

  useEffect(() => {
    setDone(false);
    if (stakeNum <= 0) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const p = await lsm.preview({ marketId: market.id, outcomeIdx, stake: stakeNum, leverage, asset });
        setPreview(p);
        setRetryOdds(null);
      } catch (e: any) {
        setError(lsmErrorMessage(e, '预览失败'));
        setPreview(null);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [market.id, outcomeIdx, stakeNum, leverage, asset]);

  const place = async () => {
    if (!preview || submitting) return;
    if (!isLoggedIn()) {
      gotoLogin();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await lsm.place({
        marketId: market.id,
        outcomeIdx,
        stake: stakeNum,
        leverage,
        quotedOdds: retryOdds ?? preview.tradableOdds,
        asset,
      });
      setDone(true);
      setRetryOdds(null);
    } catch (e: any) {
      const msg: string = lsmErrorMessage(e, '');
      if (msg.startsWith('SLIPPAGE_EXCEEDED')) {
        const newOdds = Number(msg.split(':')[1]);
        if (!Number.isNaN(newOdds)) {
          setRetryOdds(newOdds);
          setPreview((p) => (p ? { ...p, tradableOdds: newOdds } : p));
          setError('赔率已变动，点按新价确认');
        } else setError('赔率变动，请重试');
      } else if (/insufficient/i.test(msg)) setError(`${asset} 余额不足，请先充值`);
      else if (msg.includes('RISK_LIMIT')) setError('超过金库风险上限');
      else if (msg.includes('STALE')) setError('赔率过期，暂停下单');
      else if (msg.includes('Unauthorized') || msg.includes('401')) gotoLogin();
      else setError(msg || '下单失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-bold text-white">下单</h3>
        {/* AXP / USDC settlement-asset selector. */}
        <AssetToggle value={asset} onChange={setAsset} />
      </div>

      <p className="mb-3 text-xs text-slate-500">
        {asset === 'AXP'
          ? 'AXP=免费玩 · 软积分引流，不涉及真实资金。'
          : 'USDC=链上真实结算（测试网）· 计价于 Injective EVM 测试网。'}
      </p>

      <label className="mb-1 block text-sm text-slate-400">选择结果</label>
      <div
        className="mb-3 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${market.odds.length}, minmax(0, 1fr))` }}
      >
        {market.odds.map((o) => {
          const acc = outcomeAccent(market, o.outcomeIdx);
          const on = outcomeIdx === o.outcomeIdx;
          return (
            <button
              key={o.outcomeIdx}
              onClick={() => setOutcomeIdx(o.outcomeIdx)}
              className={cn(
                'rounded-xl border py-2.5 text-center transition-colors',
                on
                  ? 'border-violet-500 bg-violet-600/20 ring-1 ring-violet-500/50'
                  : 'border-slate-800 bg-slate-950 hover:border-violet-500/40',
              )}
            >
              <div className="truncate px-1 text-xs text-slate-300">{outcomeLabel(market, o.outcomeIdx)}</div>
              <div className={cn('text-lg font-extrabold', acc.text)}>{o.fairOdds.toFixed(2)}</div>
              <div className="text-[10px] text-slate-500">{impliedPct(o.fairOdds)}</div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between py-1">
        <span className="text-sm text-slate-400">可成交赔率</span>
        <span className="text-xl font-extrabold text-cyan-300">
          {preview ? preview.tradableOdds.toFixed(2) : '—'}
        </span>
      </div>

      <label className="mb-1 mt-3 block text-sm text-slate-400">保证金 ({asset})</label>
      <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="numeric" className={inputClass} />

      <div className="mb-1 mt-4 flex items-center justify-between">
        <label className="text-sm text-slate-400">杠杆</label>
        <span className="text-sm font-extrabold text-violet-300">{leverage}x</span>
      </div>
      <input
        type="range"
        min={LEVERAGES[0]}
        max={LEVERAGES[LEVERAGES.length - 1]}
        step={1}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        className="w-full accent-violet-500"
      />
      <div className="mt-2 flex gap-2">
        {LEVERAGES.map((l) => (
          <button
            key={l}
            onClick={() => setLeverage(l)}
            className={cn(
              'flex-1 rounded-lg py-1.5 text-sm font-bold transition-colors',
              leverage === l
                ? 'bg-violet-600 text-white'
                : 'border border-slate-800 bg-slate-950 text-slate-300 hover:border-violet-500/40',
            )}
          >
            {l}x
          </button>
        ))}
      </div>

      <div className="mt-4 flex min-h-[84px] items-center justify-center rounded-xl border border-slate-800 bg-slate-950 p-4">
        {loading ? (
          <Loader2 className="animate-spin text-violet-400" />
        ) : preview ? (
          <div className="w-full space-y-1.5 text-sm">
            <PreviewLine label="名义敞口" value={formatAsset(preview.notional, asset)} />
            <PreviewLine label="最大盈利" value={`+${formatAsset(preview.maxProfit, asset)}`} color="text-emerald-400" />
            <PreviewLine label="最大亏损" value={`-${formatAsset(preview.maxLoss, asset)}`} color="text-red-400" />
            <PreviewLine label="获胜派彩" value={formatAsset(preview.winPayout, asset)} bold />
          </div>
        ) : (
          <span className="text-sm text-slate-500">输入保证金查看预览</span>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {done && <p className="mt-3 text-sm text-emerald-400">下单成功，可在「持仓」查看。</p>}

      <button
        onClick={place}
        disabled={!preview || submitting || !market.tradable}
        className="mt-4 w-full rounded-xl bg-violet-600 py-3.5 font-extrabold text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
      >
        {!market.tradable
          ? '暂停交易'
          : submitting
          ? '提交中…'
          : retryOdds
          ? `按 ${retryOdds.toFixed(2)} 确认`
          : '确认下单'}
      </button>
      <p className="mt-3 text-center text-xs text-slate-600">
        {asset === 'AXP'
          ? '以 AXP 积分计价 · 免费玩，不涉及真实资金 · 本页非投资建议。'
          : '以 USDC 计价 · 链上真实结算（测试网代币无真实价值）· 本页非投资建议。'}
      </p>
    </Card>
  );
}

function OpenPositions({ marketId }: { marketId: string }) {
  const [orders, setOrders] = useState<LsmOrder[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLoggedIn()) return;
    try {
      const all = await lsm.myOrders(50);
      setOrders(all.filter((o) => o.marketId === marketId && o.status === 'open'));
    } catch {
      /* ignore */
    }
  }, [marketId]);

  useEffect(() => {
    load();
  }, [load]);

  const cashOut = async (id: string) => {
    setBusy(id);
    try {
      await lsm.cashOut(id);
      await load();
    } catch (e: any) {
      alert(lsmErrorMessage(e, '平仓失败'));
    } finally {
      setBusy(null);
    }
  };

  if (!isLoggedIn() || orders.length === 0) return null;

  return (
    <Card className="mt-4 p-5">
      <h3 className="mb-3 font-bold text-white">本盘持仓</h3>
      <div className="space-y-2">
        {orders.map((o) => {
          const a = o.asset ?? 'AXP';
          return (
            <div key={o.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">
              <div className="text-sm">
                <div className="flex items-center gap-2 font-semibold text-white">
                  <AssetBadge asset={a} />
                  保证金 {formatAsset(o.stake, a)} · {o.leverage}x · @{o.entryOdds.toFixed(2)}
                </div>
                {o.cashoutValue != null && (
                  <div className="text-xs text-slate-400">当前可兑现 {formatAsset(o.cashoutValue, a)}</div>
                )}
              </div>
              <button
                onClick={() => cashOut(o.id)}
                disabled={busy === o.id || o.cashoutValue == null}
                className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-bold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
              >
                {busy === o.id ? '处理中…' : '提前平仓'}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function MarketDetailPage() {
  const router = useRouter();
  const { id, o } = router.query;
  const marketId = typeof id === 'string' ? id : '';
  const initialOutcome = typeof o === 'string' ? Number(o) || 0 : 0;

  const [market, setMarket] = useState<LsmMarketView | null>(null);
  const [history, setHistory] = useState<LsmOddsHistory | null>(null);
  const [range, setRange] = useState<'all' | '30m' | '10m' | '5m'>('all');
  const [loading, setLoading] = useState(true);

  const loadMarket = useCallback(async () => {
    if (!marketId) return;
    try {
      setMarket(await lsm.getMarket(marketId));
    } catch {
      setMarket(null);
    } finally {
      setLoading(false);
    }
  }, [marketId]);

  const loadHistory = useCallback(async () => {
    if (!marketId) return;
    try {
      setHistory(await lsm.oddsHistory(marketId, range));
    } catch {
      setHistory(null);
    }
  }, [marketId, range]);

  useEffect(() => {
    loadMarket();
    const t = setInterval(loadMarket, 15000);
    return () => clearInterval(t);
  }, [loadMarket]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  return (
    <LsmLayout title={market ? `${market.homeTeam} vs ${market.awayTeam}` : '盘口详情'}>
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : !market ? (
        <p className="py-20 text-center text-slate-500">盘口不存在或已下架</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            <Card className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  {(market.league || market.sport) && (
                    <span className="mb-2 inline-block rounded-md bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                      {market.league || market.sport}
                    </span>
                  )}
                  <h1 className="text-xl font-extrabold text-white">
                    {market.homeTeam} <span className="text-slate-600">vs</span> {market.awayTeam}
                  </h1>
                  {(market.homeScore != null || market.awayScore != null) && (
                    <p className="mt-1 text-lg font-bold text-cyan-300">
                      {market.homeScore ?? 0} : {market.awayScore ?? 0}
                    </p>
                  )}
                </div>
                <StatusBadge m={market} />
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="font-bold text-white">赔率走势</h3>
                <div className="flex gap-1">
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRange(r)}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                        range === r
                          ? 'bg-violet-600 text-white'
                          : 'border border-slate-800 bg-slate-950 text-slate-400 hover:text-white',
                      )}
                    >
                      {r === 'all' ? '全部' : r}
                    </button>
                  ))}
                </div>
              </div>
              <OddsChart history={history} market={market} />
            </Card>

            <OpenPositions marketId={market.id} />
          </div>

          <div className="lg:col-span-2">
            <BetPanel market={market} initialOutcome={initialOutcome} />
          </div>
        </div>
      )}
    </LsmLayout>
  );
}
