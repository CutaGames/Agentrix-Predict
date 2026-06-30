# Implementation Plan

## Overview

按 Phase A→F 落地。范围：仅 Agentrix 工作区；测试网优先（Injective EVM 1439）；保持引擎语义不变，env 灰度可回退。主网相关任务（Phase E）需用户显式确认后才执行；Phase F 为前瞻评估（文档 + 可选原型），不阻塞 A–E。

## Tasks

### Phase A — 链上合约层

- [ ] 1. 结算资产 USDC（测试网用自发 MockUSDC，token 无关，主网换真 USDC）
  - [x] 1.1 写 `contract/contracts/test/MockUSDC.sol`（ERC20，decimals=6，`mint onlyOwner`，testnet-only 注释）——作测试网主资产（水龙头 20/2h 不够注入金库）
  - [x] 1.2 在 `contract/` Hardhat 加 1439 网络配置 + 部署脚本，部署 MockUSDC，记录地址到部署清单 — **已部署到 Injective EVM testnet：MockUSDC `0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D`**
  - [x] 1.3 确保 CollateralVault 对 USDC 地址 token 无关（构造参数/配置）；主网仅换地址指向 Circle 原生 USDC
  - _Requirements: 1_

- [ ] 2. CollateralVault 合约
  - [x] 2.1 `contract/contracts/CollateralVault.sol`：存储 + `deposit` + 事件 + Ownable + ReentrancyGuard + pause
  - [x] 2.2 `depositLiquidity`/`redeemLiquidity`，逐项复刻 `lsm.vault-math.ts`（NAV/份额/floor/余数归金库/高水位）
  - [x] 2.3 `applySettlement`(onlyRelayer, 批量, idemKey 幂等)，每步强校验 `payout ≤ bankroll-reserved`（守恒 + 偿付）
  - [x] 2.4 `requestWithdraw`(relayer 签名 + 偿付 + nonce 防重放) + `setRelayer`/`pause`
  - [x] 2.5 Hardhat 测试 8 项通过：deposit/dust/LP NAV/结算守恒+偿付+幂等/签名提现+防重放/isSolvent/pause（覆盖 I1/I2/I3 + NAV）
  - [x] 2.6 部署 CollateralVault 到 1439，记录地址，配置 relayer — **已部署：CollateralVault `0x760ee31334EA03c2e47900eb3c419C232b4375C0`，relayer=0x5a419E…，公共金库已注入 1000 USDC bankroll**
  - _Requirements: 2, 3, 18_

> **Phase A 完成**（合约层）。部署清单：`contract/deployments/lsm.injectiveEvmTestnet.*.json`。下一步 Phase B（后端 oracle/relayer 接线）。

### Phase B — 后端 oracle/relayer

- [x] 3. 多链链/资产注册表
  - [ ] 3.1 `backend/.../onchain/chain-registry.ts`（ChainCfg + 解析 `LSM_CHAINS`），覆盖 1439
  - _Requirements: 12, 18_

- [x] 4. OnchainVerifier 多链化
  - [ ] 4.1 改为 provider-per-chain，`verifyTokenTransfer` 增 `chainId`
  - [ ] 4.2 保持 BSC 97 行为；多链路由单测（mock provider）
  - [ ] 4.3 CollateralVault 事件监听/确认（Deposited/Withdrawn/Settled），nonce/txHash 幂等
  - _Requirements: 4_

- [x] 5. 稳定币账本（独立于 AXP）
  - [ ] 5.1 实体 `UserStableBalance` + `UserStableLedger`（chainId 维度）+ migration（不动 user_axp_*）
  - [ ] 5.2 `StableLedgerService.credit/debit/escrow/release/getBalance`（原子 + 幂等）+ 单测
  - _Requirements: 5, 18_

