/**
 * /lsm/vaults — LP vault list + deposit / redeem. Viewing is anonymous;
 * deposit / redeem require login. Currency is USDC.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, TrendingUp } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import { MmAgentPanel } from '../../components/lsm/MmAgentPanel';
import { Card, cn, AssetToggle, AssetBadge } from '../../components/lsm/ui';
import { isLoggedIn, gotoLogin } from '../../components/lsm/auth';
import {
  lsm,
  lsmErrorMessage,
  formatAsset,
  type LsmAsset,
  type LsmVaultView,
  type LsmVaultPosition,
} from '../../services/lsm';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-base font-extrabold text-white">{value}</div>
    </div>
  );
}

function VaultCard({
  vault,
  position,
  onChanged,
}: {
  vault: LsmVaultView;
  position: LsmVaultPosition | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isLeader = !!position?.isLeader;
  const redeemable = position ? position.shares : 0;
  const locked = position?.lockedUntil ? position.lockedUntil > Date.now() : false;
  const asset = vault.asset ?? 'AXP';

  const onDeposit = async () => {
    if (!isLoggedIn()) return gotoLogin();
    const txt = typeof window !== 'undefined' ? window.prompt(`存入 ${asset} 数量`) : null;
    const amt = Math.floor(Number(txt) || 0);
    if (amt <= 0) return;
    setBusy(true);
    try {
      await lsm.deposit(vault.id, amt);
      onChanged();
    } catch (e: any) {
      alert(lsmErrorMessage(e, '存入失败'));
    } finally {
      setBusy(false);
    }
  };

  const onRedeem = async () => {
    if (!isLoggedIn()) return gotoLogin();
    const txt = typeof window !== 'undefined' ? window.prompt(`赎回份额（持有 ${redeemable}）`) : null;
    const shares = Math.floor(Number(txt) || 0);
    if (shares <= 0) return;
    setBusy(true);
    try {
      await lsm.redeem(vault.id, shares);
      onChanged();
    } catch (e: any) {
      const msg = lsmErrorMessage(e, '');
      if (msg.includes('VAULT_DEPOSIT_LOCKED')) alert('存款仍在锁定期内');
      else if (msg.includes('LEADER_MIN_SHARE')) alert('主理人须维持最低自有份额');
      else alert(msg || '赎回失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 font-bold text-white">
          {vault.name || (vault.kind === 'protocol' ? '官方金库' : '用户金库')}
          <AssetBadge asset={asset} />
        </span>
        <div className="flex items-center gap-2">
          {vault.status !== 'active' && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-300">
              {vault.status === 'closing' ? '清算中' : '已关闭'}
            </span>
          )}
          <span
            className={cn(
              'rounded px-2 py-0.5 text-xs font-bold',
              vault.kind === 'protocol' ? 'bg-violet-500/20 text-violet-300' : 'bg-cyan-500/20 text-cyan-300',
            )}
          >
            {vault.kind === 'protocol' ? 'HLP' : isLeader ? '主理人' : 'USER'}
          </span>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <Stat label="NAV" value={vault.nav.toFixed(4)} />
        <Stat label="利用率" value={`${(vault.utilizationBps / 100).toFixed(1)}%`} />
        <Stat label="本金" value={formatAsset(vault.bankroll, asset)} />
      </div>
      {vault.kind === 'user' && (
        <p className="mb-3 text-xs text-slate-400">
          利润分成 {(vault.profitShareBps / 100).toFixed(0)}% · 锁定 {Math.round(vault.depositLockSecs / 3600)}h ·
          主理人最低份额 {(vault.minLeaderShareBps / 100).toFixed(0)}%
        </p>
      )}
      {position && position.shares > 0 && (
        <p className="mb-3 text-xs text-slate-300">
          我的份额 {position.shares}（本金 {formatAsset(position.costBasis, asset)}）{locked ? ' · 锁定中' : ''}
        </p>
      )}
      <div className="flex gap-2">
        <button
          onClick={onDeposit}
          disabled={busy || vault.status !== 'active'}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-violet-600 py-2.5 font-bold text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <TrendingUp size={16} />} 存入
        </button>
        {redeemable > 0 && (
          <button
            onClick={onRedeem}
            disabled={busy || vault.status === 'closed'}
            className="flex-1 rounded-lg border border-slate-800 bg-slate-950 py-2.5 font-bold text-white transition-colors hover:border-violet-500/40 disabled:opacity-50"
          >
            赎回
          </button>
        )}
      </div>
    </Card>
  );
}

export default function VaultsPage() {
  const [vaults, setVaults] = useState<LsmVaultView[]>([]);
  const [positions, setPositions] = useState<LsmVaultPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [asset, setAsset] = useState<LsmAsset>('AXP');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vs, ps] = await Promise.all([
        lsm.listVaults(undefined, asset),
        isLoggedIn() ? lsm.myPositions().catch(() => [] as LsmVaultPosition[]) : Promise.resolve([]),
      ]);
      setVaults(vs);
      setPositions(ps);
    } catch {
      /* empty */
    } finally {
      setLoading(false);
    }
  }, [asset]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <LsmLayout title="LP 金库" active="/lsm/vaults">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-white">LP 金库</h1>
        <AssetToggle value={asset} onChange={setAsset} />
      </div>
      <p className="mb-5 text-sm text-slate-400">
        作为流动性提供者向金库注入{asset === 'USDC' ? ' USDC（链上真实结算）' : ' AXP（免费玩积分）'}，按 NAV
        铸造份额，分享庄家盈亏（Hyperliquid HLP 范式）。每个金库流动性独立，按币种隔离。
      </p>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-violet-400" size={32} />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vaults.length === 0 && <p className="col-span-full py-10 text-center text-slate-500">暂无金库</p>}
          {vaults.map((v) => (
            <VaultCard
              key={v.id}
              vault={v}
              position={positions.find((p) => p.vaultId === v.id) || null}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {/* LSM Phase G · Req 28 — AI 做市 agent 可观测面板（仅 USDC 金库有决策时显示） */}
      <MmAgentPanel />
    </LsmLayout>
  );
}
