import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { getAddress } from 'ethers';
import { UserStableLedger } from '../../entities/user-stable-ledger.entity';
import { StableLedgerService } from './stable-ledger.service';
import { ChainRegistry } from './onchain/chain-registry';
import { ChainProviderService } from './onchain/chain-provider.service';
import { AxpService } from '../axp/axp.service';

/**
 * LSM 稳定币充提服务（Phase B · 需求 6、7、18）。
 *
 * 充值：用户经合约 `deposit` 把 USDC 转入合约 → 提交 txHash → 验真（ERC20 Transfer 到
 * vault，token/确认数核对）→ 按精度换算 `credit` 到链下镜像可用余额，txHash 全局幂等。
 *
 * 提现：校验可用余额 + 合规 + 熔断 → 冻结（debit 可用余额，链上放款前先扣减镜像，保证
 * 账实一致）→ relayer 生成合约可验证签名 → relayer 代发 `requestWithdraw` → 成功落 txHash；
 * 失败补偿（credit 回滚冻结）。提现 nonce 唯一防重放（合约 usedWithdrawNonce 二次兜底）。
 *
 * 精度（需求 18）：internal = floor(baseAmount / unitScale)；baseAmount = internal * unitScale。
 * unitScale 取自 ChainRegistry（Injective EVM testnet = 10000）。引擎/账本只见整数内部单位。
 */
@Injectable()
export class LsmWalletService {
  private readonly logger = new Logger(LsmWalletService.name);

  constructor(
    private readonly stable: StableLedgerService,
    private readonly registry: ChainRegistry,
    private readonly chain: ChainProviderService,
    private readonly axp: AxpService,
    @InjectRepository(UserStableLedger)
    private readonly ledger: Repository<UserStableLedger>,
  ) {}

  // ── 余额 ────────────────────────────────────────────────────

  async getBalance(userId: string, chainId?: number) {
    const cid = chainId ?? this.registry.defaultChainId;
    const cfg = this.registry.getChain(cid);
    const view = await this.stable.getBalance(userId, cid);
    // 双标的余额（需求 22.4）：AXP 经 AxpService，USDC 经稳定币镜像账本。
    // 两者均为各自最小整数单位；保留既有稳定币字段向后兼容。
    const axpView = await this.axp.getBalance(userId);
    return {
      chainId: cid,
      unit: 'USDC',
      decimals: cfg?.usdc.decimals ?? 6,
      unitScale: cfg?.unitScale ?? null,
      available: view.available,
      reserved: view.reserved,
      updated_at: view.updated_at,
      // 双标的整数余额（前端按所选币种展示）。
      axp: axpView.balance,
      usdc: view.available,
    };
  }

  // ── 充值 ────────────────────────────────────────────────────

  /**
   * 校验某 txHash 的链上充值，按精度换算入账。txHash 全局幂等（同一笔不重复入账）。
   */
  async deposit(userId: string, chainId: number | undefined, txHash: string) {
    const cid = chainId ?? this.registry.defaultChainId;
    const cfg = this.registry.getChain(cid);
    if (!cfg) {
      throw new BadRequestException(`chain_not_configured:${cid}`);
    }
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new BadRequestException('invalid_tx_hash');
    }

    // txHash 全局幂等：同一笔交易无论谁提交都只入账一次。
    const existing = await this.ledger.findOne({ where: { txHash, source: 'lsm_deposit' } });
    if (existing) {
      const view = await this.stable.getBalance(existing.userId, cid);
      return {
        ok: true,
        idempotent: true,
        txHash,
        chainId: cid,
        credited: 0,
        available: view.available,
      };
    }

    const verify = await this.chain.verifyTokenTransfer({
      chainId: cid,
      txHash,
      expectedTo: cfg.vault.address,
      tokenAddress: cfg.usdc.address,
      minAmount: 1n,
    });
    if (!verify.ok || verify.amount === undefined) {
      throw new BadRequestException(`deposit_verify_failed:${verify.reason ?? 'unknown'}`);
    }

    const baseAmount = verify.amount;
    const unitScale = BigInt(cfg.unitScale);
    const internal = Number(baseAmount / unitScale); // floor，dust 留尾在合约
    if (internal <= 0) {
      throw new BadRequestException('deposit_dust_only');
    }

