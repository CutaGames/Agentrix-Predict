import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * LSM 全局交易开关（system-mode，task 12 / 需求 4.4、6.4）。
 *
 * 沿用 KMarket system-mode 概念，作为 LSM 风控的全局熔断层（在逐金库三层敞口
 * 上限 LsmRiskService 之上）。运行期内存态可被 admin 即时切换；初值取自 env
 * `LSM_SYSTEM_MODE`。语义：
 *   - normal      正常：允许开新仓 / 存赎。
 *   - reduce_only 只减仓：禁止开新仓与新存入，仅允许结算/赎回（降低敞口）。
 *   - halted      暂停：禁止开新仓、存入、赎回（仅结算继续，保证资金正确性收敛）。
 *
 * 注意：结算（settle/refund）不受 system-mode 阻断——一旦赛果确定，必须把未结
 * 预留收敛清零以维持偿付不变量与 AXP 守恒。
 */
export enum LsmSystemMode {
  NORMAL = 'normal',
  REDUCE_ONLY = 'reduce_only',
  HALTED = 'halted',
}

@Injectable()
export class LsmSystemModeService {
  private readonly logger = new Logger(LsmSystemModeService.name);
  private mode: LsmSystemMode;
  private reason: string | null = null;
  private updatedAt: Date = new Date();

  constructor() {
    this.mode = this.parseMode(process.env.LSM_SYSTEM_MODE);
  }

  private parseMode(v?: string): LsmSystemMode {
    switch ((v || '').toLowerCase()) {
      case 'halted':
      case 'halt':
        return LsmSystemMode.HALTED;
      case 'reduce_only':
      case 'reduce-only':
      case 'reduceonly':
        return LsmSystemMode.REDUCE_ONLY;
      default:
        return LsmSystemMode.NORMAL;
    }
  }

  getMode(): LsmSystemMode {
    return this.mode;
  }

  getStatus(): { mode: LsmSystemMode; reason: string | null; updatedAt: number } {
    return { mode: this.mode, reason: this.reason, updatedAt: this.updatedAt.getTime() };
  }

  /** Admin 即时切换运行期模式。 */
  setMode(mode: LsmSystemMode, reason?: string): void {
    if (!Object.values(LsmSystemMode).includes(mode)) {
      throw new BadRequestException('invalid system mode');
    }
    this.mode = mode;
    this.reason = reason ?? null;
    this.updatedAt = new Date();
    this.logger.warn(`LSM system-mode changed → ${mode}${reason ? ` (${reason})` : ''}`);
  }

  /** 开新仓门禁：halted/reduce_only 拒绝。抛 SYSTEM_MODE_* 供前端文案映射。 */
  assertCanOpen(): void {
    if (this.mode === LsmSystemMode.HALTED) {
      throw new BadRequestException('SYSTEM_MODE_HALTED');
    }
    if (this.mode === LsmSystemMode.REDUCE_ONLY) {
      throw new BadRequestException('SYSTEM_MODE_REDUCE_ONLY');
    }
  }

  /** 存入门禁：halted/reduce_only 拒绝（不增金库敞口能力）。 */
  assertCanDeposit(): void {
    if (this.mode === LsmSystemMode.HALTED) {
      throw new BadRequestException('SYSTEM_MODE_HALTED');
    }
    if (this.mode === LsmSystemMode.REDUCE_ONLY) {
      throw new BadRequestException('SYSTEM_MODE_REDUCE_ONLY');
    }
  }

  /** 赎回门禁：仅 halted 拒绝（reduce_only 允许赎回以降敞口）。 */
  assertCanRedeem(): void {
    if (this.mode === LsmSystemMode.HALTED) {
      throw new BadRequestException('SYSTEM_MODE_HALTED');
    }
  }
}
