# Design Document

## Overview

把 LSM 升级为 Hyperliquid 式的链上抵押稳定币（USDC）平台，并新增独立 Web 端。设计原则：

1. **钱上链、引擎留链下、留好迁移缝**：抵押托管、金库份额/NAV、偿付不变量、提现保证放到链上 `CollateralVault` 合约；高频的赔率/下注/平仓/杠杆/风控继续跑现有后端引擎（`LsmOrderService` 等）；中间用确定性 `SettlementGateway` 边界隔离，为 Phase F 上链留缝。
2. **零引擎重写**：引擎只认 `LSM_ASSET_ADAPTER`；切换标的=换 adapter + 接链上合约，`lsm.vault-math.ts` 的数学既复用于链下、又作为链上合约规格。
3. **灰度可回退**：`LSM_STABLECOIN_ENABLED`/`LSM_ASSET_UNIT` 控制，AXP 与稳定币两套账本并存。
4. **EVM 同源多链**：一份 Solidity 部署到 Injective EVM testnet(1439) 与 BSC testnet(97)，按 `chainId` 配置。
5. **整数口径 + 幂等**：链上链下统一整数最小单位 + `idemKey`/`nonce`。

已确认的两项关键取舍：(1) **逐笔下注不上链**（链下记 reserved 保滚球体验，合约抵押仅在充值/提现/LP 存赎/结算/周期锚定时变更）；(2) 提现默认 **relayer 代发**（用户点一下），同时合约保留用户自助 + 逃生通道。

## Architecture

```
Web(NEW polymarket.agentrix.top) / Mobile(LSM screen)
        │ REST /lsm/* + /lsm/wallet/* + EVM 钱包
        ▼
Backend(NestJS) 链下快引擎（不变）
  LsmOrderService/VaultService/pricing/risk/vault-math/compliance/systemMode
        │ LSM_ASSET_ADAPTER（注入令牌）
        ▼
  StablecoinAssetAdapter(NEW) ── 镜像账本(StableLedgerService)
        │
  SettlementGateway(NEW 迁移缝): relayer signer / 事件索引 / 对账
        │ 提交结算·签名提现        │ 监听事件·多链验真
        ▼                          ▼
On-chain（per chain: Injective EVM 1439 / BSC 97, Hardhat 部署）
  MockUSDC(测试) + CollateralVault
   托管 USDC · 金库份额/NAV · reserved 偿付不变量 · 签名提现+逃生 · 事件
```

**职责切分**：链下引擎做「快」（报价/下注/平仓/逐金库腿分配/风控）；链上合约做「钱安全」（持币/金库份额/偿付不变量/提现保证）。两者经 `SettlementGateway` 同步，逐笔下注不上链。该切分沿用 Commission 模块「后端单一真相、合约执行镜像」的既有范式。

### 分期与组件归属
- Phase A：MockUSDC、CollateralVault 合约（含金库 NAV/份额、偿付不变量、结算入口、提现）。
- Phase B：多链 chain-registry、OnchainVerifier 多链化、稳定币账本、StablecoinAssetAdapter、SettlementGateway、充提服务、对账。
- Phase C：Web 应用（host 路由、页面、钱包充提）、子域名 + nginx + TLS + 部署。
- Phase D：chain-registry 接 BSC 97 + 同源合约部署。
- Phase E：门限/多签提现、逃生通道、审计、监控、治理、主网。
- Phase F：迁移评估文档（路线 a 自写结算合约 / 路线 b Vault-as-MM + Injective 原生 CLOB）+ 可选原型。

## Components and Interfaces

### A1. MockUSDC（仅测试网）
`contract/contracts/test/MockUSDC.sol`：OZ `ERC20`，`decimals=6`，`mint(to,amount) onlyOwner`，testnet-only 注释。经现有 `contract/` Hardhat 部署。仅当无规范测试 USDC 时使用。

