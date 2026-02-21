# Trust OS v1 Phase Plan

Status: Active planning baseline
Owner: Program Lead (Trust OS)
Last Updated: 2026-02-21

## 1) Program Objective

Deliver Trust OS v1 as the default enforceable control plane for autonomous paid/high-risk actions across hosts and rails.

Program outcomes:

1. Enforceable policy runtime with no bypass paths.
2. Deterministic execution binding and offline-verifiable receipts.
3. Formal dispute/reversal lifecycle with idempotent settlement outcomes.
4. Signed operator controls and emergency containment operations.
5. Adapter hardening + fail-closed production release gates.

## 2) Scope and Non-Scope

In scope:

- Terminal-first onboarding and host integrations.
- Trust-kernel runtime behavior and protocol object integrity.
- Deterministic conformance + release evidence.

Out of scope (for v1):

- Becoming a payment rail provider.
- Full cross-org federation standardization.
- Broad marketplace ecosystem layers beyond foundational primitives.

## 3) Delivery Phases and Milestones

- Phase 1: Production Core (target by 2026-04-30)
- Phase 2: Frictionless Adoption (target by 2026-06-30)
- Phase 3: Platform Expansion (target by 2026-09-30)
- Phase 4: Agentverse Infrastructure (target by 2026-12-31)

## 4) Workstream Tracks

1. Policy Runtime Enforcement
2. Execution Binding + Evidence + Receipts
3. Dispute + Reversal Engine
4. Operator Controls
5. Rail Adapter Hardening
6. Profile-Based Policy UX
7. Production Gates and Release Readiness

## 5) Phase 1 Plan (Production Core)

Goal: close enforcement and reliability gaps; prove fail-closed production readiness.

### 5.1 Deliverables

1. `PolicyDecision.v1` + enforced decision middleware across high-risk routes.
2. End-to-end request fingerprint binding and replay/mutation denial paths.
3. Dispute state machine + verdict -> settlement idempotent mapping.
4. Signed operator action and emergency control APIs.
5. Adapter conformance suite for Circle/x402 lane.
6. Release gates: baseline evidence, throughput/incident rehearsal, cutover guard.

### 5.2 Critical Path

1. PolicyDecision schema/signing -> middleware enforcement -> bypass regression suite.
2. Intent binding -> replay denial -> offline verification parity gate.
3. Adapter conformance -> retry/idempotency harness -> gate rehearsal.
4. Gate packet automation -> release promotion fail-closed guard.

### 5.3 Exit Criteria

1. All critical-path tickets complete and verified in CI.
2. No known bypass path through host/MCP bridge.
3. Deterministic parity for repeated fixture runs.
4. Dispute and reversal flow passes retry/chaos tests without double settlement.
5. Release promotion cannot proceed with failing or missing evidence.

## 6) Phase 2 Plan (Frictionless Adoption)

Goal: reduce onboarding time and policy authoring friction while preserving strict trust guarantees.

### 6.1 Deliverables

1. Profile CLI: `init`, `validate`, `simulate`.
2. Starter policy profile packs with stable fingerprints.
3. Reason-code linked simulation remediation output.
4. One-command host onboarding for Codex/Claude/Cursor/OpenClaw.

### 6.2 Exit Criteria

1. Median first verified receipt under 10 minutes in pilot cohorts.
2. Profile simulation outputs deterministic across environments.
3. Onboarding success >= 80% in guided runs.

## 7) Phase 3 Plan (Platform Expansion)

Goal: scale across multiple adapter lanes and richer enterprise policy operations.

### 7.1 Deliverables

1. Multi-adapter conformance matrix under same trust-kernel contract.
2. Sub-agent paid work-order primitives (`SubAgentWorkOrder.v1`, receipt chaining).
3. Tenant automation and enterprise guardrail controls.
4. Expanded policy packs with simulation templates.

### 7.2 Exit Criteria

1. At least 2 additional adapter lanes passing conformance.
2. End-to-end compositional receipts for parent+sub-agent flows.
3. No contract drift between adapters and kernel.

## 8) Phase 4 Plan (Agentverse Infrastructure)

Goal: interoperability and trust portability across organizations/runtimes.

### 8.1 Deliverables

1. Counterparty attestations and portable trust facts.
2. Cross-org trust federation policy edges.
3. Standardized dispute/attestation exchange surfaces.

### 8.2 Exit Criteria

1. Cross-org delegation proof flow in production pilots.
2. Verifiable dispute artifact portability between organizations.

## 9) Role Ownership Model

- Product/PM: scope, acceptance criteria, prioritization.
- Architecture: primitive contracts, constraints, ADR governance.
- Backend: APIs, workers, state machines, idempotent finance behavior.
- Frontend/Ops UI: operator inbox and emergency workflow surfaces.
- QA: determinism matrix, conformance, chaos/replay tests.
- DevOps/Release: gates, release packet, promotion controls.

## 10) Program Metrics

### 10.1 Reliability

1. Policy decision latency p95 <= 150ms, p99 <= 300ms.
2. Receipt issuance p95 <= 2s after terminal execution event.
3. Replay denial correctness = 100% on conformance vectors.

### 10.2 Trust/Safety

1. Bypass regression failures in CI = 0 tolerated.
2. Double-settlement incidents = 0 tolerated.
3. Unauthorized operator action acceptance = 0 tolerated.

### 10.3 Adoption

1. First verified receipt median time < 10 minutes.
2. Host onboarding completion rate >= 80%.
3. Profile simulation success for starter packs >= 95%.

## 11) Rollout Strategy

1. Shadow mode for policy decisions on selected tenants.
2. Soft enforcement for low-risk classes.
3. Hard enforcement for financial/high-risk classes.
4. Tenant cohort-based rollout by risk tier.
5. Adapter cutover only after conformance and incident rehearsal pass.

## 12) Rollback Strategy

1. Feature flags for each primitive and enforcement boundary.
2. Fallback to challenge-only mode (never unconditional allow for high-risk routes).
3. Freeze new high-risk spend on adapter instability while preserving dispute/reversal flows.
4. Preserve append-only audit/evidence lineage during rollback.

## 13) Risks and Mitigations

1. Contract drift between protocol docs and runtime implementation.
Mitigation: mandatory schema/vectors/fixtures lockstep change policy.

2. Hidden bypass routes in integration adapters.
Mitigation: explicit route inventory + negative-path bypass test gate.

3. Financial duplication under retry storms.
Mitigation: idempotency keying + external reference dedupe + chaos tests.

4. Operator override misuse.
Mitigation: signed actions, RBAC, dual-control, anomaly alerts.

5. Determinism drift across environments.
Mitigation: canonicalization contract enforcement and parity CI gates.

## 14) Dependencies

External:

1. Payment rail sandbox/stability for conformance rehearsals.
2. Host integration APIs for onboarding automation.

Internal:

1. Protocol object readiness and schema lock.
2. CI capacity for heavy gate suites (throughput + incident rehearsal).

## 15) Linear Mapping

Program is tracked in Linear project `Trust OS v1` with milestones:

1. `Phase 1: Production Core (Now)`
2. `Phase 2: Frictionless Adoption (Next)`
3. `Phase 3: Platform Expansion`
4. `Phase 4: Agentverse Infrastructure`

Epics and tickets are already seeded and dependency-linked for critical path execution.
