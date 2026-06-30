import { Injectable, Logger } from '@nestjs/common';
import { ChainProviderService, UserDeltaArg, VaultDeltaArg, TxResult } from './chain-provider.service';
import { ChainRegistry } from './chain-registry';

/**
 * 结算网关（SettlementGateway · LSM 链上稳定币平台 Phase B / 需求 21 · 迁移缝）。
 *
 * 引擎与链上结算之间的确定性边界：把引擎算好的「用户抵押 delta + 金库 bankroll/reserved
 * delta」表达为 `SettlementOp` 批量，经 relayer 调链上 `applySettlement`（按 idemKey 幂等）。
 * 逐笔下注不上链（见 design）；仅结算/派彩/退款/平仓/周期锚定时提交。
 *
 * 这是替换为链上撮合实现时引擎以外唯一需要改动的模块（需求 21.4）：当前实现 = 批量经
 * relayer 提交 balance deltas；未来可替换为链上撮合/原生订单簿实现而不动 Web/钱包/对账。
 *
 * 守恒：合约要求 ΣcollateralDelta + ΣbankrollDelta == 0（reserved 仅是 bankroll 内标记）；
 * 调用方（引擎）须保证该不变量，否则整批 revert（不静默吞错）。
 */

export interface SettlementUserOp {
  /** 用户链上地址（EVM）。 */
  user: string;
  /** 抵押 delta（内部最小整数单位，可正可负）。 */
  collateralDelta: number;
}

export interface SettlementVaultOp {
  /** 金库链上 id（bytes32）。 */
  vaultId: string;
  /** bankroll delta（内部单位，可正可负）。 */
  bankrollDelta: number;
  /** reserved delta（内部单位，可正可负）。 */
  reservedDelta: number;
}

export interface SettlementBatch {
  chainId: number;
  /** 幂等键（结算批次 id / 周期锚定 id），链上 usedIdem 去重。 */
  idemKey: string;
  userOps: SettlementUserOp[];
  vaultOps: SettlementVaultOp[];
}

export interface PushSettlementResult extends TxResult {
  idemKey: string;
  chainId: number;
}

@Injectable()
export class SettlementGatewayService {
  private readonly logger = new Logger(SettlementGatewayService.name);

  constructor(
    private readonly chain: ChainProviderService,
    private readonly registry: ChainRegistry,
  ) {}

  /**
   * 提交一批结算 delta 到链上（relayer 代发 applySettlement）。
   * chainId 缺省取 registry.defaultChainId；金额须为整数（内部单位）。
   */
  async pushSettlement(
    chainId: number | undefined,
    idemKey: string,
    userDeltas: SettlementUserOp[],
    vaultDeltas: SettlementVaultOp[],
  ): Promise<PushSettlementResult> {
    const cid = chainId ?? this.registry.defaultChainId;
    if (!idemKey) {
      return { ok: false, reason: 'missing_idem_key', idemKey, chainId: cid };
    }
    // 整数 + 守恒预检（与合约 require(net==0) 一致，提前给出可读原因，不静默吞错）。
    let net = 0n;
    for (const u of userDeltas) {
      if (!Number.isInteger(u.collateralDelta)) {
        return { ok: false, reason: 'non_integer_collateral_delta', idemKey, chainId: cid };
      }
      net += BigInt(u.collateralDelta);
    }
    for (const v of vaultDeltas) {
      if (!Number.isInteger(v.bankrollDelta) || !Number.isInteger(v.reservedDelta)) {
        return { ok: false, reason: 'non_integer_vault_delta', idemKey, chainId: cid };
      }
      net += BigInt(v.bankrollDelta);
    }
    if (net !== 0n) {
      this.logger.error(
        `pushSettlement 守恒预检失败 idem=${idemKey} net=${net.toString()}（ΣcollateralDelta+ΣbankrollDelta≠0）`,
      );
      return { ok: false, reason: `not_conservative:${net.toString()}`, idemKey, chainId: cid };
    }

    const users: UserDeltaArg[] = userDeltas.map((u) => ({
      user: u.user,
      collateralDelta: BigInt(u.collateralDelta),
    }));
    const vlts: VaultDeltaArg[] = vaultDeltas.map((v) => ({
      vaultId: v.vaultId,
      bankrollDelta: BigInt(v.bankrollDelta),
      reservedDelta: BigInt(v.reservedDelta),
    }));

    const res = await this.chain.callApplySettlement(cid, idemKey, users, vlts);
    if (!res.ok) {
      this.logger.warn(`pushSettlement 失败 idem=${idemKey} chainId=${cid}: ${res.reason}`);
    } else {
      this.logger.log(
        `pushSettlement ok idem=${idemKey} chainId=${cid} users=${users.length} vaults=${vlts.length} tx=${res.txHash}`,
      );
    }
    return { ...res, idemKey, chainId: cid };
  }

  /** 便捷重载：以 SettlementBatch 提交。 */
  async pushBatch(batch: SettlementBatch): Promise<PushSettlementResult> {
    return this.pushSettlement(batch.chainId, batch.idemKey, batch.userOps, batch.vaultOps);
  }
}
