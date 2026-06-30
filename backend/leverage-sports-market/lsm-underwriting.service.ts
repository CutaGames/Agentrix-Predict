import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LsmMarket } from '../../entities/lsm-market.entity';
import {
  LsmVault,
  LsmVaultKind,
  LsmVaultStatus,
} from '../../entities/lsm-vault.entity';
import {
  LsmVaultSubscription,
  LsmSubscriptionScopeType,
} from '../../entities/lsm-vault-subscription.entity';
import { LsmMarketHouse } from '../../entities/lsm-market-house.entity';
import { LsmVaultService } from './lsm-vault.service';
import { LsmAsset, normalizeAsset } from './lsm-asset.adapter';

export interface Allocation {
  vaultId: string;
  allocBps: number;
  /** 是否官方金库兜底腿（拆分余数归此腿） */
  isProtocol: boolean;
}

/**
 * 承接路由（P3）。决定盘口对手方金库及配比（按比例分摊）。
 *
 * 规则：
 *  - 已订阅该盘口/联赛、active、有容量的用户金库，按 (费率竞价低 → 优先, 容量大 → 优先) 排序选入。
 *  - 多金库按其容量比例分摊 allocBps，官方金库兜底剩余比例（始终作为最后一腿）。
 *  - 无可用用户金库 → 官方金库 100% 承接。
 *  - closing/closed 金库不参与新盘分配（存量未结仍按既定腿结算）。
 *  - 路由结果持久化到 lsm_market_house（同盘多行 allocBps 合计 10000）。
 */
@Injectable()
export class LsmUnderwritingService {
  constructor(
    @InjectRepository(LsmMarket)
    private readonly markets: Repository<LsmMarket>,
    @InjectRepository(LsmVault)
    private readonly vaults: Repository<LsmVault>,
    @InjectRepository(LsmVaultSubscription)
    private readonly subs: Repository<LsmVaultSubscription>,
    @InjectRepository(LsmMarketHouse)
    private readonly marketHouse: Repository<LsmMarketHouse>,
    private readonly vaultSvc: LsmVaultService,
  ) {}

  /** 获取（或首次计算并持久化）盘口承接配比（按币种隔离，需求 22.3）。 */
  async getAllocations(marketId: string, asset?: string): Promise<Allocation[]> {
    const a: LsmAsset = normalizeAsset(asset);
    const existing = await this.marketHouse.find({ where: { marketId, asset: a } });
    if (existing.length > 0) {
      const protocol = await this.vaultSvc.getOrCreateProtocolVault(a);
      return existing.map((r) => ({
        vaultId: r.vaultId,
        allocBps: r.allocBps,
        isProtocol: r.vaultId === protocol.id,
      }));
    }
    return this.computeAndPersist(marketId, a);
  }

