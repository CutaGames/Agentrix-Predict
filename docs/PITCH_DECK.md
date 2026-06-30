# Agentrix Predict — Pitch Deck (Injective Nova)

> 12 slides. Each slide = title + talking points + on-screen visual cue.
> Drop into PowerPoint / Google Slides / Gamma. Keep ~10s per bullet.

---

## Slide 1 — Title
**Agentrix Predict**
Conversational, on-chain prediction markets on **Injective**.
- Subtitle: *Talk to your AI agent → it bets in USDC, within your guardrails.*
- Visual: logo + tagline + `polymarket.agentrix.top` + Injective logo.

## Slide 2 — The problem
- Prediction markets are powerful but **clunky**: pick market → read odds →
  size a bet → manage a wallet → sign txs. High friction, low trust.
- DeFi UX still assumes humans clicking. **Agents** can do this — if they can
  act safely with on-chain money.
- Visual: a cluttered trading UI vs a single chat bubble.

## Slide 3 — Our insight
- The interface should be a **conversation**, and the actor should be **your
  agent** — with **on-chain guardrails** so it can spend without losing trust.
- "NL → retrieve markets → explain odds → bet within a mandate → settle in
  USDC → show positions" — one chat.
- Visual: chat → on-chain arrow.

## Slide 4 — What we built (demo headline)
- **Conversational prediction Copilot**: one sentence → agent calls real tools,
  explains odds/implied probability, places a leveraged order, shows positions.
- Verified in production: the LLM actually invokes `lsm_search_markets` and
  returns live World Cup markets + odds.
- Visual: screenshot of the chat returning market cards.

## Slide 5 — Guardrails (trust)
- USDC orders pass a **double fence**: AP2 **mandate** (max amount / category /
  merchant) + per-account **spending limit**. Authorize "100 USDC/day" in chat.
- AXP free-play needs no fence; USDC (real, on-chain) always does.
- Visual: "authorize 100 USDC/day" card → green check.

## Slide 6 — On-chain on Injective
- Custody, LP vault shares/NAV, **solvency invariant**, relayer-signed
  withdrawals in `CollateralVault` (Injective EVM testnet 1439).
- USDC-only collateral; token-agnostic contract → mainnet = point at native
  Injective USDC. Fast pricing/risk engine off-chain behind a settlement seam.
- Visual: architecture diagram (chat → engine → vault on Injective).

## Slide 7 — AI market-making vault (uniqueness)
- HLP-style vault run by an **AI agent**: reads utilization/NAV → auto-tunes
  underwriting **capacity + odds overround**; expand/de-risk/hold/halt.
- **Solvency-safe by construction**: capacity ≤ free equity; per-leg risk
  re-checked at order time.
- Visual: the live "AI 做市" panel on `/lsm/vaults`.

## Slide 8 — One agent, every surface
- Same agent on **web / mobile / desktop**: shared server-side memory + model.
- Web users get a personal agent with **zero downloads** (platform-hosted
  instance auto-provisioned on first chat). Download = optional power-up
  (Computer Use, local models, device sensors).
- Visual: 3 devices → one brain.

## Slide 9 — Agent economy integration
- LSM markets surface in **unified search** next to Polymarket/Manifold.
- In one chat the agent can also **accept real tasks/airdrops** (RemoteOK,
  Lever, DefiLlama…) and pay via **x402** — retrieve → act → pay → settle.
- Visual: search results mixing a task + a prediction market.

## Slide 10 — Tech & reuse (implementation quality)
- Built on Agentrix's production agent stack: tool registry, two parity-checked
  chat paths, AP2/UCP mandates, x402 settlement, marketplace connectors.
- Solidity + Hardhat (8 invariant tests), NestJS engine, Next.js app. Unit +
  production E2E. Multi-chain (Injective + BSC) from one codebase.
- Visual: component map + "reused, not bolted on".

## Slide 11 — Roadmap
- **Now**: Level-1 live on Injective EVM testnet (this submission).
- **Next**: trust-minimized withdrawals (m-of-n + escape hatch), audit, mainnet
  with native USDC.
- **Phase F (uniqueness)**: vault-as-MM on Injective's **native order book**
  (Exchange module) — AI MM posts/cancels on CLOB.
- Visual: timeline.

## Slide 12 — Ask / close
- Live now: **polymarket.agentrix.top**. Open source + demo linked.
- Vision: **agents as first-class on-chain financial actors** — Agentrix Predict
  is the proof on Injective.
- Visual: logo + links + "Thank you".

---

### Appendix (optional slides)
- A1 — Contract addresses (testnet) table.
- A2 — Security: solvency invariant, double fence, relayer signing, testnet-only.
- A3 — Metrics/architecture deep-dive.
