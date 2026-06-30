/**
 * LsmToolCards — renders structured prediction Copilot tool results in the web
 * chat (LSM Phase G · 18.4 / 20.4). Driven by `tool_result` SSE events captured
 * from the unified chat stream (cardType: lsm_market_list / lsm_preview /
 * lsm_order_placed / lsm_positions / lsm_cashed_out / lsm_spending_authorized).
 *
 * Each card is read-only presentation + optional one-tap follow-ups that send a
 * natural-language message back to the Copilot (so the agent drives the next
 * tool call), keeping a single placement path through lsm_place_order.
 */
import { Activity, TrendingUp, Wallet, CheckCircle2, ShieldCheck } from 'lucide-react';

type Card = { toolName: string; card: any };

function fmtUsdcOrAxp(amount: number, asset?: string): string {
  if (asset === 'USDC') return `${(Number(amount) / 100).toFixed(2)} USDC`;
  return `${Math.round(Number(amount))} ${asset || 'AXP'}`;
}

function Chip({ children, tone = 'slate' }: { children: any; tone?: 'slate' | 'violet' | 'cyan' | 'green' | 'red' }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
    violet: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export function LsmToolCards({ cards, onSendMessage }: { cards: Card[]; onSendMessage?: (m: string) => void }) {
  if (!cards?.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {cards.map((c, i) => (
        <LsmCard key={i} toolName={c.toolName} card={c.card} onSendMessage={onSendMessage} />
      ))}
    </div>
  );
}

function LsmCard({ toolName, card, onSendMessage }: { toolName: string; card: any; onSendMessage?: (m: string) => void }) {
  const type = card?.cardType;

  if (type === 'lsm_market_list') {
    const markets = (card.markets || []).slice(0, 6);
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-violet-300"><Activity size={13} /> 盘口 / Markets ({card.total})</div>
        <div className="flex flex-col gap-2">
          {markets.map((m: any) => (
            <div key={m.marketId} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold text-white">{m.match}</span>
                <Chip tone={m.status === 'live' ? 'red' : 'slate'}>{m.status}</Chip>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(m.outcomes || []).map((o: any) => (
                  <button
                    key={o.outcomeIdx}
                    onClick={() => onSendMessage?.(`用 10 USDC 2 倍杠杆押 ${m.match} 的 ${o.label}（marketId=${m.marketId}, outcomeIdx=${o.outcomeIdx}）`)}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-left transition-colors hover:border-violet-500/50"
                  >
                    <span className="block text-[11px] text-slate-400">{o.label}</span>
                    <span className="text-sm font-bold text-violet-300">{o.decimalOdds}</span>
                    {o.impliedPct != null && <span className="ml-1 text-[10px] text-slate-500">{o.impliedPct}%</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'lsm_preview') {
    const asset = card.asset || 'AXP';
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-cyan-300"><TrendingUp size={13} /> 下单预览 / Preview</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Row k="可成交赔率" v={`${Number(card.tradableOdds).toFixed(2)}（${card.impliedPct}%）`} />
          <Row k="名义敞口" v={fmtUsdcOrAxp(card.notional, asset)} />
          <Row k="最大盈利" v={`+${fmtUsdcOrAxp(card.maxProfit, asset)}`} tone="green" />
          <Row k="最大亏损" v={`-${fmtUsdcOrAxp(card.maxLoss, asset)}`} tone="red" />
          <Row k="获胜派彩" v={fmtUsdcOrAxp(card.winPayout, asset)} />
          <Row k="计价" v={asset} />
        </div>
        <button
          onClick={() => onSendMessage?.(`确认下单（marketId=${card.marketId}, outcomeIdx=${card.outcomeIdx}, stake=${card.stake}, leverage=${card.leverage}, asset=${asset}, quotedOdds=${card.tradableOdds}）`)}
          className="mt-2.5 w-full rounded-lg bg-violet-600 py-2 text-sm font-bold text-white transition-colors hover:bg-violet-500"
        >确认下单 / Place</button>
      </div>
    );
  }

  if (type === 'lsm_order_placed') {
    const asset = card.asset || 'AXP';
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-bold text-emerald-300"><CheckCircle2 size={13} /> 已下单 / Order placed</div>
        <div className="text-xs text-slate-200">
          {card.status?.toUpperCase()} · 保证金 {fmtUsdcOrAxp(card.stake, asset)} × {card.leverage}x @ {Number(card.entryOdds).toFixed(2)} · 派彩 {fmtUsdcOrAxp(card.winPayout, asset)}
        </div>
        <button onClick={() => onSendMessage?.('查看我的持仓')} className="mt-2 text-xs font-semibold text-violet-300 hover:underline">查看持仓 ›</button>
      </div>
    );
  }

  if (type === 'lsm_positions') {
    const ps = (card.positions || []).slice(0, 8);
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-violet-300"><Wallet size={13} /> 我的持仓 / Positions ({card.total})</div>
        <div className="flex flex-col gap-1.5">
          {ps.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 text-xs">
              <span className="text-slate-300">{p.asset} · {fmtUsdcOrAxp(p.stake, p.asset)} × {p.leverage}x @ {Number(p.entryOdds).toFixed(2)}</span>
              <span className="flex items-center gap-2">
                <Chip tone={p.status === 'open' ? 'cyan' : p.status === 'won' ? 'green' : p.status === 'lost' ? 'red' : 'slate'}>{p.status}</Chip>
                {p.status === 'open' && p.cashoutValue != null && (
                  <button onClick={() => onSendMessage?.(`平仓订单 ${p.id}`)} className="rounded bg-cyan-600 px-2 py-0.5 font-semibold text-white hover:bg-cyan-500">平仓</button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'lsm_cashed_out') {
    const asset = card.asset || 'AXP';
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-200">
        <span className="font-bold text-cyan-300">已平仓 / Cashed out</span> · 派彩 {fmtUsdcOrAxp(card.payout, asset)} · 盈亏 {card.closePnl >= 0 ? '+' : ''}{fmtUsdcOrAxp(card.closePnl, asset)}
      </div>
    );
  }

  if (type === 'lsm_spending_authorized') {
    return (
      <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-3">
        <div className="flex items-center gap-1.5 text-xs font-bold text-violet-300"><ShieldCheck size={13} /> 已授权自动下注 / Spending authorized</div>
        <div className="mt-1 text-xs text-slate-200">每日上限 {card.dailyLimitUsdc} USDC · 至 {card.validUntil ? new Date(card.validUntil).toLocaleDateString() : '—'}</div>
      </div>
    );
  }

  return null;
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'green' | 'red' }) {
  const c = tone === 'green' ? 'text-emerald-300' : tone === 'red' ? 'text-red-300' : 'text-white';
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{k}</span>
      <span className={`font-semibold ${c}`}>{v}</span>
    </div>
  );
}
