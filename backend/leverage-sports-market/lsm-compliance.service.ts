import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { KYCService } from '../compliance/kyc.service';
import { KYCLevel } from '../../entities/user.entity';

/**
 * LSM 准入 / 披露 / 地域门禁（task 8 / 需求 8.1、8.2、8.4）。
 *
 * 复用 Agentrix `compliance` 模块的 KYCService 做资格门禁，叠加地域黑名单：
 *  - 地域门禁：受限国家/地区禁止下注与出资。国家码取自请求头（CDN 注入的
 *    `cf-ipcountry` / `x-country`），黑名单经 env `LSM_BLOCKED_COUNTRIES`
 *    （逗号分隔 ISO-3166-1 alpha-2）配置。
 *  - KYC 门禁：可经 env 设置下注/出资所需最低 KYC 等级（默认下注 none、出资
 *    与创建金库 basic）。被拒主体禁止相应操作（需求 3.4：入口置灰 + 说明）。
 *
 * v1 标的为 AXP（不可提现、仅站内用途），故默认门槛较宽；稳定币升级（P5）须法务
 * 评审前置并收紧门槛。本服务不构成法律意见。
 */
@Injectable()
export class LsmComplianceService {
  private readonly logger = new Logger(LsmComplianceService.name);

  private readonly blockedCountries: Set<string>;
  private readonly minBetLevel: KYCLevel;
  private readonly minLpLevel: KYCLevel;
  private readonly minLeaderLevel: KYCLevel;

  constructor(private readonly kyc: KYCService) {
    this.blockedCountries = new Set(
      (process.env.LSM_BLOCKED_COUNTRIES || '')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    );
    this.minBetLevel = this.parseLevel(process.env.LSM_MIN_KYC_BET, KYCLevel.NONE);
    // 预发布阶段暂不要求 KYC（产品负责人 2026-06-25 决定）：LP 出资与创建金库默认 NONE，
    // 可经 env LSM_MIN_KYC_LP / LSM_MIN_KYC_LEADER 重新收紧。
    this.minLpLevel = this.parseLevel(process.env.LSM_MIN_KYC_LP, KYCLevel.NONE);
    this.minLeaderLevel = this.parseLevel(
      process.env.LSM_MIN_KYC_LEADER,
      KYCLevel.NONE,
    );
  }

  private parseLevel(v: string | undefined, fallback: KYCLevel): KYCLevel {
    switch ((v || '').toLowerCase()) {
      case 'none':
        return KYCLevel.NONE;
      case 'basic':
        return KYCLevel.BASIC;
      case 'verified':
        return KYCLevel.VERIFIED;
      default:
        return fallback;
    }
  }

  private levelRank(l: KYCLevel): number {
    return l === KYCLevel.VERIFIED ? 2 : l === KYCLevel.BASIC ? 1 : 0;
  }

  /** 地域门禁：国家码在黑名单内则拒绝。country 为空（未知）时放行（依赖上游/法务）。 */
  assertRegionAllowed(country?: string | null): void {
    if (!country) return;
    const cc = country.trim().toUpperCase();
    if (this.blockedCountries.has(cc)) {
      throw new ForbiddenException(`GEO_RESTRICTED:${cc}`);
    }
  }

  private async assertKycAtLeast(userId: string, min: KYCLevel): Promise<void> {
    if (this.levelRank(min) === 0) return; // 无需 KYC
    let status;
    try {
      status = await this.kyc.getKYCStatus(userId);
    } catch {
      throw new ForbiddenException('KYC_REQUIRED');
    }
    if (status.status !== 'approved' || this.levelRank(status.level) < this.levelRank(min)) {
      throw new ForbiddenException(`KYC_REQUIRED:${min}`);
    }
  }

  /** 下注准入：地域 + 最低 KYC（下注）。 */
  async assertCanBet(userId: string, country?: string | null): Promise<void> {
    this.assertRegionAllowed(country);
    await this.assertKycAtLeast(userId, this.minBetLevel);
  }

  /** 出资（LP 存入）准入：地域 + 最低 KYC（LP）。 */
  async assertCanProvideLiquidity(userId: string, country?: string | null): Promise<void> {
    this.assertRegionAllowed(country);
    await this.assertKycAtLeast(userId, this.minLpLevel);
  }

  /** 创建用户金库（主理人）准入：地域 + 最低 KYC（主理人，默认更高）。 */
  async assertCanCreateVault(userId: string, country?: string | null): Promise<void> {
    this.assertRegionAllowed(country);
    await this.assertKycAtLeast(userId, this.minLeaderLevel);
  }

  /** 风险披露文案（zh/en），供前端展示（需求 8.1、8.4）。 */
  disclosure(): {
    zh: { title: string; points: string[] };
    en: { title: string; points: string[] };
    minKyc: { bet: KYCLevel; lp: KYCLevel; leader: KYCLevel };
  } {
    return {
      zh: {
        title: '风险披露与准入说明',
        points: [
          'AXP 为平台积分，不可提现、仅站内用途。',
          '杠杆滚球为高风险玩法，可能损失全部保证金；LP 出资按份额社会化分担金库盈亏，至多损失出资。',
          '本页内容为产品功能说明，非投资建议。',
          '受限地域用户禁止下注与出资；部分操作需完成相应 KYC。',
          '稳定币标的升级须法务评审前置，非默认开启。',
        ],
      },
      en: {
        title: 'Risk Disclosure & Eligibility',
        points: [
          'AXP is a platform credit: non-withdrawable, in-app use only.',
          'Leverage in-play betting is high risk; you may lose your entire margin. LPs share vault PnL pro-rata and can lose at most their deposit.',
          'This page is product information, not investment advice.',
          'Users in restricted regions are barred from betting and LP deposits; some actions require KYC.',
          'Any stablecoin asset upgrade is gated behind legal review and off by default.',
        ],
      },
      minKyc: { bet: this.minBetLevel, lp: this.minLpLevel, leader: this.minLeaderLevel },
    };
  }
}
