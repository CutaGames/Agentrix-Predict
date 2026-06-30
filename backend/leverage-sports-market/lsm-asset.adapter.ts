import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AxpService } from '../axp/axp.service';
import { StableLedgerService } from './stable-ledger.service';

/**
 * 资金标的抽象层。引擎只认「资产单位」，不直接耦合 AXP。
 * v1: AxpAssetAdapter（AXP 积分，不可提现）。v2: StablecoinAssetAdapter（法务前置）。
 *
 * 所有动作整数；ref 携带幂等键 + 业务类型，落 AXP ledger。
 *
 * 需求 22（AXP 与稳定币双标的并行）：资产层从「单一 LSM_ASSET_ADAPTER 二选一」升级为
 * 「按币种路由的适配器注册表」（{@link AssetAdapterRegistry}）。AxpAssetAdapter 与
 * StablecoinAssetAdapter 同时在册，引擎按 order/vault 的 `asset` 维度路由到对应账本。
 */

/** 支持的资金标的（币种）。 */
export type LsmAsset = 'AXP' | 'USDC';

/**
 * 引擎注入令牌：保留向后兼容的「默认适配器」（按 LSM_ASSET_UNIT/LSM_STABLECOIN_ENABLED
 * 二选一）。新代码应注入 {@link AssetAdapterRegistry} 并按 `asset` 路由；本令牌仅供旧路径。
 */
export const LSM_ASSET_ADAPTER = Symbol('LSM_ASSET_ADAPTER');

/** 把任意输入规整为合法币种；空/未知一律回退 AXP（向后兼容：未指定即 AXP）。 */
export function normalizeAsset(asset?: string | null): LsmAsset {
  return (asset || '').toUpperCase() === 'USDC' ? 'USDC' : 'AXP';
}

/**
 * 当前灰度模式（LSM_ASSET_MODE）对外「提供」的币种集合，三态（需求 22.6）：
 *   - `axp`（默认 / 未设置）：仅 AXP（行为与今日完全一致）。
 *   - `usdc`：仅 USDC。
 *   - `both`：AXP + USDC 双开。
 */
export function offeredAssets(): LsmAsset[] {
  const mode = (process.env.LSM_ASSET_MODE || 'axp').toLowerCase();
  if (mode === 'usdc') return ['USDC'];
  if (mode === 'both') return ['AXP', 'USDC'];
  return ['AXP'];
}

export interface AssetRef {
  /** 幂等键（orderId / settlementId 等），重复调用不重复记账 */
  idemKey: string;
  /** 业务类型，落 note */
  kind: string;
  metadata?: Record<string, unknown>;
}

export interface AssetAdapter {
  unit(): 'AXP' | 'USDC';
  balanceOf(userId: string): Promise<number>;
  /** 扣减并锁定（下注保证金）— 失败抛错（余额不足等） */
  escrow(userId: string, amount: number, ref: AssetRef): Promise<void>;
  /** 退还（取消/退款/平局） */
  release(userId: string, amount: number, ref: AssetRef): Promise<void>;
  /** 入账（盈利派彩/赎回） */
  credit(userId: string, amount: number, ref: AssetRef): Promise<void>;
  /** 扣减（LP 出资存入） */
  debit(userId: string, amount: number, ref: AssetRef): Promise<void>;
}

/**
 * AXP 适配器。把引擎资金动作映射到 AxpService 的 spend/earn。
 *
 * 来源映射（见 axp.constants.ts）：
 *   escrow(下注保证金)  → spend  source=lsm_stake
 *   debit (LP 出资)     → spend  source=lsm_vault_deposit
 *   credit(派彩)        → earn   source=lsm_payout
 *   credit(赎回)        → earn   source=lsm_vault_redeem（按 kind 区分）
 *   release(退款)       → earn   source=lsm_refund
 *
 * 整数校验在此层强制；AxpService 内部各自开事务（P1 单侧用户记账即可原子）。
 */
@Injectable()
export class AxpAssetAdapter implements AssetAdapter {
  private readonly logger = new Logger(AxpAssetAdapter.name);

  constructor(private readonly axp: AxpService) {}

  unit(): 'AXP' | 'USDC' {
    return 'AXP';
  }

  async balanceOf(userId: string): Promise<number> {
    const v = await this.axp.getBalance(userId);
    return v.balance;
  }

  private assertInt(amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`asset amount must be a positive integer AXP, got ${amount}`);
    }
  }

  async escrow(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.axp.spend({
      userId,
      source: 'lsm_stake',
      amount,
      refId: ref.idemKey,
      note: ref.kind,
      metadata: ref.metadata,
    });
  }

  async debit(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.axp.spend({
      userId,
      source: 'lsm_vault_deposit',
      amount,
      refId: ref.idemKey,
      note: ref.kind,
      metadata: ref.metadata,
    });
  }

  async credit(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    const source = ref.kind === 'vault_redeem' ? 'lsm_vault_redeem' : 'lsm_payout';
    await this.axp.earn({
      userId,
      source,
      amount,
      refId: ref.idemKey,
      note: ref.kind,
      metadata: ref.metadata,
    });
  }

  async release(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.axp.earn({
      userId,
      source: 'lsm_refund',
      amount,
      refId: ref.idemKey,
      note: ref.kind,
      metadata: ref.metadata,
    });
  }
}