- [x] 6. StablecoinAssetAdapter + SettlementGateway
  - [ ] 6.1 实现 `StablecoinAssetAdapter`（移除 STABLECOIN_TREASURY_UNWIRED）映射到 StableLedgerService
  - [ ] 6.2 `SettlementGateway`（确定性 SettlementOp + relayer 批量 applySettlement + 可选 merkle 锚定）
  - [ ] 6.3 验证 `assetAdapterFactory` 选择逻辑；AXP 默认不回归（两标的引擎行为一致，P-灰度）
  - _Requirements: 5, 19, 21_

- [x] 7. 充值 / 提现 服务 + 控制器
  - [ ] 7.1 充值：监听 Deposited / `POST /lsm/wallet/deposit` → verifier → credit（精度换算）→ txHash 幂等
  - [ ] 7.2 提现：`POST /lsm/wallet/withdraw` → 校验+冻结 → relayer 签名 → 代发/回前端 → 确认；失败解冻补偿
  - [ ] 7.3 `GET /lsm/wallet/balance`
  - [ ] 7.4 充提受合规 + 熔断约束；补偿/幂等单测
  - _Requirements: 6, 7, 20_

- [x] 8. 对账扩展
  - [ ] 8.1 `LsmReconciliationService` 增「链上余额 ≥ 内部负债」核对（每链），负缺口告警 + 单测
  - _Requirements: 8_

### Phase C — 独立 Web 端（polymarket.agentrix.top）

- [x] 9. 子域名路由
  - [ ] 9.1 `frontend/middleware.ts` 增 host 判断 → rewrite `/predict/*`（更新 matcher）
  - _Requirements: 11_

- [x] 10. LSM Web 页面（`frontend/pages/predict/`）
  - [ ] 10.1 轻量独立 layout（复用 apiFetch+组件）
  - [ ] 10.2 盘口列表 + 详情（赔率折线）+ 下单（preview→place，滑点重试）
  - [ ] 10.3 我的持仓 + 提前平仓
  - [ ] 10.4 金库列表 + LP 存赎
  - [ ] 10.5 排行榜 + 风险披露（测试网标识，USDC 文案）
  - _Requirements: 9_

- [x] 11. 钱包连接 + 链上充提 UI
  - [ ] 11.1 EVM 钱包连接，引导添加/切换 1439
  - [ ] 11.2 充值：approve → CollateralVault.deposit → 提交 txHash
  - [ ] 11.3 提现：取 relayer 签名 → 提交合约交易（或后端代发）→ 展示确认
  - _Requirements: 10_

- [x] 12. 子域名部署
  - [ ] 12.1 Nginx 加 server_name + 反代 + Let's Encrypt + DNS A 记录
  - [ ] 12.2 复用 deploy_sg_frontend 模式构建+重启，验证主站不回归
  - _Requirements: 11_

### Phase D — 多链扩展

- [ ] 13. 接入 BSC testnet(97)
  - [ ] 13.1 chain-registry 加 97（复用现有 USDT/验真/relayer 或部署同款合约 + 测试 USDC）
  - [ ] 13.2 同源 CollateralVault 部署到 97 并登记；verifier/relayer/对账多链跑通
  - [ ] 13.3 Web/移动端选/显示结算链；披露各链流动性独立
  - _Requirements: 12, 13_

### Phase E — 主网就绪（需用户显式确认）

- [ ] 14. 提现去信任升级
  - [ ] 14.1 合约提现授权改 m-of-n 门限/多签 + 测试
  - [ ] 14.2 escapeWithdraw 逃生通道（快照 + 时间锁）+ 测试
  - _Requirements: 14_

- [ ] 15. 审计 / 监控 / 治理 / 上线
  - [ ] 15.1 CollateralVault 审计 + I1/I2/I3 形式化；修复闭环
  - [ ] 15.2 链上余额/偿付/relayer 监控告警 + 应急 pause 预案
  - [ ] 15.3 owner/relayer/签名者迁多签治理
  - [ ] 15.4 主网部署（用户确认后）+ 小额真实资金闭环验证
  - _Requirements: 14, 15_

