# Settld PRD (v1)

## One-line

Settld is the settlement kernel for the autonomous economy — the trust, verification, and financial finality layer that sits between any two agents (or any agent and any business) doing paid work.

## The problem

The autonomous economy is assembling fast:

- **Communication** is solved: A2A (Google/Linux Foundation), MCP (Anthropic), and native function calling let agents discover each other and exchange messages.
- **Payment plumbing** is solved: x402 (Coinbase/Cloudflare), Agentic Wallets, Stripe Connect, and stablecoin rails let agents hold funds, send money, and negotiate price at the HTTP layer.
- **Execution** is solved: agents can call tools, run workflows, write code, generate content, manage infrastructure, and orchestrate sub-agents.

**What is NOT solved: the space between "work happened" and "money should move."**

Today, if Agent A hires Agent B to do something:

- How does A **know** B actually did it correctly?
- How do they **agree** on terms before work starts — deterministically, not via vibes?
- When B finishes, who **decides** the work met the contract? On what evidence?
- If B fails, or partially completes, who decides the **refund** amount? How does it cascade if B had sub-contracted to C?
- How does A build a **reputation** signal about B for next time?
- How does a **human** (or organization) set spending limits, approval gates, and policy boundaries so their agents can't go rogue?

This is the trust gap. Agents can talk. Agents can pay. But nobody provides the **verifiable proof of completion, deterministic settlement logic, compositional dispute resolution, and economic reputation** that makes autonomous commerce trustable at scale.

Settld fills this gap.

## Who it's for

### Primary (ICP v1): AI tool and agent providers
- 1–30 engineers, API-first, shipping paid agent endpoints.
- Pain: "We can execute tool calls, but we can't prove completion and settle trust-minimized with customers."
- Trigger: launching paid AI APIs, increasing refunds/disputes, enterprise buyers demanding verifiable receipts.

### Secondary: Agent-to-agent platforms
- Frameworks and orchestrators building multi-agent workflows (LangGraph, CrewAI, AutoGen, custom).
- Pain: "Our agents hire sub-agents, but we have no economic accountability chain."
- Trigger: moving from demo to production multi-agent systems with real money.

### Tertiary: Businesses delegating to agents
- Enterprises deploying autonomous agents for internal ops, procurement, customer service.
- Pain: "We need audit trails, spending controls, and dispute resolution for agent-initiated transactions."
- Trigger: SOC 2 / compliance requirements for AI-driven financial actions.

### Future: The autonomous economy at large
- Autonomous vehicles, robotic systems, IoT networks, any machine-to-machine economic activity.
- The settlement kernel is domain-agnostic — it works wherever work is delegated and payment is conditional.

## Core promise

**Deterministic economic finality for autonomous work.**

1. **Agreement**: Explicit, machine-readable terms before work starts (price, SLA, evidence requirements, dispute rules, delegation limits).
2. **Proof**: Cryptographically verifiable evidence that work was completed as agreed — hash-chained, signed, tamper-evident, privacy-respecting.
3. **Settlement**: Deterministic decision logic — the same evidence + policy always produces the same payout/refund. No "trust me" totals.
4. **Disputes**: Structured, evidence-based dispute resolution with holdback management, arbitration workflows, and cascading adjustments for multi-party agreements.
5. **Reputation**: Append-only economic track record per agent — completion rates, dispute rates, settlement velocity — queryable by any counterparty.
6. **Governance**: Policy enforcement layer for human principals — spending limits, approval thresholds, delegation depth, allowed counterparties.

## MVP scope (current — shipped)

1. **Agreement creation**: Priced agreements with terms, SLA definitions, and policy constraints.
2. **Evidence submission**: Hash-chained, signed evidence bundles (proof-of-work artifacts).
3. **Verification**: Deterministic bundle verification (strict/compat modes) with stable error/warning codes.
4. **Settlement decisions**: Deterministic policy evaluation → hold/release/refund with signed decision records.
5. **Holdback + disputes**: Signed dispute envelopes, arbitration workspace, holdback adjustments, verdict workflow.
6. **Ledger**: Double-entry settlement with escrow, splits, refunds, and claims.
7. **Reputation**: Append-only reputation events with windowed queries.
8. **Self-serve billing**: Tiered plans (Free/Builder/Growth/Enterprise), Stripe checkout, usage metering, quota enforcement.
9. **Verify Cloud (Magic Link)**: Hosted verification + buyer inbox + approvals + webhooks + PDF/CSV exports.
10. **MCP integration**: Agents can discover and invoke Settld tools via MCP protocol (stdio transport).

## Next horizons

### H1: Agent protocol native (S23–S25)
- Production MCP server + SSE transport.
- A2A-native adapter: agents advertise Settld settlement capabilities via Agent Cards.
- x402 adapter: HTTP 402 payment flows route through Settld for verification before settlement.
- Agent wallet integration: Coinbase Agentic Wallets as a settlement rail.

### H2: Compositional settlement (S26–S30)
- **Multi-hop agreements**: Agent A → B → C → D, with cascading settlement, refund unwinding, and cross-party dispute resolution.
- **Programmable settlement policies**: Turing-complete policy language for custom settlement logic (conditional release, partial completion scoring, time-weighted penalties).
- **Cross-currency settlement**: Multi-currency ledger with FX rate pinning, stablecoin + fiat settlement.
- **Real-time settlement streaming**: WebSocket-based settlement status for live agent orchestration.

### H3: Trust infrastructure (S31–S34)
- **Decentralized verifier network**: Third-party verifiers can run conformance-certified verification independently.
- **Agent economic identity**: Portable, verifiable economic track record across platforms (DID-linked reputation).
- **Governance-as-code**: Organizations publish machine-readable spending/delegation policies; agents enforce them autonomously.
- **Settlement protocol standard**: Submit Settld protocol as open standard (RFC or Linux Foundation project).

## Non-goals

- Being a payment processor (we sit above Stripe, x402, crypto rails — we don't move money, we decide *if* and *how much* money should move).
- Being an agent framework (we integrate with all of them — MCP, A2A, LangChain, etc. — we don't run agents).
- Blockchain dependency (crypto rails are one option, not a requirement — we're rail-agnostic).

## Success metrics

### Near-term (6 months)
- Monthly Verified Settled Value (MVSV): $1M+
- Active tenants: 200+
- Paying customers: 50+
- Time to first settlement (new dev): < 5 minutes
- Dispute resolution time: < 4 hours

### Long-term (18 months)
- MVSV: $100M+
- Agent-to-agent settlements: 1M+/month
- Conformance-passing verifier implementations: 4+ languages
- Protocol adopted by ≥ 2 major agent frameworks as default settlement layer
- Industry standard status (RFC or equivalent)