### A2. CollateralVault 合约
关键函数：
- `deposit(uint256 amount)`：`transferFrom` 入合约，`collateral[user]+=scale(amount)`，emit `Deposited(user,amount,nonce)`。
- `depositLiquidity(bytes32 vaultId,uint256 amount)` / `redeemLiquidity(bytes32 vaultId,uint256 shares)`：按 NAV 铸/销，复刻 `computeDeposit`/`computeRedeem`（floor、余数归金库、`payout≤E`）。
- `applySettlement(SettlementBatch b) onlyRelayer`：按 `idemKey` 幂等，原子处理开仓预留/结算派彩/退款/平仓，每步强校验 `payout ≤ bankroll-reserved`，违反 revert。供结算/周期锚定调用（非逐笔）。
- `requestWithdraw(amount,to,nonce,sig)`：校验 relayer 对 `(user,amount,to,nonce,chainId,this)` 的签名 + `amount≤collateral` + 偿付；扣减并 `transfer`，标记 nonce。relayer 代发或用户自发皆可。
- `escapeWithdraw(...)`：逃生通道（Phase E）——relayer 失联时凭最近链上 `collateral` 快照 + 时间锁取回。
- 管理：`setRelayer`/`pause`/`unpause`/`onlyOwner`；全程 ReentrancyGuard；事件齐全。

设计取舍：合约不做赔率/杠杆/撮合，只按 relayer 提交的（已由引擎算好的）金额做托管记账 + 偿付校验。

### B1. chain-registry（多链配置）
`backend/src/modules/leverage-sports-market/onchain/chain-registry.ts`：`ChainCfg{chainId,name,rpcUrl,explorerApi?,usdc{address,decimals},vault{address}}`，从 env `LSM_CHAINS` 解析，覆盖 1439（先）/97（Phase D）。

### B2. OnchainVerifier 多链化
把现有 `OnchainVerifierService`（payment 模块，ethers v6 单链）改为 provider-per-chain map，`verifyTokenTransfer({chainId,...})`；保留 BSC 97 行为；新增 CollateralVault 事件监听/确认。

### B3. StablecoinAssetAdapter + SettlementGateway
- `StablecoinAssetAdapter` 实现 `AssetAdapter`（移除占位），escrow/release/credit/debit → `StableLedgerService`，结算经 `SettlementGateway` 同步链上；`assetAdapterFactory` 逻辑不变。
- `SettlementGateway`：把引擎资金动作表达为确定性 `SettlementOp`（amount/odds/leverage/reserved/idemKey）；当前实现=批量经 relayer 调 `applySettlement` + 可选 merkle 锚定；未来可替换为链上撮合实现而不动 Web/钱包/对账（迁移缝）。

### B4. 充提服务 + 控制器
- 充值：监听 `Deposited` 或 `POST /lsm/wallet/deposit{chainId,txHash}` → verifier 确认 → `StableLedgerService.credit`（精度换算）→ `txHash` 幂等。
- 提现：`POST /lsm/wallet/withdraw` → 校验 available+合规+熔断 → 冻结 → relayer 签名 → 代发/回前端 → 确认落 `txHash`；失败解冻补偿。
- `GET /lsm/wallet/balance`。

### C. Web 端（polymarket.agentrix.top）
- 路由：`frontend/middleware.ts` 增 host 判断，`polymarket.agentrix.top` → rewrite `/predict/*`（对用户透明，更新 matcher）。
- 页面 `frontend/pages/predict/`：`index`(盘口)、`market/[id]`(详情+赔率折线+下单)、`positions`、`vaults`、`wallet`(充提)、`leaderboard`、`disclosure`；轻量独立 layout，复用 `apiFetch`+组件。
- 数据：复用 `/lsm/markets/*`、`/lsm/orders*`、`/lsm/me/orders`、`/lsm/vaults/*`、`/lsm/leaderboard` + 新增 `/lsm/wallet/*`；复用现有登录；只读匿名可看。
- 钱包：EVM 钱包连接 1439；充值 `approve`+`deposit`；提现取 relayer 签名提交或后端代发。
- 部署：nginx `server_name polymarket.agentrix.top`（/ 反代 3001 带 Host 头触发 rewrite，/api 反代后端）+ Let's Encrypt + DNS A 记录；复用 `deploy_sg_frontend.sh` 模式，不影响主站。

