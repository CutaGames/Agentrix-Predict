# LSM Vault-as-MM on Injective — 设计与 PoC 路线（Phase G · Req 28 / Phase F 起点）

## 背景
LSM 是「用户加杠杆 vs 金库坐庄」的固定赔率模型（非 CLOB）。金库（HLP 范式）被动承接对手盘。
本文档把"AI 做市金库 agent"的链下落地（已实现）与"Injective 原生订单簿对接"的前瞻 PoC 衔接起来。

## 已落地（链下，Req 28.1/28.2）
- `mm-agent/lsm-mm.decision.ts` — 纯决策引擎 `decideMmAction(snapshot, cfg)`：
  - 目标利用率带（默认 30%~70%）：低于下界→`expand`（放容量、收紧 overround 吸引流量）；高于上界→`derisk`（缩容量、放宽 overround 排斥流量）；带内→`hold`。
  - **偿付不变量硬保证**：`capacity ≤ free = bankroll − reserved`，永不提议超出自由权益的承接量 → 不破 `bankroll ≥ reserved`（Property G5）。
  - 不活跃/资不抵债 → `halt`。
- `mm-agent/lsm-mm-agent.service.ts` — 定时（默认 60s）读 USDC 金库快照跑决策，写环形缓冲供可观测；
  - `LSM_MM_AGENT_ENABLED=1` 才启用循环（默认关）；**默认观察模式（dry-run）**，`LSM_MM_AGENT_APPLY=1` 时**真实写回**：把决策的 `{capacity, feeBidBps}` 写到该 USER 金库**已有的承接订阅**（`LsmUnderwritingService.upsertSubscription`，按订阅数均分 capacity；`halt`→容量 0+停用）；protocol 金库无订阅→no-op。
  - **偿付双保险**：决策引擎保证 `capacity ≤ free equity`；下单时 `LsmRiskService.assertLegWithinLimits` 再逐腿校验三层敞口上限 → 写回承接不会破 `bankroll≥reserved`（Property G5）。
- 可观测端点：`GET /lsm/mm-agent/decisions?limit=N`（只读，最近决策 + 利用率/bankroll/reserved/action/reason）。
- 决策器可叠加 LLM 行情解读（读赛况/新闻微调 overround 偏移），作为护栏内的"建议者"，最终仍过纯引擎钳制。

## 前瞻 PoC（Injective 原生订单簿 / Exchange 模块，Req 28.4）
路线 (b)「Vault-as-MM + 原生 CLOB」：把金库改造为自动做市商，按引擎报价向 Injective Exchange 模块挂单/撤单。
- **映射**：固定赔率 outcome → Injective 衍生品/二元市场的双边挂单（YES/NO 价 = 1/赔率 隐含概率）。
- **适配层**（待 PoC）：`onchain/injective-clob.adapter.ts`（接口先行）—— `placeOrders(vaultId, quotes[])` / `cancelOrders` / `syncFills`，复用既有 `SettlementGatewayService` 迁移缝。
- **最小 PoC**：testnet 上用 relayer 账户对单一市场挂一组 maker 单（maker 零 gas），验证下单/撤单/成交回流；不接入高频路径。
- **取舍**：完整高频上链做市超本期范围；默认建议保持链下引擎 + 链上托管（路线 a），(b) 作为去中心化/可组合性演进的 PoC + 路线图。

## 风险
- 仅测试网；AI 做市策略风险 + 「非投资建议」在 UI 披露。
- 应用模式（apply）上线前需：风控 `LsmRiskService` 三层敞口上限联动 + 人工灰度 + 监控告警。