    const res = await this.stable.credit({
      userId,
      chainId: cid,
      amount: internal,
      source: 'lsm_deposit',
      refId: txHash,
      txHash,
    });
    this.logger.log(
      `deposit credited user=${userId} chainId=${cid} base=${baseAmount} internal=${internal} tx=${txHash}`,
    );
    return {
      ok: true,
      idempotent: false,
      txHash,
      chainId: cid,
      credited: internal,
      available: res.available,
    };
  }

  // ── 提现 ────────────────────────────────────────────────────

  /**
   * 发起提现（relayer 代发）。amount 为内部最小整数单位；toAddress 为目标 EVM 地址。
   * 步骤：校验余额 → 冻结（debit）→ relayer 签名 → 代发 → 成功落 txHash / 失败补偿（credit）。
   */
  async withdraw(
    userId: string,
    amount: number,
    toAddress: string,
    chainId?: number,
  ): Promise<{
    ok: boolean;
    txHash?: string;
    reason?: string;
    chainId: number;
    nonce: string;
    available: number;
  }> {
    const cid = chainId ?? this.registry.defaultChainId;
    const cfg = this.registry.getChain(cid);
    if (!cfg) {
      throw new BadRequestException(`chain_not_configured:${cid}`);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive integer');
    }
    let to: string;
    try {
      to = getAddress(toAddress);
    } catch {
      throw new BadRequestException('invalid_to_address');
    }

    // relayer 不可用时拒绝（不静默吞错）。
    if (!this.chain.getRelayerAddress()) {
      throw new BadRequestException('relayer_unavailable');
    }

    const bal = await this.stable.getBalance(userId, cid);
    if (bal.available < amount) {
      throw new BadRequestException(
        `insufficient_balance:have ${bal.available} need ${amount}`,
      );
    }

    // 唯一提现 id + nonce（防重放；合约 usedWithdrawNonce 二次兜底）。
    const withdrawId = `wd_${Date.now()}_${randomBytes(8).toString('hex')}`;
    const nonce = BigInt('0x' + randomBytes(8).toString('hex'));

    // 冻结：先扣减镜像可用余额（链上放款前），保证账实一致。
    await this.stable.debit({
      userId,
      chainId: cid,
      amount,
      source: 'lsm_withdraw',
      refId: withdrawId,
    });

    const internalAmount = BigInt(amount);
    try {
      const sig = await this.chain.signWithdraw(cid, to, to, internalAmount, nonce);
      // 说明：合约按 user 字段扣减链上 collateral。Phase B relayer 代发模型下，
      // 链上 user==to（用户自己的钱包地址即抵押持有者）。
      if (!sig) {
        throw new Error('sign_withdraw_failed');
      }
      const tx = await this.chain.sendWithdraw(cid, to, internalAmount, to, nonce, sig);
      if (!tx.ok) {
        throw new Error(tx.reason ?? 'send_withdraw_failed');
      }
      // 成功：把 txHash 落到原冻结流水的后继记录（保留审计）。
      await this.recordWithdrawTx(userId, cid, withdrawId, tx.txHash ?? null);
      this.logger.log(
        `withdraw ok user=${userId} chainId=${cid} amount=${amount} to=${to} tx=${tx.txHash}`,
      );
      const after = await this.stable.getBalance(userId, cid);
      return {
        ok: true,
        txHash: tx.txHash,
        chainId: cid,
        nonce: nonce.toString(),
        available: after.available,
      };
    } catch (e: any) {
      // 失败补偿：解冻（credit 回滚），账实一致。
      const reason = e?.message ?? 'withdraw_failed';
      this.logger.error(
        `withdraw failed user=${userId} chainId=${cid} amount=${amount}: ${reason}，补偿解冻`,
      );
      await this.stable.credit({
        userId,
        chainId: cid,
        amount,
        source: 'lsm_withdraw_refund',
        refId: withdrawId,
      });
      const after = await this.stable.getBalance(userId, cid);
      return {
        ok: false,
        reason,
        chainId: cid,
        nonce: nonce.toString(),
        available: after.available,
      };
    }
  }

  /** 把成功的 txHash 标记到提现冻结流水（best-effort 审计，不影响余额）。 */
  private async recordWithdrawTx(
    userId: string,
    chainId: number,
    withdrawId: string,
    txHash: string | null,
  ): Promise<void> {
    if (!txHash) return;
    try {
      await this.ledger.update(
        { userId, chainId, source: 'lsm_withdraw', refId: withdrawId },
        { txHash },
      );
    } catch (e: any) {
      this.logger.warn(`recordWithdrawTx 失败 withdrawId=${withdrawId}: ${e?.message}`);
    }
  }
}
