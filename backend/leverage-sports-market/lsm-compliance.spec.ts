import { ForbiddenException } from '@nestjs/common';
import { LsmComplianceService } from './lsm-compliance.service';
import { LsmSystemModeService, LsmSystemMode } from './lsm-system-mode.service';
import { KYCLevel } from '../../entities/user.entity';

/**
 * task 8 验证：准入/披露/地域门禁。
 * task 12 验证：system-mode 全局熔断门禁。
 */

function makeKyc(level: KYCLevel, status: string) {
  return {
    getKYCStatus: jest.fn(async () => ({ userId: 'u1', level, status })),
  } as any;
}

describe('LsmComplianceService (task 8 准入/地域门禁)', () => {
  const ORIG = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it('地域黑名单内国家被拒（GEO_RESTRICTED）', async () => {
    process.env.LSM_BLOCKED_COUNTRIES = 'US,KP,IR';
    process.env.LSM_MIN_KYC_BET = 'none';
    const svc = new LsmComplianceService(makeKyc(KYCLevel.NONE, 'none'));
    await expect(svc.assertCanBet('u1', 'US')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertCanBet('u1', 'kp')).rejects.toBeInstanceOf(ForbiddenException); // 大小写不敏感
  });

  it('未在黑名单/国家未知时放行下注（下注默认无需 KYC）', async () => {
    process.env.LSM_BLOCKED_COUNTRIES = 'US';
    process.env.LSM_MIN_KYC_BET = 'none';
    const svc = new LsmComplianceService(makeKyc(KYCLevel.NONE, 'none'));
    await expect(svc.assertCanBet('u1', 'SG')).resolves.toBeUndefined();
    await expect(svc.assertCanBet('u1', null)).resolves.toBeUndefined();
  });

  it('LP 出资要求最低 KYC（basic）：未达标被拒，达标放行', async () => {
    process.env.LSM_BLOCKED_COUNTRIES = '';
    process.env.LSM_MIN_KYC_LP = 'basic';
    const denied = new LsmComplianceService(makeKyc(KYCLevel.NONE, 'none'));
    await expect(denied.assertCanProvideLiquidity('u1', 'SG')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const ok = new LsmComplianceService(makeKyc(KYCLevel.BASIC, 'approved'));
    await expect(ok.assertCanProvideLiquidity('u1', 'SG')).resolves.toBeUndefined();
  });

  it('创建金库（主理人）要求更高 KYC（verified）', async () => {
    process.env.LSM_MIN_KYC_LEADER = 'verified';
    const basic = new LsmComplianceService(makeKyc(KYCLevel.BASIC, 'approved'));
    await expect(basic.assertCanCreateVault('u1', 'SG')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const verified = new LsmComplianceService(makeKyc(KYCLevel.VERIFIED, 'approved'));
    await expect(verified.assertCanCreateVault('u1', 'SG')).resolves.toBeUndefined();
  });

  it('KYC pending（未 approved）即使等级足够也被拒', async () => {
    process.env.LSM_MIN_KYC_LP = 'basic';
    const pending = new LsmComplianceService(makeKyc(KYCLevel.BASIC, 'pending'));
    await expect(pending.assertCanProvideLiquidity('u1', 'SG')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('披露文案提供 zh/en 双语 + 最低 KYC 门槛', () => {
    const svc = new LsmComplianceService(makeKyc(KYCLevel.NONE, 'none'));
    const d = svc.disclosure();
    expect(d.zh.points.length).toBeGreaterThan(0);
    expect(d.en.points.length).toBeGreaterThan(0);
    expect(d.minKyc).toHaveProperty('bet');
    expect(d.minKyc).toHaveProperty('lp');
    expect(d.minKyc).toHaveProperty('leader');
  });
});

describe('LsmSystemModeService (task 12 全局熔断)', () => {
  it('normal：开仓/存入/赎回均放行', () => {
    const svc = new LsmSystemModeService();
    svc.setMode(LsmSystemMode.NORMAL);
    expect(() => svc.assertCanOpen()).not.toThrow();
    expect(() => svc.assertCanDeposit()).not.toThrow();
    expect(() => svc.assertCanRedeem()).not.toThrow();
  });

  it('reduce_only：禁开仓/禁存入，但允许赎回（降敞口）', () => {
    const svc = new LsmSystemModeService();
    svc.setMode(LsmSystemMode.REDUCE_ONLY, 'risk drill');
    expect(() => svc.assertCanOpen()).toThrow(/SYSTEM_MODE_REDUCE_ONLY/);
    expect(() => svc.assertCanDeposit()).toThrow(/SYSTEM_MODE_REDUCE_ONLY/);
    expect(() => svc.assertCanRedeem()).not.toThrow();
    expect(svc.getStatus().mode).toBe(LsmSystemMode.REDUCE_ONLY);
    expect(svc.getStatus().reason).toBe('risk drill');
  });

  it('halted：开仓/存入/赎回全部禁止', () => {
    const svc = new LsmSystemModeService();
    svc.setMode(LsmSystemMode.HALTED);
    expect(() => svc.assertCanOpen()).toThrow(/SYSTEM_MODE_HALTED/);
    expect(() => svc.assertCanDeposit()).toThrow(/SYSTEM_MODE_HALTED/);
    expect(() => svc.assertCanRedeem()).toThrow(/SYSTEM_MODE_HALTED/);
  });
});
