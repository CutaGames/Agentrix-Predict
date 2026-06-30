# Requirements Document

## Introduction

杠杆滚球预测市场（LSM，leverage-sports-market，世界杯滚球预测）现状：结算/下注币种是 **AXP**（链下软积分，不可提现），经资产适配器 `LSM_ASSET_ADAPTER` 接入引擎（`AxpAssetAdapter` 现役，`StablecoinAssetAdapter` 占位）；金库（LsmVault）是链下整数账本（LP 存赎、NAV/份额、`reserved` 偿付不变量、杠杆、高水位利润分成，数学在 `lsm.vault-math.ts`）；前端只有移动端。

本项目把 LSM 升级为 **Hyperliquid 式的链上抵押、信任最小化、链上金库**的真稳定币（USDC）滚球预测平台，并新增独立 Web 端，从 **Injective EVM testnet（chainId 1439）** 单链起步，按上线节奏分期到多链与主网就绪。

**参考模型 Hyperliquid**：资金托管在合约（bridge/vault escrow，非平台 EOA）；提现由合约 + relayer/门限签名信任最小化保证；金库/LP 链上记账（HLP 范式）；高频撮合走快引擎；USDC 唯一抵押/计价。**我们的差异**：无自有 L1，撮合/赔率/杠杆运行在中心化后端引擎（已存在），但把**抵押托管、金库份额、提现保证**放到链上合约——「资金安全链上保证 + 体验接近 CEX」。

**为什么高频引擎先留链下**：Hyperliquid 撮合全上链靠自有专用 L1（~200ms、下单 gasless）。我们没有；Injective EVM 虽亚秒终局、费用极低、maker 零 gas、自带原生订单簿，但 LSM 是「用户加杠杆 vs 金库坐庄」的非 CLOB 模型，套用需重设计（见 Requirement 17）。故先上链「钱」（托管/金库/结算/提现），引擎留链下但设计成可迁移（Requirement 21）。

**分期总览**：
- Phase A 链上合约层（Req 1–3）
- Phase B 后端 oracle/relayer（Req 4–8）
- Phase C 独立 Web 端 `polymarket.agentrix.top`（Req 9–11）
- Phase D 多链扩展（Req 12–13）
- Phase E 主网就绪与去信任强化（Req 14–15）
- Phase F 链上撮合/结算迁移探索，前瞻（Req 16–17）
- 跨阶段通用（Req 18–23）
- **Phase G 对话式预测 Copilot + 集市真实源一体化 + AI 做市金库（Injective Nova 黑客松，Req 24–28）**

**硬约束**：仅 Agentrix 工作区改动，不触 KMarket；测试网优先，主网仅 Phase E 经审计 + 用户确认；保持引擎语义不变（整数口径、`idemKey` 幂等、偿付不变量、合规门禁）；资产切换经 `assetAdapterFactory`（`LSM_STABLECOIN_ENABLED`+`LSM_ASSET_UNIT`）灰度可回退；合约托管真实测试资金按高风险对待；EVM 同源多链（Solidity+Hardhat+ethers v6，Injective EVM 与 BSC testnet 同源）。

## Glossary

- **CLOB（中央限价订单簿）**：买卖双方各自挂带价订单、引擎撮合的交易机制（Binance/Hyperliquid/Injective 原生模块）。两边为对等交易者。
- **LSM 模型（固定赔率 vs 金库）**：用户按平台报出的固定赔率加杠杆下注，金库作为「房子」被动预留赔付；非 CLOB（无对向挂单撮合）。
- **金库 / Vault**：承接对手盘的资金池；LP 注资、按 NAV 铸份额、分庄家盈亏（对标 Hyperliquid HLP）。
- **NAV**：金库净值 = (bankroll − reserved) / totalShares。
- **CollateralVault 合约**：本项目链上合约，托管 USDC + 金库份额记账 + 偿付不变量 + 提现保证。
- **relayer**：后端授权地址，提交结算指令、签发提现授权（Phase E 升级多签）。
- **SettlementGateway**：引擎与链上结算之间的确定性边界（迁移缝）。
- **最小整数单位**：引擎内部记账单位（`LSM_ASSET_MINOR_UNIT`，如 0.01 USDC），与链上 6 位小数换算。

