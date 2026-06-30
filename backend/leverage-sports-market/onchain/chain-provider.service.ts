import { Injectable, Logger } from '@nestjs/common';
import {
  JsonRpcProvider,
  Network,
  Wallet,
  Contract,
  id as keccakId,
  getAddress,
  dataSlice,
  solidityPackedKeccak256,
  getBytes,
  TransactionReceipt,
} from 'ethers';
import { ChainRegistry, ChainCfg } from './chain-registry';

/**
 * LSM 多链链上读写服务（Phase B · 需求 4、6、7）。
 *
 * 职责：
 *  - 维护 per-chain ethers v6 JsonRpcProvider（按 chainId 路由，不写死单一 RPC）。
 *  - `verifyTokenTransfer` 复用 payment/onchain-verifier 的 ERC20 Transfer 解析口径，
 *    核对 token/to/value/确认数（不改动也不依赖那个共享服务，独立 LSM-scoped 实现）。
 *  - 持有 relayer Wallet（私钥取自 env `RELAYER_PRIVATE_KEY`），每链一个绑定 provider
 *    的签名钱包 + CollateralVault Contract 实例。
 *  - 结算/提现写：`callApplySettlement`、`signWithdraw`（EIP-191 personal-sign）、
 *    `sendWithdraw`（relayer 代发）。
 *  - 只读视图：`getOnchainCollateral`、`getVault`、`isSolvent`、`totalLiabilities`。
 *
 * 设计：链/RPC 未配置时优雅降级（返回结构化原因/抛带前缀错误），不静默放行；
 * 私钥只在后端，绝不下发前端。
 */

// ERC20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_EVENT_TOPIC = keccakId('Transfer(address,address,uint256)');

/** CollateralVault 关键 ABI（与 contract/contracts/CollateralVault.sol 一致）。 */
const COLLATERAL_VAULT_ABI = [
  'function deposit(uint256 baseAmount)',
  'function requestWithdraw(address user, uint256 internalAmount, address to, uint256 nonce, bytes sig)',
  'function depositLiquidity(bytes32 vaultId, uint256 amount)',
  'function redeemLiquidity(bytes32 vaultId, uint256 shares)',
  'function applySettlement(bytes32 idemKey, (address user, int256 collateralDelta)[] users, (bytes32 vaultId, int256 bankrollDelta, int256 reservedDelta)[] vlts)',
  'function collateral(address) view returns (uint256)',
  'function totalCollateral() view returns (uint256)',
  'function totalVaultBankroll() view returns (uint256)',
  'function vaults(bytes32) view returns (uint256 bankroll, uint256 reserved, uint256 totalShares, uint256 highWaterNav, uint16 profitShareBps, bool exists)',
  'function totalLiabilities() view returns (uint256)',
  'function isSolvent() view returns (bool)',
  'function navFixed(bytes32 vaultId) view returns (uint256)',
  'function usedWithdrawNonce(uint256) view returns (bool)',
  'function usedIdem(bytes32) view returns (bool)',
  'function unitScale() view returns (uint256)',
];

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

export interface VerifyTokenTransferInput {
  chainId: number;
  txHash: string;
  expectedTo: string;
  minAmount: bigint;
  tokenAddress: string;
}

export interface VerifyTokenTransferResult {
  ok: boolean;
  reason?: string;
  confirmations: number;
  amount?: bigint;
}

export interface UserDeltaArg {
  user: string;
  collateralDelta: bigint;
}
export interface VaultDeltaArg {
  vaultId: string;
  bankrollDelta: bigint;
  reservedDelta: bigint;
}

export interface OnchainVaultView {
  bankroll: bigint;
  reserved: bigint;
  totalShares: bigint;
  highWaterNav: bigint;
  profitShareBps: number;
  exists: boolean;
}

export interface TxResult {
  ok: boolean;
  txHash?: string;
  reason?: string;
}

@Injectable()
export class ChainProviderService {
  private readonly logger = new Logger(ChainProviderService.name);
  private readonly providers = new Map<number, JsonRpcProvider>();
  private readonly wallets = new Map<number, Wallet>();
  private readonly vaultContracts = new Map<number, Contract>();
  private readonly relayerKey?: string;
  private readonly minConfirmations: number;

