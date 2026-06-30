/**
 * ModelPicker — web chat model selector (LSM Phase G · Req 24.3 / task 18.3).
 *
 * Reads & writes the SAME server-side per-instance activeModel as mobile/desktop
 * (GET /openclaw/instances → primary, GET /openclaw/models, PATCH
 * /openclaw/instances/:id/model) so model choice syncs across ends. Platform
 * Bedrock exposes Haiku by default; BYO keys unlock more models — the list is
 * whatever /openclaw/models returns for this user. Self-contained: renders
 * nothing until it resolves a primary instance + models.
 */
import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { openclawApi, type AvailableModel } from '../../lib/api/openclaw.api';

export function ModelPicker({ compact = false }: { compact?: boolean }) {
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [inst, list] = await Promise.all([
          openclawApi.getPrimaryInstance(),
          openclawApi.getAvailableModels(),
        ]);
        if (!alive) return;
        if (inst) {
          setInstanceId(inst.id);
          setCurrent(inst.capabilities?.activeModel || '');
        }
        setModels((list || []).filter((m) => m.availability !== 'coming_soon'));
      } catch {
        /* non-intrusive: hide picker on error */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!instanceId || models.length === 0) return null;

  const onChange = async (modelId: string) => {
    if (!modelId || modelId === current || !instanceId) return;
    const prev = current;
    setCurrent(modelId);
    setBusy(true);
    try {
      await openclawApi.switchInstanceModel(instanceId, modelId);
    } catch {
      setCurrent(prev); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`relative inline-flex items-center ${compact ? 'text-[11px]' : 'text-xs'}`}>
      <select
        value={current}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        title="对话模型（跨端同步）"
        className="appearance-none rounded-lg border border-slate-700 bg-slate-900/80 py-1 pl-2.5 pr-6 font-semibold text-slate-200 outline-none transition-colors hover:border-violet-500/50 disabled:opacity-50"
      >
        {!current && <option value="">选择模型…</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}{m.badge ? ` · ${m.badge}` : ''}
          </option>
        ))}
      </select>
      <ChevronDown size={13} className="pointer-events-none absolute right-1.5 text-slate-400" />
    </div>
  );
}