  private async computeAndPersist(marketId: string, asset: LsmAsset): Promise<Allocation[]> {
    const market = await this.markets.findOne({ where: { id: marketId } });
    const protocol = await this.vaultSvc.getOrCreateProtocolVault(asset);

    // 候选用户金库订阅：匹配 marketId 或 league，enabled
    const scopeValues = [marketId];
    if (market?.league) scopeValues.push(market.league);
    const candidateSubs = await this.subs.find({
      where: scopeValues.map((sv) => ({ scopeValue: sv, enabled: true })),
    });

    // 过滤 active 用户金库 + 有容量 + 同币种（不跨币种共享流动性，需求 22.3）
    const userLegs: Array<{ vaultId: string; capacity: number; feeBidBps: number }> = [];
    for (const s of candidateSubs) {
      const v = await this.vaults.findOne({ where: { id: s.vaultId } });
      if (
        v &&
        v.kind === LsmVaultKind.USER &&
        v.status === LsmVaultStatus.ACTIVE &&
        normalizeAsset(v.assetUnit) === asset &&
        Number(s.capacity) > 0
      ) {
        userLegs.push({
          vaultId: s.vaultId,
          capacity: Number(s.capacity),
          feeBidBps: s.feeBidBps,
        });
      }
    }

    // 排序：费率竞价低优先，其次容量大优先
    userLegs.sort((a, b) => a.feeBidBps - b.feeBidBps || b.capacity - a.capacity);

    const allocations: Allocation[] = [];
    if (userLegs.length === 0) {
      allocations.push({ vaultId: protocol.id, allocBps: 10000, isProtocol: true });
    } else {
      // 用户金库按容量比例分摊「用户承接份额」（封顶 80%，官方兜底 ≥20%）
      const userShareBps = 8000;
      const totalCap = userLegs.reduce((a, l) => a + l.capacity, 0);
      let assigned = 0;
      userLegs.forEach((l, i) => {
        const bps =
          i === userLegs.length - 1
            ? userShareBps - assigned
            : Math.floor((userShareBps * l.capacity) / totalCap);
        assigned += bps;
        if (bps > 0) {
          allocations.push({ vaultId: l.vaultId, allocBps: bps, isProtocol: false });
        }
      });
      // 官方金库兜底剩余
      allocations.push({
        vaultId: protocol.id,
        allocBps: 10000 - allocations.reduce((a, x) => a + x.allocBps, 0),
        isProtocol: true,
      });
    }

    // 持久化
    await this.marketHouse.save(
      allocations.map((a) =>
        this.marketHouse.create({
          marketId,
          asset,
          vaultId: a.vaultId,
          allocBps: a.allocBps,
        }),
      ),
    );
    // 保证官方金库腿排在最后（拆分余数兜底）
    allocations.sort((a, b) => Number(a.isProtocol) - Number(b.isProtocol));
    return allocations;
  }

  // ── 订阅管理（P3，主理人配置承接，task 17 / 需求 11.6） ──────

  /** 主理人为其金库新增/更新一条承接订阅（联赛或单盘 + 容量 + 费率竞价）。 */
  async upsertSubscription(input: {
    vaultId: string;
    scopeType: LsmSubscriptionScopeType;
    scopeValue: string;
    capacity: number;
    feeBidBps: number;
    enabled?: boolean;
  }): Promise<LsmVaultSubscription> {
    if (!Number.isInteger(input.capacity) || input.capacity < 0) {
      throw new BadRequestException('capacity must be a non-negative integer AXP');
    }
    if (!Number.isInteger(input.feeBidBps) || input.feeBidBps < 0 || input.feeBidBps > 2000) {
      throw new BadRequestException('feeBidBps out of range (0-2000)');
    }
    const existing = await this.subs.findOne({
      where: {
        vaultId: input.vaultId,
        scopeType: input.scopeType,
        scopeValue: input.scopeValue,
      },
    });
    if (existing) {
      existing.capacity = String(input.capacity);
      existing.feeBidBps = input.feeBidBps;
      existing.enabled = input.enabled ?? existing.enabled;
      return this.subs.save(existing);
    }
    return this.subs.save(
      this.subs.create({
        vaultId: input.vaultId,
        scopeType: input.scopeType,
        scopeValue: input.scopeValue,
        capacity: String(input.capacity),
        feeBidBps: input.feeBidBps,
        enabled: input.enabled ?? true,
      }),
    );
  }

  /** 列出某金库的全部承接订阅。 */
  async listSubscriptions(vaultId: string): Promise<LsmVaultSubscription[]> {
    return this.subs.find({ where: { vaultId }, order: { createdAt: 'DESC' } });
  }

  /** 启用/停用一条订阅。 */
  async setSubscriptionEnabled(id: string, enabled: boolean): Promise<LsmVaultSubscription> {
    const s = await this.subs.findOne({ where: { id } });
    if (!s) throw new NotFoundException('subscription not found');
    s.enabled = enabled;
    return this.subs.save(s);
  }
}
