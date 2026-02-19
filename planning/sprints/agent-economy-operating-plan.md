# Agent Economy Operating Plan (General, No Timeline)

## Objective

Build Settld into the default economic operating layer for autonomous agents by hardening the kernel, expanding programmable market primitives, and integrating regulated rails without becoming a bespoke integrations shop.

This plan is intentionally sequence-based (not date-based).

## Architectural Thesis

Settld should be a modular **Agent Economic Kernel** with strict protocol contracts:

1. **Identity + Delegation Kernel**
2. **Policy + Risk Control Plane**
3. **Economic Execution Plane** (quote -> auth -> execute -> verify -> receipt -> reversal -> settlement)
4. **Market Coordination Plane** (discovery, negotiation, contracting)
5. **Capital and Trust Plane** (reputation, credit, insurance)
6. **Compliance and Legal Interop Plane**
7. **Physical-World Adapter Plane**

Settld owns planes 1-4 deeply; planes 5-7 are hybrid (core contracts + adapter ecosystem).

## Current State (Repo-backed)

Already present in codebase:

- x402 verify-before-release gateway and API lifecycle (`/x402/gate/*`)
- deterministic receipts and settlement decisions (`SettlementDecisionRecord.v2`, `SettlementReceipt.v1`)
- durable receipt store + query/export + offline verification
- provider publish + conformance + certification + marketplace listings
- request-bound token semantics (strict binding support)
- delegation and cascade unwind/release executors
- batch settlement worker and reliability reporting
- MCP server + paid workload demos (exa/weather/llm)

Implication: kernel-level trust primitives exist; largest remaining gap is generalized autonomous market/control composition.

## Target Invariants (System-wide)

1. Every autonomous action is attributable to a principal-backed delegation chain.
2. Every economically meaningful action is policy-evaluated pre-execution.
3. Every economic transition is represented by immutable receipt/event evidence.
4. Every payout/reversal path is retry-safe and exactly-once by invariant (not by luck).
5. Discovery defaults to certified supply only.
6. Reputation/credit use verified outcomes, never unverifiable claims.
7. Compliance is attached as policy packs and decision traces, not ad-hoc side channels.

## Program Graph (Dependency)

```text
A Identity+Delegation Kernel
  -> B Policy+Risk Compiler/Issuer
    -> C Execution Intent + Contract Plane
      -> D Market Resolver + Negotiation
        -> E Trust Capital (Reputation/Credit/Insurance)
          -> F Compliance+Legal+Physical Adapters
```

Parallelizable side-streams:

- Observability/Audit hardening runs continuously across A-F.
- Conformance suite expansion runs continuously across B-F.

## Program A: Identity + Delegation Kernel

### Outcome

Portable, cryptographically stable identity/delegation model for agents and sub-agents.

### New protocol objects

- `AgentPassport.v1`
- `DelegationGrant.v1`

### Core services

- Delegation graph resolver (lineage, effective permissions, revocation checks)
- Keyset anchor resolver (JWKS + pinned fallback semantics)
- Revocation registry and monotonic revision model

### Required runtime behavior

- Reject execution if delegation chain is missing, expired, revoked, or depth-exceeded.
- Produce deterministic reject codes for each failure class.

### Acceptance gates

- Chain resolution determinism under repeated replay.
- Revocation takes effect immediately for new authorizations.
- Historical receipts remain verifiable post-key rotation.

## Program B: Policy + Risk Compiler / Issuer

### Outcome

Single deterministic source of spend/risk decisioning for all autonomous actions.

### New protocol objects

- `ExecutionIntent.v1`
- `RiskDecision.v1` (future)
- `PolicyPack.v1` (future)

### Core services

- Policy compiler (high-level controls -> executable constraints)
- Risk engine (risk class + max loss + provider/tool priors)
- Authorization issuer (bounded decision token minting)

### Required runtime behavior

- All wallet-bound authorizations require issuer decision binding.
- Decision fingerprints are bound into receipts and export surfaces.

### Acceptance gates

- Same intent + policy input always yields same decision hash.
- Policy deny and risk deny are distinguishable and machine-readable.
- Idempotent authorize replays return byte-equivalent decisions.

## Program C: Execution Intent + Contract Plane

### Outcome

Unified machine contract from intent -> quote -> authorization -> execution -> settlement.

### New protocol objects

- `WorkContract.v1` (future)
- `Quote.v2` (future)
- `OutcomeProof.v1` (future)

### Core services

- Intent normalizer/fingerprinter
- Contract registry (milestones, obligations, side-effect class)
- Multi-party escrow state machine