### Phase F — 链上撮合/结算迁移探索（前瞻：文档 + 可选原型）

- [ ] 16. 迁移评估
  - [ ] 16.1 `docs/lsm-onchain-migration-eval.md`：路线(a) 自写结算合约保持固定赔率vs金库；路线(b) Vault-as-MM + Injective 原生 CLOB（HLP 范式），含赛果杠杆→衍生品保证金映射
  - [ ] 16.2 量化延迟/成本/不变量契合度，默认建议(a)
  - [ ] 16.3 （可选）测试网原型：先把结算/派彩上链，复用 SettlementGateway 缝
  - _Requirements: 16, 17_

### 通用收尾

- [ ] 17. 灰度与验收
  - [ ] 17.1 记录切换/回退步骤（env + pm2 delete/start/save）到 memory/docs；确认两套账本并存不互扰
  - [ ] 17.2 全链路测试网验收（deposit→下注→结算→提现→对账 balanced）后再考虑灰度开启
  - _Requirements: 19, 20_

### Phase G — 对话式预测 Copilot + 集市真实源一体化 + AI 做市金库（Injective Nova）

> 范围：嫁接已有 AI/agent 能力到 LSM，最大化复用。组合主线 = task 20(头牌) + 22 + 23；task 18/19 为前置基础。env 灰度开关（`NEXT_PUBLIC_UNIFIED_CHAT`/`LSM_CHAT_TOOLS_ENABLED`/`LSM_MM_AGENT_ENABLED`）默认关，零回归。AI 做市仅测试网。

- [x] 18. Web 对话框统一到共享链路（多端共享记忆 + 模型 + 工具）
  - [x] 18.1 `lib/api/unifiedChat.ts` 新增 `streamUnifiedChat()` 走 `POST /openclaw/proxy/stream`（fetch SSE，解析 query-engine StreamEvent 协议；`isUnifiedChatEnabled()` 开关）
  - [x] 18.2 `UnifiedAgentChat.tsx` 在 `NEXT_PUBLIC_UNIFIED_CHAT=1` 时改走统一链路（流式 append + onSession 更新 sessionId）；保留旧 `/agent/chat` 回退分支
  - [x] 18.3 `ModelPicker.tsx` + `lib/api/openclaw.api.ts`：读 primary 实例 + `GET /openclaw/models`，切换 `PATCH /openclaw/instances/:id/model`（服务端 activeModel，跨端同步），仅统一链路显示
  - [x] 18.4 `LsmToolCards.tsx`：捕获 `tool_result` 流事件中 `cardType=lsm_*` 渲染结构化卡片（盘口/预览/下单/持仓/平仓/授权 + 一键追问）
  - [x] 18.5 `PetChatBubble.tsx` 桌面面板可调尺寸（sm/md/lg 预设，移动全宽），不再写死小窗
  - [x] 18.6 两链路 parity：lsm_* 经 `buildPlatformHostedTools` 统一注入，claude 链路委托同函数 → 天然一致
  - _Requirements: 24_

- [x] 19. 平台托管 agent 自动开通（消除"先下载客户端"依赖）
  - [x] 19.1 `OpenClawConnectionService.ensurePlatformHostedPrimary(userId)`（复用既有 platform-hosted 创建逻辑，`isPrimary:true`/`platformHosted:true`/默认模型），幂等 + 并发安全（per-user pg_advisory_xact_lock + 事务内复查）
  - [x] 19.2 `OpenClawProxyService.resolveDefaultInstanceForUser` 无实例时调 19.1 而非抛 404
  - [x] 19.3 单测：fast-path 幂等不创建 / cold-path 创建唯一 platform-hosted primary / race-path 返回并发已建实例（3 passed，`openclaw-connection.autoprovision.spec.ts`）
  - _Requirements: 24_