## Requirements

### Requirement 1: 结算资产 USDC（Phase A）
**User Story:** 作为开发者，我需要 Injective EVM testnet 上有可任意 mint 的 USDC 作为唯一抵押/计价资产，以便官方为金库注入初始 bankroll 并给测试用户发钱。
#### Acceptance Criteria
1. THE testnet SHALL 使用**自部署的 `MockUSDC`（6 位小数、`mint onlyOwner`、testnet-only 注释）作为主资产**——因为 Circle 测试网水龙头仅 20 USDC/地址/2h，无法满足官方注入金库 bankroll 与批量测试账户的需求；测试网代币无真实价值，自发与官方 USDC 经济上无差异。
2. THE `CollateralVault` SHALL **对 USDC 地址 token 无关**（构造参数/配置注入），使主网（Phase E）只需把地址指向 Circle 原生 USDC（Injective 已上线 native USDC + CCTP）即可切换，零业务代码改动。
3. THE deployment SHALL 把 USDC 地址、链 ID、decimals 写入链/资产配置（不硬编码进业务代码）。
4. THE system MAY（可选）领取少量 Circle 测试网 USDC，单独验证「对真实 USDC 合约的充值/验真」路径，提升上主网前拟真度。
5. THE 官方注入 SHALL 通过国库账户持有 USDC 后调用 `depositLiquidity` 为公共金库注入初始 bankroll（测试网随意 mint；主网为真实资金，属 Phase E）。

### Requirement 2: CollateralVault 合约（托管 + 金库 + 桥）（Phase A）
**User Story:** 作为平台，我需要一个持有 USDC 的合约，既做用户抵押托管，又做 LP 金库的链上记账与赔付来源，并支持信任最小化提现。
#### Acceptance Criteria
1. THE contract SHALL 托管 USDC：用户/LP 充值进合约（`deposit`），发出可监听事件（含 `user`、`amount`、`nonce`）。
2. THE contract SHALL 以链上份额/NAV 记账金库 LP：`depositLiquidity`/`redeemLiquidity` 按 NAV 铸/销份额，复刻 `lsm.vault-math.ts`（`E=bankroll−reserved`、`NAV=E/totalShares`、整数 floor、余数归金库、高水位利润分成）。
3. THE contract SHALL 维护偿付不变量：任何赔付/提现 `≤ bankroll − reserved`，reserved 随开仓增、随结算释放，链上强校验（违反 revert）。
4. THE contract SHALL 支持结算驱动的抵押变更：授权 relayer 提交「开仓预留/结算派彩/退款/平仓」批量指令，按 `idemKey` 幂等，据此调整用户抵押与金库 bankroll/reserved。
5. THE contract SHALL 支持信任最小化提现：用户提现需 relayer 签名授权（Phase E 升级门限/多签），合约校验签名 + 偿付不变量后放款；并提供逃生通道。
6. THE contract SHALL 具备 `pause`、`onlyOwner`、ReentrancyGuard、齐全事件。
7. THE contract SHALL 用 USDC 6 位小数原生口径持有资金，内部记账与后端整数单位换算口径一致（见 Requirement 18）。

### Requirement 3: 合约可升级与治理（Phase A）
**User Story:** 作为维护者，我希望测试期能迭代合约、轮换角色。
#### Acceptance Criteria
1. THE contract SHALL 采用可控的升级/迁移策略（代理或迁移脚本）。
2. THE owner/relayer 角色 SHALL 可配置可轮换；测试网用 EOA，主网阶段迁移到多签/门限。

