# Demo Video Script — Agentrix Predict (Injective Nova)

**Target length: ≤ 3:00.** Screen recording of `https://polymarket.agentrix.top`
+ brief architecture overlay. Narration in EN (or ZH); keep it tight.

Pre-record setup (so the live bits don't stall):
- A logged-in test account that **already has USDC balance** (deposit done
  beforehand) so the place step is instant. (Funding: deployer wallet → vault
  deposit → submit txHash, or use AXP free-play if USDC funding isn't ready.)
- Bedrock quota healthy (avoid 429 mid-demo); consider a BYO key for the demo
  account for snappy responses.
- Have `/lsm/vaults` open in a second tab to show the AI market-making panel.

---

### 0:00–0:20 — Hook
- Visual: landing on `polymarket.agentrix.top/lsm`, World Cup markets grid.
- VO: "Prediction markets are powerful but clunky. What if you could just…
  talk to your agent — and it bets on-chain, safely, for you? This is Agentrix
  Predict, on Injective."

### 0:20–0:35 — Zero-download agent
- Visual: click the floating pet bubble → chat opens; (mention) wallet login,
  no app install.
- VO: "Connect a wallet and you instantly get a personal AI agent — no download.
  Same agent, same memory across web, mobile and desktop."

### 0:35–1:15 — Conversational Copilot (headline)
- Type: "有哪些即将开赛的世界杯盘口？解释第一个的赔率。"
- Visual: agent calls `lsm_search_markets`, renders **market cards** with odds +
  implied probability; explains the first market.
- VO: "It calls real tools — searches live markets, explains decimal odds and
  implied probability — and shows structured cards, not just text."

### 1:15–1:55 — Guardrailed USDC order (trust + Injective)
- Type: "用 10 USDC、2 倍杠杆押主队。"
- Visual: preview card (notional / max profit / max loss). First time → agent
  asks to authorize: "授权每日 100 USDC 自动下注" → confirm (AP2 mandate created).
- Then: order places; **position card** appears. Briefly show the USDC settles
  on Injective EVM (vault address / testnet tag).
- VO: "USDC orders pass a spending fence — an on-chain mandate plus a daily
  limit. Authorize once, then the agent can act within your rules. Funds are
  custodied and settled in USDC on Injective."

### 1:55–2:25 — AI market-making vault (uniqueness)
- Visual: switch to `/lsm/vaults` → **AI 做市 / Market-Making** panel: per-vault
  utilization, suggested capacity, odds overround, reasoning, refreshing.
- VO: "The house side is run by an AI market-maker. It reads each vault's
  utilization and auto-tunes underwriting capacity and odds spread — always
  capped to free equity, so it can never break solvency."

### 2:25–2:50 — Agent economy + Injective angle
- Visual: search showing LSM markets next to external sources; quick mention of
  task + x402 in one chat.
- VO: "Markets surface in unified search beside Polymarket and Manifold. In one
  conversation the agent can even accept real tasks and pay via x402 — retrieve,
  act, pay, settle. Our roadmap: vault-as-market-maker on Injective's native
  order book."

### 2:50–3:00 — Close
- Visual: logo + `polymarket.agentrix.top` + GitHub + "Built on Injective".
- VO: "Agentrix Predict — agents as first-class on-chain financial actors.
  Live now on Injective. Thanks for watching."

---

## Shot list / b-roll
1. Markets grid (live/upcoming, odds).
2. Chat: market search → cards.
3. Chat: preview → authorize mandate → place → position.
4. Vaults: AI market-making panel.
5. Unified search (LSM + external).
6. Architecture overlay (5s): chat → engine → CollateralVault on Injective.

## Captions to keep on screen
- "No download — agent auto-provisioned"
- "AP2 mandate + spending limit (on-chain guardrails)"
- "USDC settled on Injective EVM (testnet)"
- "AI market-maker — solvency-safe"

## Fallback (if USDC funding/Bedrock not ready)
- Use **AXP free-play** for the place step (same flow, no on-chain funding), and
  keep the USDC/Injective custody as an architecture overlay + the live
  `/lsm/wallet` deposit screen. Still shows the full conversational loop.
