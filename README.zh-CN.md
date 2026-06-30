# Agentrix Predict — Injective 上的对话式链上预测市场

> **Injective Nova 参赛项目。** 用自然语言和你的 AI agent 对话：它检索实时体育预测盘口、
> 解释赔率、在**你设定的花费围栏内**下杠杆单，并以 **Injective EVM 上的 USDC** 结算——
> 全程在一个对话框里完成。另含一个 **AI 做市金库**（HLP 范式），按利用率自动调节承接。

🌐 在线（测试网）：**https://polymarket.agentrix.top**
🎬 Demo 视频：_<链接>_  ·  📊 Pitch Deck：`PITCH_DECK.zh-CN.md`
🇬🇧 English: `README.md`

---

## 这是什么

Agentrix Predict 把"杠杆滚球预测市场"升级为 **AI-agent 原生、链上稳定币** 产品：

- **对话式预测 Copilot** —— 自然语言 → agent 调用真实工具
  （`lsm_search_markets` / `lsm_preview_order` / `lsm_place_order` /
  `lsm_my_positions` / `lsm_cashout`），解释小数赔率 + 隐含概率，并渲染结构化卡片。
- **围栏内自主下单** —— USDC 下单前必须通过 **AP2 mandate + 账户级花费上限**的双重围栏；
  可在对话里直接授权"每日最多 N USDC"。
- **USDC on Injective EVM** —— 资金托管、金库份额/NAV、偿付不变量、relayer 签名提现都在链上
  `CollateralVault`；高频的定价/风控引擎留在链下，经确定性的结算缝隔离。
- **AI 做市金库（HLP 范式）** —— 一个 agent 读取每个金库的利用率/NAV，自动调节承接
  **容量 + 赔率溢价**（expand/de-risk/hold/halt），且**容量恒 ≤ 自由权益**（偿付安全）。
- **一个 agent 贯穿 web / 移动 / 桌面** —— 服务端共享记忆与模型选择；web 用户**零下载**
  即获得个人 agent（首次对话自动开通平台托管实例）。
- **集市聚合** —— LSM 盘口与外部预测源（Polymarket/Manifold）在统一检索中并列；agent 还能在
  同一对话里**接真实任务/空投**并经 **x402** 付款。

## 为什么选 Injective

- USDC 作为唯一抵押/结算资产；亚秒级终局、低费用、对 maker 友好，契合"用户加杠杆 vs 金库坐庄"的链上模型。
- `CollateralVault` 与代币地址无关 → 上主网只需把地址指向 Injective 原生 USDC。
  前瞻路线（Phase F）：金库做市商对接 Injective 原生订单簿（Exchange 模块），
  见 `vault-as-mm-injective.md`。

## 架构（概览）

```
Web / 移动 / 桌面 对话框
   │  统一 SSE
   ▼
/openclaw/proxy/stream  ──(委托)── /claude/chat        [两条链路保持 parity]
   │  无实例则自动开通平台托管 agent（零下载）
   ▼
工具注册表 ── lsm_* 预测工具 ──► LSM 引擎 (/lsm/*)
   │   下单围栏：AP2 mandate + spendingLimits（SettlementCore）
   ▼
StablecoinAssetAdapter (USDC) ─► SettlementGateway ─► CollateralVault (Injective EVM 1439)
AI 做市：lsm-mm-agent ─► 承接容量/赔率溢价（偿付安全）
聚合：ConnectorRegistry(+lsm) ─► 统一 /ard/search ；x402 结算
```

完整设计见 `docs/spec/`（requirements / design / tasks）与 `proposal.md`。

## 链上部署（测试网）

| 链 | 合约 | 地址 |
|---|---|---|
| Injective EVM 测试网 (1439) | MockUSDC (6 位精度) | `0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D` |
| Injective EVM 测试网 (1439) | CollateralVault | `0x760ee31334EA03c2e47900eb3c419C232b4375C0` |
| BSC 测试网 (97) | MockUSDC | `0x7103995D9f0B87c16964ed34Fe29AdDff8cCd5a0` |
| BSC 测试网 (97) | CollateralVault | `0x75b7CaE3ec28b2F5aA0dD275E83Ac96Cd60cfa93` |

> 测试网资产无真实价值。非投资建议。

## 仓库结构（公开裁剪版）

```
contracts/   Solidity（CollateralVault、MockUSDC）+ Hardhat 测试与部署脚本
backend/     NestJS —— 杠杆滚球引擎、对话工具、AI 做市 agent、链上 oracle/relayer、结算缝
frontend/    Next.js —— polymarket.agentrix.top (/lsm) + 统一 agent 对话
docs/        架构、设计 spec、pitch deck、demo 脚本
```
（本仓库是一个更大生产平台的**只读裁剪版**，用于参赛展示；实际功能请访问在线测试网应用。）

## 快速开始

```bash
# 合约
cd contracts && npm i && npx hardhat test
npx hardhat run scripts/deploy-lsm-vault.ts --network injectiveEvmTestnet

# 后端（NestJS）
cd backend && npm i
cp .env.example .env   # 配置 DB + AWS Bedrock（或自带 LLM key）+ LSM_* 开关
npm run start:dev

# 前端（Next.js）
cd frontend && npm i
NEXT_PUBLIC_UNIFIED_CHAT=1 npm run dev
```

关键开关：`LSM_ASSET_MODE=both`、`LSM_CHAT_TOOLS_ENABLED=1`、
`LSM_PREDICTION_CONNECTOR_ENABLED=1`、`LSM_MM_AGENT_ENABLED=1`、
`NEXT_PUBLIC_UNIFIED_CHAT=1`。

## 状态

Injective EVM 测试网上的 Level-1 已端到端跑通：合约部署、双标的（AXP 免费玩 + USDC 链上）、
独立 Web 端、对话式 Copilot（已在生产验证 LLM 真实调用 `lsm_search_markets`）、
花费围栏、AI 做市可观测、多链（Injective + BSC）。

## 许可证

MIT。