### Requirement 4: 多链链上验真（Phase B）
**User Story:** 作为平台，我希望链上验真按链路由，支持 Injective EVM testnet。
#### Acceptance Criteria
1. WHEN 校验某 `txHash` THE system SHALL 按传入 `chainId` 选 provider（至少 97 与 1439），不写死单一 RPC。
2. THE system SHALL 从配置读每链 `{chainId, rpcUrl, explorerApi?}`，缺失返回结构化错误。
3. WHEN 在 Injective EVM testnet 验真 THE system SHALL 复用 ethers v6 + ERC20 `Transfer` 解析，核对 token/to/value/确认数。
4. THE system SHALL 不回归 BSC testnet（97）既有验真（marketplace-aggregation 闭环不受影响）。
5. IF 某链未配 RPC 且 `X402_ONCHAIN_VERIFY_REQUIRED=true` THEN SHALL 拒绝入账。

### Requirement 5: StablecoinAssetAdapter 接线（Phase B）
**User Story:** 作为引擎，我希望切到稳定币后资金动作落到稳定币账本并同步链上抵押。
#### Acceptance Criteria
1. THE `StablecoinAssetAdapter` SHALL 实现 `AssetAdapter` 全部方法，移除 `STABLECOIN_TREASURY_UNWIRED` 占位。
2. THE adapter SHALL 沿用整数校验与 `idemKey` 语义；逐笔下注仅改链下镜像账本（reserved），结算/周期经 `SettlementGateway` 同步链上。
3. WHEN `LSM_STABLECOIN_ENABLED=1` 且 `LSM_ASSET_UNIT=USDC` THEN `assetAdapterFactory` SHALL 返回稳定币适配器；否则回退 AXP。
4. THE engine core SHALL 无需改动即可在两种标的下工作。

### Requirement 6: 充值入账（Phase B）
**User Story:** 作为玩家，我希望链上充值的 USDC 形成平台内可用余额。
#### Acceptance Criteria
1. WHEN 用户经合约 `deposit` 转入 USDC THE system SHALL 经验真/事件确认后按精度换算 `credit` 到用户稳定币余额，并以链上 `nonce`/`txHash` 幂等防重复。
2. THE deposit SHALL 受合规门禁与系统熔断约束。

### Requirement 7: 信任最小化提现（Phase B）
**User Story:** 作为玩家，我希望能把平台余额提回我的钱包，且不被随意冻结。
#### Acceptance Criteria
1. WHEN 用户发起提现 THE system SHALL 校验可用余额 + 偿付不变量，冻结内部余额，由 relayer 生成合约可验证签名。
2. THE contract SHALL 凭签名 + 链上偿付校验放款；确认后落提现单与 `txHash`。
3. IF 链上放款失败 THEN THE system SHALL 解冻内部余额（补偿），账实一致。
4. THE withdraw SHALL 受合规与熔断约束；提现目标地址来源明确防错付。

### Requirement 8: 对账纳入链上余额（Phase B）
**User Story:** 作为运营，我希望对账覆盖链上国库余额 vs 内部负债。
#### Acceptance Criteria
1. THE `LsmReconciliationService` SHALL 增核对：每链合约 USDC 余额 ≥ 内部稳定币总负债（available + reserved + 金库 bankroll）。
2. WHEN 出现负缺口 THE system SHALL 产出告警，不静默；只读核对不阻塞主流程。

### Requirement 9: LSM Web 应用（Phase C）
**User Story:** 作为用户，我希望在独立子域名网页使用滚球杠杆预测市场。
#### Acceptance Criteria
1. THE web app SHALL 作为相对独立站点挂在 `polymarket.agentrix.top`，与主站可区隔但复用同一 Next.js 工程与后端。
2. THE web app SHALL 提供：盘口列表（赛前+滚球）、详情+赔率折线、下单（preview→place 含滑点重试）、提前平仓、我的持仓、金库列表/LP 存赎、稳定币充提、排行榜、风险披露。
3. THE web app SHALL 复用现有 LSM API + 新增稳定币余额/充提 API。
4. THE 币种文案 SHALL 按所选标的显示（USDC 或 AXP，见 Requirement 22），展示「测试网」标识与风险披露。
5. WHEN 未登录访问需鉴权操作 THE web app SHALL 引导登录；只读盘口/排行榜匿名可看。
6. THE **账户系统 SHALL 与主站 agentrix.top 完全一致**：同一后端、同一 JWT（access_token）、同一 `/auth/login` 登录模块；用户在本子域名用相同账户登录。（跨子域名一键 SSO 见 Requirement 23。）
7. THE **UI/交互 SHALL 对标 kmarket.xyz**（polymarket 式预测市场体验：盘口卡片、1X2/赔率展示、下注面板、持仓与结算视图），而非简单列表占位。
8. THE web app（及后端 CORS）SHALL 允许 `polymarket.agentrix.top` 跨域访问 `api.agentrix.top`，否则盘口拉取被 CORS 拦截（已修复：后端 CORS 白名单加该子域）。

