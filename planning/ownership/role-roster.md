# Settld Role Roster and Headcount Plan

## Operating model

- Sprint cadence: 2 weeks.
- Cross-functional planning horizon: 12 sprints.
- Goal: ship Release 1 by end of Sprint 4, then scale revenue and platform depth.

## Recommended startup team size

### Phase A (S1-S4, Release 1): 14-18 people

- Founders/exec: 2-3
- Product management: 1
- Tech lead/architecture: 1
- Backend/platform engineers: 4-5
- Frontend engineer: 1-2
- SDK/DevEx engineer: 1
- QA/verification engineer: 1-2
- DevOps/SRE engineer: 1
- GTM (founder-led + operator): 2

### Phase B (S5-S8, Post-release conversion): 20-26 people

- Add: 2 backend, 1 frontend, 1 QA, 1 solutions engineer, 1 demand-gen role, 1 customer success role.

### Phase C (S9-S12, scale): 28-36 people

- Add: reliability specialist, partner engineer, enterprise AE(s), compliance/security specialist.

## Capability requirements by function

- PM: pricing, packaging, release scope control, pilot scorecards.
- Tech Lead: architecture decisions, migration paths, rollback safety.
- Backend: deterministic APIs, workers, ledger/escrow, reconciliation.
- Frontend: policy/delegation control plane and finance ops UX.
- SDK/DevEx: first-run success, docs, integration kits, onboarding telemetry.
- QA: replay determinism, conformance, release gate ownership.
- DevOps: CI gates, SLOs, rollout safety, incident operations.
- GTM: ICP targeting, outbound motion, pilot-to-contract conversion.

## Core sub-agent mapping

- Orchestrator: `$ai-workforce-orchestrator`
- PM: `$ai-pm-sprint-planner`
- Tech Lead: `$ai-tech-lead-architect`
- Backend: `$ai-backend-implementer`
- Frontend: `$ai-frontend-workflow-builder`
- QA: `$ai-qa-verification-engineer`
- DevOps: `$ai-devops-release-operator`
- GTM: `$ai-gtm-pilot-operator` + `marketing-psychology`

## Collaboration order

1. Orchestrator + PM + Tech Lead lock sprint outcomes and dependencies.
2. Backend + Frontend + SDK/DevEx ship contract-safe increments.
3. QA + DevOps run deterministic and reliability release gates.
4. GTM executes pilot onboarding and conversion plans.
5. Revenue and adoption metrics feed next sprint prioritization.

## Role-specific ownership in Release 1

- Critical path owners:
- Money rails/reconciliation: Backend + DevOps.
- Escrow/netting: Backend + QA.
- Arbitration: Backend + QA.
- Policy/delegation control plane: Frontend + Backend.
- SDK adoption and onboarding: SDK/DevEx + PM.
- Pilot conversion and monetization: GTM + PM.

## AI agent operating roster (v1)

Primary execution roster is defined in `planning/ownership/agent-roster.md`.
Prompt templates for each role live under `planning/ownership/prompts/`.

Current execution order:

1. Kernel-Protocol + API-Control (correctness and contracts)
2. Provider-Ecosystem + MCP-Integration (supply and activation)
3. Reliability-DevOps + QA-Security (release confidence)
4. GTM-Docs + CEO-Orchestrator (adoption and weekly prioritization)
