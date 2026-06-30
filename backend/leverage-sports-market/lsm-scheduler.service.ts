import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LsmOrderService } from './lsm-order.service';
import { LsmVaultService } from './lsm-vault.service';

/**
 * LSM 后台编排调度（P3/P4，task 16 触发器 + 结算闭环）。
 *
 * 三项周期任务（生产经 ScheduleModule 驱动；测试可直驱 public 方法）：
 *  - 结算扫描：FINAL+赛果 → settleMarket；VOIDED → refundMarket（幂等）。
 *  - 主理人分成计提：对 active 用户金库按高水位计提（仅创新高，幂等不重复）。
 *  - 关闭金库清算：对 closing 且 reserved==0 的金库按 NAV 返还 LP 并置 closed。
 *
 * 经 env `LSM_SCHEDULER_DISABLED=1` 可整体停用（如灰度/演练）。
 */
@Injectable()
export class LsmSchedulerService {
  private readonly logger = new Logger(LsmSchedulerService.name);

  constructor(
    private readonly orderSvc: LsmOrderService,
    private readonly vaultSvc: LsmVaultService,
  ) {}

  private get disabled(): boolean {
    return process.env.LSM_SCHEDULER_DISABLED === '1';
  }

  /** 结算扫描：每分钟。 */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'lsm-settlement-sweep' })
  async settlementTick(): Promise<void> {
    if (this.disabled) return;
    try {
      const r = await this.orderSvc.sweepSettlements();
      if (r.settledMarkets + r.refundedMarkets > 0) {
        this.logger.log(
          `settlement sweep: settled=${r.settledMarkets}(won=${r.wonOrders},lost=${r.lostOrders}) refunded=${r.refundedMarkets}(${r.refundedOrders}) errors=${r.errors}`,
        );
      }
    } catch (e) {
      this.logger.error(`settlement sweep failed: ${(e as Error).message}`);
    }
  }

  /** 关闭金库清算扫描：每 5 分钟（结算后预留归零的 closing 金库收尾）。 */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'lsm-close-finalize' })
  async closeFinalizeTick(): Promise<void> {
    if (this.disabled) return;
    try {
      const ids = await this.vaultSvc.listClosingVaultIds();
      for (const id of ids) {
        try {
          const r = await this.vaultSvc.finalizeCloseIfReady(id);
          if (r.closed) this.logger.log(`vault ${id} finalized (payouts=${r.payouts})`);
        } catch (e) {
          this.logger.error(`finalize vault ${id} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.error(`close finalize sweep failed: ${(e as Error).message}`);
    }
  }

  /** 主理人高水位分成计提：每小时（仅 active 用户金库；computeProfitFee 幂等不重复）。 */
  @Cron(CronExpression.EVERY_HOUR, { name: 'lsm-profit-fee-accrual' })
  async profitFeeTick(): Promise<void> {
    if (this.disabled) return;
    try {
      const ids = await this.vaultSvc.listActiveUserVaultIds();
      let minted = 0;
      for (const id of ids) {
        try {
          const r = await this.vaultSvc.accrueProfitFee(id);
          if (r.leaderSharesMinted > 0) minted += 1;
        } catch (e) {
          this.logger.error(`accrue fee vault ${id} failed: ${(e as Error).message}`);
        }
      }
      if (minted > 0) this.logger.log(`profit-fee accrual: ${minted} vault(s) accrued`);
    } catch (e) {
      this.logger.error(`profit-fee sweep failed: ${(e as Error).message}`);
    }
  }
}
