import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Request,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LsmMarketService } from './lsm-market.service';
import { LsmOrderService } from './lsm-order.service';
import { LsmFeedService } from './lsm-feed.service';
import { LsmLeaderboardService } from './lsm-leaderboard.service';
import { LsmMmAgentService } from './mm-agent/lsm-mm-agent.service';
import { FeedBatchPayload } from './lsm-feed.types';

// 注意：全局 ValidationPipe 启用了 whitelist + forbidNonWhitelisted，
// DTO 字段必须带 class-validator 装饰器，否则会被判为非白名单并拒绝请求。
class PreviewDto {
  @IsString()
  @IsNotEmpty()
  marketId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  outcomeIdx!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  stake!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  leverage!: number;

  /** 资金标的（币种）：可选，默认 'AXP'。需求 22。 */
  @IsOptional()
  @IsString()
  @IsIn(['AXP', 'USDC'])
  asset?: string;
}

class PlaceDto extends PreviewDto {
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quotedOdds!: number;

  @IsString()
  @IsNotEmpty()
  idemKey!: string;
}

@ApiTags('leverage-sports-market')
@Controller('lsm')
export class LsmController {
  constructor(
    private readonly marketSvc: LsmMarketService,
    private readonly orderSvc: LsmOrderService,
    private readonly feed: LsmFeedService,
    private readonly leaderboard: LsmLeaderboardService,
    private readonly mmAgent: LsmMmAgentService,
  ) {}

  // ── 排行榜（公开，运营位，task 20 / 需求 1.2） ─────────────

  @Get('leaderboard')
  @ApiOperation({ summary: '排行榜（pnl 盈利王 / volume 成交量王；all/week）' })
  async getLeaderboard(
    @Query('board') board?: string,
    @Query('period') period?: string,
    @Query('limit') limit?: string,
  ) {
    const b = board === 'volume' ? 'volume' : 'pnl';
    const p = period === 'week' ? 'week' : 'all';
    const n = limit ? Math.max(1, Math.min(100, parseInt(limit, 10))) : 20;
    return this.leaderboard.leaderboard(b, p, n);
  }

  // ── 只读盘口（公开） ─────────────────────────────────────────

  @Get('mm-agent/decisions')
  @ApiOperation({ summary: 'AI 做市 agent 最近决策（可观测视图，只读）' })
  mmDecisions(@Query('limit') limit?: string) {
    const n = limit ? Math.max(1, Math.min(200, parseInt(limit, 10))) : 50;
    return { items: this.mmAgent.getRecentDecisions(n) };
  }

  @Get('markets/live')
  @ApiOperation({ summary: '活跃盘口列表（赛前+滚球）' })
  async listLive(@Query('league') league?: string, @Query('limit') limit?: string) {
    const n = limit ? Math.max(1, Math.min(100, parseInt(limit, 10))) : 50;
    return { items: await this.marketSvc.listLive(league, n) };
  }

  @Get('markets/recent')
  @ApiOperation({ summary: '最近已结算盘口' })
  async listRecent(@Query('limit') limit?: string) {
    const n = limit ? Math.max(1, Math.min(100, parseInt(limit, 10))) : 20;
    return { items: await this.marketSvc.listRecentSettled(n) };
  }

  @Get('markets/:id/odds-history')
  @ApiOperation({ summary: '盘口赔率历史（折线数据；range=all|30m|10m|5m）' })
  async oddsHistory(@Param('id') id: string, @Query('range') range?: string) {
    return this.marketSvc.oddsHistory(id, range || 'all');
  }

  @Get('markets/:id')
  @ApiOperation({ summary: '盘口详情 + 当前赔率' })
  async getMarket(@Param('id') id: string) {
    return this.marketSvc.getMarket(id);
  }

  // ── 下单（需登录） ───────────────────────────────────────────

  @Post('orders/preview')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '下单预览（纯定价：可成交赔率/敞口/最大盈亏）' })
  async preview(@Body() dto: PreviewDto) {
    return this.orderSvc.preview({
      marketId: dto.marketId,
      outcomeIdx: Number(dto.outcomeIdx),
      stake: Number(dto.stake),
      leverage: Number(dto.leverage),
      asset: dto.asset,
    });
  }

  @Post('orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '下单（AXP 保证金，平台 bankroll 对手方；幂等键防重复）' })
  async place(@Request() req: any, @Body() dto: PlaceDto, @Headers() headers: Record<string, any>) {
    const country =
      (headers['cf-ipcountry'] as string) ||
      (headers['x-country'] as string) ||
      (headers['x-vercel-ip-country'] as string) ||
      null;
    const order = await this.orderSvc.place({
      userId: req.user?.id,
      marketId: dto.marketId,
      outcomeIdx: Number(dto.outcomeIdx),
      stake: Number(dto.stake),
      leverage: Number(dto.leverage),
      quotedOdds: Number(dto.quotedOdds),
      idemKey: dto.idemKey,
      asset: dto.asset,
      country,
    });
    return {
      id: order.id,
      status: order.status,
      asset: order.asset,
      stake: Number(order.stake),
      leverage: order.leverage,
      entryOdds: Number(order.entryOdds),
      notional: Number(order.notional),
      maxProfit: Number(order.maxProfit),
      winPayout: Number(order.stake) + Number(order.maxProfit),
    };
  }

  @Get('me/orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '我的下单记录（OPEN 单附实时可兑现值 cashoutValue）' })
  async myOrders(@Request() req: any, @Query('limit') limit?: string) {
    const n = limit ? Math.max(1, Math.min(200, parseInt(limit, 10))) : 50;
    const rows = await this.orderSvc.myOrders(req.user?.id, n);
    const items = await Promise.all(
      rows.map(async (o) => ({
        id: o.id,
        marketId: o.marketId,
        outcomeIdx: o.outcomeIdx,
        asset: o.asset,
        stake: Number(o.stake),
        leverage: o.leverage,
        entryOdds: Number(o.entryOdds),
        notional: Number(o.notional),
        maxProfit: Number(o.maxProfit),
        status: o.status,
        payout: Number(o.payout),
        closePnl: Number(o.closePnl),
        // OPEN 单按当前可成交赔率 mark-to-market；其它状态/盘口不可交易返回 null
        cashoutValue: await this.orderSvc.currentCashoutValue(o),
        createdAt: o.createdAt.getTime(),
        settledAt: o.settledAt?.getTime() ?? null,
      })),
    );
    return { items };
  }

  @Post('orders/:id/cashout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '提前平仓（按当前可成交赔率 mark-to-market 兑现；整数 AXP、幂等、同事务）',
  })
  async cashOut(@Request() req: any, @Param('id') id: string) {
    const order = await this.orderSvc.cashOut(id, req.user?.id);
    return {
      id: order.id,
      status: order.status,
      asset: order.asset,
      payout: Number(order.payout),
      closePnl: Number(order.closePnl),
      cashoutValue: Number(order.payout),
      settledAt: order.settledAt?.getTime() ?? null,
    };
  }

  // ── feed-bridge 内部摄取（服务间令牌鉴权，非 JWT） ──────────

  @Post('internal/feed/ingest')
  @ApiOperation({ summary: '[内部] KMarket 赔率摄取（服务间令牌）' })
  async ingest(
    @Body() payload: FeedBatchPayload,
    @Headers('x-internal-token') token?: string,
  ) {
    if (!this.feed.verifyServiceToken(token || payload.serviceToken)) {
      throw new UnauthorizedException('invalid service token');
    }
    return this.feed.ingest(payload);
  }
}