### D/E/F 组件
- D：chain-registry 加 97 + 同源 CollateralVault 部署；多链 UI 选链。
- E：提现签名升 m-of-n；逃生通道；审计；监控告警 + 应急 pause；多签治理；主网（用户确认）。
- F：`docs/lsm-onchain-migration-eval.md`（路线 a 自写结算合约 / 路线 b Vault-as-MM + Injective 原生 CLOB，含赛果杠杆→衍生品保证金映射评估）+ 可选测试网原型，复用 SettlementGateway 缝。

## Data Models

### 链下实体（NEW，独立于 AXP，不动 user_axp_*）
- `UserStableBalance`：`{userId, chainId, available(bigint, 最小整数单位), reserved(bigint), updatedAt}`，snapshot 一行/用户/链。
- `UserStableLedger`：`{id, userId, chainId, direction(credit|debit|escrow|release), amount, source, refId, txHash?, createdAt}`，write-once 流水。
- 幂等：`(userId, source, refId)`；与 `AxpService` 同构（事务内 snapshot + ledger 原子）。

### 链上存储（CollateralVault）
- `mapping(address=>uint256) collateral / reserved`（用户可用 / 预留，USDC base unit）。
- `struct Vault{bankroll,reserved,totalShares,highWaterNav,profitShareBps}`；`mapping(bytes32=>Vault) vaults`；`mapping(bytes32=>mapping(address=>uint256)) lpShares`。
- `mapping(bytes32=>bool) usedIdem`；`uint256 withdrawNonce`。

### 精度与单位（Requirement 18）
- 每资产 `decimals`（Injective USDC=6）+ 内部最小整数单位 `LSM_ASSET_MINOR_UNIT`（建议 0.01 USDC = `1e4` base unit）。
- 链上→内部：`internal = floor(baseAmount / (10^decimals * minorUnit))`，dust 留尾在合约（计入 vault 留存，不入用户可用）。
- 内部→链上：`baseAmount = internal * 10^decimals * minorUnit`。换算常量合约/后端共用，单测对齐。引擎只见整数内部单位。

### 配置 / Env
| Key | 说明 |
|---|---|
| `LSM_STABLECOIN_ENABLED` | `1` 启用稳定币标的 |
| `LSM_ASSET_UNIT` | `USDC`（否则 `AXP`） |
| `LSM_ASSET_MINOR_UNIT` | 内部最小单位（如 `0.01`） |
| `LSM_CHAINS` | JSON：各链 `{chainId,rpc,explorer,usdc,decimals,vault}` |
| `LSM_DEFAULT_CHAIN_ID` | 默认结算链（如 `1439`） |
| `INJECTIVE_EVM_TESTNET_RPC_URL` | RPC（1439） |
| `LSM_VAULT_CONTRACT_<chainId>` / `LSM_USDC_<chainId>` | 各链合约/USDC 地址 |
| `RELAYER_PRIVATE_KEY` | 复用现有；结算/签名提现 |
| `X402_MIN_CONFIRMATIONS` / `X402_ONCHAIN_VERIFY_REQUIRED` | 复用 |

> pm2 env-cache：改 `.env` 值用 `pm2 delete + start + save`。

## Correctness Properties

合约层不变量（链上强校验 + property/invariant 测试）：

### Property 1: 偿付（Solvency）
对任意 vault，`bankroll ≥ reserved`；任何派彩/赎回/提现后仍成立（链上强校验，违反 revert）。
**Validates: Requirements 2.3**

### Property 2: 守恒（Conservation）
`Σcollateral + Σreserved + Σvault.bankroll == usdc.balanceOf(this)`（按精度，dust 留尾合约）。
**Validates: Requirements 2.7, 18.2**

