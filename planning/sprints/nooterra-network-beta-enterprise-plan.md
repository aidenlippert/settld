# Nooterra Network Beta: Enterprise Delivery Plan

Date: March 3, 2026  
Scope: get a real, externally usable beta online with deterministic trust guarantees.

## Objective

Run a six-week beta program that graduates Nooterra from internal capability to external production usage with three design partners and a controlled public intake.

## Beta Outcomes (Non-Negotiable)

1. External teams complete signup to first verified paid run in <= 30 minutes (p50).
2. Every paid run has replay-pack, settlement explainability, and immutable evidence links.
3. Beta-critical state is durable in Postgres and survives restart/failover without contract drift.
4. Release promotion is blocked unless all required gates emit passing machine-readable reports.

## Required Planes For Beta

1. Trust kernel plane: policy/runtime/settlement/dispute stay fail-closed and deterministic.
2. Identity and access plane: tenant-safe auth, RBAC, key rotation, and auditability.
3. Builder plane: scaffold, SDK/provider kit, and install path that works from clean environments.
4. Customer onboarding plane: deterministic onboarding state machine to first paid call.
5. Wallet and payment plane: idempotent authorize/verify/reversal with strict spend controls.
6. Intent-integrity plane: strict request binding plus canonical intent hash contracts.
7. Reliability plane: split API/worker/maintenance topology, deep readiness, and synthetic canaries.
8. Operations/support plane: incident response, dispute triage, abuse/fraud containment.
9. Launch/distribution plane: package coherence, design-partner launch packets, promotion gates.

## Workstream Ownership Model

1. Program Core: PM, Staff Engineer, SRE lead, Security lead.
2. Kernel Pod: NB1 + NB5 + NB6 (`STLD-NBT101..605`).
3. Identity/Onboarding Pod: NB2 + NB4 (`STLD-NBT201..405`).
4. DevEx/Ecosystem Pod: NB3 + NB9 (`STLD-NBT301..905`).
5. Ops Control Pod: NB7 + NB8 (`STLD-NBT701..804`).

Each pod owns code, tests, runbook updates, and gate evidence for its ticket set.

## Chunked Shipping Order

## Chunk A (Weeks 1-2): Beta-Safe Foundation

Goal: remove blockers that would make external beta unsafe or unreliable.

Primary tickets:
- `STLD-NBT101` `STLD-NBT102` `STLD-NBT103` `STLD-NBT104` `STLD-NBT105` `STLD-NBT106`
- `STLD-NBT201` `STLD-NBT202` `STLD-NBT203`
- `STLD-NBT401` `STLD-NBT402`
- `STLD-NBT501`
- `STLD-NBT601`
- `STLD-NBT701` `STLD-NBT702` `STLD-NBT703`
- `STLD-NBT301`

Exit criteria:
1. PG parity fixes complete for publication/reconciliation/webhook paths.
2. Query-param ops auth is removed and auth contract tests pass.
3. Onboarding profile is frozen and deterministic step journal is available.
4. Split topology is running with component-level readiness checks.

## Chunk B (Weeks 3-4): External Usability + Integrity

Goal: let external developers and customers complete real economic workflows safely.

Primary tickets:
- `STLD-NBT204`
- `STLD-NBT302` `STLD-NBT303` `STLD-NBT304`
- `STLD-NBT403` `STLD-NBT404`
- `STLD-NBT502` `STLD-NBT503`
- `STLD-NBT602` `STLD-NBT603`
- `STLD-NBT704` `STLD-NBT705`
- `STLD-NBT801` `STLD-NBT802`
- `STLD-NBT901`

Exit criteria:
1. External install matrix is passing (`npm`, `npx`, SDK smoke lanes).
2. First paid call flow is guided, measurable, and remediation-aware.
3. Side-effect routes enforce strict request binding with deterministic rejects.
4. Synthetic canary and rollback drill produce signed evidence artifacts.

## Chunk C (Weeks 5-6): Launch Readiness + Public Beta Cut

Goal: graduate from design-partner reliability to controlled public beta intake.

Primary tickets:
- `STLD-NBT305` `STLD-NBT405`
- `STLD-NBT504` `STLD-NBT505`
- `STLD-NBT604` `STLD-NBT605`
- `STLD-NBT803` `STLD-NBT804`
- `STLD-NBT904` `STLD-NBT902` `STLD-NBT903` `STLD-NBT905`

Exit criteria:
1. Determinism soak + evidence mismatch fail-closed suites are release-blocking and green.
2. Design partners are onboarded via launch packets with support coverage.
3. Beta promotion gate bundle is green and emits no blocking issues.
4. Weekly operating review dashboard is active with owner-level follow-up tracking.

## Critical Path

1. `STLD-NBT101 -> STLD-NBT102` (durability before reconciliation confidence).
2. `STLD-NBT201 -> STLD-NBT401 -> STLD-NBT601 -> STLD-NBT602` (auth and onboarding contract before strict integrity enforcement).
3. `STLD-NBT301 -> STLD-NBT302/STLD-NBT303 -> STLD-NBT304 -> STLD-NBT901` (builder distribution path).
4. `STLD-NBT501 -> STLD-NBT502 -> STLD-NBT503 -> STLD-NBT801` (paid flow to ops triage).
5. `STLD-NBT702/STLD-NBT703 -> STLD-NBT705 -> STLD-NBT802` (reliability posture to incident routing).
6. `STLD-NBT704 + STLD-NBT604 + STLD-NBT304 -> STLD-NBT903` (promotion gate preconditions).

## Metrics And Weekly Operating Rhythm

Weekly command-center review (one doc, one owner per metric):
1. Activation: time-to-first-verified-paid-run (p50/p95), onboarding completion rate.
2. Reliability: canary success rate, queue dead-letter growth, readiness health budget.
3. Integrity: strict binding reject-rate, replay-pack completeness, deterministic drift count.
4. Payments: authorize latency, reversal success, dispute cycle times.
5. Developer adoption: clean install pass rate, first-run SDK pass rate, scaffold success rate.

## Risks and Mitigations

1. Risk: external dependencies fail during first paid run.
- Mitigation: degraded rail mode (`STLD-NBT505`) and synthetic canary alerting (`STLD-NBT704`).

2. Risk: auth and onboarding regressions block activation.
- Mitigation: frozen onboarding profile (`STLD-NBT401`) + contract tests (`STLD-NBT201`).

3. Risk: release confidence drops due to non-deterministic artifacts.
- Mitigation: deterministic soak gate (`STLD-NBT604`) and fail-closed evidence mismatch matrix (`STLD-NBT605`).

4. Risk: public beta load exceeds support bandwidth.
- Mitigation: launch packet discipline (`STLD-NBT902`) and incident severity routing (`STLD-NBT802`).

## Artifact Links

1. Epics: `planning/jira/nooterra-network-beta-epics.csv`
2. Tickets: `planning/jira/nooterra-network-beta-tickets.csv`
3. Release gates: `planning/launch/nooterra-network-beta-release-gates.md`
4. Blueprint: `planning/nooterra-network-beta-blueprint.md`
