/**
 * LsmPredictionConnector — Agentrix 自有杠杆滚球预测市场（LSM）作为 prediction 品类源
 * 接入统一聚合检索（LSM Phase G · Req 27）。
 *
 * 与外部预测源（Polymarket/Manifold，只读跳转）并列，让用户在对话框 `/ard/search`
 * 检索"预测机会"时同时看到本平台 LSM 盘口。归一化为 NormalizedListing，由
 * AggregationSyncService 按 (source, externalId) 幂等 upsert，经 UnifiedMarketplaceService
 * .search 以 source=lsm、aggregated=true 可见。
 *
 * 能力位（需求 27）：`canDiscover=true`。**`canAccept=false`** —— LSM 是「加杠杆 vs 金库」
 * 的固定赔率下单，需要 outcome/leverage/quotedOdds 等参数，无法用通用 ParticipationContext
 * (action/amount/currency) 表达；故代下单**不走通用 accept**，而是由对话式 Copilot 的
 * `lsm_place_order` 工具（携全量下单参数）或 /lsm 站点完成。本连接器只负责"被检索到"。
 * externalUrl 指向本平台 LSM 站点的盘口详情，点击即进入下单/对话路径。
 *
 * 数据来源为本地引擎（LsmMarketService），无出站 HTTP、无凭证。仅当
 * `LSM_PREDICTION_CONNECTOR_ENABLED=1` 时由 bootstrap 注册（默认关，零回归）。
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AggregationCategory,
  ConnectorCapabilities,
  ExternalConnector,
  NormalizedListing,
} from '../types/connector.types';
import { LsmMarketService } from '../../leverage-sports-market/lsm-market.service';

const LSM_SOURCE = 'lsm';
const DEFAULT_SITE_URL = 'https://polymarket.agentrix.top';
const DEFAULT_LIMIT = 50;

@Injectable()
export class LsmPredictionConnector implements ExternalConnector {
  private readonly logger = new Logger(LsmPredictionConnector.name);

  readonly category: AggregationCategory = 'prediction';
  readonly source: string = LSM_SOURCE;
  readonly capabilities: ConnectorCapabilities = {
    canDiscover: true,
    canAccept: false,
    canPublish: false,
  };

  constructor(private readonly markets: LsmMarketService) {}

  private get siteUrl(): string {
    return (process.env.LSM_WEB_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  }

  /**
   * 只读聚合：拉取活跃（赛前+滚球）盘口并归一化。单页返回（LSM 活跃盘口量有限），
   * 失败仅告警返回空集（降级隔离由 sync 层兜底）。
   */
  async fetchListings(): Promise<{ items: NormalizedListing[]; nextCursor?: string }> {
    try {
      const rows = await this.markets.listLive(undefined, DEFAULT_LIMIT);
      const items = rows
        .map((m) => this.normalize(m))
        .filter((x): x is NormalizedListing => x !== null);
      this.logger.debug(`[lsm] fetched markets=${rows.length} normalized=${items.length}`);
      return { items };
    } catch (e) {
      this.logger.warn(`[lsm] fetchListings failed: ${(e as Error).message}`);
      return { items: [] };
    }
  }

  private normalize(m: any): NormalizedListing | null {
    if (!m?.id) return null;
    const title = `${m.homeTeam} vs ${m.awayTeam}`;
    const labels = [m.homeTeam, m.awayTeam, 'Draw'];
    const oddsDesc = (m.odds || [])
      .map((o: any) => `${labels[o.outcomeIdx] ?? `#${o.outcomeIdx}`} @ ${Number(o.fairOdds).toFixed(2)}`)
      .join(' · ');
    const statusZh =
      m.status === 'live' ? '滚球进行中' : m.status === 'pre' ? '即将开赛' : m.status;
    const description = `${m.league ? m.league + ' · ' : ''}${statusZh}${oddsDesc ? ' · ' + oddsDesc : ''} · 杠杆预测（AXP/USDC，USDC 链上结算·测试网）`;
    const tags = ['prediction', 'sports', m.sport || 'soccer', 'agentrix-lsm'].filter(Boolean);
    return {
      externalId: String(m.id),
      title,
      description,
      category: 'prediction',
      externalUrl: `${this.siteUrl}/lsm/market/${encodeURIComponent(String(m.id))}`,
      tags,
      // 杠杆预测带博彩属性，供 ComplianceGate 判定（与外部预测源一致）。
      regulated: 'gambling',
      raw: {
        marketId: m.id,
        status: m.status,
        league: m.league,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        odds: m.odds,
        // 提示前端/Copilot：内部源，代下单走 lsm_place_order 工具。
        internalPlacement: 'lsm_place_order',
      },
    };
  }
}