### Required runtime behavior

- Side-effecting execution requires strict request binding.
- Contract milestone transitions are append-only and receipt-bound.

### Acceptance gates

- No token replay with mutated request body/path in strict mode.
- Milestone settle/reverse operations remain exactly-once under retries.
- Contract dispute path can reconstruct full evidence lineage offline.

## Program D: Market Resolver + Negotiation

### Outcome

Agents can autonomously discover, select, and negotiate with certified providers under policy budget constraints.

### New protocol objects

- `ResolverQuery.v1` (future)
- `NegotiationThread.v1` (future)
- `OfferCommitment.v1` (future)

### Core services

- Resolver API (`intent + constraints + budget + risk -> ranked options`)
- Negotiation engine (offer/counter/accept/abort with deterministic state)
- Certified supply index (provider/tool/contract compatibility)

### Required runtime behavior

- Resolver excludes non-certified tools by default.
- Policy-incompatible options are filtered before ranking.

### Acceptance gates

- Deterministic ranking for same query+state snapshot.
- Negotiation state machine is replay-safe and conflict-detecting.
- Chosen option includes full trust bindings (manifest hash, badge hash, key refs).

## Program E: Trust Capital (Reputation, Credit, Insurance)

### Outcome

Economic expansion from pure payments to risk-priced autonomy using verified outcomes.

### New protocol objects

- `ReputationDelta.v3` (future)
- `CreditDecision.v1` (future)
- `InsuranceClaim.v1` (future)

### Core services

- Outcome-derived reputation graph
- Credit limit underwriter (policy + historical reliability)
- Insurance claims adjudication with signed evidence requirements

### Required runtime behavior

- Reputation only updates from verified receipts/outcome proofs.
- Credit/insurance decisions must reference reproducible evidence snapshots.

### Acceptance gates

- No reputation mutation without linked receipt IDs.
- Credit decisions reproduce from frozen inputs.
- Claims acceptance/denial emits machine-verifiable rationale.

## Program F: Compliance, Legal Interop, Physical Adapters

### Outcome

Jurisdiction-aware, legally accountable execution that can bridge real-world rails.

### New protocol objects

- `ComplianceDecision.v1` (future)
- `JurisdictionProfile.v1` (future)
- `OracleAttestation.v1` (future)

### Core services

- Compliance policy packs (KYC/KYB/sanctions/tax profiles)
- Legal-wrapper binding (principal/legal entity link)
- Oracle quorum adapter (real-world event attestation)
- Physical adapters (payout/procurement/cards/logistics)

### Required runtime behavior

- High-risk actions require compliance decision binding pre-execution.
- Real-world completion claims require oracle attestation references.

### Acceptance gates

- Compliance decisions are explainable and exportable for audit.
- Oracle disagreement paths are deterministic (quorum or fail-closed).
- Adapter failures preserve fund safety and evidence completeness.

## Cross-Cutting Engineering Constraints

1. **Determinism first**: policy, ranking, and settlement transitions must be replay-stable.
2. **Append-only truth**: no destructive edits to receipt/event lineage.
3. **Fail-closed defaults**: missing trust artifacts imply deny, not allow.
4. **No hidden state coupling**: derive read models from event/receipt truth.
5. **Provider portability**: all rail/provider integrations behind adapter contracts.
6. **Certification as control surface**: discovery and autopay trust default to certified supply.

## Rejected Alternatives

1. **Monolithic super-service**
- Rejected: impossible upgrade safety and high blast radius.

2. **Wallet-only product strategy**
- Rejected: commoditized by larger custodial players; weak moat.

3. **Manual integrations as growth strategy**
- Rejected: linear scaling ceiling and support collapse.

## Rollout / Rollback Strategy (General)

- Rollout via additive protocol versions and dual-read compatibility windows.
- Gate new behavior behind explicit policy/config flags and conformance checks.
- Rollback by disabling feature flags and preserving backward-compatible schema readers.
- Never require destructive migrations for core receipt/decision objects.

## Observability Requirements (Before Code)

Each program must define:

- deterministic decision hash distribution,
- reject reason cardinality and drift,
- replay/idempotency collision rates,
- settlement lag + reversal lag,
- evidence completeness ratio,
- certified vs uncertified supply invocation rates.

## Program Exit Condition

Settld becomes the default economic trust layer when autonomous agents can:

1. act under bounded delegated authority,
2. transact with certified providers under policy/risk constraints,
3. settle and reverse safely,
4. prove every step offline,
5. earn expanded limits via verified trust outcomes.