  constructor(private readonly registry: ChainRegistry) {
    this.relayerKey = process.env.RELAYER_PRIVATE_KEY || undefined;
    this.minConfirmations = this.parseIntEnv('X402_MIN_CONFIRMATIONS', 1);
    if (!this.relayerKey) {
      this.logger.warn(
        'RELAYER_PRIVATE_KEY 未配置：结算/签名提现/代发将不可用（只读验真仍可用）',
      );
    }
  }

  // ── provider / wallet / contract 懒加载 ─────────────────────

  getProvider(chainId: number): JsonRpcProvider | null {
    const existing = this.providers.get(chainId);
    if (existing) return existing;
    const cfg = this.registry.getChain(chainId);
    if (!cfg?.rpcUrl) {
      this.logger.warn(`chainId=${chainId} 未配置 RPC，provider 不可用`);
      return null;
    }
    try {
      const network = new Network(cfg.name || `chain-${chainId}`, chainId);
      const provider = new JsonRpcProvider(cfg.rpcUrl, network);
      this.providers.set(chainId, provider);
      return provider;
    } catch (e: any) {
      this.logger.error(`初始化 provider 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  getRelayerWallet(chainId: number): Wallet | null {
    if (!this.relayerKey) return null;
    const existing = this.wallets.get(chainId);
    if (existing) return existing;
    const provider = this.getProvider(chainId);
    if (!provider) return null;
    try {
      const wallet = new Wallet(this.relayerKey, provider);
      this.wallets.set(chainId, wallet);
      return wallet;
    } catch (e: any) {
      this.logger.error(`初始化 relayer wallet 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  /** relayer 地址（不暴露私钥），用于校验/日志。 */
  getRelayerAddress(): string | null {
    if (!this.relayerKey) return null;
    try {
      return new Wallet(this.relayerKey).address;
    } catch {
      return null;
    }
  }

  private getVaultContract(chainId: number, requireSigner = false): Contract | null {
    const cfg = this.registry.getChain(chainId);
    if (!cfg) return null;
    if (requireSigner) {
      const wallet = this.getRelayerWallet(chainId);
      if (!wallet) return null;
      // signer-bound 合约不缓存到只读 map（避免读写混用），每次新建即可。
      return new Contract(cfg.vault.address, COLLATERAL_VAULT_ABI, wallet);
    }
    const existing = this.vaultContracts.get(chainId);
    if (existing) return existing;
    const provider = this.getProvider(chainId);
    if (!provider) return null;
    const c = new Contract(cfg.vault.address, COLLATERAL_VAULT_ABI, provider);
    this.vaultContracts.set(chainId, c);
    return c;
  }

  // ── 验真（ERC20 Transfer，多链路由）─────────────────────────

  async verifyTokenTransfer(
    input: VerifyTokenTransferInput,
  ): Promise<VerifyTokenTransferResult> {
    const { chainId, txHash, expectedTo, minAmount, tokenAddress } = input;
    if (!txHash || typeof txHash !== 'string') {
      return { ok: false, reason: 'missing_tx_hash', confirmations: 0 };
    }
    const cfg = this.registry.getChain(chainId);
    if (!cfg) {
      return { ok: false, reason: `chain_not_configured:${chainId}`, confirmations: 0 };
    }
    const provider = this.getProvider(chainId);
    if (!provider) {
      return {
        ok: false,
        reason: `rpc_not_configured:${chainId}`,
        confirmations: 0,
      };
    }

    try {
      let receipt: TransactionReceipt | null = null;
      try {
        receipt = await provider.getTransactionReceipt(txHash);
      } catch (rpcErr: any) {
        this.logger.warn(`getTransactionReceipt 失败 txHash=${txHash}: ${rpcErr?.message}`);
      }
      if (!receipt) {
        return { ok: false, reason: 'receipt_not_found', confirmations: 0 };
      }
      if (receipt.status !== 1) {
        return { ok: false, reason: 'tx_failed_status', confirmations: 0 };
      }
      const currentBlock = await provider.getBlockNumber();
      const confirmations = Math.max(0, currentBlock - receipt.blockNumber + 1);
      if (confirmations < this.minConfirmations) {
        return {
          ok: false,
          reason: `insufficient_confirmations:${confirmations}<${this.minConfirmations}`,
          confirmations,
        };
      }
      const match = this.findMatchingTransfer(
        receipt.logs,
        tokenAddress,
        expectedTo,
        minAmount,
      );
      if (!match.found) {
        return { ok: false, reason: match.reason, confirmations };
      }
      return { ok: true, confirmations, amount: match.amount };
    } catch (e: any) {
      this.logger.error(`verifyTokenTransfer 异常 txHash=${txHash}: ${e?.message}`);
      return { ok: false, reason: `verify_error:${e?.message}`, confirmations: 0 };
    }
  }

  private findMatchingTransfer(
    logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
    tokenAddress: string,
    expectedTo: string,
    minAmount: bigint,
  ): { found: boolean; amount?: bigint; reason?: string } {
    let normToken: string;
    let normExpectedTo: string;
    try {
      normToken = getAddress(tokenAddress);
      normExpectedTo = getAddress(expectedTo);
    } catch {
      return { found: false, reason: 'invalid_address_argument' };
    }
    let sawTokenTransfer = false;
    for (const log of logs || []) {
      if (!log?.topics || log.topics.length < 3) continue;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC.toLowerCase()) continue;
      let logToken: string;
      try {
        logToken = getAddress(log.address);
      } catch {
        continue;
      }
      if (logToken !== normToken) continue;
      sawTokenTransfer = true;
      let to: string;
      try {
        to = getAddress(dataSlice(log.topics[2], 12));
      } catch {
        continue;
      }
      if (to !== normExpectedTo) continue;
      let value: bigint;
      try {
        value = BigInt(log.data);
      } catch {
        continue;
      }
      if (value >= minAmount) {
        return { found: true, amount: value };
      }
    }
    return {
      found: false,
      reason: sawTokenTransfer ? 'amount_or_recipient_mismatch' : 'no_matching_transfer_log',
    };
  }

  // ── 结算写（relayer 调 applySettlement）─────────────────────

  async callApplySettlement(
    chainId: number,
    idemKey: string,
    users: UserDeltaArg[],
    vlts: VaultDeltaArg[],
  ): Promise<TxResult> {
    const contract = this.getVaultContract(chainId, true);
    if (!contract) {
      return { ok: false, reason: this.writeUnavailableReason(chainId) };
    }
    try {
      const userTuples = users.map((u) => [u.user, u.collateralDelta] as const);
      const vaultTuples = vlts.map(
        (v) => [v.vaultId, v.bankrollDelta, v.reservedDelta] as const,
      );
      const tx = await contract.applySettlement(idemKey, userTuples, vaultTuples);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        return { ok: false, txHash: tx.hash, reason: 'tx_failed_status' };
      }
      return { ok: true, txHash: tx.hash };
    } catch (e: any) {
      this.logger.error(`callApplySettlement 失败 chainId=${chainId} idem=${idemKey}: ${e?.message}`);
      return { ok: false, reason: `apply_settlement_error:${e?.shortMessage ?? e?.message}` };
    }
  }

  // ── 提现签名 + 代发 ─────────────────────────────────────────

  /**
   * 生成 relayer 对 (vault, chainId, user, to, internalAmount, nonce) 的 EIP-191 签名。
   * 与合约 `keccak256(abi.encodePacked(address(this),block.chainid,user,to,internalAmount,nonce))`
   * + `toEthSignedMessageHash` 校验口径一致。
   */
  async signWithdraw(
    chainId: number,
    user: string,
    to: string,
    internalAmount: bigint,
    nonce: bigint,
  ): Promise<string | null> {
    const wallet = this.getRelayerWallet(chainId);
    const cfg = this.registry.getChain(chainId);
    if (!wallet || !cfg) return null;
    try {
      const digest = solidityPackedKeccak256(
        ['address', 'uint256', 'address', 'address', 'uint256', 'uint256'],
        [cfg.vault.address, BigInt(chainId), user, to, internalAmount, nonce],
      );
      // personal_sign over the 32-byte digest（ethers 自动套 EIP-191 前缀，对齐合约 toEthSignedMessageHash）。
      return await wallet.signMessage(getBytes(digest));
    } catch (e: any) {
      this.logger.error(`signWithdraw 失败 chainId=${chainId} user=${user}: ${e?.message}`);
      return null;
    }
  }

  /** relayer 代发提现交易（凭已生成的签名调 requestWithdraw）。 */
  async sendWithdraw(
    chainId: number,
    user: string,
    internalAmount: bigint,
    to: string,
    nonce: bigint,
    sig: string,
  ): Promise<TxResult> {
    const contract = this.getVaultContract(chainId, true);
    if (!contract) {
      return { ok: false, reason: this.writeUnavailableReason(chainId) };
    }
    try {
      const tx = await contract.requestWithdraw(user, internalAmount, to, nonce, sig);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        return { ok: false, txHash: tx.hash, reason: 'tx_failed_status' };
      }
      return { ok: true, txHash: tx.hash };
    } catch (e: any) {
      this.logger.error(`sendWithdraw 失败 chainId=${chainId} user=${user}: ${e?.message}`);
      return { ok: false, reason: `send_withdraw_error:${e?.shortMessage ?? e?.message}` };
    }
  }

