import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { LsmVaultService } from './lsm-vault.service';
import { LsmOrderService } from './lsm-order.service';
import { LsmReconciliationService } from './lsm-reconciliation.service';
import { LsmSystemModeService, LsmSystemMode } from './lsm-system-mode.service';

class SetModeDto {
  mode!: LsmSystemMode;
  reason?: string;
}

/**
 * LSM 运营/对账面板（P4，task 19 / 需求 9）。仅管理员。
 *  - 金库面板：两类金库 bankroll/NAV/份额/利用率/未结预留/状态。
 *  - 对账：偿付/份额/权益=份额×NAV/预留=最坏赔付和。
 *  - 反作弊信号：对敲/多账号启发式。
 *  - system-mode：查看/切换全局熔断 + 手动触发结算扫描。
 */
@ApiTags('lsm-admin')
@Controller('admin/lsm')
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class LsmAdminController {
  constructor(
    private readonly vaultSvc: LsmVaultService,
    private readonly orderSvc: LsmOrderService,
    private readonly recon: LsmReconciliationService,
    private readonly systemMode: LsmSystemModeService,
  ) {}

  @Get('vaults')
  @ApiOperation({ summary: '金库面板（两类，含 NAV/利用率/未结预留/状态）' })
  async vaults() {
    return { items: await this.vaultSvc.listVaults() };
  }

  @Get('reconcile')
  @ApiOperation({ summary: '对账报告（守恒/偿付/份额×NAV/预留=最坏赔付和）' })
  async reconcile() {
    return this.recon.reconcile();
  }

  @Get('anti-cheat')
  @ApiOperation({ summary: '反作弊信号（对敲/多账号启发式）' })
  async antiCheat(@Query('lookback') lookback?: string) {
    const n = lookback ? Math.max(50, Math.min(2000, parseInt(lookback, 10))) : 500;
    return { items: await this.recon.antiCheatSignals(n) };
  }

  @Get('system-mode')
  @ApiOperation({ summary: '查看全局交易开关（system-mode）' })
  systemModeStatus() {
    return this.systemMode.getStatus();
  }

  @Post('system-mode')
  @ApiOperation({ summary: '切换全局交易开关（normal/reduce_only/halted）' })
  setSystemMode(@Body() dto: SetModeDto) {
    this.systemMode.setMode(dto.mode, dto.reason);
    return this.systemMode.getStatus();
  }

  @Post('settle/sweep')
  @ApiOperation({ summary: '手动触发结算扫描（FINAL→结算 / VOIDED→退款，幂等）' })
  async sweep() {
    return this.orderSvc.sweepSettlements();
  }
}
