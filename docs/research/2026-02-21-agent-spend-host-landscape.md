# Agent Spend Host Landscape (2026-02-21)

## Why this matters
To get Settld adopted, we need to integrate where autonomous spend is already happening and where users already run agents day-to-day.

## What users are running today

### 1) Coding-agent hosts with MCP support are the default surface
- Codex exposes MCP server setup in CLI (`codex mcp add ...`) and shared config between CLI + IDE extension.
- Claude Code has first-class MCP server management (`claude mcp add`, `list`, `get`) and scope controls.
- Cursor supports MCP in editor + CLI (`cursor-agent mcp ...`) with stdio/SSE/HTTP transports.

Implication for Settld:
- MCP-first distribution is correct.
- Setup must be one command, host-aware, and idempotent.

### 2) Wallet/payment rails are accelerating and commoditizing
- Coinbase Agentic Wallet positions CLI/MCP wallet operations with built-in limits and x402 support.
- Stripe + OpenAI announced Instant Checkout and ACP in ChatGPT (US rollout, Sept 29, 2025).
- x402 continues to position HTTP-native pay-per-use flows as core agent payment rail.

Implication for Settld:
- We should not position as "just another wallet".
- Differentiate with policy runtime, deterministic enforcement, dispute/evidence lifecycle, and cross-host operational safety.

### 3) OpenClaw ecosystem is active but noisier/higher risk
- OpenClaw docs confirm skills-based extension model and local skill install paths.
- Community skill/marketplaces and wallet wrappers are growing quickly.
- Security incidents around malicious skills have been reported in ecosystem media.

Implication for Settld:
- Keep OpenClaw as a target host, but treat it as higher-risk environment.
- Emphasize signed policy packs, deterministic receipts, and strict tool/policy constraints.

## Build priorities derived from this landscape
1. Make `settld setup` fully host-native for Codex/Claude/Cursor/OpenClaw.
2. Make policy deployment one step from onboarding (starter profile apply + dry-run + live).
3. Keep MCP smoke validation built in so users know setup is real immediately.
4. Publish security posture for skill-hosted environments (verification, guardrails, audit proofs).
5. Avoid wallet-only framing; focus on trust/runtime layer for any wallet/payment rail.

## Confidence notes
- Official docs/newsroom items are high confidence.
- Community ecosystem pages indicate direction, but quality varies; use for signal, not sole source of truth.

## Sources
- OpenAI Docs MCP: https://platform.openai.com/docs/docs-mcp
- Anthropic Claude Code MCP: https://docs.anthropic.com/en/docs/claude-code/mcp
- Cursor MCP docs: https://docs.cursor.com/advanced/model-context-protocol
- Cursor CLI MCP docs: https://docs.cursor.com/cli/mcp
- Coinbase Agentic Wallet docs: https://docs.cdp.coinbase.com/agentic-wallet/welcome
- Stripe newsroom (OpenAI Instant Checkout + ACP): https://stripe.com/us/newsroom/news/stripe-openai-instant-checkout
- x402 docs: https://docs.x402.org/
- x402 site: https://www.x402.org/
- OpenClaw skills docs: https://docs.openclaw.ai/skills
- OpenClaw community directory example: https://www.ruleofclaw.ai/
- OpenClaw ecosystem incident coverage (secondary source): https://www.tomshardware.com/tech-industry/cyber-security/malicious-moltbot-skill-targets-crypto-users-on-clawhub
