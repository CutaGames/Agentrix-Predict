/**
 * /lsm/wallet — stablecoin balance + on-chain deposit/withdraw. Requires login.
 *
 *  - Balance: GET /lsm/wallet/balance
 *  - Deposit: wallet approve(vault, base) + CollateralVault.deposit(base),
 *             then POST /lsm/wallet/deposit { chainId, txHash } so the backend
 *             verifies the tx and credits the platform balance.
 *  - Withdraw: POST /lsm/wallet/withdraw { amount, toAddress, chainId } — the
 *             backend relayer sends the on-chain tx; the UI only shows status.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Wallet as WalletIcon, ArrowDownToLine, ArrowUpFromLine, ExternalLink } from 'lucide-react';
import LsmLayout from '../../components/lsm/LsmLayout';
import { Card, AssetBadge, ChainSelector, inputClass } from '../../components/lsm/ui';
import { isLoggedIn, gotoLogin } from '../../components/lsm/auth';
import { lsm, lsmErrorMessage, formatAsset, type LsmWalletBalance } from '../../services/lsm';
import {
  DEFAULT_LSM_CHAIN_ID,
  getChainConfig,
  type LsmChainId,
} from '../../services/lsmChains';
import {
  connectWallet,
  getConnectedAccount,
  ensureChain,
  readUsdcBalance,
  depositUsdc,
  shortAddress,
  hasInjectedWallet,
  WalletError,
} from '../../services/lsmWallet';

export default function WalletPage() {
  const [authed, setAuthed] = useState(false);
  const [chainId, setChainId] = useState<LsmChainId>(DEFAULT_LSM_CHAIN_ID);
  const chain = getChainConfig(chainId);

  const [balance, setBalance] = useState<LsmWalletBalance | null>(null);
  const [loadingBal, setLoadingBal] = useState(true);

  const [account, setAccount] = useState<string | null>(null);
  const [onchainUsdc, setOnchainUsdc] = useState<number | null>(null);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);

  const [depositAmt, setDepositAmt] = useState('100');
  const [depositing, setDepositing] = useState(false);
  const [depositMsg, setDepositMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMsg, setWithdrawMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refreshBalance = useCallback(async () => {
    setLoadingBal(true);
    try {
      setBalance(await lsm.walletBalance(chainId));
    } catch (e: any) {
      if (/401|Unauthorized/.test(lsmErrorMessage(e, ''))) setAuthed(false);
      setBalance(null);
    } finally {
      setLoadingBal(false);
    }
  }, [chainId]);

  const refreshOnchain = useCallback(
    async (addr: string) => {
      try {
        setOnchainUsdc(await readUsdcBalance(chainId, addr));
      } catch {
        setOnchainUsdc(null);
      }
    },
    [chainId],
  );

  useEffect(() => {
    const ok = isLoggedIn();
    setAuthed(ok);
    if (ok) refreshBalance();
    else setLoadingBal(false);
    getConnectedAccount().then((a) => {
      if (a) {
        setAccount(a);
        setWithdrawAddr((prev) => prev || a);
        refreshOnchain(a);
      }
    });
  }, [refreshBalance, refreshOnchain]);

  const onConnect = async () => {
    setWalletMsg(null);
    try {
      const addr = await connectWallet();
      await ensureChain(chainId);
      setAccount(addr);
      setWithdrawAddr((prev) => prev || addr);
      refreshOnchain(addr);
    } catch (e: any) {
      setWalletMsg(e instanceof WalletError ? e.message : lsmErrorMessage(e, '连接钱包失败'));
    }
  };

  const onDeposit = async () => {
    if (!isLoggedIn()) return gotoLogin();
    const amt = Number(depositAmt);
    if (!(amt > 0)) {
      setDepositMsg({ kind: 'err', text: '请输入正数充值金额' });
      return;
    }
    setDepositing(true);
    setDepositMsg({ kind: 'info', text: '请在钱包中确认授权与充值交易…' });
    try {
      const { txHash } = await depositUsdc(chainId, amt);
      setDepositMsg({ kind: 'info', text: '链上交易已提交，正在通知后端入账…' });
      await lsm.walletDeposit({ chainId, txHash });
      setDepositMsg({ kind: 'ok', text: '充值成功，余额将在确认后到账。' });
      await refreshBalance();
      if (account) refreshOnchain(account);
    } catch (e: any) {
      setDepositMsg({ kind: 'err', text: e instanceof WalletError ? e.message : lsmErrorMessage(e, '充值失败') });
    } finally {
      setDepositing(false);
    }
  };

  const onWithdraw = async () => {
    if (!isLoggedIn()) return gotoLogin();
    const amt = Number(withdrawAmt);
    if (!(amt > 0)) {
      setWithdrawMsg({ kind: 'err', text: '请输入正数提现金额' });
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(withdrawAddr.trim())) {
      setWithdrawMsg({ kind: 'err', text: '请输入有效的 EVM 地址' });
      return;
    }
    setWithdrawing(true);
    setWithdrawMsg(null);
    try {
      const res = await lsm.walletWithdraw({ amount: amt, toAddress: withdrawAddr.trim(), chainId });
      setWithdrawMsg({
        kind: 'ok',
        text: `提现已受理（状态：${res.status}）。由 relayer 代发上链，确认后到账。`,
      });
      setWithdrawAmt('');
      await refreshBalance();
    } catch (e: any) {
      const msg = lsmErrorMessage(e, '');
      if (msg.includes('insufficient') || msg.includes('INSUFFICIENT')) setWithdrawMsg({ kind: 'err', text: '可用余额不足' });
      else if (msg.includes('COMPLIANCE') || msg.includes('GEO')) setWithdrawMsg({ kind: 'err', text: '当前账户/地域受限，无法提现' });
      else if (msg.includes('SYSTEM_MODE') || msg.includes('PAUSED')) setWithdrawMsg({ kind: 'err', text: '系统维护中，暂停提现' });
      else setWithdrawMsg({ kind: 'err', text: msg || '提现失败' });
    } finally {
      setWithdrawing(false);
    }
  };

  if (!authed) {
    return (
      <LsmLayout title="钱包" active="/lsm/wallet">
        <h1 className="mb-4 text-2xl font-extrabold text-white">钱包</h1>
        <div className="py-20 text-center">
          <p className="mb-4 text-slate-400">登录后查看余额并进行 USDC 充值 / 提现。</p>
          <button
            onClick={() => gotoLogin()}
            className="rounded-xl bg-violet-600 px-6 py-3 font-bold text-white transition-colors hover:bg-violet-500"
          >
            去登录
          </button>
        </div>
      </LsmLayout>
    );
  }

  return (
    <LsmLayout title="钱包" active="/lsm/wallet">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-white">钱包</h1>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[11px] font-semibold text-slate-500">USDC 结算链</span>
          <ChainSelector value={chainId} onChange={setChainId} size="sm" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Balance — dual asset (AXP points + on-chain USDC) */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-slate-400">
            <WalletIcon size={16} /> 平台余额
          </div>
          {loadingBal ? (
            <Loader2 className="animate-spin text-violet-400" />
          ) : balance ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">
                <AssetBadge asset="AXP" />
                <div className="text-right">
                  <div className="text-2xl font-extrabold text-white">{formatAsset(balance.axp, 'AXP')}</div>
                  <div className="text-[11px] text-slate-500">免费玩 · 软积分，不可提现</div>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">
                <AssetBadge asset="USDC" />
                <div className="text-right">
                  <div className="text-2xl font-extrabold text-white">{formatAsset(balance.usdc, 'USDC')}</div>
                  <div className="text-[11px] text-slate-500">链上真实结算（测试网）· {chain.name}（{chainId}）</div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">暂无法获取余额</p>
          )}
          <button onClick={refreshBalance} className="mt-3 text-xs text-violet-300 hover:underline">
            刷新余额
          </button>
        </Card>

        {/* Wallet connection */}
        <Card className="p-5">
          <div className="mb-2 flex items-center gap-2 text-slate-400">
            <ExternalLink size={16} /> 浏览器钱包
          </div>
          {account ? (
            <>
              <div className="font-mono text-lg font-bold text-white">{shortAddress(account)}</div>
              <p className="mt-1 text-sm text-slate-500">
                链上 USDC（{chain.shortName}）：{onchainUsdc != null ? `${onchainUsdc.toFixed(2)} USDC` : '—'}
              </p>
              <p className="mt-1 text-xs text-slate-600">网络：{chain.name}（{chainId}）· Gas {chain.nativeSymbol}</p>
            </>
          ) : (
            <>
              <button
                onClick={onConnect}
                className="rounded-xl bg-cyan-600 px-5 py-2.5 font-bold text-white transition-colors hover:bg-cyan-500"
              >
                连接钱包
              </button>
              {!hasInjectedWallet() && (
                <p className="mt-2 text-xs text-amber-300">未检测到浏览器钱包，请安装 MetaMask 等 EVM 钱包。</p>
              )}
            </>
          )}
          {walletMsg && <p className="mt-2 text-sm text-red-400">{walletMsg}</p>}
        </Card>

        {/* Deposit */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 font-bold text-white">
            <ArrowDownToLine size={18} className="text-emerald-400" /> 充值 USDC
          </div>
          <p className="mb-3 text-xs text-slate-500">
            通过钱包授权并存入 {chain.shortName} CollateralVault（{shortAddress(chain.vault)}），成功后自动通知后端入账。
          </p>
          <label className="mb-1 block text-sm text-slate-400">充值金额 (USDC)</label>
          <input
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            inputMode="decimal"
            className={`${inputClass} mb-3`}
          />
          <button
            onClick={onDeposit}
            disabled={depositing || !account}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-extrabold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {depositing ? <Loader2 className="animate-spin" size={18} /> : null}
            {account ? '授权并充值' : '请先连接钱包'}
          </button>
          {depositMsg && (
            <p
              className={`mt-3 text-sm ${
                depositMsg.kind === 'ok'
                  ? 'text-emerald-400'
                  : depositMsg.kind === 'err'
                  ? 'text-red-400'
                  : 'text-slate-400'
              }`}
            >
              {depositMsg.text}
            </p>
          )}
        </Card>

        {/* Withdraw */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 font-bold text-white">
            <ArrowUpFromLine size={18} className="text-amber-400" /> 提现 USDC
          </div>
          <p className="mb-3 text-xs text-slate-500">
            提现由后端 relayer 代发上链，无需你支付 gas；提交后展示链上状态。
          </p>
          <label className="mb-1 block text-sm text-slate-400">提现金额 (USDC)</label>
          <input
            value={withdrawAmt}
            onChange={(e) => setWithdrawAmt(e.target.value)}
            inputMode="decimal"
            placeholder={balance ? `可用 ${formatAsset(balance.usdc, 'USDC')}` : ''}
            className={`${inputClass} mb-3`}
          />
          <label className="mb-1 block text-sm text-slate-400">收款地址</label>
          <input
            value={withdrawAddr}
            onChange={(e) => setWithdrawAddr(e.target.value)}
            placeholder="0x…"
            className={`${inputClass} mb-3 font-mono text-sm`}
          />
          <button
            onClick={onWithdraw}
            disabled={withdrawing}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 py-3 font-extrabold text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
          >
            {withdrawing ? <Loader2 className="animate-spin" size={18} /> : null}
            申请提现
          </button>
          {withdrawMsg && (
            <p className={`mt-3 text-sm ${withdrawMsg.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
              {withdrawMsg.text}
            </p>
          )}
        </Card>
      </div>

      <p className="mt-6 text-xs text-slate-600">
        测试网（{chain.name}，chainId {chainId}）USDC 为测试代币，无真实价值。充提受合规与系统熔断约束。
      </p>
    </LsmLayout>
  );
}