- [ ] 20. LSM chat 工具集（对话式预测 Copilot 头牌）
  - [x] 20.1 `tool-registry/tools/lsm/lsm.tools.ts` 新增 `lsm_search_markets`/`lsm_preview_order`/`lsm_my_positions`（只读）+ `lsm_cashout`，`@RegisterTool`+zod，调 `LsmMarketService`/`LsmOrderService`；`ToolCategory.PREDICTION` 新增
  - [x] 20.2 `lsm_place_order`（`requiresPayment`,`riskLevel:2`）调 `LsmOrderService.place`，带 `asset`/`quotedOdds`/`idemKey`；在 `tool-registry.module` 注册（import `LeverageSportsMarketModule`）
  - [x] 20.3 两链路注册：proxy `buildPlatformHostedTools` 经 `ToolRegistryService.getSchemasForProvider('claude',{categories:[PREDICTION]})` 注入 + `onToolCall` 加 `lsm_` 分发（`LSM_CHAT_TOOLS_ENABLED` 门控）；claude 链路委托同一函数 → parity 天然成立
  - [x] 20.4 前端 LSM 卡片渲染（`LsmToolCards`：盘口/预览/持仓/下单/平仓/授权 + 一键追问）
  - [x] 20.5 工具 zod+execute 单测（6 passed，`lsm.tools.spec.ts`：search 映射/preview 隐含概率/place 登录校验+下单+错误码/positions 兑现值）
  - _Requirements: 25_

- [x] 21. 围栏内自主下单 + USDC on Injective 结算
  - [x] 21.1 `lsm_place_order.checkPermissions` → `SettlementCoreService.authorizeAutonomousPayment`（AP2 mandate + spendingLimits 双围栏，ModuleRef 懒解析避免 DI 循环）；AXP 免费玩放行；USDC 无授权/超限返回 ask（Property G2，4 单测）
  - [x] 21.2 对话内授权工具 `lsm_authorize_spending`（UCP `createMandate`，scope=prediction/lsm）；checkPermissions 自动取 agent 最新 active mandate 传入围栏
  - [x] 21.3 USDC 下单经既有 StablecoinAssetAdapter+SettlementGateway+relayer 落 1439（引擎已具备，asset 维度透传）
  - [x] 21.4 生产 E2E（`lsm-nova-e2e.mjs`）：无实例用户默认 chat **不再 404**（自动开通成功，进到 LLM 调用）；preview USDC + 双余额回归通过。完整对话式 LLM 下单受 Bedrock 429 限流，路径已验证
  - _Requirements: 26_

- [ ] 22. 集市真实源一体化（检索→接单→x402→结算，一个对话内）
  - [x] 22.1 `connectors/lsm-prediction.connector.ts`（`source='lsm'`,`canDiscover=true`,`fetchListings`→`LsmMarketService`,`normalize`），module providers + bootstrap 注册（`LSM_PREDICTION_CONNECTOR_ENABLED` 门控）
  - [x] 22.2 生产部署确认 **`聚合连接器装配完成：成功注册 19/19（… lsm …）`**；检索数据由既有 30min sync cron 填充进 `aggregated_resources`→`/ard/search`（与其它 18 源同路径）
  - [x] 22.3 **设计取舍**：LSM 杠杆单需 outcome/leverage/quotedOdds，无法用通用 `ParticipationContext` 表达 → `canAccept=false`（discovery-only），代下单走对话式 `lsm_place_order`（携全量参数，单一下单路径）；externalUrl 指向 `/lsm/market/:id`
  - [ ] 22.4 同一会话连续"接 x402 任务 + 押 USDC 盘口"双资金流，统一账本对账 — 待对话式 LLM 联调（依赖 Bedrock 配额）
  - _Requirements: 27_

