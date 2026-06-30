/**
 * LSM (leverage sports market) chat tools — LSM Phase G · Req 25.
 *
 * Exposes the conversational "prediction Copilot" surface: search markets,
 * explain odds, preview / place leveraged orders, view positions, cash out.
 * These are registered in the central ToolRegistry and therefore reachable
 * from BOTH chat paths (openclaw-proxy.service canonical + claude-integration
 * delegating垫片), satisfying the two-path parity hard rule.
 *
 * Reuses the existing engine services (LsmMarketService / LsmOrderService) —
 * no pricing/risk re-implementation. Orders carry the `asset` dimension
 * (`AXP` | `USDC`); USDC settles on-chain (Injective EVM testnet).
 *
 * NOTE: `lsm_place_order` is `requiresPayment` + `riskLevel:2`. The autonomous
 * spending fence (AP2 mandate + spendingLimits) is wired in Phase G · task 21
 * via `checkPermissions`; until then the underlying engine still enforces
 * balance / compliance / circuit-breaker checks on every place.
 */
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { z } from 'zod';
import { AgentrixTool, PermissionResult, ToolCategory, ToolContext, ToolResult } from '../../interfaces';
import { RegisterTool } from '../../decorators/register-tool.decorator';
import { LsmMarketService } from '../../../leverage-sports-market/lsm-market.service';
import { LsmOrderService } from '../../../leverage-sports-market/lsm-order.service';
import { SettlementCoreService } from '../../../agent-protocol/settlement-core.service';
import { UCPService } from '../../../ucp/ucp.service';

const ASSET = z.enum(['AXP', 'USDC']);

/** Implied probability from decimal odds, as a 0–100 integer percent. */
function impliedPct(odds: number): number | null {
  if (!odds || odds <= 0) return null;
  return Math.round((1 / odds) * 100);
}

