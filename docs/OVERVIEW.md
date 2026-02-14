# Settld Overview

## What Settld is

Settld is the **settlement kernel for the autonomous economy**. It is the trust, verification, and financial finality layer that sits between any two agents (or any agent and any business) doing paid work.

Concretely, Settld ships as **two products** that share the same truth engine:

1. **Settld Protocol (open)**: A cryptographically verifiable artifact protocol — bundles, manifests, attestations, receipts — that can be verified offline by someone who does not trust the producer.
2. **Settld Cloud (commercial)**: A hosted settlement controller ("Magic Link") that runs the same verifier server-side and turns verifiable artifacts into settlement decisions, buyer approvals, dispute workflows, and automation hooks.

The core design principle: the hosted product must never be "the only judge." Everything it shows should be reproducible offline using the open verifier + explicit trust anchors.

## Why Settld exists

The autonomous economy is assembling across three layers:

| Layer | What exists | Examples |
|-------|------------|----------|
| **Communication** | Agents can discover and talk to each other | A2A (Google/LF), MCP (Anthropic), OpenAI function calling |
| **Payment plumbing** | Agents can hold funds and send money | x402 (Coinbase/Cloudflare), Agentic Wallets, Stripe Connect |
| **Execution** | Agents can do work | LangChain, AutoGen, CrewAI, custom agents, tool APIs |

**What's missing: the trust layer between "work happened" and "money should move."**

- Who **proves** the work was done correctly?
- Who **decides** the payout amount, deterministically?
- What happens when the work **fails** or is **disputed**?
- How do **reputation signals** accumulate?
- How do **humans** maintain control over agent spending?

Settld fills this gap. It is to the autonomous economy what **SSL/HTTPS was to the internet** — the trust layer that makes commerce possible.

## The settlement kernel

The kernel governs the lifecycle of any economic agreement:

```
agreement → hold → evidence → verification → decision → receipt
                                                    ↓
                                              dispute → verdict → adjustment
```

Every step is:
- **Deterministic**: same inputs → same outputs, always.
- **Verifiable**: cryptographically signed, hash-chained, offline-checkable.
- **Auditable**: append-only event log with stable error/warning codes.

## What Settld solves (with examples)

### 1. Proof of completion
> Agent B says it completed the data analysis. Settld requires a signed evidence bundle with deterministic hash-chain integrity. The buyer can verify offline that the work output matches the agreed terms.

### 2. Deterministic settlement
> Agent B's evidence is evaluated against the agreement's SLA definition. The same evidence + same policy always produces the same payout. No "trust me" totals.

### 3. Disputes and refunds
> Agent A disputes Agent B's work quality. A signed dispute envelope opens an arbitration case. Evidence is attached. An arbiter renders a verdict. Holdback is adjusted deterministically.

### 4. Compositional (multi-hop) settlement
> Agent A hires B, B hires C, C hires D. D fails. Refunds cascade back through the chain: D→C→B→A, each with deterministic pro-rata adjustments.

### 5. Reputation
> After 100 settlements, Agent B has an append-only track record: 97% completion rate, 2% dispute rate, median settlement in 3 seconds. Any counterparty can query this.

### 6. Governance
> A company sets policy: "My agents can spend up to $500/transaction, max 3 delegation hops, only counterparties with >90% completion rate." Settld enforces this autonomously.

## Protocol truth sources

When docs disagree, the contract is:

1. `docs/spec/` (human spec)
2. `docs/spec/schemas/` (JSON Schemas)
3. `test/fixtures/` (fixture corpus) + `conformance/v1/` (language-agnostic oracle)
4. The reference verifier implementations (Node + Python), as constrained by conformance

## Bundle kinds implemented

- **Proof bundles**: JobProofBundle.v1, MonthProofBundle.v1
- **Finance pack**: FinancePackBundle.v1
- **Invoice bundle**: InvoiceBundle.v1 (work → terms → metering → claim)
- **ClosePack**: ClosePack.v1 (pre-dispute wedge pack with embedded InvoiceBundle + evaluation surfaces)

## Toolchain CLIs

- `settld-produce`: deterministic bundle production
- `settld-verify`: bundle verification (strict/compat), deterministic JSON output
- `settld-release`: release authenticity verification
- `settld-trust`: bootstrap trust materials

## Settld Cloud (Magic Link)

Hosted settlement controller:

- Bundle zip upload → verification → buyer report (green/red/amber)
- Downloads: bundle, verify output, receipt, PDF summary, audit packet
- Workflow: inbox, approvals/holds (OTP gated), webhooks (signed)
- Tenant management: settings, policies, quotas, usage metering, billing
- Self-serve billing: Free / Builder ($99/mo) / Growth ($599/mo) / Enterprise

## Protocol integrations

| Protocol | Status | How Settld integrates |
|----------|--------|-----------------------|
| **MCP** | ✅ Shipped (stdio) | Settld tools (create agreement, submit evidence, settle, dispute) exposed as MCP tools |
| **A2A** | 🔜 Planned | Settlement capabilities advertised via Agent Cards; agents discover Settld |
| **x402** | 🔜 Planned | HTTP 402 flows route through Settld for verification before on-chain settlement |
| **REST API** | ✅ Shipped | Direct HTTP API for all settlement operations |
| **Webhooks** | ✅ Shipped | Signed webhook delivery for settlement events |

## Quick commands

```sh
# Start the API
PROXY_OPS_TOKEN=tok_ops npm run dev:api

# Full local dev stack
./bin/settld.js dev up

# Run tests
npm test

# Run conformance
./bin/settld.js conformance kernel --ops-token tok_ops

# Start MCP server
npm run mcp:server

# Start Verify Cloud
npm run dev:magic-link
```

## Reading paths

### A) New engineer (2–3 hours)
1. `docs/spec/README.md` → `docs/spec/INVARIANTS.md` → `docs/spec/CANONICAL_JSON.md`
2. `docs/spec/STRICTNESS.md` → `conformance/v1/README.md`
3. `packages/artifact-verify/bin/settld-verify.js` → `packages/artifact-verify/src/invoice-bundle.js`
4. `services/magic-link/README.md`

### B) Agent developer 
1. `docs/QUICKSTART_SDK.md` → `docs/QUICKSTART_SDK_PYTHON.md`
2. `scripts/mcp/settld-mcp-server.mjs`
3. `docs/spec/SettlementKernel.v1.md`
4. `docs/spec/SettlementDecisionRecord.v2.md`

### C) Buyer / finance ops
1. `docs/pilot-kit/buyer-one-pager.md` → `docs/pilot-kit/procurement-one-pager.md`
2. `services/magic-link/README.md`
3. `docs/spec/InvoiceClaim.v1.md` → `docs/spec/PricingMatrix.v1.md`

### D) Security reviewer
1. `docs/spec/CRYPTOGRAPHY.md` → `docs/spec/TRUST_ANCHORS.md`
2. `docs/spec/BundleHeadAttestation.v1.md` → `docs/spec/VerificationReport.v1.md`
3. `docs/THREAT_MODEL.md`
4. `packages/artifact-verify/src/safe-unzip.js` → `test/zip-security.test.js`