  // ── 只读视图 ────────────────────────────────────────────────

  /** 用户链上可用抵押（内部单位）。 */
  async getOnchainCollateral(chainId: number, user: string): Promise<bigint | null> {
    const contract = this.getVaultContract(chainId);
    if (!contract) return null;
    try {
      return BigInt(await contract.collateral(user));
    } catch (e: any) {
      this.logger.warn(`getOnchainCollateral 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  async getVault(chainId: number, vaultId: string): Promise<OnchainVaultView | null> {
    const contract = this.getVaultContract(chainId);
    if (!contract) return null;
    try {
      const v = await contract.vaults(vaultId);
      return {
        bankroll: BigInt(v.bankroll ?? v[0]),
        reserved: BigInt(v.reserved ?? v[1]),
        totalShares: BigInt(v.totalShares ?? v[2]),
        highWaterNav: BigInt(v.highWaterNav ?? v[3]),
        profitShareBps: Number(v.profitShareBps ?? v[4]),
        exists: Boolean(v.exists ?? v[5]),
      };
    } catch (e: any) {
      this.logger.warn(`getVault 失败 chainId=${chainId} vault=${vaultId}: ${e?.message}`);
      return null;
    }
  }

  async isSolvent(chainId: number): Promise<boolean | null> {
    const contract = this.getVaultContract(chainId);
    if (!contract) return null;
    try {
      return Boolean(await contract.isSolvent());
    } catch (e: any) {
      this.logger.warn(`isSolvent 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  /** 内部总负债（内部单位 = totalCollateral + totalVaultBankroll）。 */
  async totalLiabilities(chainId: number): Promise<bigint | null> {
    const contract = this.getVaultContract(chainId);
    if (!contract) return null;
    try {
      return BigInt(await contract.totalLiabilities());
    } catch (e: any) {
      this.logger.warn(`totalLiabilities 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  /** 合约持有的 USDC base unit 余额（对账用）。 */
  async getVaultUsdcBalance(chainId: number): Promise<bigint | null> {
    const cfg = this.registry.getChain(chainId);
    const provider = this.getProvider(chainId);
    if (!cfg || !provider) return null;
    try {
      const token = new Contract(cfg.usdc.address, ERC20_BALANCE_ABI, provider);
      return BigInt(await token.balanceOf(cfg.vault.address));
    } catch (e: any) {
      this.logger.warn(`getVaultUsdcBalance 失败 chainId=${chainId}: ${e?.message}`);
      return null;
    }
  }

  /** 查询提现 nonce 是否已用（防重放，落单前可选检查）。 */
  async isWithdrawNonceUsed(chainId: number, nonce: bigint): Promise<boolean | null> {
    const contract = this.getVaultContract(chainId);
    if (!contract) return null;
    try {
      return Boolean(await contract.usedWithdrawNonce(nonce));
    } catch {
      return null;
    }
  }

  private writeUnavailableReason(chainId: number): string {
    if (!this.relayerKey) return 'relayer_key_not_configured';
    if (!this.registry.getChain(chainId)) return `chain_not_configured:${chainId}`;
    return `rpc_not_configured:${chainId}`;
  }

  private parseIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = parseInt(String(raw), 10);
    return Number.isNaN(n) ? fallback : n;
  }
}