### Requirement 22: AXP 与稳定币双标的并行（同时支持）
**User Story:** 作为平台，我希望同一套滚球预测同时支持 AXP 积分（免费/引流）与链上 USDC（真实结算），用户每笔自选币种。
#### Acceptance Criteria
1. THE 资产层 SHALL 从「单一 `LSM_ASSET_ADAPTER` 二选一」升级为**按币种路由的适配器注册表**（`getAdapter(asset: 'AXP'|'USDC')`），AxpAssetAdapter 与 StablecoinAssetAdapter **同时在册**。
2. THE 下单/preview/持仓/金库 SHALL 携带 `asset` 维度；引擎按 `asset` 路由到对应账本与金库。
3. THE 金库 SHALL 按币种隔离（AXP 金库 bankroll 用 AXP；USDC 金库 bankroll 用链上 USDC）；不跨币种共享流动性。
4. THE Web/移动端 SHALL 让用户在下注时选择币种（AXP 免费玩 / USDC 真实），并分别显示余额与文案。
5. THE 引擎核心（定价/风控/vault-math/idemKey/整数口径）SHALL 双标的复用，不为某一币种分叉逻辑。
6. THE 灰度 SHALL 支持三态：仅 AXP（默认）/ 仅 USDC / 双开；由配置控制，互不影响既有 AXP 数据。

### Requirement 23: 跨子域名单点登录（SSO，可选增强）
**User Story:** 作为用户，我希望在 agentrix.top 登录后访问 polymarket.agentrix.top 免再次登录。
#### Acceptance Criteria
1. THE 会话 SHALL 经 `.agentrix.top` 域级 cookie 在主站与子域名间共享（或登录态 SSO 重定向传递 token）。
2. THE 后端鉴权 SHALL 接受该共享 cookie（`credentials: 'include'`）作为 JWT 来源之一，而不仅是 localStorage Bearer。
3. IF 未实现 SSO THEN 用户在子域名用同一账户单独登录一次即可（不阻塞功能）。

### Requirement 10: 钱包连接与链上充提（Phase C）
**User Story:** 作为用户，我希望用浏览器钱包充值/提现 USDC。
#### Acceptance Criteria
1. THE web app SHALL 支持 EVM 钱包（WalletConnect/注入）连接 Injective EVM testnet(1439)，引导添加/切换网络。
2. WHEN 充值 THE web app SHALL 调起钱包 `approve` + `CollateralVault.deposit`，成功后提交 `txHash`。
3. WHEN 提现 THE web app SHALL 取后端 relayer 签名并提交合约提现（或后端代发），展示链上确认。

### Requirement 11: 子域名路由与部署（Phase C）
**User Story:** 作为运维，我需要子域名正确解析到 LSM Web 并启用 HTTPS。
#### Acceptance Criteria
1. THE system SHALL 经 Next.js 基于 Host 的 middleware rewrite 把 `polymarket.agentrix.top` 导向 LSM 页面组，复用 `agentrix-frontend`（端口 3001）。
2. THE Nginx SHALL 为该子域加 server_name + 反代前端 + `/api` 反代后端 + Let's Encrypt TLS。
3. THE deployment SHALL 复用 `scripts/deploy/deploy_sg_frontend.sh` 模式，不影响主站 `agentrix.top`。

### Requirement 12: 链/资产注册表（Phase D）
**User Story:** 作为平台，我需要统一多链配置以扩展到多条链。
#### Acceptance Criteria
1. THE system SHALL 提供统一链/资产注册 `{chainId, name, rpc, explorer, usdcAddress, usdcDecimals, vaultContractAddress}`，覆盖 1439 与 97。
2. THE CollateralVault SHALL 同源部署到每条目标链，地址按链登记。
3. THE backend verifier/relayer/对账 SHALL 全部按 `chainId` 多链工作。

