# Agentrix Predict — Injective Nova 提案

> 杠杆滚球预测市场（LSM）作为独立子项目参加 Injective Nova。
> 核心叙事：**对话式 AI agent + Injective 链上金融全流程** —— 把 Agentrix 已有的 agent 协议栈嫁接到链上稳定币预测市场。

## 一句话
在 `polymarket.agentrix.top`，用户用**自然语言**让自己的 AI agent 检索盘口、解释赔率、在**风控围栏内**代下单，并以 **Injective 上的 USDC** 结算——一个对话框跑完「检索 → 决策 → 链上支付 → 持仓」。

## 为什么有竞争力（实现质量 + 独创性）
1. **不是 demo 壳，是接到真实平台能力**：复用 Agentrix 生产级 agent 协议栈——工具注册表、双聊天链路、AP2 mandate 自主支付围栏、x402 结算、集市聚合连接器——而非为黑客松临时拼装。
2. **NL → 链上金融闭环**：对话式 Copilot 把"检索集市真实源 + 下单 + 支付"统一在一个会话里。
3. **AI 做市金库（HLP 范式，独创）**：AI agent 按金库利用率动态调承接容量与赔率溢价，偿付不变量链上/链下双重保证。
4. **多端共享 agent**：web/移动/桌面同一个 platform-hosted agent，共享记忆与模型；web 用户零下载即得个人 agent。

## 已落地（生产 · Injective EVM testnet 1439）
| 能力 | 实现 |
|---|---|
| 链上托管 + 金库 | `CollateralVault` + `MockUSDC`（6dec），NAV/份额/偿付不变量/签名提现 |
| 双标的 | AXP（免费玩）+ USDC（链上真实），按币种路由适配器与金库隔离 |
| 独立 Web 端 | `polymarket.agentrix.top`，Agentrix 品牌，kmarket 式盘口 |
| 对话式预测 Copilot | `lsm_*` 工具（检索/预览/下单/持仓/平仓/授权），两聊天链路 parity 注入 |
| 自主支付围栏 | `lsm_place_order` → AP2 mandate + spendingLimits 双围栏；对话内授权日限额 |
| USDC on Injective 结算 | StablecoinAssetAdapter + SettlementGateway + relayer |
| 集市真实源一体化 | LSM 盘口进统一 `/ard/search`，与 Polymarket/Manifold 并列；任务/空投经 x402 接单 |
| AI 做市金库 agent | 利用率带 expand/derisk/hold 决策（capacity≤free 偿付安全），可观测面板 |
| 多链 | Injective EVM 1439 + BSC 97 同源部署 + 链选择器 |
| 自动开通托管 agent | web 用户登录即得 platform-hosted primary，无需下载客户端 |

## Demo 脚本（头牌）
1. 打开 `polymarket.agentrix.top`，钱包登录（自动获得个人 agent，零下载）。
2. 悬浮球对话："有哪些即将开赛的世界杯盘口？" → agent 调 `lsm_search_markets`，渲染盘口卡 + 隐含概率。
3. "用 10 USDC 2 倍押主队" → agent 调 `lsm_preview_order` 出预览卡（敞口/最大盈亏）。
4. 首次触发围栏 → "授权每日 100 USDC 自动下注" → `lsm_authorize_spending` 建 AP2 mandate。
5. 确认 → `lsm_place_order`（USDC，过双围栏）→ 链上结算 → 持仓卡。
6. /lsm/vaults 看 **AI 做市** 面板：agent 实时按利用率调容量/赔率溢价。

## 架构
```
对话框(web/移动/桌面) → /openclaw/proxy/stream（统一 runtime，共享记忆/模型/工具）
  → ToolRegistry(lsm_*) → checkPermissions(AP2+spendingLimits 围栏)
  → LSM 引擎(/lsm/*) → StablecoinAssetAdapter(USDC) → SettlementGateway → CollateralVault(Injective EVM)
聚合检索：ConnectorRegistry(+lsm-prediction) → /ard/search
AI 做市：lsm-mm-agent（利用率带决策，偿付安全）→（Phase F PoC）Injective Exchange CLOB
```

## 路线图（Phase F）
- Vault-as-MM 对接 Injective 原生订单簿（Exchange 模块）——AI 做市 agent 向 CLOB 挂/撤单，详见 `docs/lsm-vault-as-mm-injective.md`。
- 提现去信任升级（门限/多签 + 逃生通道）、审计、主网（真实 USDC）。

## 运行配置（生产已开）
- backend：`LSM_CHAT_TOOLS_ENABLED=1` / `LSM_PREDICTION_CONNECTOR_ENABLED=1` / `LSM_MM_AGENT_ENABLED=1`（观察模式）/ `LSM_ASSET_MODE=both`
- frontend：`NEXT_PUBLIC_UNIFIED_CHAT=1`
- 注：对话 completion 走平台 AWS Bedrock（Haiku）；高并发 demo 前建议申请提高 Bedrock 配额或对评审账户配 BYO key，避免 429 限流。

> 测试网资产无真实价值；AI 做市/预测为娱乐演示，非投资建议。
