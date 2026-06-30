# Agentrix Predict — Conversational On-Chain Prediction Markets on Injective

> **Injective Nova submission.** Talk to your AI agent in plain language; it
> searches live sports prediction markets, explains the odds, places leveraged
> orders **within your spending guardrails**, and settles in **USDC on Injective
> EVM** — all inside one chat. Plus an **AI market-making vault** (HLP-style) that
> auto-tunes underwriting by utilization.

🌐 Live (testnet): **https://polymarket.agentrix.top**
🎬 Demo video: _<link>_  ·  📊 Pitch deck: `PITCH_DECK.md`

---

## What it is

Agentrix Predict turns a leveraged sports prediction market into an **AI-agent-native,
on-chain stablecoin** product:

- **Conversational prediction Copilot** — natural language → the agent calls real
  tools (`lsm_search_markets` / `lsm_preview_order` / `lsm_place_order` /
  `lsm_my_positions` / `lsm_cashout`), explains decimal odds + implied
  probability, and renders structured cards.
- **Guardrailed autonomous orders** — USDC orders pass an **AP2 mandate +
  per-account spending-limit** double fence before the agent can place them.
  Authorize "up to N USDC/day" right in the chat.
- **USDC on Injective EVM** — custody, vault shares/NAV, solvency invariant and
  relayer-signed withdrawals live in an on-chain `CollateralVault`; the fast
  pricing/risk engine stays off-chain behind a deterministic settlement seam.
- **AI market-making vault (HLP范式)** — an agent reads each vault's
  utilization/NAV and auto-tunes underwriting **capacity + odds overround**,
  always capped to free equity (solvency-safe).
- **One agent across web / mobile / desktop** — shared server-side memory and
  model selection; a web user gets a personal agent **with zero downloads**
  (a platform-hosted instance is auto-provisioned on first chat).
- **Marketplace aggregation** — LSM markets are discoverable alongside external
  prediction sources (Polymarket/Manifold) in unified search; agents can also
  accept real tasks/airdrops and pay via **x402** in the same conversation.

## Why Injective

- USDC as the sole collateral/settlement asset; sub-second finality, low fees,
  maker-friendly economics fit an on-chain "house vs leveraged user" model.
- Token-agnostic `CollateralVault` → mainnet only needs to point at native
  Injective USDC. Forward path (Phase F): vault-as-MM on Injective's native
  order book (Exchange module) — see `../lsm-vault-as-mm-injective.md`.

## Architecture (high level)

```
Web / Mobile / Desktop chat
   │  unified SSE
   ▼
/openclaw/proxy/stream  ──(delegates)── /claude/chat       [two paths kept in parity]
   │  auto-provisions a platform-hosted agent (no download)
   ▼
Tool Registry ── lsm_* prediction tools ──► LSM engine (/lsm/*)
   │   place fence: AP2 mandate + spendingLimits (SettlementCore)
   ▼
StablecoinAssetAdapter (USDC) ─► SettlementGateway ─► CollateralVault (Injective EVM 1439)
AI market-making: lsm-mm-agent ─► underwriting capacity/overround (solvency-safe)
Aggregation: ConnectorRegistry(+lsm) ─► unified /ard/search ; x402 settlement
```

Full design: [`../../.kiro/specs/lsm-onchain-stablecoin-platform/`](../../.kiro/specs/lsm-onchain-stablecoin-platform/)
(requirements / design / tasks) and [`../lsm-nova-hackathon-proposal.md`](../lsm-nova-hackathon-proposal.md).

## On-chain deployments (testnet)

| Chain | Contract | Address |
|---|---|---|
| Injective EVM testnet (1439) | MockUSDC (6dec) | `0x9fcF02d8f706BAbc690a860F89b93b9801c8F28D` |
| Injective EVM testnet (1439) | CollateralVault | `0x760ee31334EA03c2e47900eb3c419C232b4375C0` |
| BSC testnet (97) | MockUSDC | `0x7103995D9f0B87c16964ed34Fe29AdDff8cCd5a0` |
| BSC testnet (97) | CollateralVault | `0x75b7CaE3ec28b2F5aA0dD275E83Ac96Cd60cfa93` |

> Testnet assets have no real value. Not investment advice.

## Repository layout (public curation)

```
contracts/         Solidity (CollateralVault, MockUSDC) + Hardhat tests & deploy
backend/           NestJS — leverage-sports-market engine, chat tools, MM agent,
                   onchain oracle/relayer, settlement gateway
frontend/          Next.js — polymarket.agentrix.top (/lsm) + unified agent chat
docs/              architecture, design spec, pitch deck, demo script
```
(See `PUBLIC_REPO_PLAN.md` for exactly which paths are published and how secrets
are kept out.)

## Quickstart

```bash
# Contracts
cd contracts && npm i && npx hardhat test
npx hardhat run scripts/deploy-lsm-vault.ts --network injectiveEvmTestnet

# Backend (NestJS)
cd backend && npm i
cp .env.example .env   # set DB + AWS Bedrock (or BYO LLM) + LSM_* flags
npm run start:dev

# Frontend (Next.js)
cd frontend && npm i
NEXT_PUBLIC_UNIFIED_CHAT=1 npm run dev
```

Key feature flags: `LSM_ASSET_MODE=both`, `LSM_CHAT_TOOLS_ENABLED=1`,
`LSM_PREDICTION_CONNECTOR_ENABLED=1`, `LSM_MM_AGENT_ENABLED=1`,
`NEXT_PUBLIC_UNIFIED_CHAT=1`.

## Status

Level-1 on Injective EVM testnet is live end-to-end: contracts deployed, dual
asset (AXP free-play + USDC on-chain), independent web app, conversational
Copilot (verified invoking `lsm_search_markets` against production), spending
fence, AI market-making observability, multi-chain (Injective + BSC).

## License

MIT (intended for the public submission repo).