### Requirement 13: 多链 UX 与流动性边界（Phase D）
**User Story:** 作为用户，我需要清楚在哪条链结算。
#### Acceptance Criteria
1. THE web/mobile SHALL 让用户选择/显示结算链；单次结算落单链（不做跨链净额）。
2. THE system SHALL 明确每链金库流动性独立并在 UI 披露。

### Requirement 14: 提现去信任升级（Phase E）
**User Story:** 作为用户，我希望提现不依赖单一运营方。
#### Acceptance Criteria
1. THE 提现授权 SHALL 从单 relayer 签名升级为门限/多签（m-of-n）。
2. THE 逃生通道 SHALL 在签名者集体失联时允许用户凭最终状态证明取回抵押。

### Requirement 15: 审计、监控、治理、主网上线（Phase E）
**User Story:** 作为平台，我希望主网上线前满足安全与治理门槛。
#### Acceptance Criteria
1. THE CollateralVault SHALL 通过安全审计（外审或严格内审 + 关键不变量形式化）后方可上主网。
2. THE system SHALL 具备链上余额/偿付/relayer 健康监控告警与应急暂停预案。
3. THE owner/relayer/签名者 SHALL 迁移到多签治理；主网上线需用户显式确认。

### Requirement 16: 链上迁移可行性评估与原型（Phase F）
**User Story:** 作为架构师，我想评估把结算/撮合迁移上链的可行性。
#### Acceptance Criteria
1. THE system SHALL 评估两条路径：(a) Injective EVM 自定义结算合约；(b) 调用 Injective 原生 exchange/WASM 模块。
2. THE evaluation SHALL 量化延迟（~0.8s 终局对滚球影响）、成本（逐笔 vs 批量）、与金库/偿付不变量契合度。
3. THE prototype（如进行）SHALL 仅测试网，先迁「结算/派彩」低频高价值动作，保留链下报价/下注。
4. THE migration SHALL 复用 Requirement 21 接缝，不重写 Web/钱包/对账。

### Requirement 17: Vault-as-MM / CLOB 重构路线（Phase F）
**User Story:** 作为架构师，我想评估把 LSM 重构为「Injective 原生订单簿 + 金库做市商」（HLP 范式）。
#### Acceptance Criteria
1. THE evaluation SHALL 说明：LSM 现为非 CLOB 模型；用 Injective 原生订单簿须把金库改造为自动做市商（按引擎报价向 CLOB 挂单，对标 HLP）。
2. THE evaluation SHALL 评估把「赛果杠杆」映射到 Injective 衍生品/perp 保证金模型的可行性与差异。
3. THE evaluation SHALL 对比路线 (a) 自写结算合约保持现模型 vs (b) CLOB + 金库做市商复用原生 exchange 模块的取舍。
4. THE evaluation SHALL 默认建议路线 (a)（增量、低风险）；(b) 仅强去中心化/可组合诉求时投入 + 测试网原型先行。
5. THE evaluation SHALL 不要求在本项目内实现路线 (b)；产出决策文档 + 可选原型，复用 Requirement 21 接缝，不阻塞 A–E。

### Requirement 18: 精度与单位换算（通用）
**User Story:** 作为平台，我需要在 6 位 USDC 与整数引擎单位间安全换算。
#### Acceptance Criteria
1. THE system SHALL 为每资产配置 `decimals`（Injective USDC=6）与内部最小整数单位 `LSM_ASSET_MINOR_UNIT`。
2. WHEN 链上↔链下换算 THE system SHALL 整数换算，dust 余数明确处理（留尾在合约），不静默四舍五入致账差；链上合约与后端换算口径一致。
3. THE engine SHALL 始终只见整数内部单位。

