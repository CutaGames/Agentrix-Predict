import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LsmMarket } from '../../entities/lsm-market.entity';
import { LsmOddsSnapshot } from '../../entities/lsm-odds-snapshot.entity';
import { LsmOrder } from '../../entities/lsm-order.entity';
import { LsmOrderLeg } from '../../entities/lsm-order-leg.entity';
import { LsmVault } from '../../entities/lsm-vault.entity';
import { LsmVaultPosition } from '../../entities/lsm-vault-position.entity';
import { LsmVaultEvent } from '../../entities/lsm-vault-event.entity';
import { LsmVaultSubscription } from '../../entities/lsm-vault-subscription.entity';
import { LsmMarketHouse } from '../../entities/lsm-market-house.entity';
import { UserStableBalance } from '../../entities/user-stable-balance.entity';
import { UserStableLedger } from '../../entities/user-stable-ledger.entity';
import { AxpModule } from '../axp/axp.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { LsmFeedService } from './lsm-feed.service';
import { LsmFeedPoller } from './lsm-feed.poller';
import { LsmMarketService } from './lsm-market.service';
import { LsmOrderService } from './lsm-order.service';
import { LsmVaultService } from './lsm-vault.service';
import { LsmUnderwritingService } from './lsm-underwriting.service';
import { LsmRiskService } from './lsm-risk.service';
import { LsmSystemModeService } from './lsm-system-mode.service';
import { LsmComplianceService } from './lsm-compliance.service';
import { LsmReconciliationService } from './lsm-reconciliation.service';
import { LsmLeaderboardService } from './lsm-leaderboard.service';
import { LsmSchedulerService } from './lsm-scheduler.service';
import { AxpAssetAdapter, StablecoinAssetAdapter, assetAdapterFactory, AssetAdapterRegistry, LSM_ASSET_ADAPTER } from './lsm-asset.adapter';
import { ChainRegistry } from './onchain/chain-registry';
import { ChainProviderService } from './onchain/chain-provider.service';
import { SettlementGatewayService } from './onchain/settlement-gateway.service';
import { StableLedgerService } from './stable-ledger.service';
import { LsmMmAgentService } from './mm-agent/lsm-mm-agent.service';
import { LsmWalletService } from './lsm-wallet.service';
import { LsmController } from './lsm.controller';
import { LsmVaultController } from './lsm-vault.controller';
import { LsmAdminController } from './lsm-admin.controller';
import { LsmWalletController } from './lsm-wallet.controller';

/**
 * 杠杆滚球预测市场（LSM）模块 — P0–P3。
 *  - P0/P1：feed-bridge、只读盘口、AXP 资产适配、pricing、下单/结算。
 *  - P2：官方金库（NAV/存赎/偿付）作对手方。
 *  - P3：用户自建金库（主理人/分成/隔离）+ 承接路由（多金库按比例分摊）。
 * 复用 AxpModule（AxpService）作资金标的；feed-bridge 消费 KMarket 内部赔率 API。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      LsmMarket,
      LsmOddsSnapshot,
      LsmOrder,
      LsmOrderLeg,
      LsmVault,
      LsmVaultPosition,
      LsmVaultEvent,
      LsmVaultSubscription,
      LsmMarketHouse,
      UserStableBalance,
      UserStableLedger,
    ]),
    AxpModule,
    ComplianceModule,
  ],
  controllers: [LsmController, LsmVaultController, LsmAdminController, LsmWalletController],
  providers: [
    LsmFeedService,
    LsmFeedPoller,
    LsmMarketService,
    LsmOrderService,
    LsmVaultService,
    LsmUnderwritingService,
    LsmRiskService,
    LsmSystemModeService,
    LsmComplianceService,
    LsmReconciliationService,
    LsmLeaderboardService,
    LsmSchedulerService,
    ChainRegistry,
    ChainProviderService,
    StableLedgerService,
    SettlementGatewayService,
    LsmMmAgentService,
    LsmWalletService,
    AxpAssetAdapter,
    StablecoinAssetAdapter,
    AssetAdapterRegistry,
    {
      // 向后兼容：保留「默认适配器」令牌（按 LSM_ASSET_UNIT 二选一），新引擎按币种走 registry。
      provide: LSM_ASSET_ADAPTER,
      useFactory: assetAdapterFactory,
      inject: [AxpAssetAdapter, StablecoinAssetAdapter],
    },
  ],
  exports: [LsmFeedService, LsmMarketService, LsmOrderService, LsmVaultService],
})
export class LeverageSportsMarketModule {}
