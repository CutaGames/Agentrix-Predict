/**
 * LSM (Leverage Sports Market) Web API client — Phase C standalone web app
 * (polymarket.agentrix.top). Typed wrapper over a shared axios instance with
 * JWT (Bearer from localStorage) auto-injection, mirroring the conventions in
 * `services/lsmApi.ts` / `services/marketplaceApi.ts`.
 *
 * Covers all backend `/lsm/*` endpoints plus the Phase B wallet endpoints
 * (`/lsm/wallet/*`). Orders/vaults carry an `asset` dimension (`AXP` | `USDC`,
 * default `AXP`); the dual-asset wallet balance reports both.
 */
import axios, { AxiosInstance } from 'axios';

// ---------------------------------------------------------------------------
// Base URL — SSR + client compatible (same logic as marketplaceApi)
// ---------------------------------------------------------------------------
const getApiBaseUrl = (): string => {
  if (process.env.NEXT_PUBLIC_API_URL) {
    const envUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!envUrl.endsWith('/api')) {
      return envUrl.endsWith('/') ? `${envUrl}api` : `${envUrl}/api`;
    }
    return envUrl;
  }
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.');
    if (isLocal) return 'http://localhost:3001/api';
    return `${window.location.origin}/api`;
  }
  if (process.env.BACKEND_URL) {
    const backendUrl = process.env.BACKEND_URL;
    return backendUrl.endsWith('/api') ? backendUrl : `${backendUrl.replace(/\/$/, '')}/api`;
  }
  if (process.env.NODE_ENV === 'production') return 'https://api.agentrix.top/api';
  return 'http://localhost:3001/api';
};

const http: AxiosInstance = axios.create({
  baseURL: getApiBaseUrl(),
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
  // Cross-subdomain SSO (Requirement 23): send the shared `.agentrix.top`
  // HttpOnly `agentrix_token` cookie cross-origin to api.agentrix.top so a user
  // logged in on agentrix.top is authenticated here too. Backend CORS allows
  // this origin with credentials; the JWT guard accepts the cookie. The Bearer
  // header (below) still works for same-origin login on the predict site.
  withCredentials: true,
});

http.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token =
      localStorage.getItem('access_token') ||
      localStorage.getItem('authToken') ||
      sessionStorage.getItem('authToken');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Normalize an axios error into a readable backend message string. */
export function lsmErrorMessage(e: any, fallback = '请求失败'): string {
  return e?.response?.data?.message || e?.message || fallback;
}

/**
 * Format an integer minor-unit amount for the given asset.
 *  - `AXP`  → integer points (no fractional part), e.g. `100 AXP`.
 *  - `USDC` → minor units divided by 100, 2 decimals, e.g. `1.00 USDC`.
 */
