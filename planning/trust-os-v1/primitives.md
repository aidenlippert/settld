# Trust OS v1 Primitive Spec

Status: Draft v1.0 (planning baseline)
Owner: Trust Kernel Team
Last Updated: 2026-02-21

## 1) Objective

Define the minimum complete primitive layer required for Settld to operate as an enforceable, auditable, reversible control plane for autonomous economic action across hosts and payment rails.

This doc is implementation-facing. Each primitive here is expected to map to:

- protocol object(s) in `docs/spec`
- API and worker behavior in runtime services
- deterministic vectors/fixtures/conformance gates

## 2) Global Protocol Contract

These rules apply to all primitives in Trust OS v1.

1. Canonical JSON: RFC 8785 JCS.
2. Hashing: `sha256` lowercase hex over canonical UTF-8 bytes unless object spec states raw-bytes mode.
3. Versioning: `schemaVersion` is required and immutable.
4. Time: RFC3339 UTC (`Z`) only.
5. Idempotency: all mutation-side APIs require explicit `idempotencyKey`.
6. Strictness posture: unknown/invalid/missing critical fields fail closed in strict runtime paths.
7. Cross-object linking: by hash/addressable IDs, not mutable names.
8. Decision semantics: allow/challenge/deny/escalate are closed and stable.
9. Reason code semantics: closed-set stable identifiers (no free-text logic keys).
10. Auditability: every state transition produces an append-only event.

## 3) Core Shared Types

```ts
export type HashRef = {
  alg: "sha256";
  hex: string; // 64-char lowercase hex
};

export type Signature = {
  keyId: string;
  alg: "ed25519";
  sig: string; // base64
};

export type Decision = "ALLOW" | "CHALLENGE" | "DENY" | "ESCALATE";

export type RiskClass = "READ" | "COMPUTE" | "ACTION" | "FINANCIAL";

export type DeterminismClass =
  | "DETERMINISTIC"
  | "BOUNDED_NONDETERMINISTIC"
  | "OPEN_NONDETERMINISTIC";

export type MoneyMinor = {
  currency: string; // ISO-4217, e.g. USD
  amountMinor: string; // decimal string, no float
};
```

## 4) Primitive Catalog (v1 Required)

## 4.1 Identity + Authority

### `DelegationGrant.v1` (existing)

Purpose: Principal -> agent delegated authority envelope.

Required semantics:

- scope constraints (actions/resources)
- spend constraints and validity window
- revocation compatibility
- delegation chain integrity

### `AgentIdentity.v1` / `AgentPassport.v1` (existing)

Purpose: Portable identity anchors and delegation root.

Required semantics:

- stable agent identity binding
- keyset anchors and rotation compatibility
- policy envelope linkage

## 4.2 Execution Authorization

### `ExecutionIntent.v1` (existing)

Purpose: immutable pre-execution target object for request fingerprint, risk profile, policy binding, spend bounds, replay context.

Trust OS runtime must enforce:

- request binding at execute-time against `requestFingerprint`
- nonce + idempotency replay guards
- expiration checks before any side-effecting call

### `PolicyDecision.v1` (new)

Purpose: deterministic outcome receipt emitted by policy runtime.

Required fields:

- `schemaVersion` (`PolicyDecision.v1`)
- `decisionId`, `tenantId`, `intentHash`
- `decision` (`ALLOW|CHALLENGE|DENY|ESCALATE`)
- `reasonCodes[]` (closed set)
- `policyBinding` (`policyId`, `policyVersion`, `policyHash`, optional verifier hash)
- `risk` (`riskClass`, score, determinism class)
- `constraints` (amount/time bounds)
- `createdAt`, `decisionHash`, signatures

Minimum invariant:

- `PolicyDecision.intentHash == ExecutionIntent.intentHash` for same request path

## 4.3 Economic Agreement + Evidence

### `ToolCallAgreement.v1` (existing)

Purpose: economic/contract surface for call terms.

### `ToolCallEvidence.v1` (existing)

Purpose: binds output hash to agreement hash.

Required invariant:

- no settlement action without verifiable agreement/evidence linkage

### `FundingHold.v1` (existing)

Purpose: holdback/challenge window control for pre-finality funds.

## 4.4 Settlement + Finality

### `SettlementDecisionRecord.v2` (existing)

Purpose: replay-critical settlement decision with policy pinning.

### `SettlementReceipt.v1` (existing)

Purpose: finality receipt bound to decision hash.

Required invariants:

- one terminal decision per economic unit
- idempotent retries cannot produce duplicate external outcomes
- journal remains zero-sum

## 4.5 Dispute + Recourse

### `DisputeOpenEnvelope.v1` (existing)

Purpose: signed dispute opening bound to hold/receipt/agreement references.

### `ArbitrationCase.v1` (existing)

Purpose: formal dispute lifecycle state machine.

### `ArbitrationVerdict.v1` (existing)

Purpose: adjudication result linked to case/appeal chain.

Required invariant:

- verdict maps to exactly one deterministic settlement outcome

## 4.6 Human Governance + Emergency Controls

### `OperatorAction.v1` (new)

Purpose: signed HITL decisions for challenge/escalation handling.

Required fields:

- case reference (`challenge|dispute|escalation`)
- action (`APPROVE|REJECT|REQUEST_INFO|OVERRIDE_ALLOW|OVERRIDE_DENY`)
- justification code and actor metadata
- signature + timestamp

### `EmergencyControlEvent.v1` (new)

Purpose: signed emergency containment operations.

Required actions:

