/**
 * MmAgentPanel — AI market-making agent observability (LSM Phase G · Req 28 / 23.3).
 *
 * Read-only view of the AI market-maker's recent decisions per vault
 * (GET /lsm/mm-agent/decisions): action (expand/derisk/hold/halt), suggested
 * underwriting capacity, fee bid (overround), utilization and the reasoning.
 * Renders nothing when the agent is disabled / has produced no decisions yet.
 */
import { useEffect, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { lsm, formatAsset, type LsmMmDecision } from '../../services/lsm';

const ACTION_TONE: Record<string, string> = {
  expand: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  derisk: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  hold: 'bg-slate-700/60 text-slate-300 border-slate-600',
  halt: 'bg-red-500/15 text-red-300 border-red-500/30',
};
const ACTION_LABEL: Record<string, string> = {
  expand: '扩容', derisk: '降险', hold: '持稳', halt: '暂停',
};

export function MmAgentPanel() {
  const [items, setItems] = useState<LsmMmDecision[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const d = await lsm.mmDecisions(30);
      // newest first; keep one latest decision per vault for a clean snapshot
      const byVault = new Map<string, LsmMmDecision>();
      for (const it of d) byVault.set(it.vaultId, it); // d is newest-last → last wins
      setItems(Array.from(byVault.values()).sort((a, b) => b.ts - a.ts));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  if (loading || items.length === 0) return null;

  return (
    <div className="mt-6 rounded-2xl border border-violet-500/20 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-violet-500/20 text-violet-300"><Cpu size={15} /></span>
          <div>
            <h2 className="text-sm font-bold text-white">AI 做市 / Market-Making</h2>
            <p className="text-[11px] text-slate-400">金库做市 agent 按利用率动态调容量与赔率溢价（观察模式 · 测试网）</p>
          </div>
        </div>
        <button onClick={load} className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white" title="刷新">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((d) => (
          <div key={d.vaultId} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-slate-400">vault {d.vaultId.slice(0, 8)}…</span>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${ACTION_TONE[d.action] || ACTION_TONE.hold}`}>
                {ACTION_LABEL[d.action] || d.action}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Metric label="利用率" value={`${(d.utilizationBps / 100).toFixed(1)}%`} />
              <Metric label="建议承接" value={formatAsset(d.capacity, 'USDC')} />
              <Metric label="赔率溢价" value={`${(d.feeBidBps / 100).toFixed(1)}%`} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{d.reason}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-600">AI 做市策略风险自负，非投资建议。决策每 ~60s 刷新。</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-900/70 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className="text-sm font-bold text-white">{value}</div>
    </div>
  );
}
