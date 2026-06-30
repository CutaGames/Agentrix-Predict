import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { UserStableBalance } from '../../entities/user-stable-balance.entity';
import { UserStableLedger } from '../../entities/user-stable-ledger.entity';
import { ChainRegistry } from './onchain/chain-registry';

/**
 * 稳定币（USDC）镜像账本服务（LSM 链上稳定币平台 Phase B · 需求 5、6、7、18、19）。
 *
 * 与 `AxpService` 同构：所有写都走单一原子事务（append ledger 行 + 更新 snapshot 余额）；
 * 读命中 `user_stable_balances`（O(1)）。金额始终为正整数内部最小单位；当提供 `refId` 时
 * 按 (userId, source, refId) 精确一次（事务内预检 no-op + 并发 partial UNIQUE 23505 兜底）。
 *
 * 语义（available = 可用，reserved = 冻结/预留）：
 *   - credit  : available += amount（充值入账 / 派彩 / 赎回）
 *   - debit   : available -= amount（LP 出资存入），校验余额充足
 *   - escrow  : available -= amount, reserved += amount（下注保证金 / 提现冻结）
 *   - release : reserved -= amount, available += amount（退款 / 平局 / 提现解冻）
 *
 * 与 AXP 两套账本并存、互不覆盖（需求 19.3）。chainId 缺省取 ChainRegistry.defaultChainId。
 */

export interface StableLedgerInput {
  userId: string;
  amount: number;
  source: string;
  refId?: string | null;
  chainId?: number;
  txHash?: string | null;
}

export interface StableBalanceView {
  available: number;
  reserved: number;
  chainId: number;
  updated_at: number;
}

type Direction = 'credit' | 'debit' | 'escrow' | 'release';

@Injectable()
export class StableLedgerService {
  private readonly logger = new Logger(StableLedgerService.name);

  constructor(
    @InjectRepository(UserStableLedger)
    private readonly ledger: Repository<UserStableLedger>,
    @InjectRepository(UserStableBalance)
    private readonly balances: Repository<UserStableBalance>,
    private readonly dataSource: DataSource,
    private readonly registry: ChainRegistry,
  ) {}

  // ── Read ────────────────────────────────────────────────────

  async getBalance(userId: string, chainId?: number): Promise<StableBalanceView> {
    const cid = chainId ?? this.registry.defaultChainId;
    const row = await this.balances.findOne({ where: { userId, chainId: cid } });
    return {
      available: row ? Number(row.available) : 0,
      reserved: row ? Number(row.reserved) : 0,
      chainId: cid,
      updated_at: row?.updatedAt?.getTime() ?? Date.now(),
    };
  }

  async listHistory(userId: string, chainId?: number, limit = 50) {
    const cid = chainId ?? this.registry.defaultChainId;
    const rows = await this.ledger.find({
      where: { userId, chainId: cid },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      amount: Number(r.amount),
      source: r.source,
      ref_id: r.refId,
      tx_hash: r.txHash,
      created_at: r.createdAt.getTime(),
    }));
  }

  // ── Write（公开语义方法）────────────────────────────────────

  /** 入账：available += amount（充值/派彩/赎回）。 */
  credit(input: StableLedgerInput) {
    return this.apply('credit', input);
  }

  /** 扣减：available -= amount（LP 出资）。校验可用余额充足。 */
  debit(input: StableLedgerInput) {
    return this.apply('debit', input);
  }

  /** 冻结：available -= amount, reserved += amount（下注保证金/提现冻结）。 */
  escrow(input: StableLedgerInput) {
    return this.apply('escrow', input);
  }

  /** 解冻：reserved -= amount, available += amount（退款/平局/提现解冻）。 */
  release(input: StableLedgerInput) {
    return this.apply('release', input);
  }

  // ── 内部：原子事务（snapshot + ledger）+ 幂等 ───────────────

  private assertInt(amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(`stable amount must be a positive integer, got ${amount}`);
    }
  }

  private async apply(
    direction: Direction,
    input: StableLedgerInput,
  ): Promise<{ ledger_id: string; available: number; reserved: number }> {
    this.assertInt(input.amount);
    const chainId = input.chainId ?? this.registry.defaultChainId;
    const idempotent = input.refId != null && input.refId !== '';

    const run = () =>
      this.dataSource.transaction(async (manager) => {
        // 精确一次：同 (userId, source, refId) 已存在则 no-op，返回当前余额。
        if (idempotent) {
          const existing = await manager.findOne(UserStableLedger, {
            where: {
              userId: input.userId,
              source: input.source,
              refId: input.refId as string,
            },
          });
          if (existing) {
            const cur = await manager.findOne(UserStableBalance, {
              where: { userId: input.userId, chainId },
            });
            return {
              ledger_id: existing.id,
              available: Number(cur?.available ?? 0),
              reserved: Number(cur?.reserved ?? 0),
            };
          }
        }

        const snap = await manager.findOne(UserStableBalance, {
          where: { userId: input.userId, chainId },
        });
        const available = snap ? Number(snap.available) : 0;
        const reserved = snap ? Number(snap.reserved) : 0;
        const { nextAvailable, nextReserved } = this.computeNext(
          direction,
          available,
          reserved,
          input.amount,
        );

        const row = manager.create(UserStableLedger, {
          userId: input.userId,
          chainId,
          direction,
          amount: String(input.amount),
          source: input.source,
          refId: input.refId ?? null,
          txHash: input.txHash ?? null,
        });
        await manager.save(row);

        if (!snap) {
          await manager.save(
            manager.create(UserStableBalance, {
              userId: input.userId,
              chainId,
              available: String(nextAvailable),
              reserved: String(nextReserved),
            }),
          );
        } else {
          await manager.update(
            UserStableBalance,
            { userId: input.userId, chainId },
            { available: String(nextAvailable), reserved: String(nextReserved) },
          );
        }
        return { ledger_id: row.id, available: nextAvailable, reserved: nextReserved };
      });

    if (!idempotent) return run();

    // 并发安全网：两请求竞争越过预检时，partial unique 拒绝第二次插入（23505）→ 回放首次结果。
    try {
      return await run();
    } catch (e: any) {
      if (e?.code === '23505') {
        const existing = await this.ledger.findOne({
          where: {
            userId: input.userId,
            source: input.source,
            refId: input.refId as string,
          },
        });
        const bal = await this.balances.findOne({
          where: { userId: input.userId, chainId },
        });
        return {
          ledger_id: existing?.id ?? '',
          available: Number(bal?.available ?? 0),
          reserved: Number(bal?.reserved ?? 0),
        };
      }
      throw e;
    }
  }

  private computeNext(
    direction: Direction,
    available: number,
    reserved: number,
    amount: number,
  ): { nextAvailable: number; nextReserved: number } {
    switch (direction) {
      case 'credit':
        return { nextAvailable: available + amount, nextReserved: reserved };
      case 'debit':
        if (available < amount) {
          throw new BadRequestException(
            `insufficient stable balance (have ${available}, need ${amount})`,
          );
        }
        return { nextAvailable: available - amount, nextReserved: reserved };
      case 'escrow':
        if (available < amount) {
          throw new BadRequestException(
            `insufficient stable balance to escrow (have ${available}, need ${amount})`,
          );
        }
        return { nextAvailable: available - amount, nextReserved: reserved + amount };
      case 'release':
        if (reserved < amount) {
          throw new BadRequestException(
            `insufficient reserved to release (reserved ${reserved}, need ${amount})`,
          );
        }
        return { nextAvailable: available + amount, nextReserved: reserved - amount };
    }
  }
}