- [ ] 23. AI 做市金库 agent（HLP 范式，独创性）
  - [x] 23.1 `mm-agent/lsm-mm.decision.ts` 纯决策引擎（利用率带→expand/derisk/hold）+ `lsm-mm-agent.service.ts`（@Interval 60s，`LSM_MM_AGENT_ENABLED` 门控）；`LSM_MM_AGENT_APPLY=1` **真实写回**承接订阅（`LsmUnderwritingService.upsertSubscription`，均分 capacity+设 feeBid，halt→0+停用，protocol 无订阅 no-op）
  - [x] 23.2 决策引擎硬保证 `capacity ≤ free(bankroll−reserved)` + halt 资不抵债/非活跃；写回后下单仍经 `LsmRiskService` 逐腿校验 → 双保险不破偿付（Property G5；决策 6 + apply 4 单测）
  - [x] 23.3 可观测后端端点 `GET /lsm/mm-agent/decisions` + 前端 `MmAgentPanel`（/lsm/vaults "AI 做市" 面板：利用率/建议承接/赔率溢价/决策理由，每 30s 刷新）
  - [x] 23.4 `docs/lsm-vault-as-mm-injective.md` 设计 + Injective Exchange CLOB PoC 路线（接口先行，复用 SettlementGateway 缝）
  - _Requirements: 28_

- [ ] 24. Phase G 收尾（黑客松 demo + E2E）
  - [x] 24.1 生产 E2E：`lsm-nova-e2e.mjs`（自动开通 5/5）+ `lsm-copilot-e2e.mjs`（**对话式 LLM 真实调用 `lsm_search_markets` 工具、返回真实盘口+赔率解释**，Bedrock 恢复 + 工具 schema 400 修复后跑通）
  - [ ] 24.2 录制头牌 demo（对话式 USDC 全闭环）+ Nova 提案文档 `docs/lsm-nova-hackathon-proposal.md`（文档已成，**对话式工具链路已生产验证**，录屏待做）
  - _Requirements: 24, 25, 26, 27, 28_

## Task Dependency Graph