/**
 * 稳定币适配器（LSM 链上稳定币平台 Phase B · 需求 5）。引擎核心不变，仅切适配器即可
 * 把标的从 AXP 升级为 USDC。
 *
 * 已接线（移除 `STABLECOIN_TREASURY_UNWIRED` 占位）：把引擎资金动作映射到链下稳定币
 * 镜像账本 `StableLedgerService`（与 AXP 路径一致的整数口径 + `idemKey` 幂等语义）。
 * 逐笔下注只改链下镜像账本（reserved，见 design「逐笔下注不上链」）；充值/提现的链上
 * 托管由 LsmWalletService + ChainProviderService 编排，结算/周期经 SettlementGateway
 * 同步链上。本类不持有任何私钥。
 *
 * 来源映射（落 ledger.source）：
 *   escrow(下注保证金) → escrow  source=lsm_stake     （available→reserved）
 *   debit (LP 出资)    → debit   source=lsm_vault_deposit
 *   credit(派彩)       → credit  source=lsm_payout / lsm_vault_redeem（按 kind 区分）
 *   release(退款)      → release source=lsm_refund    （reserved→available）
 *
 * **默认关闭（灰度门）**：仅当 `LSM_STABLECOIN_ENABLED=1` 且 `LSM_ASSET_UNIT=USDC`
 * 时才被工厂选中；否则一律回退 AXP（行为与今日完全一致，需求 19.1）。
 */
@Injectable()
export class StablecoinAssetAdapter implements AssetAdapter {
  private readonly logger = new Logger(StablecoinAssetAdapter.name);

  constructor(private readonly stable: StableLedgerService) {}

  unit(): 'AXP' | 'USDC' {
    return 'USDC';
  }

  private assertInt(amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`asset amount must be a positive integer USDC unit, got ${amount}`);
    }
  }

  async balanceOf(userId: string): Promise<number> {
    const v = await this.stable.getBalance(userId);
    return v.available;
  }

  async escrow(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.stable.escrow({
      userId,
      source: 'lsm_stake',
      amount,
      refId: ref.idemKey,
    });
  }

  async debit(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.stable.debit({
      userId,
      source: 'lsm_vault_deposit',
      amount,
      refId: ref.idemKey,
    });
  }

  async credit(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    const source = ref.kind === 'vault_redeem' ? 'lsm_vault_redeem' : 'lsm_payout';
    await this.stable.credit({
      userId,
      source,
      amount,
      refId: ref.idemKey,
    });
  }

  async release(userId: string, amount: number, ref: AssetRef): Promise<void> {
    this.assertInt(amount);
    await this.stable.release({
      userId,
      source: 'lsm_refund',
      amount,
      refId: ref.idemKey,
    });
  }
}

/**
 * 资产适配器工厂：按 env 选择标的。默认 AXP；稳定币须 `LSM_STABLECOIN_ENABLED=1`
 * 且 `LSM_ASSET_UNIT=USDC`（法务前置开关），否则一律回退 AXP。
 */
export function assetAdapterFactory(
  axp: AxpAssetAdapter,
  stable: StablecoinAssetAdapter,
): AssetAdapter {
  const enabled = process.env.LSM_STABLECOIN_ENABLED === '1';
  const unit = (process.env.LSM_ASSET_UNIT || 'AXP').toUpperCase();
  if (enabled && unit === 'USDC') return stable;
  return axp;
}

/** 注册表注入令牌（按币种路由）。 */
export const LSM_ASSET_REGISTRY = Symbol('LSM_ASSET_REGISTRY');

/**
 * 资产适配器注册表（需求 22.1）。AxpAssetAdapter 与 StablecoinAssetAdapter 同时在册，
 * 引擎按 `asset` 维度路由到对应账本/金库；不再「二选一」。灰度由 LSM_ASSET_MODE 控制
 * 对外提供哪些币种（默认仅 AXP，行为与今日完全一致）。
 */
@Injectable()
export class AssetAdapterRegistry {
  constructor(
    private readonly axpAdapter: AxpAssetAdapter,
    private readonly stableAdapter: StablecoinAssetAdapter,
  ) {}

  /** 按币种解析适配器；未指定/未知一律回退 AXP（向后兼容）。 */
  forAsset(asset?: string | null): AssetAdapter {
    return normalizeAsset(asset) === 'USDC' ? this.stableAdapter : this.axpAdapter;
  }

  /** 当前 LSM_ASSET_MODE 对外提供的币种集合（三态）。 */
  offeredAssets(): LsmAsset[] {
    return offeredAssets();
  }

  /** 默认币种：AXP 在提供集合内则取 AXP，否则取首个提供币种。 */
  defaultAsset(): LsmAsset {
    const offered = this.offeredAssets();
    return offered.includes('AXP') ? 'AXP' : offered[0];
  }

  /**
   * 规整并校验请求币种：空 → 默认币种；非法/未提供（不在灰度集合内）→ 抛
   * `ASSET_NOT_OFFERED`。返回合法币种供下游路由。
   */
  resolveOffered(asset?: string | null): LsmAsset {
    const a = asset == null || asset === '' ? this.defaultAsset() : normalizeAsset(asset);
    if (!this.offeredAssets().includes(a)) {
      throw new BadRequestException(`ASSET_NOT_OFFERED:${a}`);
    }
    return a;
  }
}
