# Settld Architecture (v1)

Settld is the **settlement kernel** for the autonomous economy: a trust, verification, and financial finality layer that sits between any two economic actors (agents, businesses, humans) doing paid work.

## Design philosophy

1. **Rail-agnostic**: Settld decides *if* and *how much* money should move. It does not move money. It integrates with any payment rail (Stripe, x402/stablecoins, Coinbase Agentic Wallets, wire, crypto).
2. **Framework-agnostic**: Settld works with any agent framework (MCP, A2A, LangChain, AutoGen, custom). It integrates at the protocol level, not the SDK level.
3. **Deterministic**: The same evidence + the same policy always produces the same settlement decision. No probabilistic outcomes for money.
4. **Verifiable offline**: Everything Settld produces can be independently verified by someone who does not trust Settld. The hosted product is never "the only judge."
5. **Compositional**: Settlement is a graph problem. Agent A hires B, B hires C. Settlement, refunds, and disputes must cascade correctly through the entire chain.

## The settlement stack

```
┌─────────────────────────────────────────────┐
│           GOVERNANCE LAYER                  │
│  Spending limits · Approval gates ·         │
│  Delegation policy · Allowed counterparties │
├─────────────────────────────────────────────┤
│           APPLICATION LAYER                 │
│  Verify Cloud (Magic Link) · Dashboard ·    │
│  Buyer inbox · Approvals · Webhooks · PDF   │
├─────────────────────────────────────────────┤
│           SETTLEMENT KERNEL                 │
│  Agreement · Evidence · Verification ·      │
│  Settlement decision · Holdback · Dispute · │
│  Arbitration · Adjustment · Receipt         │
├─────────────────────────────────────────────┤
│           TRUST ENGINE                      │
│  Hash-chain · Signatures · Attestations ·   │
│  Conformance · Canonical JSON · Manifests   │
├─────────────────────────────────────────────┤
│           LEDGER                            │
│  Double-entry · Escrow · Splits · Refunds · │
│  Claims · Multi-currency (planned)          │
├─────────────────────────────────────────────┤
│           REPUTATION LAYER                  │
│  Append-only facts · Windowed queries ·     │
│  Trust scores · Completion/dispute rates    │
├─────────────────────────────────────────────┤
│           PROTOCOL ADAPTERS                 │
│  MCP · A2A · x402 · REST API · Webhooks ·  │
│  Agent wallets · Stripe · Custom rails      │
└─────────────────────────────────────────────┘
```

## Core components

### Settlement Kernel

The kernel is the state machine that governs the lifecycle of any economic agreement between autonomous actors:

```
agreement → hold → evidence → verification → decision → receipt
                                                    ↓
                                              dispute → verdict → adjustment
```

- **Agreement**: Machine-readable terms (price, SLA, evidence requirements, dispute rules, delegation limits, holdback %).
- **Hold**: Escrow or pre-authorization on the payment rail.
- **Evidence**: Cryptographically committed proof-of-work artifacts (hash-chained, signed).
- **Verification**: Deterministic evaluation of evidence against agreement terms (strict/compat modes, stable error codes).
- **Decision**: Settlement decision record — deterministic policy evaluation producing hold/release/refund with signed proof.
- **Receipt**: Verifiable settlement receipt that can be independently validated offline.
- **Dispute**: Signed dispute envelope, evidence attachment, arbitration workflow.
- **Verdict**: Arbiter decision with holdback release/refund adjustment.

### Trust Engine

The cryptographic foundation that makes everything verifiable:

- **Hash-chain integrity**: Append-only event log where each event commits to its payload hash and the previous chain hash.
- **Signer policy**: Each event type requires specific signatures (agent, server, arbiter).
- **Bundle protocol**: Manifest → attestation → verification report → receipt chain.
- **Canonical JSON**: Deterministic serialization for cross-language verification parity.
- **Conformance suite**: Portable oracle that any third-party verifier can run to prove spec compliance.

### Ledger

Double-entry system of record for all money movement:

- Every journal entry balances to zero (invariant).
- Escrow holds, settlement splits (platform fee, agent payout, developer royalties, insurance reserve), refunds, claims adjustments.
- Designed for multi-currency extension (FX rate pinning, stablecoin + fiat).

### Reputation Layer

Append-only economic track record per agent/entity:

- `ReputationEvent.v1` facts: completion, failure, dispute, settlement speed, SLA adherence.
- Windowed query API for counterparties to assess trust.
- Feeds into dispatch, pricing, and policy decisions.

### Protocol Adapters

Settld speaks the agent's language:

- **MCP adapter**: Settld tools (create agreement, submit evidence, settle, dispute) exposed as MCP tools via stdio/SSE.
- **A2A adapter** (planned): Settld settlement capabilities advertised via A2A Agent Cards; agents discover and invoke settlement flows.
- **x402 adapter** (planned): HTTP 402 payment flows route through Settld for verification before settlement on-chain.
- **REST API**: Direct HTTP API for non-agent integrations.
- **Webhook relay**: Signed webhook delivery (or record-mode for restricted environments).
- **Payment rails**: Pluggable rail adapters (Stripe, crypto wallets, manual).

## Data & storage

- **Transactional truth**: PostgreSQL (agreements, settlements, entities, ledger, reputation).
- **Evidence**: Object storage (S3/MinIO) for artifact bundles — never inline, always referenced by hash.
- **Queue** (current): Autotick polling loop; planned migration to proper job queue (BullMQ or similar).
- **Cache/locks** (planned): Redis for idempotency, rate limits, settlement locks.
- **Event streaming** (planned): Kafka/NATS for event fan-out to webhooks, analytics, billing.

## Deployment topology (current)

```
┌─────────────────────────────────────┐
│  Settld API (src/api/server.js)     │  Core settlement kernel
├─────────────────────────────────────┤
│  Magic Link (services/magic-link/)  │  Verify Cloud / commercial SaaS
├─────────────────────────────────────┤
│  Receiver (services/receiver/)      │  Async event ingestion
├─────────────────────────────────────┤
│  Finance Sink (services/finance-sink/) │  Financial event processing
├─────────────────────────────────────┤
│  MCP Server (scripts/mcp/)          │  Agent protocol adapter
└─────────────────────────────────────┘
         ↓                ↓
    PostgreSQL          MinIO/S3
```

Ship as a **modular monolith** with strict domain boundaries. Extract services only when scale or team velocity demands it.

## Security posture

- Signed artifacts (bundles) and signed/hash-chained event logs.
- Safe zip ingestion (anti zip-bomb, zip-slip, symlinks, path attacks) — centralized for CLI + hosted.
- Tenant isolation (row-level; RLS planned for S27).
- Device/agent identity via API keys + capability attestation; agent wallet identity planned.
- Principle of least privilege: scoped API keys, rate limits per plan tier, delegation depth limits.
- SOC 2 Type II readiness targeted for S26+ (audit log export, GDPR data subject API, PII redaction).

## Compositional settlement (the hard problem)

The biggest unsolved problem in the autonomous economy is **compositional settlement** — when Agent A hires Agent B who hires Agent C who hires Agent D:

- Agreement terms cascade: each sub-agreement inherits limits from its parent.
- Evidence rolls up: D's proof is part of C's proof is part of B's proof.
- Settlement cascades: D settles with C, C settles with B, B settles with A.
- Failure unwinds: if D fails, refunds cascade back through the chain deterministically.
- Disputes propagate: A disputes B → B may need to dispute C → C may need to dispute D.

This is the "TCP/IP of economic trust" — reliable, ordered, verified delivery of economic obligations across a graph of autonomous actors. Settld's architecture is designed from the ground up to solve this.
