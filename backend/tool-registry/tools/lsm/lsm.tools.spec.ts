/**
 * LSM chat tools (LSM Phase G · Req 25) — unit tests.
 *
 * Validates input schemas + execute() mapping against mocked engine services
 * (LsmMarketService / LsmOrderService). No DB / network.
 */
import {
  LsmSearchMarketsTool,
  LsmPreviewOrderTool,
  LsmPlaceOrderTool,
  LsmMyPositionsTool,
} from './lsm.tools';
import { ToolContext } from '../../interfaces';

const ctx = (userId?: string, agentId?: string): ToolContext => ({
  userId: userId as any,
  sessionId: 'sess-1',
  agentId,
});

/** Minimal ModuleRef stub: SettlementCoreService resolves to a fence we control. */
function moduleRefWith(fence?: { allowed: boolean; reason?: string }) {
  return {
    get: (token: any, _opts?: any) => {
      const name = token?.name || '';
      if (name === 'SettlementCoreService') {
        return { authorizeAutonomousPayment: jest.fn().mockResolvedValue(fence ?? { allowed: true }) };
      }
      if (name === 'UCPService') {
        return { listMandates: jest.fn().mockResolvedValue([]) };
      }
      throw new Error('not found');
    },
  } as any;
}

describe('LSM chat tools (Req 25)', () => {
  describe('lsm_search_markets', () => {
    it('maps markets with labels + implied probability', async () => {
      const markets = {
        listLive: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            homeTeam: 'Brazil',
            awayTeam: 'Spain',
            league: 'World Cup',
            status: 'live',
            tradable: true,
            kickoffAt: 123,
            homeScore: 1,
            awayScore: 0,
            odds: [
              { outcomeIdx: 0, fairOdds: 2.0 },
              { outcomeIdx: 1, fairOdds: 4.0 },
              { outcomeIdx: 2, fairOdds: 3.5 },
            ],
          },
        ]),
      };
      const tool = new LsmSearchMarketsTool(markets as any);
      const res = await tool.execute({ limit: 10 } as any);

      expect(res.success).toBe(true);
      expect(markets.listLive).toHaveBeenCalledWith(undefined, 10);
      expect(res.data.cardType).toBe('lsm_market_list');
      const m = res.data.markets[0];
      expect(m.match).toBe('Brazil vs Spain');
      expect(m.score).toBe('1:0');
      expect(m.outcomes[0]).toMatchObject({ outcomeIdx: 0, label: 'Brazil', decimalOdds: 2, impliedPct: 50 });
      expect(m.outcomes[2]).toMatchObject({ label: 'Draw', impliedPct: 29 });
    });
  });

  describe('lsm_preview_order', () => {
    it('returns preview with implied probability', async () => {
      const orders = {
        preview: jest.fn().mockResolvedValue({
          marketId: 'm1',
          outcomeIdx: 0,
          stake: 100,
          leverage: 2,
          asset: 'USDC',
          fairOdds: 2,
          tradableOdds: 1.95,
          notional: 200,
          maxProfit: 190,
          maxLoss: 100,
          winPayout: 290,
          tradable: true,
          slippageBps: 500,
        }),
      };
      const tool = new LsmPreviewOrderTool(orders as any);
      const res = await tool.execute({ marketId: 'm1', outcomeIdx: 0, stake: 100, leverage: 2, asset: 'USDC' } as any);

      expect(res.success).toBe(true);
      expect(res.data.cardType).toBe('lsm_preview');
      expect(res.data.tradableOdds).toBe(1.95);
      expect(res.data.impliedPct).toBe(51); // round(1/1.95*100)
    });
  });

  describe('lsm_place_order', () => {
    it('requires login (no userId → error, no place call)', async () => {
      const orders = { place: jest.fn() };
      const tool = new LsmPlaceOrderTool(orders as any, moduleRefWith());
      const res = await tool.execute(
        { marketId: 'm1', outcomeIdx: 0, stake: 100, leverage: 2, quotedOdds: 1.95 } as any,
        ctx(undefined),
      );
      expect(res.success).toBe(false);
      expect(orders.place).not.toHaveBeenCalled();
    });

    it('places order and returns summary card', async () => {
      const orders = {
        place: jest.fn().mockResolvedValue({
          id: 'o1', status: 'open', asset: 'USDC',
          stake: '100', leverage: 2, entryOdds: '1.9500',
          notional: '200', maxProfit: '190', payout: '0', closePnl: '0',
        }),
      };
      const tool = new LsmPlaceOrderTool(orders as any, moduleRefWith());
      const res = await tool.execute(
        { marketId: 'm1', outcomeIdx: 0, stake: 100, leverage: 2, quotedOdds: 1.95, asset: 'USDC' } as any,
        ctx('user-1'),
      );
      expect(res.success).toBe(true);
      expect(orders.place).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', marketId: 'm1', asset: 'USDC', quotedOdds: 1.95, country: null }),
      );
      expect(res.data.cardType).toBe('lsm_order_placed');
      expect(res.data.winPayout).toBe(290); // stake 100 + maxProfit 190
    });

    it('surfaces engine error codes', async () => {
      const orders = { place: jest.fn().mockRejectedValue(new Error('SLIPPAGE_EXCEEDED:2.10')) };
      const tool = new LsmPlaceOrderTool(orders as any, moduleRefWith());
      const res = await tool.execute(
        { marketId: 'm1', outcomeIdx: 0, stake: 100, leverage: 2, quotedOdds: 1.95 } as any,
        ctx('user-1'),
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('SLIPPAGE_EXCEEDED');
    });
  });

  describe('lsm_place_order spending fence (Req 26 / Property G2)', () => {
    const input = (asset?: string) =>
      ({ marketId: 'm1', outcomeIdx: 0, stake: 1000, leverage: 2, quotedOdds: 1.95, asset } as any);

    it('AXP free-play needs no fence → allow', async () => {
      const tool = new LsmPlaceOrderTool({} as any, moduleRefWith());
      const r = await tool.checkPermissions(input('AXP'), ctx('user-1', 'agent-1'));
      expect(r.behavior).toBe('allow');
    });

    it('USDC without an agent account → ask (explicit confirmation)', async () => {
      const tool = new LsmPlaceOrderTool({} as any, moduleRefWith());
      const r = await tool.checkPermissions(input('USDC'), ctx('user-1', undefined));
      expect(r.behavior).toBe('ask');
    });

    it('USDC within authorized limit → allow', async () => {
      const tool = new LsmPlaceOrderTool({} as any, moduleRefWith({ allowed: true }));
      const r = await tool.checkPermissions(input('USDC'), ctx('user-1', 'agent-1'));
      expect(r.behavior).toBe('allow');
    });

    it('USDC exceeding limit → ask with reason (not silently placed)', async () => {
      const tool = new LsmPlaceOrderTool(
        {} as any,
        moduleRefWith({ allowed: false, reason: 'exceeds remaining daily limit' }),
      );
      const r = await tool.checkPermissions(input('USDC'), ctx('user-1', 'agent-1'));
      expect(r.behavior).toBe('ask');
      expect(r.reason).toContain('daily limit');
    });
  });

  describe('lsm_my_positions', () => {
    it('lists positions with cash-out value', async () => {
      const orders = {
        myOrders: jest.fn().mockResolvedValue([
          { id: 'o1', marketId: 'm1', outcomeIdx: 0, asset: 'USDC', stake: '100', leverage: 2, entryOdds: '1.95', notional: '200', status: 'open', payout: '0', closePnl: '0' },
        ]),
        currentCashoutValue: jest.fn().mockResolvedValue(120),
      };
      const tool = new LsmMyPositionsTool(orders as any);
      const res = await tool.execute({ limit: 20 } as any, ctx('user-1'));
      expect(res.success).toBe(true);
      expect(res.data.positions[0].cashoutValue).toBe(120);
      expect(res.data.positions[0].stake).toBe(100);
    });
  });
});
