import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

import { LsmOrderService } from './lsm-order.service';
import { LsmVaultService } from './lsm-vault.service';
import { LsmUnderwritingService } from './lsm-underwriting.service';
import { LsmRiskService } from './lsm-risk.service';
import { LsmSystemModeService, LsmSystemMode } from './lsm-system-mode.service';
import { LsmComplianceService } from './lsm-compliance.service';
import { LsmReconciliationService } from './lsm-reconciliation.service';
import { AxpAssetAdapter, AssetAdapterRegistry, LSM_ASSET_ADAPTER } from './lsm-asset.adapter';
import { LsmFeedService } from './lsm-feed.service';
import { KYCService } from '../compliance/kyc.service';
import { KYCLevel } from '../../entities/user.entity';

import { LsmMarket, LsmMarketStatus } from '../../entities/lsm-market.entity';
import { LsmOddsSnapshot } from '../../entities/lsm-odds-snapshot.entity';
import { LsmOrder, LsmOrderStatus } from '../../entities/lsm-order.entity';
import { LsmOrderLeg } from '../../entities/lsm-order-leg.entity';
import { LsmVault } from '../../entities/lsm-vault.entity';
import { LsmVaultPosition } from '../../entities/lsm-vault-position.entity';
import { LsmVaultEvent } from '../../entities/lsm-vault-event.entity';
import { LsmVaultSubscription } from '../../entities/lsm-vault-subscription.entity';
import { LsmMarketHouse } from '../../entities/lsm-market-house.entity';

/**
 * LSM P1 全链路 E2E 冒烟（task 8）。
 *
 * 用真实 LSM 服务（order/vault/underwriting/risk/system-mode/compliance）跑端到端，
 * 仅 mock 赔率 feed + 资产适配器(AXP) + KYC，验证：
 *   1. LP 注资官方金库 → 下注（escrow + 金库腿预留 + 偿付不变量） → 结算（赢/输派彩 + NAV 反映）。
 *   2. 取消盘口退款（保证金原额退还）。
 *   3. AXP 守恒：用户余额 + 金库权益 + 未结预留 全程恒等于初始发行总额。
 *   4. 门禁：system-mode halted 禁开仓；地域黑名单禁下注；滑点超限拒绝。
 *
 * 通过自建内存 ORM 桩（MemRepo + 事务 manager + 针对 risk.sumLegs 的 QueryBuilder）
 * 让真实服务逻辑运行，无需真实数据库。
 */

// ── 内存 ORM 桩 ───────────────────────────────────────────────