function idemKey(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ───────────────────────────── search markets ─────────────────────────────

const searchSchema = z.object({
  league: z.string().optional().describe('Optional league/competition filter, e.g. "World Cup"'),
  limit: z.number().int().min(1).max(30).default(10).describe('Max markets to return'),
});
type SearchInput = z.infer<typeof searchSchema>;

@RegisterTool()
@Injectable()
export class LsmSearchMarketsTool implements AgentrixTool<SearchInput> {
  readonly name = 'lsm_search_markets';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    'Search live & upcoming leverage sports prediction markets (e.g. World Cup matches). Returns teams, status, decimal odds and implied probability for each outcome (0=home,1=away,2=draw).';
  readonly inputSchema = searchSchema;
  readonly isReadOnly = true;
  readonly isConcurrencySafe = true;
  readonly requiresPayment = false;
  readonly riskLevel = 0 as const;
  readonly maxResultChars = 6000;

  constructor(private readonly markets: LsmMarketService) {}

  async execute(input: SearchInput): Promise<ToolResult> {
    const rows = await this.markets.listLive(input.league, input.limit);
    const items = rows.map((m) => ({
      marketId: m.id,
      match: `${m.homeTeam} vs ${m.awayTeam}`,
      league: m.league,
      status: m.status,
      tradable: m.tradable,
      kickoffAt: m.kickoffAt,
      score: m.homeScore != null && m.awayScore != null ? `${m.homeScore}:${m.awayScore}` : null,
      outcomes: m.odds.map((o) => ({
        outcomeIdx: o.outcomeIdx,
        label: o.outcomeIdx === 0 ? m.homeTeam : o.outcomeIdx === 1 ? m.awayTeam : 'Draw',
        decimalOdds: Number(o.fairOdds.toFixed(2)),
        impliedPct: impliedPct(o.fairOdds),
      })),
    }));
    return {
      success: true,
      data: {
        cardType: 'lsm_market_list',
        total: items.length,
        markets: items,
        message: items.length
          ? `Found ${items.length} market(s).`
          : 'No live or upcoming markets right now.',
      },
    };
  }
}

// ───────────────────────────── preview order ──────────────────────────────

const previewSchema = z.object({
  marketId: z.string().describe('Market id from lsm_search_markets'),
  outcomeIdx: z.number().int().min(0).describe('Outcome to back: 0=home, 1=away, 2=draw'),
  stake: z.number().int().min(1).describe('Margin in the asset minor unit (AXP points; USDC = 0.01 units, i.e. ×100)'),
  leverage: z.number().int().min(1).max(100).describe('Leverage multiplier'),
  asset: ASSET.optional().describe('Settlement asset (default AXP). USDC settles on-chain (testnet).'),
});
type PreviewInput = z.infer<typeof previewSchema>;

@RegisterTool()
@Injectable()
export class LsmPreviewOrderTool implements AgentrixTool<PreviewInput> {
  readonly name = 'lsm_preview_order';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    'Preview a leveraged prediction order: returns tradable odds, notional exposure, max profit/loss, win payout and slippage. Read-only — does not place anything.';
  readonly inputSchema = previewSchema;
  readonly isReadOnly = true;
  readonly isConcurrencySafe = true;
  readonly requiresPayment = false;
  readonly riskLevel = 0 as const;
  readonly maxResultChars = 3000;

  constructor(private readonly orders: LsmOrderService) {}

  async execute(input: PreviewInput): Promise<ToolResult> {
    const p = await this.orders.preview({
      marketId: input.marketId,
      outcomeIdx: input.outcomeIdx,
      stake: input.stake,
      leverage: input.leverage,
      asset: input.asset,
    });
    return {
      success: true,
      data: {
        cardType: 'lsm_preview',
        ...p,
        impliedPct: impliedPct(p.tradableOdds),
        note: 'Call lsm_place_order with quotedOdds = tradableOdds to confirm.',
      },
    };
  }
}

// ───────────────────────────── place order ────────────────────────────────

const placeSchema = z.object({
  marketId: z.string().describe('Market id'),
  outcomeIdx: z.number().int().min(0).describe('Outcome to back: 0=home, 1=away, 2=draw'),
  stake: z.number().int().min(1).describe('Margin in the asset minor unit'),
  leverage: z.number().int().min(1).max(100).describe('Leverage multiplier'),
  quotedOdds: z.number().min(1).describe('Odds quoted to the user (from lsm_preview_order.tradableOdds)'),
  asset: ASSET.optional().describe('Settlement asset (default AXP). USDC settles on-chain (testnet).'),
});
type PlaceInput = z.infer<typeof placeSchema>;

@RegisterTool()
@Injectable()
export class LsmPlaceOrderTool implements AgentrixTool<PlaceInput> {
  readonly name = 'lsm_place_order';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    'Place a leveraged prediction order on behalf of the user. Confirm intent + amount first. Settles in the chosen asset (USDC = on-chain testnet). Subject to balance, slippage, compliance and (when authorized) the user spending fence.';
  readonly inputSchema = placeSchema;
  readonly isReadOnly = false;
  readonly isConcurrencySafe = false;
  readonly requiresPayment = true;
  readonly riskLevel = 2 as const;
  readonly maxResultChars = 2000;

  constructor(
    private readonly orders: LsmOrderService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * LSM Phase G · Req 26 — autonomous spending fence. AXP is free-play and
   * needs no fence (allow). USDC is real on-chain value, so it must pass the
   * AP2 mandate + AgentAccount.spendingLimits double fence via
   * SettlementCoreService.authorizeAutonomousPayment. When the user has no
   * agent account / authorization, or the fence rejects, we return `ask` so the
   * chat surfaces an explicit confirmation / "authorize a daily USDC limit"
   * step instead of silently placing the order. Fail-closed to `ask`.
   */
  async checkPermissions(input: PlaceInput, ctx: ToolContext): Promise<PermissionResult> {
    const asset = input.asset ?? 'AXP';
    if (asset !== 'USDC') {
      return { behavior: 'allow' };
    }
    const agentAccountId = ctx.agentId;
    if (!agentAccountId) {
      return {
        behavior: 'ask',
        reason:
          'USDC order needs spending authorization. Confirm this order explicitly, or set up an AP2 mandate (e.g. "authorize up to 100 USDC/day").',
      };
    }
    let settlement: SettlementCoreService | undefined;
    try {
      settlement = this.moduleRef.get(SettlementCoreService, { strict: false });
    } catch {
      settlement = undefined;
    }
    if (!settlement) {
      return { behavior: 'ask', reason: 'Spending fence unavailable; explicit confirmation required.' };
    }
    // If the caller didn't pass a mandate, use the agent's newest ACTIVE mandate
    // so an in-chat "authorize N USDC/day" (lsm_authorize_spending) actually
    // gates subsequent orders.
    let mandateId: string | undefined = (ctx.metadata as any)?.mandateId;
    if (!mandateId) {
      try {
        const ucp = this.moduleRef.get(UCPService, { strict: false });
        const mandates = await ucp?.listMandates(agentAccountId, 'active');
        if (Array.isArray(mandates) && mandates.length) {
          mandateId = mandates[mandates.length - 1]?.id;
        }
      } catch {
        /* no mandate registry available — fall back to spendingLimits only */
      }
    }
    // USDC stake is in minor units (0.01 USDC); fences are denominated in USDC.
    const amountUsdc = input.stake / 100;
    const fence = await settlement.authorizeAutonomousPayment({
      agentAccountId,
      amount: amountUsdc,
      mandateId,
      merchantId: 'lsm',
      category: 'prediction',
    });
    if (fence.allowed) {
      return { behavior: 'allow' };
    }
    return {
      behavior: 'ask',
      reason:
        fence.reason ||
        'Exceeds your authorized USDC spending limit. Confirm explicitly or raise your AP2 mandate.',
    };
  }

  async execute(input: PlaceInput, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.userId) return { success: false, error: 'login required' };
    try {
      const order = await this.orders.place({
        userId: ctx.userId,
        marketId: input.marketId,
        outcomeIdx: input.outcomeIdx,
        stake: input.stake,
        leverage: input.leverage,
        quotedOdds: input.quotedOdds,
        asset: input.asset,
        idemKey: idemKey(),
        country: null,
      });
      return {
        success: true,
        data: {
          cardType: 'lsm_order_placed',
          id: order.id,
          status: order.status,
          asset: order.asset,
          stake: Number(order.stake),
          leverage: order.leverage,
          entryOdds: Number(order.entryOdds),
          notional: Number(order.notional),
          maxProfit: Number(order.maxProfit),
          winPayout: Number(order.stake) + Number(order.maxProfit),
          message: 'Order placed. Use lsm_my_positions to track it.',
        },
      };
    } catch (e: any) {
      // Surface engine error codes (SLIPPAGE_EXCEEDED:x / ODDS_STALE / MARKET_SUSPENDED /
      // RISK_LIMIT_EXCEEDED / insufficient balance) so the model can react.
      return { success: false, error: e?.message || 'order failed' };
    }
  }
}

// ───────────────────────────── my positions ───────────────────────────────

const positionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe('Max positions to return'),
});
type PositionsInput = z.infer<typeof positionsSchema>;