export function formatAsset(amount: number | null | undefined, asset: LsmAsset = 'AXP'): string {
  if (amount == null || Number.isNaN(amount)) return '—';
  if (asset === 'USDC') {
    const v = amount / 100;
    return `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  }
  return `${Math.round(amount).toLocaleString('en-US')} AXP`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Settlement asset for an order/vault. `AXP` is the off-chain soft-points
 * (free play / 引流); `USDC` is the on-chain stablecoin (real settlement,
 * testnet). Default is `AXP` to match the existing free-play behavior.
 */
export type LsmAsset = 'AXP' | 'USDC';

export interface LsmOddsOutcome {
  outcomeIdx: number;
  fairOdds: number;
}

export interface LsmMarketView {
  id: string;
  externalMarketId: string;
  sport: string;
  league: string | null;
  homeTeam: string;
  awayTeam: string;
  outcomeCount: number;
  status: 'pre' | 'live' | 'suspended' | 'final' | 'voided';
  kickoffAt: number | null;
  lastOddsAt: number | null;
  tradable: boolean;
  stale: boolean;
  winningOutcomeIdx: number | null;
  homeScore?: number | null;
  awayScore?: number | null;
  odds: LsmOddsOutcome[];
}

export interface LsmPreview {
  marketId: string;
  outcomeIdx: number;
  stake: number;
  leverage: number;
  fairOdds: number;
  tradableOdds: number;
  notional: number;
  maxProfit: number;
  maxLoss: number;
  winPayout: number;
  tradable: boolean;
  slippageBps: number;
}

export interface LsmOrder {
  id: string;
  marketId: string;
  outcomeIdx: number;
  stake: number;
  leverage: number;
  entryOdds: number;
  notional: number;
  maxProfit: number;
  status: 'open' | 'won' | 'lost' | 'refunded' | 'cashed_out';
  payout: number;
  closePnl: number;
  /** OPEN order mark-to-market cash-out value (integer asset minor units); null when not cashable */
  cashoutValue: number | null;
  /** Settlement asset for this order (defaults to AXP for legacy orders). */
  asset?: LsmAsset;
  createdAt: number;
  settledAt: number | null;
}

export interface LsmVaultView {
  id: string;
  kind: 'protocol' | 'user';
  name: string | null;
  leaderUserId?: string | null;
  status: 'active' | 'closing' | 'closed';
  /** Settlement asset this vault holds (defaults to AXP for legacy vaults). */
  asset?: LsmAsset;
  bankroll: number;
  reserved: number;
  equity: number;
  totalShares: number;
  nav: number;
  utilizationBps: number;
  minLeaderShareBps: number;
  profitShareBps: number;
  depositLockSecs: number;
}

export interface LsmVaultPosition {
  vaultId: string;
  shares: number;
  costBasis: number;
  isLeader: boolean;
  lockedUntil: number | null;
}

export interface LsmLeaderboardRow {
  rank: number;
  userId: string;
  value: number;
  bets: number;
}

export interface LsmOddsHistory {
  marketId: string;
  range: string;
  series: Array<{ outcomeIdx: number; points: Array<{ ts: number; odds: number }> }>;
}

export interface LsmDisclosure {
  zh: { title: string; points: string[] };
  en: { title: string; points: string[] };
  minKyc?: { bet: string; lp: string; leader: string };
}

// ── Wallet (Phase B contract) ──
/**
 * Dual-asset platform balance. Integers in each asset's minor unit:
 *  - `axp`  — AXP soft-points (minor unit = 1 point).
 *  - `usdc` — on-chain USDC (minor unit = 0.01 USDC, i.e. divide by 100 for display).
 */
export interface LsmWalletBalance {
  axp: number;
  usdc: number;
}

export interface LsmWalletDepositResult {
  credited: number;
  txHash: string;
  status: 'confirmed' | 'pending' | string;
}

export interface LsmWalletWithdrawResult {
  id: string;
  amount: number;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | string;
  txHash?: string | null;
}

function idemKey(): string {
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** AI market-making decision (LSM Phase G · Req 28 observability). */
export interface LsmMmDecision {
  vaultId: string;
  action: 'expand' | 'derisk' | 'hold' | 'halt';
  capacity: number;
  feeBidBps: number;
  reason: string;
  solvent: boolean;
  ts: number;
  utilizationBps: number;
  bankroll: number;
  reserved: number;
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export const lsm = {
  // ── Markets (public) ──
  async listLive(league?: string, limit = 50): Promise<LsmMarketView[]> {
    const { data } = await http.get('/lsm/markets/live', { params: { league, limit } });
    return data.items;
  },
  async listRecent(limit = 20): Promise<LsmMarketView[]> {
    const { data } = await http.get('/lsm/markets/recent', { params: { limit } });
    return data.items;
  },
  async getMarket(id: string): Promise<LsmMarketView> {
    const { data } = await http.get(`/lsm/markets/${encodeURIComponent(id)}`);
    return data;
  },
  async oddsHistory(
    marketId: string,
    range: 'all' | '30m' | '10m' | '5m' = 'all',
  ): Promise<LsmOddsHistory> {
    const { data } = await http.get(`/lsm/markets/${encodeURIComponent(marketId)}/odds-history`, {
      params: { range },
    });
    return data;
  },

  // ── Orders ──
  async preview(input: {
    marketId: string;
    outcomeIdx: number;
    stake: number;
    leverage: number;
    asset?: LsmAsset;
  }): Promise<LsmPreview> {
    const { data } = await http.post('/lsm/orders/preview', input);
    return data;
  },
  async place(input: {
    marketId: string;
    outcomeIdx: number;
    stake: number;
    leverage: number;
    quotedOdds: number;
    asset?: LsmAsset;
  }): Promise<{ id: string; status: string; winPayout: number }> {
    const { data } = await http.post('/lsm/orders', { ...input, idemKey: idemKey() });
    return data;
  },
  async myOrders(limit = 50): Promise<LsmOrder[]> {
    const { data } = await http.get('/lsm/me/orders', { params: { limit } });
    return data.items;
  },
  async cashOut(orderId: string): Promise<{
    id: string;
    status: string;
    payout: number;
    closePnl: number;
    cashoutValue: number;
    settledAt: number | null;
  }> {
    const { data } = await http.post(`/lsm/orders/${encodeURIComponent(orderId)}/cashout`, {});
    return data;
  },

  // ── Vaults (LP) ──
  async listVaults(kind?: 'protocol' | 'user', asset?: LsmAsset): Promise<LsmVaultView[]> {
    const { data } = await http.get('/lsm/vaults', { params: { kind, asset } });
    return data.items;
  },
  async getVault(id: string): Promise<LsmVaultView> {
    const { data } = await http.get(`/lsm/vaults/${encodeURIComponent(id)}`);
    return data;
  },
  async deposit(vaultId: string, amount: number): Promise<{ sharesMinted: number; nav: number }> {
    const { data } = await http.post('/lsm/vaults/deposit', { vaultId, amount });
    return data;
  },
  async redeem(
    vaultId: string,
    shares: number,
  ): Promise<{ payout: number; sharesBurned: number; nav: number }> {
    const { data } = await http.post('/lsm/vaults/redeem', { vaultId, shares });
    return data;
  },
  async myPositions(): Promise<LsmVaultPosition[]> {
    const { data } = await http.get('/lsm/vaults/me/positions');
    return data.items;
  },
  async disclosure(): Promise<LsmDisclosure> {
    const { data } = await http.get('/lsm/vaults/disclosure');
    return data;
  },

  // ── AI market-making agent (LSM Phase G · Req 28, observability) ──
  /** Recent AI market-making decisions (read-only observability view). */
  async mmDecisions(limit = 30): Promise<LsmMmDecision[]> {
    const { data } = await http.get('/lsm/mm-agent/decisions', { params: { limit } });
    return data.items || [];
  },

  // ── Leaderboard (public) ──
  async leaderboard(
    board: 'pnl' | 'volume' = 'pnl',
    period: 'all' | 'week' = 'all',
    limit = 20,
  ): Promise<{ board: string; period: string; items: LsmLeaderboardRow[] }> {
    const { data } = await http.get('/lsm/leaderboard', { params: { board, period, limit } });
    return data;
  },

  // ── Wallet (stablecoin deposit/withdraw — Phase B contract) ──
  /**
   * Platform balance. AXP is off-chain (chain-agnostic); USDC reflects the
   * selected settlement chain when `chainId` is provided (`?chainId=`).
   */
  async walletBalance(chainId?: number): Promise<LsmWalletBalance> {
    const { data } = await http.get('/lsm/wallet/balance', {
      params: chainId != null ? { chainId } : undefined,
    });
    return data;
  },
  /** Notify backend of an on-chain deposit tx so it can verify + credit. */
  async walletDeposit(input: { chainId: number; txHash: string }): Promise<LsmWalletDepositResult> {
    const { data } = await http.post('/lsm/wallet/deposit', input);
    return data;
  },
  /** Request a relayer-sent withdrawal of platform balance back to a wallet. */
  async walletWithdraw(input: {
    amount: number;
    toAddress: string;
    chainId?: number;
  }): Promise<LsmWalletWithdrawResult> {
    const { data } = await http.post('/lsm/wallet/withdraw', input);
    return data;
  },
};

export default lsm;
