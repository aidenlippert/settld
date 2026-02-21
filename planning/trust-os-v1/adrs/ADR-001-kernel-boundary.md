# ADR-001: Trust Kernel Boundary and Adapter Contract

- Status: Accepted
- Date: 2026-02-21
- Owners: Architecture, Backend, Security
- Decision Scope: Trust OS v1 runtime and protocol boundary

## Context

Settld must enforce policy, evidence, and settlement guarantees across multiple hosts and payment rails.

If enforcement logic is duplicated in each host integration or rail adapter, behavior drifts and breaks the core promise:

1. enforceability
2. auditability
3. reversibility
4. deterministic cross-surface behavior

The architecture needs a hard boundary that prevents bypass and keeps rails/hosts pluggable.

## Decision

Establish a single **Trust Kernel** boundary as the only authority for:

1. policy decision emission (`ALLOW|CHALLENGE|DENY|ESCALATE`)
2. request/intent binding validation
3. dispute and settlement decision semantics
4. evidence and verification artifact binding
5. operator and emergency control acceptance

All host bridges and rail adapters are **untrusted execution connectors** behind this boundary and must satisfy a strict adapter contract.

## Adapter Contract (Normative)

Adapters must:

1. accept only kernel-authorized execution contexts.
2. preserve immutable hash-bound fields (intent hash, policy hash, idempotency key).
3. return canonical result payloads sufficient for deterministic evidence.
4. expose stable failure classes mapped to deterministic reason/error codes.
5. support idempotent retry semantics with external reference dedupe.

Adapters must not:

1. perform policy overrides.
2. mint settlement finality artifacts independently.
3. mutate authorization envelope fields.
4. bypass emergency control state.

## Rationale

1. Preserves one source of truth for trust-critical logic.
2. Enables rail/host pluggability without contract drift.
3. Makes conformance measurable and gateable in CI.
4. Improves incident containment via centralized emergency controls.
5. Keeps evidence and dispute semantics consistent for audit/compliance.

## Alternatives Considered

## A) Per-adapter policy and settlement logic

Rejected.

- Pros: local optimization per adapter.
- Cons: high drift risk, inconsistent liability semantics, impossible deterministic guarantees across adapters.

## B) Post-hoc audit only (no inline enforcement)

Rejected.

- Pros: lower immediate integration effort.
- Cons: cannot prevent unauthorized actions; trust becomes forensic only.

## C) Host-native trust controls with optional kernel checks

Rejected.

- Pros: faster host-specific path.
- Cons: bypass vectors increase and guarantees become host-dependent.

## Consequences

Positive:

1. Deterministic and portable trust semantics.
2. Clear conformance boundary for adapters.
3. Faster root-cause isolation during incidents.

Tradeoffs:

1. Adapter teams must implement stricter contracts.
2. Slight latency overhead for centralized decision path.
3. Requires stronger versioning discipline for kernel contracts.

## Rollout Plan

1. Define contract tests and conformance suite for current Circle/x402 lane.
2. Run shadow validation in non-blocking mode.
3. Enable hard enforcement for high-risk classes.
4. Block release on adapter conformance and bypass regression failure.

## Rollback Plan

1. Keep feature flags for enforcement boundaries.
2. On severe outage, fallback to challenge-only for high-risk classes (never unconditional allow).
3. Preserve audit/evidence chain and dispute/reversal operations during rollback.

## Observability and SLOs

1. Policy decision latency: p95 <= 150ms.
2. Adapter contract mismatch count: 0 tolerated in production promotion.
3. Replay/mutation denial correctness: 100% on conformance vectors.
4. Duplicate settlement external effects: 0 tolerated.

## Security Considerations

1. Trust kernel keys and operator keys require hardened lifecycle and rotation.
2. Emergency controls must be signed, scoped, and immediately effective.
3. All high-risk paths require explicit route inventory and bypass tests.

## Follow-up ADRs

- ADR-002: Policy reason code namespace and compatibility policy.
- ADR-003: Sub-agent work-order contract and liability inheritance.
- ADR-004: Multi-adapter conformance matrix and release gating thresholds.