@RegisterTool()
@Injectable()
export class LsmMyPositionsTool implements AgentrixTool<PositionsInput> {
  readonly name = 'lsm_my_positions';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    "List the current user's prediction positions (open & settled), with stake, leverage, entry odds, PnL and — for open orders — the current cash-out value.";
  readonly inputSchema = positionsSchema;
  readonly isReadOnly = true;
  readonly isConcurrencySafe = true;
  readonly requiresPayment = false;
  readonly riskLevel = 0 as const;
  readonly maxResultChars = 6000;

  constructor(private readonly orders: LsmOrderService) {}

  async execute(input: PositionsInput, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.userId) return { success: false, error: 'login required' };
    const rows = await this.orders.myOrders(ctx.userId, input.limit);
    const items = await Promise.all(
      rows.map(async (o: any) => ({
        id: o.id,
        marketId: o.marketId,
        outcomeIdx: o.outcomeIdx,
        asset: o.asset,
        stake: Number(o.stake),
        leverage: o.leverage,
        entryOdds: Number(o.entryOdds),
        notional: Number(o.notional),
        status: o.status,
        payout: Number(o.payout),
        closePnl: Number(o.closePnl),
        cashoutValue: await this.orders.currentCashoutValue(o),
      })),
    );
    return {
      success: true,
      data: { cardType: 'lsm_positions', total: items.length, positions: items },
    };
  }
}

