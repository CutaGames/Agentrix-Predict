/**
 * LSM multichain registry (Phase C — multichain UX).
 *
 * The LSM backend now settles USDC on two testnet chains (verified
 * `ChainRegistry chains=[1439, 97]`):
 *   - Injective EVM testnet (chainId 1439, native INJ)
 *   - BSC testnet            (chainId 97,   native tBNB)
 *
 * This module is the single source of truth the web app uses to:
 *   - render the chain selector (name + native symbol),
 *   - read the on-chain USDC (MockUSDC, 6 decimals) balance,
 *   - approve + deposit into the chain's CollateralVault,
 *   - switch / add the network in an injected wallet
 *     (`wallet_switchEthereumChain` / `wallet_addEthereumChain`),
 *   - thread the selected `chainId` into the backend wallet endpoints.
 *
 * Every field has an `NEXT_PUBLIC_*` env override so deploys can point at new
 * contract addresses / RPCs without a code change; the defaults match the
 * verified testnet deployment.
 */

/** Settlement chain ids supported by the LSM USDC flow. */
export type LsmChainId = 1439 | 97;

/** `wallet_addEthereumChain` params (EIP-3085 shape). */
export interface AddEthereumChainParams {
  chainId: string; // hex, e.g. '0x59f'
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

export interface LsmChainConfig {
  /** EVM chain id (decimal). */
  id: LsmChainId;
  /** EVM chain id (0x-prefixed hex) — used by wallet RPC methods. */
  chainIdHex: string;
  /** Human-readable network name (selector label). */
  name: string;
  /** Short label for compact UI. */
  shortName: string;
  /** JSON-RPC endpoint for direct reads (balanceOf etc.). */
  rpcUrl: string;
  /** Block explorer base URL. */
  explorerUrl: string;
  /** MockUSDC (ERC-20) token address — 6 decimals. */
  usdc: string;
  /** CollateralVault address (approve + deposit target). */
  vault: string;
  /** Native gas token symbol (INJ / tBNB). */
  nativeSymbol: string;
  /** Native gas token full name. */
  nativeName: string;
  /** Ready-to-use `wallet_addEthereumChain` params. */
  addChainParams: AddEthereumChainParams;
}

/** USDC uses 6 decimals on both chains. */
export const USDC_DECIMALS = 6;

/** Backend unit scale (USDC base unit ÷ unitScale → platform minor unit). */
export const USDC_UNIT_SCALE = 10000;

const env = (key: string): string | undefined => {
  // process.env access is statically analyzed by Next; guard for safety.
  if (typeof process === 'undefined' || !process.env) return undefined;
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
};

// ── Injective EVM testnet (1439) ──
const INJECTIVE: LsmChainConfig = {
  id: 1439,
  chainIdHex: '0x59f', // 1439
  name: 'Injective EVM Testnet',
  shortName: 'Injective',
  rpcUrl:
    env('NEXT_PUBLIC_INJECTIVE_EVM_RPC') ||
    'https://injective-testnet.g.alchemy.com/v2/vAvCiSYMxBD1e4KgGL6oh',
  explorerUrl: 'https://testnet.blockscout.injective.network',
  usdc: env('NEXT_PUBLIC_LSM_USDC_1439') || '0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D',
  vault: env('NEXT_PUBLIC_LSM_VAULT_1439') || '0x760ee31334EA03c2e47900eb3c419C232b4375C0',
  nativeSymbol: 'INJ',
  nativeName: 'Injective',
  get addChainParams(): AddEthereumChainParams {
    return {
      chainId: this.chainIdHex,
      chainName: this.name,
      nativeCurrency: { name: this.nativeName, symbol: this.nativeSymbol, decimals: 18 },
      rpcUrls: [this.rpcUrl],
      blockExplorerUrls: [this.explorerUrl],
    };
  },
};

// ── BSC testnet (97) ──
const BSC: LsmChainConfig = {
  id: 97,
  chainIdHex: '0x61', // 97
  name: 'BSC Testnet',
  shortName: 'BSC',
  rpcUrl: env('NEXT_PUBLIC_BSC_TESTNET_RPC') || 'https://bsc-testnet.publicnode.com',
  explorerUrl: 'https://testnet.bscscan.com',
  usdc: env('NEXT_PUBLIC_LSM_USDC_97') || '0x7103995D9f0B87c16964ed34Fe29AdDff8cCd5a0',
  vault: env('NEXT_PUBLIC_LSM_VAULT_97') || '0x75b7CaE3ec28b2F5aA0dD275E83Ac96Cd60cfa93',
  nativeSymbol: 'tBNB',
  nativeName: 'BNB',
  get addChainParams(): AddEthereumChainParams {
    return {
      chainId: this.chainIdHex,
      chainName: this.name,
      nativeCurrency: { name: this.nativeName, symbol: this.nativeSymbol, decimals: 18 },
      rpcUrls: [this.rpcUrl],
      blockExplorerUrls: [this.explorerUrl],
    };
  },
};

/** Registry keyed by chain id. */
export const LSM_CHAINS: Record<LsmChainId, LsmChainConfig> = {
  1439: INJECTIVE,
  97: BSC,
};

/** Ordered list for selector rendering (Injective first = default). */
export const LSM_CHAIN_LIST: LsmChainConfig[] = [INJECTIVE, BSC];

/** Default settlement chain = Injective EVM testnet. */
export const DEFAULT_LSM_CHAIN_ID: LsmChainId = 1439;

/** Type guard for supported chain ids. */
export function isSupportedChainId(id: number): id is LsmChainId {
  return id === 1439 || id === 97;
}

/**
 * Resolve a chain config by id. Throws if unsupported so callers fail loudly
 * rather than silently using the wrong contracts.
 */
export function getChainConfig(chainId: number): LsmChainConfig {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`Unsupported LSM chain id: ${chainId}`);
  }
  return LSM_CHAINS[chainId];
}