### Property 3: 幂等（Idempotency）
相同 `idemKey`/`withdrawNonce` 不重复生效。
**Validates: Requirements 2.4, 7.2**

### Property 4: NAV 双实现一致
链上 `depositLiquidity`/`redeemLiquidity` 的份额/NAV 结果与 `lsm.vault-math.ts`（`computeDeposit`/`computeRedeem`/`computeProfitFee`）逐项数值一致（同一规格双实现交叉验证）。
**Validates: Requirements 2.2**

### Property 5: 换算 round-trip 安全
内部↔链上换算不放大（`toInternal(toBase(x))==x`），dust 不进用户可用余额。
**Validates: Requirements 18.2**

### Property 6: 灰度无回归
`LSM_STABLECOIN_ENABLED=0` 时引擎行为与现 AXP 路径完全一致。
**Validates: Requirements 19.1**

## Error Handling

- **充值**：验真失败/确认不足 → 不入账，返回结构化原因；重复 `txHash` → 幂等忽略。
- **提现**：内部冻结后若链上放款失败/超时 → 解冻补偿，保持账实一致；签名重放（已用 nonce）→ 合约 revert。
- **结算批量**：`applySettlement` 任一步违反偿付不变量 → 整批 revert，relayer 重试或人工介入；相同 `idemKey` → 跳过（幂等）。
- **多链验真**：链未配置/ RPC 不可用 → 按 `X402_ONCHAIN_VERIFY_REQUIRED` 拒绝或（仅非必需时）降级；不静默放行。
- **对账缺口**：链上余额 < 内部负债 → 告警（日志/指标）+ 可触发 `pause`，只读不阻塞主流程。
- **合规/熔断**：充提/下注/存赎被 `LsmComplianceService`/`LsmSystemModeService` 拒绝 → 结构化错误，前端可读提示。

## Testing Strategy

- **合约（Hardhat）**：deposit/withdraw/LP 存赎/applySettlement/pause/重入 单测；invariant 测试 I1/I2/I3；与 `lsm.vault-math.ts` 数值交叉验证（P-NAV）。
- **后端**：StableLedgerService 幂等/原子；OnchainVerifier 多链路由（mock provider）；充提补偿/回滚；对账缺口告警；adapter 在 AXP/USDC 两标的下引擎行为不变（P-灰度回归）。
- **集成（测试网 1439）**：mint MockUSDC → deposit → 下注/结算 → 提现，校验链上余额 + 内部账 + 对账 balanced。
- **Web**：host rewrite、关键页渲染、下单滑点重试、充提钱包流程（可 mock 钱包）。
- **安全**：偿付不变量链上强校验、ReentrancyGuard、pause、提现签名带 chainId+合约地址+nonce 防跨链/重放、逃生通道；relayer 签名在后端、不在前端暴露私钥。


---

## Phase G — 对话式预测 Copilot + 集市真实源一体化 + AI 做市金库（Injective Nova）

> 目标：把 Agentrix 已有 AI/agent 能力嫁接到 LSM，形成「对话式 → Injective 链上金融全流程」。**最大化复用既有真实代码**，新增主要是"接线 + 少量工具/连接器/agent"。组合主线 = Req25(头牌) + Req27 + Req28；Req24 为前置基础。

### G.架构总览

