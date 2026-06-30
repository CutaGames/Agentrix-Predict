import { Injectable, Logger } from '@nestjs/common';

/**
 * LSM 多链链/资产注册表（Phase B · 需求 4、12、18）。
 *
 * 统一描述每条结算链的 RPC、USDC token（地址 + 小数位）、CollateralVault 合约地址，
 * 以及「内部最小整数单位 ↔ USDC base unit」的换算常量 `unitScale`（1 内部单位 =
 * unitScale 个 USDC base unit；与链上合约 `unitScale` 必须一致）。
 *
 * 配置来源（优先级从高到低）：
 *   1. env `LSM_CHAINS`（JSON 数组，覆盖/新增任意链）；
 *   2. 内置默认 Injective EVM testnet(1439)，地址来自 Phase A 部署，RPC 取
 *      `INJECTIVE_EVM_TESTNET_RPC_URL`；
 *   3. 各链可经 `LSM_VAULT_CONTRACT_<chainId>` / `LSM_USDC_<chainId>` /
 *      `LSM_RPC_<chainId>` 单独覆盖地址/RPC（便于运维不动 JSON）。
 *
 * 注意：本注册表不持有私钥、不发起网络请求，纯配置解析；`getChain` 缺失返回 null，
 * 由调用方按 `X402_ONCHAIN_VERIFY_REQUIRED` 决定拒绝/降级（不静默放行）。
 */

export interface ChainTokenCfg {
  /** ERC20 合约地址 */
  address: string;
  /** 小数位（Injective USDC = 6） */
  decimals: number;
}

export interface ChainCfg {
  chainId: number;
  name: string;
  rpcUrl?: string;
  /** 可选区块浏览器 API（降级交叉核对用） */
  explorerApi?: string;
  usdc: ChainTokenCfg;
  vault: { address: string };
  /**
   * 1 内部最小整数单位 = unitScale 个 USDC base unit。
   * Injective USDC@6dec、内部单位 0.01 USDC → unitScale = 1e4 = 10000。
   * 与链上 CollateralVault.unitScale 必须一致。
   */
  unitScale: number;
}

/** Injective EVM testnet(1439) 内置默认（Phase A 部署）。 */
const INJECTIVE_EVM_TESTNET_CHAIN_ID = 1439;
const DEFAULT_INJECTIVE_VAULT = '0x760ee31334EA03c2e47900eb3c419C232b4375C0';
const DEFAULT_INJECTIVE_USDC = '0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D';
const DEFAULT_UNIT_SCALE = 10000;

@Injectable()
export class ChainRegistry {
  private readonly logger = new Logger(ChainRegistry.name);
  private readonly chains = new Map<number, ChainCfg>();
  readonly defaultChainId: number;

  constructor() {
    this.loadBuiltinDefaults();
    this.loadFromEnvJson();
    this.applyPerChainOverrides();
    this.defaultChainId = this.parseIntEnv('LSM_DEFAULT_CHAIN_ID', INJECTIVE_EVM_TESTNET_CHAIN_ID);
    const ids = [...this.chains.keys()].join(',');
    this.logger.log(
      `ChainRegistry initialized: chains=[${ids}] default=${this.defaultChainId}`,
    );
  }

  /** 返回某链配置；未登记返回 null（调用方决定拒绝/降级）。 */
  getChain(chainId: number): ChainCfg | null {
    return this.chains.get(Number(chainId)) ?? null;
  }

  /** 已登记的全部链（对账/多链遍历用）。 */
  listChains(): ChainCfg[] {
    return [...this.chains.values()];
  }

  // ── 内部加载 ────────────────────────────────────────────────

  private loadBuiltinDefaults(): void {
    const rpcUrl =
      process.env.INJECTIVE_EVM_TESTNET_RPC_URL ||
      process.env.LSM_RPC_1439 ||
      undefined;
    this.chains.set(INJECTIVE_EVM_TESTNET_CHAIN_ID, {
      chainId: INJECTIVE_EVM_TESTNET_CHAIN_ID,
      name: 'Injective EVM testnet',
      rpcUrl,
      explorerApi: process.env.INJECTIVE_EVM_TESTNET_EXPLORER_API || undefined,
      usdc: { address: DEFAULT_INJECTIVE_USDC, decimals: 6 },
      vault: { address: DEFAULT_INJECTIVE_VAULT },
      unitScale: DEFAULT_UNIT_SCALE,
    });
  }

  private loadFromEnvJson(): void {
    const raw = process.env.LSM_CHAINS;
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const arr: any[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of arr) {
        const chainId = Number(c.chainId ?? c.chain_id);
        if (!Number.isInteger(chainId) || chainId <= 0) {
          this.logger.warn(`LSM_CHAINS entry skipped: invalid chainId ${c.chainId}`);
          continue;
        }
        const existing = this.chains.get(chainId);
        const usdcAddress = c.usdc?.address ?? c.usdcAddress ?? existing?.usdc.address;
        const usdcDecimals = Number(
          c.usdc?.decimals ?? c.usdcDecimals ?? existing?.usdc.decimals ?? 6,
        );
        const vaultAddress =
          c.vault?.address ?? c.vaultContractAddress ?? c.vault ?? existing?.vault.address;
        if (!usdcAddress || !vaultAddress) {
          this.logger.warn(
            `LSM_CHAINS entry chainId=${chainId} missing usdc/vault address, skipped`,
          );
          continue;
        }
        this.chains.set(chainId, {
          chainId,
          name: c.name ?? existing?.name ?? `chain-${chainId}`,
          rpcUrl: c.rpc ?? c.rpcUrl ?? existing?.rpcUrl,
          explorerApi: c.explorer ?? c.explorerApi ?? existing?.explorerApi,
          usdc: { address: String(usdcAddress), decimals: usdcDecimals },
          vault: { address: String(vaultAddress) },
          unitScale: Number(c.unitScale ?? existing?.unitScale ?? DEFAULT_UNIT_SCALE),
        });
      }
    } catch (e: any) {
      this.logger.error(`Failed to parse LSM_CHAINS JSON: ${e?.message}`);
    }
  }

  /** 允许 `LSM_VAULT_CONTRACT_<chainId>` / `LSM_USDC_<chainId>` / `LSM_RPC_<chainId>` 覆盖。 */
  private applyPerChainOverrides(): void {
    for (const cfg of this.chains.values()) {
      const vaultOverride = process.env[`LSM_VAULT_CONTRACT_${cfg.chainId}`];
      const usdcOverride = process.env[`LSM_USDC_${cfg.chainId}`];
      const rpcOverride = process.env[`LSM_RPC_${cfg.chainId}`];
      if (vaultOverride) cfg.vault.address = vaultOverride;
      if (usdcOverride) cfg.usdc.address = usdcOverride;
      if (rpcOverride) cfg.rpcUrl = rpcOverride;
    }
  }

  private parseIntEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = parseInt(String(raw), 10);
    return Number.isNaN(n) ? fallback : n;
  }
}