### Requirement 19: 灰度与回退（通用）
**User Story:** 作为平台，我希望能安全在 AXP 与稳定币间切换并回退。
#### Acceptance Criteria
1. THE 资产切换 SHALL 完全由 env 控制；关闭即回 AXP，无需改代码。
2. THE 切换/回退步骤 SHALL 文档化（含 pm2 env-cache：改 `.env` 值需 `pm2 delete + start + save`）。
3. THE 两套账本（AXP/稳定币）SHALL 并存、互不覆盖。

### Requirement 20: 合规与风控不回归（通用）
**User Story:** 作为合规，我要求充提/下注/存赎继续受门禁约束。
#### Acceptance Criteria
1. THE deposit/withdraw/下注/LP 存赎 SHALL 继续受 `LsmComplianceService`（地域/准入）与 `LsmSystemModeService`（熔断）约束。
2. THE 风险披露（测试网、不保证收益、博彩属性）SHALL 在 Web/移动端显著展示。

### Requirement 21: 链上迁移接缝（通用，为 Phase F 准备）
**User Story:** 作为架构师，我希望引擎与结算解耦，为上链迁移留缝。
#### Acceptance Criteria
1. THE 引擎与结算之间 SHALL 有清晰边界（`SettlementGateway`/适配器），使「下注→结算」状态确定性、可重建。
2. THE 订单/结算关键状态 SHALL 以可独立重算形式记录（金额、赔率、杠杆、reserved、idemKey）。
3. THE system MAY 周期性把状态承诺（merkle root）锚定到合约，提供链上可审计性而不改链下高频路径。
4. THE 接口设计 SHALL 不假设撮合永远在链下；替换为链上实现时引擎以外模块改动最小。

## Phase G — 对话式预测 Copilot + 集市真实源一体化 + AI 做市金库（Injective Nova）

> 黑客松定位：把 Agentrix 已有的 AI/agent 能力嫁接到 LSM，形成「对话式 → 链上金融全流程」差异化。
> 评审重实现质量 + 独创性。主线组合 = Req 25（对话式 Copilot，头牌）+ Req 27（集市真实源一体化）+ Req 28（AI 做市金库，独创性）。
> Req 24 是使其在 web 端真正可用的**前置基础**（统一对话框链路）。
> 复用既有真实代码：tool-registry（`@RegisterTool`/`buildTool`）、两条聊天链路（`openclaw-proxy.service` canonical + `claude-integration` 委托，须保持 parity）、`query-engine/opportunity-cards-event`（检索单一权威源 + `/ard/search`）、`marketplace-aggregation`（连接器 + `AggregationParticipationService` + `participation-path.resolver`）、`agent-protocol/settlement-core`（x402 `requireX402`/`verifyAndSettle` + `authorizeAutonomousPayment` 双围栏）、`ucp`（AP2 mandate）、LSM `/lsm/*` 全套 API（已含 `asset` 维度）。