```
Web(/lsm 悬浮球 + 主站工作台) / Mobile / Desktop
        │  统一流式 SSE
        ▼
/openclaw/proxy/stream（canonical） ←委托← /claude/chat（兼容垫片）
        │  resolveDefaultInstanceForUser →（无实例则）自动开通 platform-hosted primary
        ▼
OpenClawProxyService.runPlatformHostedChat
   ├─ 工具循环：ToolRegistryService（getSchemasForProvider）
   │     ├─ 既有：opportunity_search(/ard/search) / skill_* / wallet_* / commerce_*
   │     └─ 新增：lsm_search_markets / lsm_preview_order / lsm_place_order / lsm_cashout / lsm_my_positions
   ├─ 记忆：getOrCreatePlatformHostedSession + savePlatformHostedMessage（按 instanceId 跨端共享）
   └─ 下单工具 checkPermissions → SettlementCoreService.authorizeAutonomousPayment（AP2 mandate + spendingLimits 双围栏）
        │
        ▼
LSM 引擎(/lsm/*) + StablecoinAssetAdapter(USDC) + SettlementGateway → CollateralVault(Injective EVM 1439)
聚合检索：ConnectorRegistry(+lsm-prediction) → unified-marketplace.search → /ard/search
接单/支付：AggregationParticipationService + participation-path.resolver + settlement-core(x402 verifyAndSettle)
做市：lsm-mm-agent（链下策略）→ lsm-underwriting/lsm-risk → (Phase F PoC) Injective Exchange CLOB
```

### G1. Web 对话框统一 + 自动开通托管 agent（Req 24）

**G1.1 统一链路迁移**
- `frontend/lib/api/agent.api.ts`：新增 `streamUnifiedChat()` 走 `POST /openclaw/proxy/stream`（SSE，复用移动/桌面的请求体：`{messages|message, sessionId, context, mode, platform:'web', tier, options}`）。
- `frontend/components/agent/UnifiedAgentChat.tsx`：`handleSend` 在开关 `NEXT_PUBLIC_UNIFIED_CHAT=1` 时改走统一链路，消费 `consumeAgentrixSse`（与桌面同款事件协议）；保留旧 `/agent/chat` 为回退分支（开关关闭即回退，零回归）。
- 会话：`sessionId` 以服务端为准（首条响应 meta 回传），localStorage 仅作离线缓存镜像，不再是唯一来源。
- 模型选择：复用 `GET /openclaw/models` + `PATCH /openclaw/instances/:id/model`；web 顶部加模型选择器（compact 模式下放抽屉），读写服务端 activeModel → 与移动/桌面同步。
- 工具结果渲染：复用既有 `StructuredResponseCard` + `QuickActionCards`（已支持 `message.metadata.data`），新增 LSM 卡片类型（盘口/预览/持仓）。
- parity：`lsm_*` 工具经 `ToolRegistryService` 自动适配两 provider；跑 `chat-path-parity.contract.ts`/`runtime-doctor.service.ts` 守护。

**G1.2 平台托管 agent 自动开通（消除先后协同）**
- 后端 `OpenClawProxyService.resolveDefaultInstanceForUser`：把"无实例抛 404"改为"无实例则调 `ensurePlatformHostedPrimary(userId)`"。
- 新增 `OpenClawConnectionService.ensurePlatformHostedPrimary(userId)`（复用既有 platform-hosted 创建逻辑：`instanceRepo.create({ userId, isPrimary:true, status:ACTIVE, instanceUrl:null, capabilities:{ platformHosted:true, activeModel: resolvePlatformHostedDefaultModel(provider), modelPinned:false }})`）。
- **幂等+并发安全**：用 `userId` 维度的唯一约束/`INSERT ... ON CONFLICT DO NOTHING` 或建实例时加 advisory lock，保证同用户并发首聊只落一个 primary；返回已存在的 primary。
- 时序：

```
用户(web 钱包登录) → 首次发对话
  → POST /openclaw/proxy/stream
    → resolveDefaultInstanceForUser(userId)
        → 查 ACTIVE/PROVISIONING 实例
        → 空 → ensurePlatformHostedPrimary(userId)  [幂等/带锁]
              → 受 SystemMode/Compliance 门禁
              → instanceRepo.save(platform-hosted primary)
        → 返回 primary 实例
    → runPlatformHostedChat(...)  正常对话+记忆
```
- 失败处理：门禁拒绝/创建异常 → 结构化错误（非 404），不留半开通脏实例（事务内 create+校验）。
- "宠物 agent 身份"：platform-hosted primary = 该用户规范 agent；记忆按 `metadata.instanceId` 服务端存（`getPlatformConversationHistory` 已支持跨 session/跨端）。移动/桌面登录后默认复用同一 primary（共享记忆）；显式云/本地部署=新增能力更强实例（不破坏既有部署路径）。