- `PAUSE`
- `QUARANTINE`
- `REVOKE_DELEGATION`
- `KILL_SWITCH`
- `RESUME`

Required behavior:

- immediate effect
- immutable append-only audit trace
- scoped and time-bounded where applicable

## 4.7 Verification + Portability

### `EvidenceIndex.v1` (existing)

Purpose: deterministic evidence manifest and hash references.

### `VerificationReport.v1` (existing)

Purpose: machine-ingestible signed verification result and warnings/errors.

Required behavior:

- offline verification parity in CI and release flows
- strict-mode fail closed on critical invariant violations

## 5) Primitive Catalog (v1.1 Next)

### `SubAgentWorkOrder.v1` (new)

Purpose: parent agent delegates bounded paid work to sub-agent.

### `SubAgentCompletionReceipt.v1` (new)

Purpose: sub-agent completion proof bound to work order + parent intent.

### `PolicyProfile.v1` (new)

Purpose: reusable policy/risk/spend templates with stable fingerprints.

### `RailAdapterConformanceResult.v1` (new)

Purpose: deterministic rail adapter pass/fail + coverage artifact for release gates.

### `CounterpartyAttestation.v1` (new)

Purpose: machine-verifiable reliability/compliance facts for vendor/sub-agent selection.

## 6) Invariant Set (Must Enforce)

### 6.1 Authorization/Binding

- `INV-AUTH-001`: No high-risk side effect without valid `DelegationGrant` and unexpired `ExecutionIntent`.
- `INV-AUTH-002`: `PolicyDecision` required for paid/high-risk execution.
- `INV-BIND-001`: execute request hash must equal approved intent request hash.
- `INV-BIND-002`: any post-approval mutation returns deterministic deny code.
- `INV-BIND-003`: replay attempts blocked by nonce/idempotency/expiry.

### 6.2 Settlement/Finance

- `INV-FIN-001`: settlement processing idempotent by `(tenantId, idempotencyKey, externalRef)`.
- `INV-FIN-002`: only one terminal settlement outcome per decision lineage.
- `INV-FIN-003`: double-entry ledger net must equal zero for committed journal.
- `INV-FIN-004`: challenge window constraints enforced before release.

### 6.3 Dispute/Recourse

- `INV-DSP-001`: dispute transitions must match allowed state graph.
- `INV-DSP-002`: verdict-to-outcome mapping is total and single-valued.
- `INV-DSP-003`: appeal lineage must be hash-linked and acyclic.

### 6.4 Operator/Governance

- `INV-OPS-001`: sensitive overrides require signed `OperatorAction`.
- `INV-OPS-002`: emergency controls are signed and immutable.
- `INV-OPS-003`: unauthorized operator actions always denied + audited.

### 6.5 Evidence/Verification

- `INV-EVD-001`: every evidence artifact in index hash-validates.
- `INV-EVD-002`: verification report cryptographically binds to bundle head/manifest.
- `INV-EVD-003`: deterministic fixture replay yields byte-stable expected outputs.

### 6.6 Tenancy/Federation

- `INV-TEN-001`: no cross-tenant mutation without explicit trust artifact.
- `INV-TEN-002`: tenant isolation boundaries enforced for retrieval and settlement operations.

## 7) State Machines (Normative)

## 7.1 Trust Decision Lifecycle

`INTENT_CREATED -> DECISION_EMITTED -> (ALLOW|CHALLENGE|DENY|ESCALATE)`

Rules:

- ALLOW permits bounded execution within constraints.
- CHALLENGE requires operator action before progression.
- DENY is terminal for that intent hash.
- ESCALATE enters operator/governance handling flow.

## 7.2 Dispute Lifecycle

`OPEN -> TRIAGE -> REVIEW -> VERDICT -> (APPEAL_OPEN|CLOSED)`

Rules:

- invalid backward transitions rejected deterministically.
- verdict emits settlement decision transition event.
- appeal can only branch from eligible verdict states.

## 7.3 Emergency Control Lifecycle

`NORMAL -> (PAUSED|QUARANTINED|KILLED) -> RESUMED`

Rules:

- `KILL_SWITCH` may require explicit recovery workflow.
- every transition requires signed control artifact.

## 8) API and Worker Contract Requirements

1. Trust middleware is mandatory for paid/high-risk execution routes.
2. API returns stable error/reason codes; workers preserve idempotent behavior.
3. Async workers cannot bypass policy checks done at request edge.
4. Every state transition emits event envelope suitable for audit replay.
5. Dispute worker and settlement worker share deterministic mapping table.
6. Emergency controls propagate with bounded latency and confirm effective state.

## 9) Determinism and Conformance Requirements

1. Add vectors for every new schema object.
2. Add fixtures for happy + failure + replay + outage paths.
3. Add CI matrix for host x adapter x policy-profile critical paths.
4. Gate release on deterministic parity and offline verify results.
5. Keep strict/non-strict warning behavior stable and documented.

## 10) Open Decisions (Tracked)

1. Canonical reason code namespace split (`POLICY_*`, `RISK_*`, `BUDGET_*`, `OPS_*`).
2. Required quorum model for sensitive operator overrides.
3. Standardized sub-agent liability mapping format for v1.1.
4. Time source hardening strategy for cross-region deterministic expiry checks.

## 11) Exit Criteria for Trust OS v1 Primitive Layer

1. All v1 required primitives have stable schema docs + runtime enforcement.
2. Invariant test suite passes in CI and pre-release gates.
3. Offline verification parity is green for all canonical bundle flows.
4. Dispute/reversal path proven idempotent under retries and outages.
5. Operator/emergency actions are signed, immutable, and auditable.
