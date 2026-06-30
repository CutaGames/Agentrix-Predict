/**
 * /lsm/positions — my orders + cash-out. Requires login.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import { Card, cn, AssetBadge } from '../../components/lsm/ui';
import { isLoggedIn, gotoLogin } from '../../components/lsm/auth';
import { lsm, lsmErrorMessage, formatAsset, type LsmOrder } from '../../services/lsm';

const STATUS_LABEL: Record<LsmOrder['status'], { t: string; c: string }> = {
  open: { t: '进行中', c: 'text-cyan-300' },
  won: { t: '已获胜', c: 'text-emerald-400' },
  lost: { t: '已落败', c: 'text-red-400' },
  refunded: { t: '已退款', c: 'text-slate-400' },
  cashed_out: { t: '已平仓', c: 'text-violet-300' },
};

function LoginPrompt() {
  return (
    <div className="py-20 text-center">
      <p className="mb-4 text-slate-400">登录后查看你的持仓与平仓记录。</p>
      <button
        onClick={() => gotoLogin()}
        className="rounded-xl bg-violet-600 px-6 py-3 font-bold text-white transition-colors hover:bg-violet-500"
      >
        去登录
      </button>
    </div>
  );
}

export default function PositionsPage() {
  const [authed, setAuthed] = useState(false);
  const [orders, setOrders] = useState<LsmOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOrders(await lsm.myOrders(80));
    } catch (e: any) {
      if (/401|Unauthorized/.test(lsmErrorMessage(e, ''))) setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ok = isLoggedIn();
    setAuthed(ok);
    if (ok) load();
    else setLoading(false);
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

  return (
    <LsmLayout title="我的持仓" active="/lsm/positions">
      <h1 className="mb-5 text-2xl font-extrabold text-white">我的持仓</h1>

      {!authed ? (
        <LoginPrompt />
      ) : loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : orders.length === 0 ? (
        <p className="py-20 text-center text-slate-500">
          暂无订单，去 <Link href="/lsm" className="text-violet-300 hover:underline">盘口</Link> 下单试试。
        </p>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => {
            const s = STATUS_LABEL[o.status];
            const a = o.asset ?? 'AXP';
            return (
              <Card key={o.id} className="p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/lsm/market/${o.marketId}`}
                      className="font-mono text-xs text-slate-400 hover:text-violet-300"
                    >
                      盘口 {o.marketId.slice(0, 8)}…
                    </Link>
                    <AssetBadge asset={a} />
                  </div>
                  <span className={cn('text-sm font-bold', s.c)}>{s.t}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Field label="保证金" value={formatAsset(o.stake, a)} />
                  <Field label="杠杆 / 赔率" value={`${o.leverage}x @${o.entryOdds.toFixed(2)}`} />
                  <Field label="名义敞口" value={formatAsset(o.notional, a)} />
                  {o.status === 'open' ? (
                    <Field label="可兑现" value={o.cashoutValue != null ? formatAsset(o.cashoutValue, a) : '—'} />
                  ) : (
                    <Field
                      label="盈亏"
                      value={`${o.closePnl >= 0 ? '+' : ''}${formatAsset(o.closePnl, a)}`}
                      color={o.closePnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
                    />
                  )}
                </div>
                {o.status === 'open' && (
                  <button
                    onClick={() => cashOut(o.id)}
                    disabled={busy === o.id || o.cashoutValue == null}
                    className="mt-3 w-full rounded-lg bg-cyan-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
                  >
                    {busy === o.id ? '处理中…' : '提前平仓（按当前可兑现）'}
                  </button>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </LsmLayout>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cn('font-semibold', color || 'text-white')}>{value}</div>
    </div>
  );
}
