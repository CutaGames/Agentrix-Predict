# Agentrix Predict — Pitch Deck（Injective Nova）

> 12 页。每页 = 标题 + 讲述要点 + 画面提示。可直接转 PowerPoint / Google Slides / Gamma。
> 每个要点约 10 秒。English: `PITCH_DECK.md`

---

## 第 1 页 — 封面
**Agentrix Predict**
Injective 上的对话式链上预测市场。
- 副标题：*和你的 AI agent 对话 → 它在围栏内用 USDC 下注。*
- 画面：logo + slogan + `polymarket.agentrix.top` + Injective logo。

## 第 2 页 — 痛点
- 预测市场很强，但**很笨重**：选盘口→读赔率→算注码→管钱包→签交易。高摩擦、低信任。
- DeFi 的 UX 仍假设"人在点击"。**Agent** 本可代劳——前提是它能**安全地**动用链上资金。
- 画面：杂乱的交易界面 vs 一个对话气泡。

## 第 3 页 — 我们的洞察
- 界面应是**一段对话**，执行者应是**你的 agent**——配上**链上围栏**，让它花钱也不失信任。
- "自然语言 → 检索盘口 → 解释赔率 → 在 mandate 内下注 → USDC 结算 → 看持仓"——一个对话搞定。
- 画面：对话 → 链上 的箭头。

## 第 4 页 — 我们做了什么（demo 头牌）
- **对话式预测 Copilot**：一句话 → agent 调真实工具、解释赔率/隐含概率、下杠杆单、展示持仓。
- 已在生产验证：LLM 真的调用了 `lsm_search_markets`，返回实时世界杯盘口 + 赔率。
- 画面：对话返回盘口卡片的截图。

## 第 5 页 — 围栏（信任）
- USDC 下单要过**双重围栏**：AP2 **mandate**（最大额/品类/商户）+ 账户级**花费上限**。
  在对话里授权"每日 100 USDC"。
- AXP 免费玩无需围栏；USDC（真实、链上）始终要过。
- 画面："授权每日 100 USDC"卡片 → 绿色对勾。

## 第 6 页 — 在 Injective 上链
- 资金托管、LP 金库份额/NAV、**偿付不变量**、relayer 签名提现都在 `CollateralVault`
  （Injective EVM 测试网 1439）。
- 仅 USDC 抵押；合约与代币地址无关 → 上主网只需指向 Injective 原生 USDC。
  高频定价/风控引擎留链下，经结算缝隔离。
- 画面：架构图（对话 → 引擎 → Injective 上的金库）。

## 第 7 页 — AI 做市金库（独创性）
- 由 **AI agent** 运营的 HLP 范式金库：读利用率/NAV → 自动调承接**容量 + 赔率溢价**；
  expand/de-risk/hold/halt。
- **结构上偿付安全**：容量 ≤ 自由权益；下单时按腿再校验风险。
- 画面：`/lsm/vaults` 上的"AI 做市"实时面板。

## 第 8 页 — 一个 agent，覆盖所有端
- web / 移动 / 桌面 同一个 agent：服务端共享记忆 + 模型。
- web 用户**零下载**即得个人 agent（首次对话自动开通平台托管实例）。下载 = 可选增强
  （Computer Use、本地模型、设备传感器）。
- 画面：3 个设备 → 一个大脑。

## 第 9 页 — 接入 agent 经济
- LSM 盘口在**统一检索**中与 Polymarket/Manifold 并列。
- 同一对话里 agent 还能**接真实任务/空投**（RemoteOK、Lever、DefiLlama…）并经 **x402** 付款——
  检索 → 执行 → 付款 → 结算。
- 画面：检索结果里任务 + 预测盘口混排。

## 第 10 页 — 技术与复用（实现质量）
- 构建在 Agentrix 的生产级 agent 栈之上：工具注册表、两条 parity 校验的对话链路、
  AP2/UCP mandate、x402 结算、集市连接器。
- Solidity + Hardhat（8 项不变量测试）、NestJS 引擎、Next.js 应用。单测 + 生产 E2E。
  一套代码多链（Injective + BSC）。
- 画面：组件图 + "复用而非临时拼装"。

## 第 11 页 — 路线图
- **现在**：Injective EVM 测试网 Level-1 已上线（本次提交）。
- **下一步**：去信任提现（m-of-n + 逃生通道）、审计、主网（原生 USDC）。
- **Phase F（独创性）**：金库做市商对接 Injective **原生订单簿**（Exchange 模块）——
  AI 做市在 CLOB 上挂/撤单。
- 画面：时间线。

## 第 12 页 — 诉求 / 收尾
- 现已上线：**polymarket.agentrix.top**。开源 + demo 已附。
- 愿景：**让 agent 成为一等的链上金融行为体**——Agentrix Predict 在 Injective 上给出证明。
- 画面：logo + 链接 + "谢谢观看"。

---

### 附录（可选页）
- A1 — 合约地址（测试网）表。
- A2 — 安全：偿付不变量、双围栏、relayer 签名、仅测试网。
- A3 — 指标/架构深入。
