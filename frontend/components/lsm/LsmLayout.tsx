/**
 * LsmLayout — shared shell for the standalone LSM web app
 * (polymarket.agentrix.top → /lsm/*).
 *
 * Branded to match the Agentrix main site: the SAME logo + wordmark as
 * `components/layout/L1TopNav.tsx`, a slate-950 backdrop-blur sticky header,
 * the predict sub-nav (盘口/持仓/金库/钱包/排行), a login/account link, and the
 * SAME site `<Footer/>` at the bottom of every page. Content/layout draws on
 * Polymarket / kmarket-style prediction markets.
 */
import Head from 'next/head';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { ReactNode, useEffect, useState } from 'react';
import { Activity, Wallet, ListChecks, Vault, Trophy, ShieldAlert, UserCircle2 } from 'lucide-react';
import { Footer } from '../layout/Footer';
import { isLoggedIn, gotoLogin } from './auth';
import { lsm, formatAsset, type LsmWalletBalance } from '../../services/lsm';

// Floating pet-bubble chat entry — client-only, self-lazy (mounts the heavy
// chat surface only when the user opens the panel).
const PetChatBubble = dynamic(() => import('./PetChatBubble'), { ssr: false });

export const LSM_NAV: Array<{ href: string; label: string; icon: any }> = [
  { href: '/lsm', label: '盘口', icon: Activity },
  { href: '/lsm/positions', label: '持仓', icon: ListChecks },
  { href: '/lsm/vaults', label: '金库', icon: Vault },
  { href: '/lsm/wallet', label: '钱包', icon: Wallet },
  { href: '/lsm/leaderboard', label: '排行', icon: Trophy },
];

/** Small testnet tag rendered next to the wordmark. */
export function TestnetTag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-300">
      <ShieldAlert size={12} /> Predict · 测试网/Testnet
    </span>
  );
}

/** Compact dual-asset balance shown in the header when logged in. */
function HeaderBalances() {
  const [authed, setAuthed] = useState(false);
  const [bal, setBal] = useState<LsmWalletBalance | null>(null);

  useEffect(() => {
    const ok = isLoggedIn();
    setAuthed(ok);
    if (!ok) return;
    let alive = true;
    lsm
      .walletBalance()
      .then((b) => {
        if (alive) setBal(b);
      })
      .catch(() => {
        /* non-intrusive: silently skip on error */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!authed || !bal) return null;
  return (
    <Link
      href="/lsm/wallet"
      title="平台余额"
      className="hidden items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-2.5 py-1.5 text-xs font-bold transition-colors hover:border-violet-500/50 md:inline-flex"
    >
      <span className="flex items-center gap-1 text-violet-300">
        <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-violet-400 text-[8px] font-black text-slate-950">
          A
        </span>
        {formatAsset(bal.axp, 'AXP')}
      </span>
      <span className="h-3 w-px bg-slate-700" />
      <span className="flex items-center gap-1 text-cyan-300">
        <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-cyan-400 text-[8px] font-black text-slate-950">
          $
        </span>
        {formatAsset(bal.usdc, 'USDC')}
      </span>
    </Link>
  );
}

/** Login / account control — client-only to avoid SSR auth flicker. */
function AccountLink() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => setAuthed(isLoggedIn()), []);

  if (authed) {
    return (
      <Link
        href="/lsm/positions"
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:border-violet-500/50 hover:text-white"
      >
        <UserCircle2 size={16} /> 我的账户
      </Link>
    );
  }
  return (
    <button
      onClick={() => gotoLogin()}
      className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-violet-500"
    >
      登录
    </button>
  );
}

export default function LsmLayout({
  children,
  title = '链上滚球预测市场',
  active,
}: {
  children: ReactNode;
  title?: string;
  active?: string;
}) {
  const router = useRouter();
  const current = active ?? router.pathname;

  const isActive = (href: string) =>
    href === '/lsm' ? current === '/lsm' : current.startsWith(href);

  return (
    <>
      <Head>
        <title>{title} · Agentrix Predict</title>
        <meta
          name="description"
          content="Agentrix Predict — 链上抵押稳定币（USDC）杠杆滚球预测市场（Injective EVM 测试网）。"
        />
      </Head>
      <div className="flex min-h-screen flex-col bg-slate-950 text-white">
        {/* ─── Agentrix-branded top bar ─── */}
        <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
            {/* Logo + wordmark + testnet tag */}
            <Link href="/lsm" className="flex shrink-0 items-center gap-2">
              <img src="/brand/logo-icon.png" alt="Agentrix" className="h-8 w-8 rounded-lg" />
              <span className="text-base font-bold text-white">Agentrix</span>
              <span className="hidden sm:inline-flex">
                <TestnetTag />
              </span>
            </Link>

            {/* Sub-nav */}
            <nav className="flex items-center gap-1 overflow-x-auto">
              {LSM_NAV.map((item) => {
                const Icon = item.icon;
                const on = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                      on
                        ? 'bg-slate-800 text-white border-b-2 border-violet-500'
                        : 'text-slate-400 hover:bg-slate-800/50 hover:text-white'
                    }`}
                  >
                    <Icon size={15} /> {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex shrink-0 items-center gap-2">
              <HeaderBalances />
              <AccountLink />
            </div>
          </div>
          {/* Testnet tag for narrow screens */}
          <div className="border-t border-slate-800/60 px-4 py-1.5 sm:hidden">
            <TestnetTag />
          </div>
        </header>

        <main className="w-full flex-1">
          <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
        </main>

        {/* Risk disclosure strip */}
        <div className="border-t border-slate-800 bg-slate-900/60">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500 sm:flex-row">
            <span>
              所有金额以 <span className="font-semibold text-slate-300">USDC</span> 计价 · 运行于
              Injective EVM 测试网（chainId 1439），代币无真实价值。
            </span>
            <Link href="/lsm/disclosure" className="font-semibold text-amber-300 hover:underline">
              风险披露 / Risk Disclosure
            </Link>
          </div>
        </div>

        {/* ─── Shared Agentrix site footer ─── */}
        <Footer />
      </div>

      {/* Floating pet-bubble chat entry on every /lsm page */}
      <PetChatBubble />
    </>
  );
}
