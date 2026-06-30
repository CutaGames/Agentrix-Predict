/**
 * /lsm/leaderboard — pnl / volume leaderboard × all / week. Anonymous-viewable.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import { Card, cn, fmtUsdc } from '../../components/lsm/ui';
import { lsm, type LsmLeaderboardRow } from '../../services/lsm';

export default function LeaderboardPage() {
  const [board, setBoard] = useState<LsmLeaderboardRow[]>([]);
  const [boardType, setBoardType] = useState<'pnl' | 'volume'>('pnl');
  const [period, setPeriod] = useState<'all' | 'week'>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await lsm.leaderboard(boardType, period, 30);
      setBoard(r.items);
    } catch {
      setBoard([]);
    } finally {
      setLoading(false);
    }
  }, [boardType, period]);

  useEffect(() => {
    load();
  }, [load]);

  const pill = (on: boolean, accent: 'violet' | 'cyan') =>
    cn(
      'rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors',
      on
        ? accent === 'violet'
          ? 'bg-violet-600 text-white'
          : 'bg-cyan-600 text-white'
        : 'border border-slate-800 bg-slate-900/60 text-slate-300 hover:text-white',
    );

  return (
    <LsmLayout title="排行榜" active="/lsm/leaderboard">
      <h1 className="mb-4 text-2xl font-extrabold text-white">排行榜</h1>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={() => setBoardType('pnl')} className={pill(boardType === 'pnl', 'violet')}>
          盈利王
        </button>
        <button onClick={() => setBoardType('volume')} className={pill(boardType === 'volume', 'violet')}>
          成交量王
        </button>
        <span className="mx-1 h-5 w-px bg-slate-700" />
        <button onClick={() => setPeriod('all')} className={pill(period === 'all', 'cyan')}>
          全部
        </button>
        <button onClick={() => setPeriod('week')} className={pill(period === 'week', 'cyan')}>
          本周
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : (
        <Card className="divide-y divide-slate-800">
          {board.length === 0 && <p className="py-10 text-center text-slate-500">暂无数据</p>}
          {board.map((row) => (
            <div key={row.userId} className="flex items-center justify-between px-5 py-3">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'w-7 text-center font-extrabold',
                    row.rank <= 3 ? 'text-amber-400' : 'text-slate-500',
                  )}
                >
                  #{row.rank}
                </span>
                <span className="font-mono text-sm text-slate-300">{row.userId.slice(0, 8)}…</span>
                <span className="text-xs text-slate-500">{row.bets} 笔</span>
              </div>
              <span
                className={cn(
                  'font-extrabold',
                  boardType === 'pnl'
                    ? row.value >= 0
                      ? 'text-emerald-400'
                      : 'text-red-400'
                    : 'text-cyan-300',
                )}
              >
                {boardType === 'pnl' && row.value >= 0 ? '+' : ''}
                {fmtUsdc(row.value)} USDC
              </span>
            </div>
          ))}
        </Card>
      )}
    </LsmLayout>
  );
}
