import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LsmWalletService } from './lsm-wallet.service';
import { LsmComplianceService } from './lsm-compliance.service';
import { LsmSystemModeService } from './lsm-system-mode.service';

/** 从 CDN/反代请求头解析国家码（cf-ipcountry / x-country）。 */
function countryFrom(headers: Record<string, any>): string | null {
  return (
    (headers['cf-ipcountry'] as string) ||
    (headers['x-country'] as string) ||
    (headers['x-vercel-ip-country'] as string) ||
    null
  );
}

// 注意：全局 ValidationPipe 启用了 whitelist + forbidNonWhitelisted，
// DTO 字段必须带 class-validator 装饰器，否则会被判为非白名单并拒绝请求。
class DepositDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: 'invalid tx hash' })
  txHash!: string;
}

class WithdrawDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'invalid address' })
  toAddress!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chainId?: number;
}

/**
 * LSM 稳定币钱包控制器（Phase B · 需求 6、7、20）。
 *   GET  /lsm/wallet/balance       — 链下镜像稳定币余额（available/reserved）。
 *   POST /lsm/wallet/deposit       — 提交链上充值 txHash，验真后入账（幂等）。
 *   POST /lsm/wallet/withdraw      — 发起提现（合规 + 熔断门禁，relayer 代发）。
 * 守卫/门禁与 lsm-vault.controller 一致（JwtAuthGuard + compliance + systemMode）。
 */
@ApiTags('lsm-wallet')
@Controller('lsm/wallet')
export class LsmWalletController {
  constructor(
    private readonly wallet: LsmWalletService,
    private readonly compliance: LsmComplianceService,
    private readonly systemMode: LsmSystemModeService,
  ) {}

  @Get('balance')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '稳定币余额（available/reserved，内部整数单位）' })
  async balance(@Request() req: any, @Query('chainId') chainId?: string) {
    const cid = chainId !== undefined ? Number(chainId) : undefined;
    return this.wallet.getBalance(req.user?.id, cid);
  }

  @Post('deposit')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '充值入账（提交链上 txHash，验真后按精度 credit，幂等）' })
  async deposit(
    @Request() req: any,
    @Body() dto: DepositDto,
    @Headers() headers: Record<string, any>,
  ) {
    // 充值受合规门禁与系统熔断约束（需求 6.2、20.1）。
    this.systemMode.assertCanDeposit();
    await this.compliance.assertCanProvideLiquidity(req.user?.id, countryFrom(headers));
    return this.wallet.deposit(req.user?.id, dto.chainId, dto.txHash);
  }

  @Post('withdraw')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '提现（校验余额+合规+熔断 → 冻结 → relayer 签名代发 → 落 txHash）' })
  async withdraw(
    @Request() req: any,
    @Body() dto: WithdrawDto,
    @Headers() headers: Record<string, any>,
  ) {
    // 提现受合规门禁与系统熔断约束（需求 7.4、20.1）。仅 halted 阻断赎回类资金流出。
    this.systemMode.assertCanRedeem();
    await this.compliance.assertCanProvideLiquidity(req.user?.id, countryFrom(headers));
    return this.wallet.withdraw(req.user?.id, Number(dto.amount), dto.toAddress, dto.chainId);
  }
}