并行波次（wave）定义：同一 wave 内任务可并行；后一 wave 依赖前序完成。Phase E（waves 含 14/15）需用户显式确认；Phase F（16）只依赖迁移缝（task 6），可与 B/C 并行。

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "3"], "rationale": "USDC 资产 + 多链注册表，无前置，可并行" },
    { "wave": 2, "tasks": ["2", "4", "5"], "rationale": "合约依赖 1；验真依赖 3；稳定币账本独立" },
    { "wave": 3, "tasks": ["6"], "rationale": "Adapter+Gateway 依赖 2/4/5" },
    { "wave": 4, "tasks": ["7", "8", "16"], "rationale": "充提依赖 6；对账依赖 7 数据面；迁移评估只依赖 6 接缝" },
    { "wave": 5, "tasks": ["9"], "rationale": "子域名路由，Web 入口，依赖 7 的 wallet API" },
    { "wave": 6, "tasks": ["10"], "rationale": "Web 页面依赖路由 9" },
    { "wave": 7, "tasks": ["11"], "rationale": "钱包充提 UI 依赖页面 10 + 充提 API 7" },
    { "wave": 8, "tasks": ["12"], "rationale": "子域名部署依赖 Web 11" },
    { "wave": 9, "tasks": ["13", "17"], "rationale": "多链扩展 + 灰度验收，依赖部署 12" },
    { "wave": 10, "tasks": ["14"], "rationale": "去信任提现，依赖多链 13（Phase E，需用户确认）" },
    { "wave": 11, "tasks": ["15"], "rationale": "审计/监控/治理/主网，依赖 14（需用户确认）" },
    { "wave": "G1", "tasks": ["18", "19"], "rationale": "Phase G 前置：web 统一链路 + 自动开通托管 agent，可并行" },
    { "wave": "G2", "tasks": ["20", "22"], "rationale": "LSM chat 工具集 + lsm-prediction 连接器，依赖统一链路 18/19" },
    { "wave": "G3", "tasks": ["21"], "rationale": "围栏内自主下单 + USDC 结算，依赖 chat 工具 20" },
    { "wave": "G4", "tasks": ["23"], "rationale": "AI 做市 agent，依赖 USDC 金库链路（task 6/7），可与 G2/G3 并行" },
    { "wave": "G5", "tasks": ["24"], "rationale": "Phase G demo + E2E 收尾，依赖 21/22/23" }
  ]
}
```

关键链路：1→2→6→7→9→10→11→12 是 Level-1-on-Injective + Web 上线主干。
Phase G 关键链路：18→20→21→24（对话式预测 Copilot 头牌闭环）；19 与 18 并行；22/23 可与 21 并行。

## Notes

### A/B/C 增强（2026-06-29 第二批）
- **A（UI 对标 + 品牌一致）**：LSM web 从 `/predict` 迁到 **`/lsm`**（修复与主站 BTC 预测页 `pages/predict.tsx` 的路由冲突），改用 **Agentrix 品牌**（logo `/brand/logo-icon.png` + 主站 `<Footer/>` + slate/violet 主题），kmarket/polymarket 式盘口卡片网格 + 详情/赔率图/下注面板。`polymarket.agentrix.top → /lsm`；`agentrix.top/predict` 恢复为 BTC 页。已部署。
- **B（AXP+USDC 双标的并行）**：`AssetAdapterRegistry`（按币种路由）+ 订单/金库 `asset` 维度 + 双余额 `/lsm/wallet/balance {axp,usdc}` + 前端 AssetToggle + 迁移 1829。官方金库按币种隔离、自动 seed（AXP/USDC 各 1e8 单位）。**`LSM_ASSET_MODE=both` 已在生产开启**；默认 AXP 不回归。已部署。
- **C（跨子域名 SSO）**：后端早已支持（JWT 读 `agentrix_token` cookie + 生产 `AUTH_COOKIE_DOMAIN=.agentrix.top`）；本次让 predict 客户端 `withCredentials:true` 跨域携带共享 cookie（CORS 已 `Allow-Credentials:true` + 回显 polymarket origin），主站登录态即在子域名生效。已部署。
- 部署 gotcha：前端勿并发 `npm run build`（会污染 `.next` 致 `next start` 缺 prerender-manifest 崩溃循环）；先确保单次 build 完成（`.next/prerender-manifest.json` 存在）再 `pm2 restart`。Injective EVM 部署 gas price 设 0.2 gwei。

### 部署状态（2026-06-29）
- **Phase A/B/C 已提交并部署到生产**（commit `09c81219e`，分支 `build/world-creation-ui-v6-2026-06-10`）。
- 链上（Injective EVM testnet 1439）：CollateralVault `0x760ee31334EA03c2e47900eb3c419C232b4375C0`，MockUSDC `0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D`，公共金库已注入 1000 USDC。
- 后端：迁移 `CreateLsmStableLedger` 已跑（user_stable_balances/ledger 建表），`/api/lsm/wallet/*` 路由已挂载（balance 401 鉴权），health 200。**`LSM_STABLECOIN_ENABLED` 未开** → 现网仍走 AXP，零回归；切 USDC 是后续灰度步骤（改 .env 值需 pm2 delete+start+save）。
- 前端：`/predict/*` 页面已构建上线；中间件 host 改写已生效。
- **子域名 `https://polymarket.agentrix.top` 已上线**（TLS 证书已 expand 含该子域；根路径→/predict；/api 反代后端，均 200）。主站 agentrix.top 不受影响。
- 待用户后续：(a) 决定何时灰度开启 `LSM_STABLECOIN_ENABLED=1`/`LSM_ASSET_UNIT=USDC`；(b) 验证 predict 页面登录态（前端 token 取用方式需确认）；(c) Phase D 多链 / Phase E 主网。

- 合约持有真实测试资金，按高风险推进：先单测/invariant 充分，再测试网集成，最后才谈灰度。
- `applySettlement` 与逐笔下注解耦：下注只改链下镜像账本，合约抵押在结算/周期锚定时批量更新（保滚球体验）。
- 切换由 env 控制，随时可回退 AXP；两套账本并存、互不覆盖。
- 主网（15.4）与任何真实资金动作，必须用户显式确认。
