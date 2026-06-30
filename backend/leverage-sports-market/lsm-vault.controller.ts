import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LsmVaultService } from './lsm-vault.service';
import { LsmUnderwritingService } from './lsm-underwriting.service';
import { LsmComplianceService } from './lsm-compliance.service';
import { LsmSystemModeService } from './lsm-system-mode.service';
import { LsmVaultKind } from '../../entities/lsm-vault.entity';
import { LsmSubscriptionScopeType } from '../../entities/lsm-vault-subscription.entity';

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
  @IsString()
  @IsNotEmpty()
  vaultId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;
}
class RedeemDto {
  @IsString()
  @IsNotEmpty()
  vaultId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  shares!: number;
}
class CreateVaultDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  initialDeposit!: number;

  /** 金库币种：可选，默认 'AXP'。需求 22.3 按币种隔离。 */
  @IsOptional()
  @IsString()
  @IsIn(['AXP', 'USDC'])
  asset?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  minLeaderShareBps?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3000)
  profitShareBps?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  depositLockSecs?: number;
}
class SubscriptionDto {
  @IsString()
  @IsNotEmpty()
  vaultId!: string;

  @IsEnum(LsmSubscriptionScopeType)
  scopeType!: LsmSubscriptionScopeType;

  @IsString()
  @IsNotEmpty()
  scopeValue!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacity!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  feeBidBps!: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@ApiTags('lsm-vault')
@Controller('lsm/vaults')
export class LsmVaultController {
  constructor(
    private readonly vaultSvc: LsmVaultService,
    private readonly underwriting: LsmUnderwritingService,
    private readonly compliance: LsmComplianceService,
    private readonly systemMode: LsmSystemModeService,
  ) {}

  // ── 风险披露 / 准入说明（公开，需求 8.1、8.4） ─────────────

  @Get('disclosure')
  @ApiOperation({ summary: '风险披露与准入说明（zh/en）' })
  disclosure() {
    return this.compliance.disclosure();
  }

  // ── 公开金库列表（两类，含 NAV/利用率/条款披露） ─────────────

  @Get()
  @ApiOperation({ summary: '金库列表（官方 + 用户自建，含 NAV/利用率/主理人/分成/锁定期/币种）' })
  async list(@Query('kind') kind?: string, @Query('asset') asset?: string) {
    const k =
      kind === 'protocol'
        ? LsmVaultKind.PROTOCOL
        : kind === 'user'
          ? LsmVaultKind.USER
          : undefined;
    return { items: await this.vaultSvc.listVaults(k, asset) };
  }

  @Get(':id')
  @ApiOperation({ summary: '金库详情' })
  async detail(@Param('id') id: string) {
    return this.vaultSvc.getVault(id);
  }

  // ── LP 存赎（需登录） ────────────────────────────────────────

  @Post('deposit')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'LP 存入 AXP（按 NAV 铸份额，进入锁定期）' })
  async deposit(
    @Request() req: any,
    @Body() dto: DepositDto,
    @Headers() headers: Record<string, any>,
  ) {
    this.systemMode.assertCanDeposit();
    await this.compliance.assertCanProvideLiquidity(req.user?.id, countryFrom(headers));
    return this.vaultSvc.deposit(dto.vaultId, req.user?.id, Number(dto.amount));
  }

  @Post('redeem')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'LP 赎回份额（按 NAV 返还 AXP，受锁定期/主理人最低份额约束）' })
  async redeem(@Request() req: any, @Body() dto: RedeemDto) {
    this.systemMode.assertCanRedeem();
    return this.vaultSvc.redeem(dto.vaultId, req.user?.id, Number(dto.shares));
  }

  @Get('me/positions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '我的金库持仓' })
  async myPositions(@Request() req: any) {
    return { items: await this.vaultSvc.myPositions(req.user?.id) };
  }

  // ── 创建/管理用户金库（主理人，需登录 + 准入门禁） ───────────

  @Post('user')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建用户自建金库（主理人初始出资 + skin-in-game）' })
  async createUserVault(
    @Request() req: any,
    @Body() dto: CreateVaultDto,
    @Headers() headers: Record<string, any>,
  ) {
    this.systemMode.assertCanDeposit();
    await this.compliance.assertCanCreateVault(req.user?.id, countryFrom(headers));
    const v = await this.vaultSvc.createUserVault({
      leaderUserId: req.user?.id,
      name: dto.name,
      initialDeposit: Number(dto.initialDeposit),
      asset: dto.asset,
      minLeaderShareBps: dto.minLeaderShareBps,
      profitShareBps: dto.profitShareBps,
      depositLockSecs: dto.depositLockSecs,
    });
    return this.vaultSvc.getVault(v.id);
  }

  @Post(':id/close')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '关闭用户金库（停止承接 → 结清未结 → 按 NAV 返还 LP）' })
  async closeVault(@Request() req: any, @Param('id') id: string) {
    return this.vaultSvc.closeVault(id, req.user?.id);
  }

  // ── 承接订阅管理（主理人，需求 11.6） ────────────────────────

  @Get(':id/subscriptions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '金库承接订阅列表' })
  async listSubs(@Param('id') id: string) {
    return { items: await this.underwriting.listSubscriptions(id) };
  }

  @Post('subscriptions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '新增/更新承接订阅（联赛或单盘 + 容量 + 费率竞价）' })
  async upsertSub(@Request() req: any, @Body() dto: SubscriptionDto) {
    const vault = await this.vaultSvc.getVault(dto.vaultId);
    if (vault.leaderUserId !== req.user?.id) {
      throw new ForbiddenException('only the leader can manage subscriptions');
    }
    return this.underwriting.upsertSubscription({
      vaultId: dto.vaultId,
      scopeType: dto.scopeType,
      scopeValue: dto.scopeValue,
      capacity: Number(dto.capacity),
      feeBidBps: Number(dto.feeBidBps),
      enabled: dto.enabled,
    });
  }
}
