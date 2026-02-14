# Settld: What's Actually Built & What Primitives Are Missing (Code-Grounded)

This document is a code-grounded snapshot of what this repository *actually ships* today, and what primitives are still missing to reach compositional (multi-hop) settlement for the autonomous economy.

Scope:
- "Implemented" means there is a concrete protocol object / state machine / toolchain behavior in code and/or an API surface wired to storage.
- Specs live in `docs/spec/` and are backed by conformance in `conformance/v1/`.

## Part 1: What's Actually Implemented (Code-Grounded)

### Protocol Adapters (1 of 3 built)

**MCP server (stdio, JSON-RPC 2.0)**: `scripts/mcp/settld-mcp-server.mjs`

Tools exposed (exact names):
- `settld.create_agreement`
- `settld.submit_evidence`
- `settld.settle_run`
- `settld.resolve_settlement`
- `settld.open_dispute`
- `settld.about`

Notes:
- Transport is stdio; the tool list is returned via `tools/list` (see `scripts/mcp/probe.mjs` and `docs/QUICKSTART_MCP.md`).
- Calls are idempotency-keyed at the API layer; the MCP server also handles `prevChainHash` preconditions for run-event appends.

Not built (planning/docs only today):
- A2A adapter (Agent Cards)
- x402 adapter (HTTP 402 payment negotiation gate)

### Governance (verification signer governance, not spending governance)

Implemented governance primitives are focused on *strict verification signer authorization and key lifecycle*, not principal spending policy:
- `GovernancePolicy.v1` + `GovernancePolicy.v2` (signed) in `src/core/governance-policy.js`
- Revocation / rotation list support referenced by policy v2
- Timestamp proofs used to establish trustworthy signing time in strict verification flows (bundle production + verification)

Related operational governance event validation exists in `src/core/governance.js` (tenant policy updates; server signer key register/rotate/revoke payload validation).

### Reputation (append-only facts)

Reputation is implemented as a hash-addressable append-only fact artifact:
- `ReputationEvent.v1`: `src/core/reputation-event.js`

Important correction:
- The *actual* event kinds are:
  - `decision_approved`
  - `decision_rejected`
  - `holdback_auto_released`
  - `dispute_opened`
  - `verdict_issued`
  - `adjustment_applied`

Roles:
- `payee`, `payer`, `arbiter`, `system`

### Dispute + Arbitration + Adjustment

Dispute open primitive:
- `DisputeOpenEnvelope.v1`: `src/core/dispute-open-envelope.js`

Arbitration artifacts exist (implemented in API + stored, not in `src/core/`):
- `ArbitrationCase.v1`: spec `docs/spec/ArbitrationCase.v1.md`, schema `docs/spec/schemas/ArbitrationCase.v1.schema.json`, stored in `src/api/store.js`, produced/handled in `src/api/app.js`
- `ArbitrationVerdict.v1`: spec `docs/spec/ArbitrationVerdict.v1.md`, schema `docs/spec/schemas/ArbitrationVerdict.v1.schema.json`, produced/handled in `src/api/app.js`

Holdback adjustment primitive:
- `SettlementAdjustment.v1`: `src/core/settlement-adjustment.js`
  - Kinds: `holdback_release`, `holdback_refund`
  - Optional `verdictRef` binding: `{ caseId, verdictHash }`

What is *not* present yet:
- A pluggable "arbiter" plugin system (automated arbiters / external arbiter integrations) as a first-class adapter surface.

### Settlement Kernel (decision -> receipt binding + error-code semantics)

Kernel artifacts:
- `SettlementDecisionRecord.v1` / `SettlementDecisionRecord.v2`: `src/core/settlement-kernel.js`
- `SettlementReceipt.v1`: `src/core/settlement-kernel.js`
- Binding invariants + stable verification error code semantics: `docs/spec/SettlementKernel.v1.md`

Settlement policy evaluation (deterministic):
- `SettlementPolicy.v1` normalization + hash pinning + green/amber/red release-rate logic: `src/core/settlement-policy.js`

Settlement verifier plugins (deterministic):
- Latency threshold plugin + schema-check plugin: `src/core/settlement-verifier.js`

Finality:
- Current finality provider is `internal_ledger` (see `src/core/settlement-kernel.js`).

### Escrow + Holds

Hold primitive:
- `FundingHold.v1`: `src/core/funding-hold.js`

Escrow ledger (wallet + escrow semantics, idempotent operations):
- `src/core/escrow-ledger.js`

### Agent Wallets (internal ledger-backed wallet semantics)

Wallet + run settlement semantics:
- `AgentWallet.v1` and `AgentRunSettlement.v1`: `src/core/agent-wallets.js`

Important correction:
- Dispute escalation levels are:
  - `l1_counterparty`
  - `l2_arbiter`
  - `l3_external`
  (not "auto/internal/external")

