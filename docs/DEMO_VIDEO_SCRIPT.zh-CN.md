# Demo 视频脚本 — Agentrix Predict（Injective Nova）

**目标时长：≤ 3:00。** 录屏 `https://polymarket.agentrix.top` + 简短架构叠层。
旁白中文（或英文），节奏紧凑。English: `DEMO_VIDEO_SCRIPT.md`

录制前准备（避免现场卡顿）：
- 一个**已有 USDC 余额**的已登录测试账户（提前充好），让下单步骤秒回。
  （充值：部署钱包 → 向金库转 USDC → 提交 txHash；若 USDC 没准备好，用 AXP 免费玩演示。）
- Bedrock 配额健康（别在演示中途 429）；可给演示账户配 BYO key 让回复更快。
- 另开一个标签停在 `/lsm/vaults` 展示 AI 做市面板。

---

### 0:00–0:20 — 钩子
- 画面：进入 `polymarket.agentrix.top/lsm`，世界杯盘口网格。
- 旁白："预测市场很强，但很笨重。如果你只需要……和你的 agent 对话，它就能安全地替你链上下注呢？
  这就是 Agentrix Predict，运行在 Injective 上。"

### 0:20–0:35 — 零下载 agent
- 画面：点右下萌宠悬浮球 → 打开对话；（口播）钱包登录，无需装应用。
- 旁白："连上钱包，你立刻拥有一个个人 AI agent——无需下载。web、移动、桌面同一个 agent、同一份记忆。"

### 0:35–1:15 — 对话式 Copilot（头牌）
- 输入："有哪些即将开赛的世界杯盘口？解释第一个的赔率。"
- 画面：agent 调用 `lsm_search_markets`，渲染**盘口卡片**（赔率 + 隐含概率）；解释第一个盘口。
- 旁白："它调用真实工具——检索实时盘口、解释小数赔率和隐含概率——并展示结构化卡片，不只是文字。"

### 1:15–1:55 — 围栏内 USDC 下单（信任 + Injective）
- 输入："用 10 USDC、2 倍杠杆押主队。"
- 画面：预览卡（名义敞口 / 最大盈利 / 最大亏损）。首次触发 → agent 请求授权：
  "授权每日 100 USDC 自动下注" → 确认（创建 AP2 mandate）。
- 然后：下单成功，**持仓卡**出现。简短展示 USDC 在 Injective EVM 结算（金库地址 / 测试网标识）。
- 旁白："USDC 下单要过花费围栏——链上 mandate 加每日上限。授权一次，agent 即可在你的规则内行动。
  资金被托管并以 USDC 在 Injective 结算。"

### 1:55–2:25 — AI 做市金库（独创性）
- 画面：切到 `/lsm/vaults` → **AI 做市 / Market-Making** 面板：各金库利用率、建议承接容量、
  赔率溢价、决策理由，持续刷新。
- 旁白："庄家一侧由 AI 做市商运营。它读取每个金库的利用率，自动调节承接容量和赔率价差——
  且永远不超过自由权益，因此不会破坏偿付。"

### 2:25–2:50 — agent 经济 + Injective 角度
- 画面：检索结果里 LSM 盘口与外部源并列；快速口播"同一对话里接任务 + x402"。
- 旁白："盘口在统一检索里与 Polymarket、Manifold 并列。同一对话里 agent 甚至能接真实任务、
  用 x402 付款——检索、执行、付款、结算。路线图：金库做市商对接 Injective 原生订单簿。"

### 2:50–3:00 — 收尾
- 画面：logo + `polymarket.agentrix.top` + GitHub + "Built on Injective"。
- 旁白："Agentrix Predict——让 agent 成为一等的链上金融行为体。现已在 Injective 上线。感谢观看。"

---

## 分镜 / 素材清单
1. 盘口网格（滚球/赛前，赔率）。
2. 对话：盘口检索 → 卡片。
3. 对话：预览 → 授权 mandate → 下单 → 持仓。
4. 金库：AI 做市面板。
5. 统一检索（LSM + 外部）。
6. 架构叠层（5 秒）：对话 → 引擎 → Injective 上的 CollateralVault。

## 屏幕常驻字幕
- "零下载——agent 自动开通"
- "AP2 mandate + 花费上限（链上围栏）"
- "USDC 在 Injective EVM 结算（测试网）"
- "AI 做市——偿付安全"

## 兜底方案（若 USDC 充值/Bedrock 没就绪）
- 下单步骤改用 **AXP 免费玩**（同样流程，无需链上充值），USDC/Injective 托管用架构叠层 +
  `/lsm/wallet` 充值页展示。仍能呈现完整对话闭环。