function matchWhere(row: any, where: any): boolean {
  if (Array.isArray(where)) return where.some((w) => matchWhere(row, w));
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

class MemRepo<T extends { id?: string }> {
  rows: any[] = [];
  constructor(private readonly Entity: new () => T) {}

  create(obj: any): any {
    return Object.assign(new this.Entity(), obj);
  }
  async save(obj: any): Promise<any> {
    if (Array.isArray(obj)) return Promise.all(obj.map((o) => this.save(o)));
    if (!obj.id) obj.id = randomUUID();
    if (!obj.createdAt) obj.createdAt = new Date();
    obj.updatedAt = new Date();
    const idx = this.rows.findIndex((r) => r.id === obj.id);
    if (idx >= 0) {
      // 保持同一引用，合并字段
      Object.assign(this.rows[idx], obj);
      return this.rows[idx];
    }
    this.rows.push(obj);
    return obj;
  }
  async findOne(opts: any): Promise<any> {
    return this.rows.find((r) => matchWhere(r, opts?.where)) ?? null;
  }
  async findOneOrFail(opts: any): Promise<any> {
    const r = await this.findOne(opts);
    if (!r) throw new Error('not found');
    return r;
  }
  async find(opts: any = {}): Promise<any[]> {
    let out = this.rows.filter((r) => matchWhere(r, opts.where));
    if (opts.order) {
      const [k, dir] = Object.entries(opts.order)[0] as [string, any];
      out = [...out].sort((a, b) => {
        const av = a[k];
        const bv = b[k];
        const cmp = av > bv ? 1 : av < bv ? -1 : 0;
        return String(dir).toUpperCase() === 'DESC' ? -cmp : cmp;
      });
    }
    if (opts.take) out = out.slice(0, opts.take);
    return out;
  }
  async update(where: any, partial: any): Promise<void> {
    this.rows
      .filter((r) => matchWhere(r, where))
      .forEach((r) => Object.assign(r, partial));
  }
  createQueryBuilder(_alias?: string): MemQB {
    return new MemQB(this.Entity, this);
  }
}

/** 仅支持 risk.sumLegs（LsmOrderLeg innerJoin LsmOrder/LsmMarket，SUM 聚合）。 */
class MemQB {
  private params: Record<string, any> = {};
  private hasMarketJoin = false;
  constructor(
    private readonly Entity: any,
    private readonly repo: MemRepo<any>,
    private readonly store?: MemStore,
  ) {}
  innerJoin(target: any, _alias: string, _cond: string): this {
    if (target === LsmMarket) this.hasMarketJoin = true;
    return this;
  }
  select(): this {
    return this;
  }
  addSelect(): this {
    return this;
  }
  where(_s: string, p?: any): this {
    if (p) Object.assign(this.params, p);
    return this;
  }
  andWhere(_s: string, p?: any): this {
    if (p) Object.assign(this.params, p);
    return this;
  }
  async getRawOne(): Promise<any> {
    const store = this.store ?? GLOBAL_STORE!;
    const legs: LsmOrderLeg[] = store.legs.rows;
    let stake = 0;
    let reserve = 0;
    for (const leg of legs) {
      if (this.params.vaultId && (leg as any).vaultId !== this.params.vaultId) continue;
      const order = store.orders.rows.find((o) => o.id === (leg as any).orderId);
      if (!order || order.status !== LsmOrderStatus.OPEN) continue;
      if (this.params.marketId && order.marketId !== this.params.marketId) continue;
      if (this.params.eventId) {
        const market = store.markets.rows.find((m) => m.id === order.marketId);
        if (!market || market.eventId !== this.params.eventId) continue;
      }
      stake += Number((leg as any).stakeShare);
      reserve += Number((leg as any).reserveShare);
    }
    return { stake: String(stake), reserve: String(reserve), sum: String(reserve) };
  }
}

interface MemStore {
  markets: MemRepo<LsmMarket>;
  snapshots: MemRepo<LsmOddsSnapshot>;
  orders: MemRepo<LsmOrder>;
  legs: MemRepo<LsmOrderLeg>;
  vaults: MemRepo<LsmVault>;
  positions: MemRepo<LsmVaultPosition>;
  events: MemRepo<LsmVaultEvent>;
  subs: MemRepo<LsmVaultSubscription>;
  marketHouse: MemRepo<LsmMarketHouse>;
}
let GLOBAL_STORE: MemStore | null = null;

/** 事务 manager：把 Entity class 映射到对应 MemRepo（findOne/find/save/create/update/QB）。 */
function makeManager(store: MemStore) {
  const repoFor = (Entity: any): MemRepo<any> => {
    const map = new Map<any, MemRepo<any>>([
      [LsmMarket, store.markets],
      [LsmOddsSnapshot, store.snapshots],
      [LsmOrder, store.orders],
      [LsmOrderLeg, store.legs],
      [LsmVault, store.vaults],
      [LsmVaultPosition, store.positions],
      [LsmVaultEvent, store.events],
      [LsmVaultSubscription, store.subs],
      [LsmMarketHouse, store.marketHouse],
    ]);
    const r = map.get(Entity);
    if (!r) throw new Error(`no repo for ${Entity?.name}`);
    return r;
  };
  const repoForInstance = (obj: any): MemRepo<any> => repoFor(obj.constructor);
  return {
    findOne: (Entity: any, opts: any) => repoFor(Entity).findOne(opts),
    find: (Entity: any, opts: any) => repoFor(Entity).find(opts),
    create: (Entity: any, obj: any) => repoFor(Entity).create(obj),
    save: (obj: any) => repoForInstance(Array.isArray(obj) ? obj[0] : obj).save(obj),
    update: (Entity: any, where: any, partial: any) =>
      repoFor(Entity).update(where, partial),
    createQueryBuilder: (Entity: any, _alias?: string) =>
      new MemQB(Entity, repoFor(Entity), store),
  };
}

function makeDataSource(store: MemStore): DataSource {
  const manager = makeManager(store);
  return {
    transaction: async (cb: any) => cb(manager),
  } as unknown as DataSource;
}

// ── Mock 资产适配器（内存 AXP，整数守恒） ─────────────────────

class InMemoryAsset {
  balances = new Map<string, number>();
  /** 已发行总额（用于守恒断言）：初始充值计入 issuance */
  issued = 0;
  applied = new Set<string>(); // 幂等键

  unit(): 'AXP' | 'USDC' {
    return 'AXP';
  }
  mint(userId: string, amount: number) {
    this.balances.set(userId, (this.balances.get(userId) ?? 0) + amount);
    this.issued += amount;
  }
  async balanceOf(userId: string): Promise<number> {
    return this.balances.get(userId) ?? 0;
  }
  private add(userId: string, amount: number, idemKey: string) {
    if (this.applied.has(idemKey)) return;
    this.applied.add(idemKey);
    this.balances.set(userId, (this.balances.get(userId) ?? 0) + amount);
  }
  private sub(userId: string, amount: number, idemKey: string) {
    if (this.applied.has(idemKey)) return;
    const bal = this.balances.get(userId) ?? 0;
    if (bal < amount) throw new BadRequestException('insufficient AXP balance');
    this.applied.add(idemKey);
    this.balances.set(userId, bal - amount);
  }
  async escrow(userId: string, amount: number, ref: any) {
    this.sub(userId, amount, ref.idemKey);
  }
  async debit(userId: string, amount: number, ref: any) {
    this.sub(userId, amount, ref.idemKey);
  }
  async credit(userId: string, amount: number, ref: any) {
    this.add(userId, amount, ref.idemKey);
  }
  async release(userId: string, amount: number, ref: any) {
    this.add(userId, amount, ref.idemKey);
  }
  /** 用户侧 AXP 总额（不含金库内权益/预留） */
  totalUserBalance(): number {
    let t = 0;
    for (const v of this.balances.values()) t += v;
    return t;
  }
}

// ── 测试套件 ──────────────────────────────────────────────────

describe('LSM P1 端到端冒烟 (task 8, mock feed + mock 适配器)', () => {
  let order: LsmOrderService;
  let vault: LsmVaultService;
  let systemMode: LsmSystemModeService;
  let store: MemStore;
  let asset: InMemoryAsset;
  let feedMock: any;
  let marketRow: LsmMarket;

  const LP = 'lp-1';
  const BETTOR = 'bettor-1';

  beforeEach(async () => {
    process.env.LSM_BLOCKED_COUNTRIES = 'US';
    process.env.LSM_MIN_KYC_BET = 'none';
    process.env.LSM_MIN_KYC_LP = 'none';
    process.env.LSM_SYSTEM_MODE = 'normal';

    store = {
      markets: new MemRepo(LsmMarket),
      snapshots: new MemRepo(LsmOddsSnapshot),
      orders: new MemRepo(LsmOrder),
      legs: new MemRepo(LsmOrderLeg),
      vaults: new MemRepo(LsmVault),
      positions: new MemRepo(LsmVaultPosition),
      events: new MemRepo(LsmVaultEvent),
      subs: new MemRepo(LsmVaultSubscription),
      marketHouse: new MemRepo(LsmMarketHouse),
    };
    GLOBAL_STORE = store;
    asset = new InMemoryAsset();

    // 盘口（live，2-way），公允赔率 2.0
    marketRow = await store.markets.save(
      store.markets.create({
        externalMarketId: 'ext-1',
        eventId: 'evt-1',
        sport: 'soccer',
        league: 'EPL',
        homeTeam: 'A',
        awayTeam: 'B',
        outcomeCount: 2,
        status: LsmMarketStatus.LIVE,
        kickoffAt: new Date(),
        lastOddsAt: new Date(),
        winningOutcomeIdx: null,
      }),
    );

    feedMock = {
      latestFairOdds: jest.fn(async () => 2.0),
      isTradable: jest.fn(() => marketRow.status === LsmMarketStatus.LIVE),
      isStale: jest.fn(() => false),
    };

    const kycMock = {
      getKYCStatus: jest.fn(async () => ({ userId: 'x', level: KYCLevel.NONE, status: 'none' })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LsmVaultService,
        LsmOrderService,
        LsmUnderwritingService,
        LsmRiskService,
        LsmSystemModeService,
        LsmComplianceService,
        LsmReconciliationService,
        { provide: LsmFeedService, useValue: feedMock },
        { provide: AxpAssetAdapter, useValue: asset },
        { provide: LSM_ASSET_ADAPTER, useValue: asset },
        {
          // 双标的注册表（需求 22）：测试仅用 AXP，按任意 asset 路由到同一 mock 适配器。
          provide: AssetAdapterRegistry,
          useValue: {
            forAsset: () => asset,
            offeredAssets: () => ['AXP'],
            defaultAsset: () => 'AXP',
            resolveOffered: () => 'AXP',
          },
        },
        { provide: KYCService, useValue: kycMock },
        { provide: DataSource, useValue: makeDataSource(store) },
        { provide: getRepositoryToken(LsmMarket), useValue: store.markets },
        { provide: getRepositoryToken(LsmOddsSnapshot), useValue: store.snapshots },
        { provide: getRepositoryToken(LsmOrder), useValue: store.orders },
        { provide: getRepositoryToken(LsmOrderLeg), useValue: store.legs },
        { provide: getRepositoryToken(LsmVault), useValue: store.vaults },
        { provide: getRepositoryToken(LsmVaultPosition), useValue: store.positions },
        { provide: getRepositoryToken(LsmVaultEvent), useValue: store.events },
        { provide: getRepositoryToken(LsmVaultSubscription), useValue: store.subs },
        { provide: getRepositoryToken(LsmMarketHouse), useValue: store.marketHouse },
      ],
    }).compile();

    order = moduleRef.get(LsmOrderService);
    vault = moduleRef.get(LsmVaultService);
    systemMode = moduleRef.get(LsmSystemModeService);

    // 初始发行：给 LP 与 bettor 充值 AXP
    asset.mint(LP, 100000);
    asset.mint(BETTOR, 10000);
  });

  /** 守恒断言：用户余额 + Σ金库权益 + Σ未结预留 == 已发行总额。 */
  function assertConservation() {
    const vaultEquity = store.vaults.rows.reduce(
      (a, v) => a + (Number(v.bankroll) - Number(v.reserved)),
      0,
    );
    const vaultReserved = store.vaults.rows.reduce((a, v) => a + Number(v.reserved), 0);
    const total = asset.totalUserBalance() + vaultEquity + vaultReserved;
    expect(total).toBe(asset.issued);
  }

  it('LP 注资官方金库 → NAV=1.0、bankroll=注资额', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    const r = await vault.deposit(protocol.id, LP, 50000);
    expect(r.sharesMinted).toBe(50000); // 首笔 1:1
    expect(r.nav).toBeCloseTo(1.0, 6);
    const view = await vault.getVault(protocol.id);
    expect(view.bankroll).toBe(50000);
    expect(await asset.balanceOf(LP)).toBe(50000);
    assertConservation();
  });

  it('下注（赢）：派彩=保证金+最大盈利，金库 NAV 下降，AXP 守恒', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);

    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 100, leverage: 2 });
    expect(preview.tradableOdds).toBeLessThan(2.0); // edge 压缩
    expect(preview.maxProfit).toBeGreaterThan(0);

    const placed = await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 100,
      leverage: 2,
      quotedOdds: preview.tradableOdds,
      idemKey: 'bet-win-1',
      country: 'SG',
    });
    expect(placed.status).toBe(LsmOrderStatus.OPEN);
    expect(await asset.balanceOf(BETTOR)).toBe(9900); // 扣 100 保证金
    assertConservation();

    // 偿付不变量：金库 reserved ≤ bankroll
    const vrow = store.vaults.rows[0];
    expect(Number(vrow.reserved)).toBeLessThanOrEqual(Number(vrow.bankroll));

    // 结算：outcome 0 获胜
    const res = await order.settleMarket(marketRow.id, 0);
    expect(res.won).toBe(1);
    const settled = await store.orders.findOne({ where: { id: placed.id } });
    expect(settled.status).toBe(LsmOrderStatus.WON);
    const payout = Number(settled.stake) + Number(settled.maxProfit);
    expect(await asset.balanceOf(BETTOR)).toBe(9900 + payout);
    // 金库权益减少了 maxProfit（赔付净额）
    const navAfter = (await vault.getVault(protocol.id)).nav;
    expect(navAfter).toBeLessThan(1.0);
    assertConservation();
  });

  it('下注（输）：金库收走保证金，NAV 上升，AXP 守恒', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);

    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 200, leverage: 3 });
    await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 200,
      leverage: 3,
      quotedOdds: preview.tradableOdds,
      idemKey: 'bet-lose-1',
      country: 'SG',
    });
    // outcome 1 获胜 → bettor(押 0) 输
    const res = await order.settleMarket(marketRow.id, 1);
    expect(res.lost).toBe(1);
    expect(await asset.balanceOf(BETTOR)).toBe(9800); // 保证金没收
    const navAfter = (await vault.getVault(protocol.id)).nav;
    expect(navAfter).toBeGreaterThan(1.0); // LP 获利
    assertConservation();
  });

  it('取消盘口退款：保证金原额退还，金库预留释放，AXP 守恒', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 1, stake: 150, leverage: 2 });
    await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 1,
      stake: 150,
      leverage: 2,
      quotedOdds: preview.tradableOdds,
      idemKey: 'bet-refund-1',
      country: 'SG',
    });
    expect(await asset.balanceOf(BETTOR)).toBe(9850);
    const res = await order.refundMarket(marketRow.id);
    expect(res.refunded).toBe(1);
    expect(await asset.balanceOf(BETTOR)).toBe(10000); // 原额退还
    const vrow = store.vaults.rows[0];
    expect(Number(vrow.reserved)).toBe(0); // 预留释放
    assertConservation();
  });

  it('幂等：相同 idemKey 重复下单只生成一笔', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 100, leverage: 2 });
    const input = {
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 100,
      leverage: 2,
      quotedOdds: preview.tradableOdds,
      idemKey: 'dup-1',
      country: 'SG',
    };
    const a = await order.place(input);
    const b = await order.place(input);
    expect(a.id).toBe(b.id);
    expect(store.orders.rows.length).toBe(1);
    expect(await asset.balanceOf(BETTOR)).toBe(9900); // 只扣一次
  });

  it('门禁：system-mode halted 禁止开新仓', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    systemMode.setMode(LsmSystemMode.HALTED);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 100, leverage: 2 });
    await expect(
      order.place({
        userId: BETTOR,
        marketId: marketRow.id,
        outcomeIdx: 0,
        stake: 100,
        leverage: 2,
        quotedOdds: preview.tradableOdds,
        idemKey: 'halt-1',
        country: 'SG',
      }),
    ).rejects.toThrow(/SYSTEM_MODE_HALTED/);
  });

  it('门禁：地域黑名单（US）禁止下注', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 100, leverage: 2 });
    await expect(
      order.place({
        userId: BETTOR,
        marketId: marketRow.id,
        outcomeIdx: 0,
        stake: 100,
        leverage: 2,
        quotedOdds: preview.tradableOdds,
        idemKey: 'geo-1',
        country: 'US',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('滑点：报价偏离可成交赔率超 5% 被拒（SLIPPAGE_EXCEEDED）', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    await expect(
      order.place({
        userId: BETTOR,
        marketId: marketRow.id,
        outcomeIdx: 0,
        stake: 100,
        leverage: 2,
        quotedOdds: 3.0, // 远高于可成交赔率（~1.9）
        idemKey: 'slip-1',
        country: 'SG',
      }),
    ).rejects.toThrow(/SLIPPAGE_EXCEEDED/);
  });

  // ── 提前平仓 cash-out 全链路 (task 5: 开仓 → 价变 → 平仓 → 守恒) ──

  it('开仓 → 价变(增值) → 平仓：兑现>保证金，预留释放，订单 CASHED_OUT，AXP 守恒', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);

    // 开仓：公允赔率 2.0
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 200, leverage: 3 });
    const placed = await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 200,
      leverage: 3,
      quotedOdds: preview.tradableOdds,
      idemKey: 'cashout-up-1',
      country: 'SG',
    });
    expect(placed.status).toBe(LsmOrderStatus.OPEN);
    expect(await asset.balanceOf(BETTOR)).toBe(9800); // 扣 200 保证金
    assertConservation();

    // 价变：本方更被看好（公允赔率 2.0 → 1.5）→ 当前可成交赔率下降 → 持仓增值
    feedMock.latestFairOdds.mockResolvedValue(1.5);

    const cashed = await order.cashOut(placed.id, BETTOR);
    expect(cashed.status).toBe(LsmOrderStatus.CASHED_OUT);

    const cashout = Number(cashed.payout);
    // 增值场景：兑现值 > 保证金（已实现正盈亏）
    expect(cashout).toBeGreaterThan(200);
    expect(Number(cashed.closePnl)).toBe(cashout - 200);
    // 用户入账兑现值
    expect(await asset.balanceOf(BETTOR)).toBe(9800 + cashout);

    // 兑现 ≤ 该单预留（= maxProfit + stake），偿付不变量护栏
    expect(cashout).toBeLessThanOrEqual(Number(placed.stake) + Number(placed.maxProfit));

    // 金库腿预留全部释放
    const vrow = store.vaults.rows[0];
    expect(Number(vrow.reserved)).toBe(0);
    expect(Number(vrow.reserved)).toBeLessThanOrEqual(Number(vrow.bankroll)); // 偿付保持
    assertConservation();
  });

  it('开仓 → 价变(贬值) → 平仓：兑现<保证金，订单 CASHED_OUT，AXP 守恒', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);

    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 300, leverage: 4 });
    const placed = await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 300,
      leverage: 4,
      quotedOdds: preview.tradableOdds,
      idemKey: 'cashout-down-1',
      country: 'SG',
    });
    expect(await asset.balanceOf(BETTOR)).toBe(9700);
    assertConservation();

    // 价变：本方更不被看好（公允赔率 2.0 → 3.0）→ 当前可成交赔率上升 → 持仓贬值
    feedMock.latestFairOdds.mockResolvedValue(3.0);

    const cashed = await order.cashOut(placed.id, BETTOR);
    expect(cashed.status).toBe(LsmOrderStatus.CASHED_OUT);

    const cashout = Number(cashed.payout);
    // 贬值场景：兑现值 < 保证金（已实现负盈亏），但 ≥ 0
    expect(cashout).toBeLessThan(300);
    expect(cashout).toBeGreaterThanOrEqual(0);
    expect(await asset.balanceOf(BETTOR)).toBe(9700 + cashout);

    const vrow = store.vaults.rows[0];
    expect(Number(vrow.reserved)).toBe(0);
    expect(Number(vrow.reserved)).toBeLessThanOrEqual(Number(vrow.bankroll));
    assertConservation();
  });

  it('平仓幂等：重复 cashOut 同一订单只入账一次', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 200, leverage: 2 });
    const placed = await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 200,
      leverage: 2,
      quotedOdds: preview.tradableOdds,
      idemKey: 'cashout-idem-1',
      country: 'SG',
    });
    feedMock.latestFairOdds.mockResolvedValue(1.6);
    const first = await order.cashOut(placed.id, BETTOR);
    const balAfterFirst = await asset.balanceOf(BETTOR);
    const second = await order.cashOut(placed.id, BETTOR); // 已 CASHED_OUT → 幂等返回
    expect(second.status).toBe(LsmOrderStatus.CASHED_OUT);
    expect(Number(second.payout)).toBe(Number(first.payout));
    expect(await asset.balanceOf(BETTOR)).toBe(balAfterFirst); // 不重复入账
    assertConservation();
  });

  it('平仓门禁：盘口暂停时拒绝平仓（MARKET_SUSPENDED）', async () => {
    const protocol = await vault.getOrCreateProtocolVault();
    await vault.deposit(protocol.id, LP, 50000);
    const preview = await order.preview({ marketId: marketRow.id, outcomeIdx: 0, stake: 100, leverage: 2 });
    const placed = await order.place({
      userId: BETTOR,
      marketId: marketRow.id,
      outcomeIdx: 0,
      stake: 100,
      leverage: 2,
      quotedOdds: preview.tradableOdds,
      idemKey: 'cashout-suspend-1',
      country: 'SG',
    });
    // 盘口暂停（非 tradable）
    marketRow.status = LsmMarketStatus.SUSPENDED;
    await expect(order.cashOut(placed.id, BETTOR)).rejects.toThrow(/MARKET_SUSPENDED/);
    // 拒绝后订单仍为 OPEN，资金不变
    const fresh = await store.orders.findOne({ where: { id: placed.id } });
    expect(fresh.status).toBe(LsmOrderStatus.OPEN);
    assertConservation();
  });
});