### Requirement 24: Web 对话框统一到共享链路（多端共享记忆 + 模型 + 工具）（Phase G · 前置基础）
**User Story:** 作为用户，我希望 web 端（含 polymarket.agentrix.top 悬浮球与主站工作台）的对话框与移动端/桌面端是同一个 agent：共享服务端记忆、共享模型选择、能调用同样的平台工具。
#### Acceptance Criteria
1. THE web `UnifiedAgentChat` SHALL 从老的 `/agent/chat`（V3.0 电商服务）迁移到统一流式链路 `/openclaw/proxy/stream`（或经 `/claude/chat` 委托到同一 runtime），与移动端/桌面端同源。
2. THE web 会话 SHALL 以服务端 `sessionId`（按 userId/instance）持久化，而非仅浏览器 localStorage，使同一用户在 web/移动/桌面间**共享对话记忆**（localStorage 可保留为离线缓存，不作为唯一来源）。
3. THE web SHALL 暴露模型选择并读写**服务端按实例的 activeModel**（复用移动/桌面的 `GET /openclaw/models` + `PATCH /openclaw/instances/:id/model`），使模型选择跨端同步；平台 Bedrock 默认仅 Haiku、BYO key 解锁多模型的既有逻辑不变。
4. THE web SHALL 复用 `ToolRegistryService` 工具（含 Req 25 新增的 `lsm_*`），工具结果用结构化卡片渲染。
5. THE 两条聊天链路 SHALL 保持 parity（`chat-path-parity.contract.ts`/`runtime-doctor.service.ts` 不 fail）。
6. THE 迁移 SHALL 灰度可回退（env 开关），默认不破坏现有工作台个人/商户/开发者壳层与 `/lsm` 悬浮球的现有可用性。
7. THE `/lsm` 悬浮球（`PetChatBubble`）SHALL 在统一链路下工作，并支持基本尺寸适配（移动全宽、桌面可更大/可调），不再写死不可调整的小窗为唯一形态。
8. WHEN 已登录用户**没有任何 ACTIVE/PROVISIONING 实例**且发起默认对话 THE system SHALL **幂等地自动开通一个 platform-hosted 的 primary 实例**（`isPlatformHosted` 语义：无 `instanceUrl`，服务端 Claude/Bedrock + 平台工具运行，默认模型由 `resolvePlatformHostedDefaultModel` 决定），而非抛 `No active OpenClaw instance`（404）。复用 `openclaw-connection.service` 既有 platform-hosted 创建逻辑。
9. THE 自动开通 SHALL 幂等且并发安全（同用户多端并发首聊只生成一个 primary 实例）。
10. THE platform-hosted 实例 SHALL 即为该用户的"个人宠物 agent"，记忆按 `instanceId` 服务端持久化，**web/移动/桌面共享同一记忆**；下载移动端/桌面端是**可选升级**（解锁 Computer Use / 本地模型 / 设备能力 / 自托管或云部署），**而非获取 agent 的前置条件**，客户端登录后绑定同一用户并默认复用该 primary 实例。
11. THE 自动开通 SHALL 受系统熔断/合规门禁约束，不改变既有"用户主动云/本地部署"的实例创建路径；失败时返回结构化错误并提示重试，不静默吞错、不留半开通脏实例。

### Requirement 25: 对话式预测 Copilot —— LSM chat 工具集（Phase G · 头牌）
**User Story:** 作为用户，我希望在对话框用自然语言检索盘口、让 agent 解释赔率/隐含概率，并在对话里完成下单与查看持仓。
#### Acceptance Criteria
1. THE system SHALL 在 `tool-registry/tools/` 新增 LSM 工具（`@RegisterTool` + zod schema），至少：`lsm_search_markets`（只读，调 `LsmMarketService`）、`lsm_preview_order`（只读，调 `LsmOrderService.preview`）、`lsm_place_order`（写，`requiresPayment`）、`lsm_cashout`、`lsm_my_positions`。
2. THE 工具 SHALL 在两条聊天链路均注册可用（仿 `opportunity-cards-event` 的单一权威源模式），并通过 parity 校验。
3. WHEN 用户自然语言提问（如「有哪些即将开赛的世界杯盘口」「用 10 USDC 2 倍押主队」）THE agent SHALL 调用工具检索盘口、解释赔率/隐含概率/敞口/最大盈亏，并在确认后下单。
4. THE 工具返回 SHALL 以结构化卡片呈现（盘口卡 / 下单预览卡 / 持仓卡 + 一键确认），而非纯文本。
5. THE 下单工具 SHALL 携带 `asset`（默认 USDC for Nova demo）、`leverage`、`quotedOdds`、`idemKey`，复用既有 `/lsm/orders` 语义与滑点/熔断/合规校验。