### Money Rails (rail-agnostic state machine)

Money-rail operation lifecycle:
- `src/core/money-rail-adapters.js`

Important correction:
- The normalized provider event types and operation states are centered on:
  - `initiated` -> `submitted` -> `confirmed` (or `failed` / `cancelled` / `reversed`)
  (not "authorized/captured" as canonical primitives)

### Event Chain (hash chain + optional signatures)

Append-only chained event envelope (payload hash + chain hash + optional ed25519 signature):
- `src/core/event-chain.js`

### Trust Engine + Verifier Toolchain

Protocol truth sources:
- Specs: `docs/spec/`
- Schemas: `docs/spec/schemas/`
- Fixture corpus + oracle: `conformance/v1/`
- Reference verifier: `packages/artifact-verify/`
- Reference producer: `packages/artifact-produce/`

Key hardening:
- Safe unzip and path safety: `packages/artifact-verify/src/safe-unzip.js`

Bundle types with concrete code paths today:
- `InvoiceBundle.v1`: `src/core/invoice-bundle.js` + `packages/artifact-verify/src/invoice-bundle.js`
- `ClosePack.v1`: `src/core/close-pack-bundle.js` + `packages/artifact-verify/src/close-pack-bundle.js`
- Job/month proof + finance pack bundles: `packages/artifact-verify/src/job-proof-bundle.js`, `packages/artifact-verify/src/finance-pack-bundle.js`

### Tool Provenance

Signed tool manifests:
- `ToolManifest.v1`: `src/core/tool-manifest.js`

### Double-Entry Ledger

Core ledger invariant:
- Pure minimal ledger: `src/core/ledger.js` (sum(postings) must always equal 0)

Posting construction and settlement split logic:
- `src/core/ledger-postings.js`
- `src/core/settlement-splits.js`

## Part 2: Honest Mapping to "Autonomous Economy" Needs

Where the code is already unusually "real":
- Offline-verifiable bundle protocol + strict verification (governance roots, revocation timeline, timestamp proofs) + conformance oracle.
- Deterministic settlement policy evaluation and hash-bound decision -> receipt artifacts.
- Escrow/holdback primitives and deterministic holdback adjustments with verdict binding.
- Event-chain integrity (hash chain + signature verification) for run events.
- Tool provenance (signed tool manifests).

Where the code is real-but-thin:
- Reputation is fact-level; higher-order trust scoring and cross-tenant portability are not first-class products yet.
- Arbitration artifacts exist, but the ecosystem integration surface for arbiters is not yet a pluginized adapter model.

Where it is not built yet:
- Compositional (multi-hop) settlement and refund unwinding across agent graphs.
- A2A and x402 integrations.
- Real-time settlement streaming (SSE/WS).

## Part 3: Missing Primitives (ordered by impact)

### 1) Agreement Delegation Graph (new artifact + invariants)

Current state:
- There is delegation-chain machinery in the API for marketplace acceptance signatures (`delegationChain`), but there is no *parent-child agreement linking* primitive that drives settlement cascade/refund unwind.

Proposed new primitive (one option):
- `AgreementDelegation.v1`:
  - `parentAgreementHash`
  - `childAgreementHash`
  - `delegationDepth`
  - `maxDelegationDepth`
  - `budgetCapCents`
  - `ancestorChain[]`

Required kernel functions:
- `cascadeSettlement()` (bottom-up)
- `cascadeRefund()` (top-down unwind)

### 2) A2A Settlement Agent Card

Ship a `.well-known` Agent Card that advertises SettlementKernel compatibility, supported bundle types, and endpoints.

### 3) x402 Verification Gate

Ship an HTTP middleware/proxy that:
- converts x402 payment negotiation into a Settld agreement/hold,
- gates release on evidence verification + deterministic decision/receipt,
- supports dispute windows / holdback.

### 4) Capability Attestation

Extend tool provenance into capability-level attestation, so counterparties can verify *what an agent can do* in addition to reputation history.

### 5) Streaming Settlement Status

Add a real-time state stream (SSE/WS) for settlements/runs so orchestrators can make live decisions without polling.

### 6) Cross-Agent Escrow Router

Multi-party escrow that natively models agent graphs:
- pooled escrow allocation
- conditional releases per sub-agent
- pro-rata splits
- cascading holds funded from parent escrow

### 7) Settlement Observability Protocol

A structured telemetry export surface for enterprise governance (Prometheus/OpenTelemetry-friendly metrics objects).

## Appendix: Line Counts (for quick sanity checks)

As of this snapshot:
- `src/core/` file count: 107
- Key file LOC (approx): `src/core/agent-wallets.js` 883, `src/core/settlement-kernel.js` 405, `src/core/money-rail-adapters.js` 735, `services/magic-link/src/server.js` ~13k (monolith).