**G1.3 /lsm 悬浮球尺寸**
- `PetChatBubble.tsx`：桌面面板宽高可调（拖拽手柄或预设 sm/md/lg），移动保持全宽；不再写死唯一小窗。

### G2. LSM chat 工具集（Req 25）

- 目录 `backend/src/modules/tool-registry/tools/lsm/`，用 `buildTool()` + zod：
  - `lsm_search_markets`（`isReadOnly`, 调 `LsmMarketService.listLive/getMarket`）：入 `{league?, status?, limit?}`，出盘口+赔率+隐含概率。
  - `lsm_preview_order`（`isReadOnly`, `LsmOrderService.preview`）：入 `{marketId,outcomeIdx,stake,leverage,asset?}`，出敞口/最大盈亏/滑点。
  - `lsm_place_order`（`requiresPayment:true`, `riskLevel:2`, `LsmOrderService.place`）：入 `{marketId,outcomeIdx,stake,leverage,quotedOdds,asset,idemKey?}`。
  - `lsm_cashout`（`LsmOrderService.cashOut`）、`lsm_my_positions`（`myOrders`）。
- 注册：仿 `query-engine/opportunity-cards-event.ts` 的"单一权威源"——一个 `lsm-tools.registration.ts` 同时供 `openclaw-proxy.service`（canonical 工具循环）与 `claude-integration`（委托）使用，避免 parity 漂移。
- 工具结果 `metadata.data` 带卡片类型（`lsm_market`/`lsm_preview`/`lsm_position`），前端 G1.1 渲染。

### G3. 围栏内自主下单 + USDC on Injective 结算（Req 26）

- `lsm_place_order.checkPermissions(input, ctx)` → 调 `SettlementCoreService.authorizeAutonomousPayment({ agentAccountId, amount, mandateId?, merchantId, category:'prediction' })`：过 `AgentAccount.spendingLimits`(单笔/日额 vs usedToday) + `UCPService.verifyMandate`(maxAmount/allowedCategories) 双围栏；不过 → 返回 `{behavior:'ask'|'deny', reason}`（chat 弹授权卡或拒绝）。
- 对话内授权：新增 chat 动作/卡片调用 `POST /ucp/v1/mandates`（如"授权每日 100 USDC 自动下注"），`DELETE` 撤销。
- USDC 结算：`asset='USDC'` 时校验 `/lsm/wallet/balance.usdc`，下注/结算经 `StablecoinAssetAdapter`+`SettlementGateway`+relayer 落 Injective EVM 1439；落统一 `Payment`/`agent_cost_records` 账本。
- 闭环 demo：一句话→`lsm_search_markets`→解释→（首次）授权 mandate→`lsm_place_order`(USDC)→持仓卡→`lsm_cashout`。

### G4. 集市真实源一体化（Req 27）

- 新增连接器 `backend/src/modules/marketplace-aggregation/connectors/lsm-prediction.connector.ts`（实现 `ExternalConnector`，`source='lsm'`，`category='prediction'`，`capabilities.canAccept=true`，`fetchListings` 调 `LsmMarketService.listLive` → `normalize` 成 `NormalizedListing`），在 `aggregation-bootstrap.service` 注册进 `ConnectorRegistry` → 自动进 `unified-marketplace.search()` → `/ard/search`。
- participate：LSM 条目经 `resolveParticipationPath` → `internal-accept` → 复用 `AggregationParticipationService` 触达 `lsm_place_order`；外部预测源(polymarket/manifold) 仍 `external` 跳转。
- 任务/空投/技能接单：复用既有 participate + `SettlementCoreService.verifyAndSettle`（x402）；同一会话内可连续"接 RemoteOK 任务(x402 付费) + 押 LSM 盘口(USDC)"，均落统一账本，对账脚本覆盖两类资金流。

### G5. AI 做市金库 agent（Req 28，独创性）