### Requirement 26: 围栏内自主下单 + USDC on Injective 结算（Phase G · 头牌闭环）
**User Story:** 作为用户，我希望授权 agent 在我设定的额度内自动下注，并以 Injective 上的 USDC 结算，全程有风控围栏。
#### Acceptance Criteria
1. THE `lsm_place_order.checkPermissions()` SHALL 调 `SettlementCoreService.authorizeAutonomousPayment`，过 AP2 mandate（`ucp.verifyMandate`）+ `AgentAccount.spendingLimits`（单笔/日额）双围栏；未授权返回 `ask`（引导授权）或 `deny`。
2. THE 用户 SHALL 能在对话/面板内创建/撤销 mandate（复用 `POST /ucp/v1/mandates`、`DELETE /ucp/v1/mandates/:id`），如「授权每日最多 100 USDC 自动下注」。
3. WHEN `asset='USDC'` THE 下单 SHALL 校验 `/lsm/wallet/balance` USDC 余额，结算/充提经既有 `settlement-gateway` + relayer 落在 Injective EVM testnet（chainId 1439）。
4. THE 闭环 SHALL 可端到端演示：一句话 → 检索 → 解释 → 围栏授权 → USDC 下注 → 持仓卡 → 平仓回款，链下账本与链上充提一致。
5. THE 所有自主下单 SHALL 写统一账本（`Payment`/`agent_cost_records` 可追溯），超限被拦不入账。

### Requirement 27: 集市真实源一体化（检索 → 接单 → x402 → 结算，一个对话内）（Phase G）
**User Story:** 作为用户，我希望在同一个对话里既能检索/接平台聚合的真实任务/空投/技能源并用 x402 付费，也能押 LSM 盘口，形成「agent 经济 + Injective 支付」闭环。
#### Acceptance Criteria
1. THE system SHALL 新增 `lsm-prediction` 连接器（参考 `polymarket-prediction`/`manifold-prediction`，`source='lsm'`、`capabilities.canAccept=true`）注册进 `ConnectorRegistry`，使 LSM 盘口进入 `unified-marketplace.search()` → `/ard/search` 对话检索。
2. WHEN 对话检索预测机会 THE 结果 SHALL 同时含 LSM 本地盘口与外部预测源（Polymarket/Manifold），LSM 走 `internal-accept`（代下单），外部源走 `external` 跳转。
3. THE 任务/空投/技能源（RemoteOK/Lever/DefiLlama 等既有连接器）接单 SHALL 复用 `AggregationParticipationService` + `SettlementCoreService.verifyAndSettle` 的 x402 付款链路。
4. THE 同一会话 SHALL 能连续完成「接一个 x402 付费任务」+「押一个 USDC 盘口」两类动作，均落统一账本并可对账。
5. THE participate 守卫 SHALL 经 `participation-path.resolver` 能力位门控（`canAccept` 决定内部代成交 vs 外部跳转），不旁路。

### Requirement 28: AI 做市金库 agent（HLP 范式）（Phase G · 独创性）
**User Story:** 作为金库主理人/平台，我希望用 AI agent 运营金库做市策略——动态调赔率/敞口/对冲/再平衡——并为对接 Injective 原生订单簿留出路径。
#### Acceptance Criteria
1. THE system SHALL 提供链下 `lsm-mm-agent`：周期性读盘口/敞口/`vault-math` NAV/利用率，产出做市决策（调赔率偏移/承接容量/对冲/再平衡），复用 `lsm-underwriting` 订阅竞价与 `lsm-risk` 熔断护栏。
2. THE 决策 SHALL 可由平台 LLM（Bedrock 默认/BYO）+ 规则护栏驱动；任何调整 SHALL 不破坏金库偿付不变量（`bankroll − reserved` 约束），违反则被风控拦截。
3. THE Web `/lsm/vaults` SHALL 提供「AI 做市」可观测视图，展示 agent 实时动作日志（调赔率/敞口/对冲），供 demo。
4. THE system SHALL 产出 Injective 原生订单簿（Exchange 模块）对接的设计与最小 PoC（testnet 挂单/撤单适配层），作为 Phase F「vault-as-MM」的落地起点；完整高频上链做市不在本期承诺。
5. THE AI 做市 SHALL 仅运行于测试网；策略风险与「非投资建议」在 UI 披露。

## 非目标（Out of Scope）
- 自建专用 L1（不复制 HyperBFT）。链上撮合迁移仅 Phase F 前瞻探索（不在 A–E 承诺）。
- 跨链净额结算 / 跨链共享流动性。
- KMarket 仓库任何改动。
- 主网真实资金在 Phase E 审计 + 用户确认前不执行。
- 重写引擎/定价/风控核心（仅切资产标的与上链抵押）。