// ───────────────────────────── cash out ───────────────────────────────────

const cashoutSchema = z.object({
  orderId: z.string().describe('Open order id to cash out (from lsm_my_positions)'),
});
type CashoutInput = z.infer<typeof cashoutSchema>;

@RegisterTool()
@Injectable()
export class LsmCashoutTool implements AgentrixTool<CashoutInput> {
  readonly name = 'lsm_cashout';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    'Cash out (settle early at the current tradable odds) an open prediction order. Confirm with the user first.';
  readonly inputSchema = cashoutSchema;
  readonly isReadOnly = false;
  readonly isConcurrencySafe = false;
  readonly requiresPayment = false;
  readonly riskLevel = 1 as const;
  readonly maxResultChars = 1500;

  constructor(private readonly orders: LsmOrderService) {}

  async execute(input: CashoutInput, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.userId) return { success: false, error: 'login required' };
    try {
      const order: any = await this.orders.cashOut(input.orderId, ctx.userId);
      return {
        success: true,
        data: {
          cardType: 'lsm_cashed_out',
          id: order.id,
          status: order.status,
          asset: order.asset,
          payout: Number(order.payout),
          closePnl: Number(order.closePnl),
        },
      };
    } catch (e: any) {
      return { success: false, error: e?.message || 'cash out failed' };
    }
  }
}

// ───────────────────────── authorize spending (AP2 mandate) ───────────────

const authorizeSchema = z.object({
  dailyLimitUsdc: z.number().positive().describe('Daily USDC spending cap the agent may auto-place within'),
  validDays: z.number().int().min(1).max(365).default(30).describe('How many days the authorization stays valid'),
});
type AuthorizeInput = z.infer<typeof authorizeSchema>;

@RegisterTool()
@Injectable()
export class LsmAuthorizeSpendingTool implements AgentrixTool<AuthorizeInput> {
  readonly name = 'lsm_authorize_spending';
  readonly category = ToolCategory.PREDICTION;
  readonly description =
    'Authorize the agent to auto-place USDC prediction orders up to a daily limit (creates an AP2 mandate scoped to prediction/lsm). Use when the user says e.g. "let you bet up to 100 USDC a day". Confirm the amount first.';
  readonly inputSchema = authorizeSchema;
  readonly isReadOnly = false;
  readonly isConcurrencySafe = false;
  readonly requiresPayment = false;
  readonly riskLevel = 2 as const;
  readonly maxResultChars = 1200;

  constructor(private readonly moduleRef: ModuleRef) {}

  async execute(input: AuthorizeInput, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.userId) return { success: false, error: 'login required' };
    const agentAccountId = ctx.agentId;
    if (!agentAccountId) {
      return {
        success: false,
        error:
          'No agent account bound to this session; cannot create a spending mandate. Confirm orders individually instead.',
      };
    }
    let ucp: UCPService | undefined;
    try {
      ucp = this.moduleRef.get(UCPService, { strict: false });
    } catch {
      ucp = undefined;
    }
    if (!ucp) return { success: false, error: 'authorization service unavailable' };
    const validUntil = new Date(Date.now() + input.validDays * 24 * 60 * 60 * 1000).toISOString();
    const mandate: any = await ucp.createMandate({
      agent_id: agentAccountId,
      max_amount: input.dailyLimitUsdc,
      currency: 'USDC',
      valid_until: validUntil,
      allowed_merchants: ['lsm'],
      allowed_categories: ['prediction'],
    } as any);
    return {
      success: true,
      data: {
        cardType: 'lsm_spending_authorized',
        mandateId: mandate?.id,
        dailyLimitUsdc: input.dailyLimitUsdc,
        validUntil,
        message: `Authorized auto-placing USDC predictions up to ${input.dailyLimitUsdc} USDC/day. Revoke anytime in settings.`,
      },
    };
  }
}

export const LSM_CHAT_TOOLS = [
  LsmSearchMarketsTool,
  LsmPreviewOrderTool,
  LsmPlaceOrderTool,
  LsmMyPositionsTool,
  LsmCashoutTool,
  LsmAuthorizeSpendingTool,
];