- `backend/src/modules/leverage-sports-market/mm-agent/lsm-mm-agent.service.ts`（链下，先落地）：定时（cron/间隔）对每个启用的 USDC 金库读 `LsmVaultService` NAV/利用率 + 当前敞口 + 盘口赔率，产出做市决策：
  - 调赔率偏移（overround/margin）、设/调 `lsm-underwriting` 承接容量与费率竞价、触发对冲/再平衡建议。
  - 决策器：规则护栏为主 + 可选平台 LLM（Bedrock 默认/BYO）做行情解读；所有调整经 `LsmRiskService` 熔断 + 偿付不变量校验（`bankroll-reserved`），违反则拒绝。
- 可观测：Web `/lsm/vaults` 加"AI 做市"视图，展示 agent 动作日志（调赔率/敞口/对冲）与金库 NAV 曲线，供 demo。
- Injective 订单簿 PoC（Phase F 起点）：`docs/lsm-vault-as-mm-injective.md` 设计 vault-as-MM 在 Injective Exchange 模块挂单/撤单的适配层 + 最小 testnet 挂单 PoC；完整高频上链做市不在本期承诺，复用 `SettlementGateway` 迁移缝。

### G. 数据模型 / 配置（Phase G 增量）

- 复用：`OpenClawInstance`(capabilities.platformHosted/activeModel/isPrimary)、`AgentSession`(metadata.instanceId 记忆)、`AP2MandateEntity`、`AgentAccount.spendingLimits`、`Payment`、`agent_cost_records`、`AggregatedResource`。
- 新增 env：

| Key | 说明 |
|---|---|
| `NEXT_PUBLIC_UNIFIED_CHAT` | `1` web 对话框走统一 proxy 链路（默认 0 回退老 `/agent/chat`） |
| `LSM_CHAT_TOOLS_ENABLED` | `1` 注册 `lsm_*` chat 工具 |
| `LSM_MM_AGENT_ENABLED` | `1` 启用 AI 做市 agent（仅测试网） |
| `LSM_MM_AGENT_INTERVAL_MS` | 做市决策周期 |

### G. Correctness Properties（Phase G 增量）

- **Property G1（自动开通幂等/唯一）**：同 userId 任意并发/重复首聊，最终只存在一个 platform-hosted primary 实例。**Validates: Req 24.8/24.9**
- **Property G2（围栏不可旁路）**：`lsm_place_order` 在 mandate/spendingLimits 任一不过时一定不下单、不入账、用量不变。**Validates: Req 26.1/26.5**
- **Property G3（chat 路径 parity）**：`lsm_*` 工具集在 `/openclaw/proxy/stream` 与 `/claude/chat` 两路行为/schema 一致（contract 测试）。**Validates: Req 24.5, 25.2**
- **Property G4（能力位门控）**：`resolveParticipationPath` 决定 LSM=internal-accept、外部源=external，不旁路。**Validates: Req 27.5**
- **Property G5（做市不破偿付）**：AI 做市任何调整后金库仍满足 `bankroll≥reserved`，违反被风控拦截。**Validates: Req 28.2**

### G. Testing Strategy（Phase G 增量）

- 后端单测：`ensurePlatformHostedPrimary` 幂等/并发（G1）；`lsm_*` 工具 zod+execute（mock 引擎服务）；`authorizeAutonomousPayment` 双围栏拦截（G2）；`lsm-prediction` 连接器 normalize；chat-path parity 合约（G3）；mm-agent 决策不破不变量（G5，property/invariant）。
- 集成（testnet 1439）：对话式 USDC 下单全闭环（搜索→授权→下单→持仓→平仓）；一个会话内 x402 接单 + USDC 押注双资金流对账。
- 前端：统一链路 SSE 渲染 + 模型选择器同步 + 悬浮球 resize；回退开关关闭时老链路零回归。
- E2E：扩展 `scripts/test/lsm-dual-e2e.mjs` 加"对话式下单"路径（调 chat 工具）。
