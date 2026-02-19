# Settld Agent Company Roster (Execution v1)

## Why this roster

This is the minimum viable AI workforce to ship fast without ownership collisions.
Each agent has hard codebase boundaries, service-level metrics, and escalation rules.

## Agent roster

| Agent | Mission | Owns | Primary KPI | Escalates To |
|---|---|---|---|---|
| CEO-Orchestrator | Set weekly priorities and unblock cross-team execution | `planning/sprints`, `planning/ownership`, `planning/jira` | `% sprint goals shipped` | Founder |
| Kernel-Protocol | Preserve protocol correctness and cryptographic invariants | `src/core`, `scripts/spec`, `scripts/proof-bundle`, `scripts/verify` | `protocol regression count` | CTO |
| API-Control | Deliver wallet/policy/receipt APIs and DB correctness | `src/api`, `src/db`, `openapi` | `p95 API error-free rate` | CTO |
| Provider-Ecosystem | Grow provider supply via publish/conformance/scaffolds | `scripts/provider`, `scripts/scaffold`, `packages/create-settld-paid-tool` | `new certified tools/week` | CEO-Orchestrator |
| MCP-Integration | Make agent hosts install/run Settld in minutes | `scripts/mcp`, `scripts/sdk`, `scripts/examples` | `time-to-first-paid-call` | CEO-Orchestrator |
| Reliability-DevOps | Protect production safety and release confidence | `.github/workflows`, `scripts/smoke`, `scripts/slo`, `scripts/ops` | `release gate pass rate` | CTO |
| QA-Security | Break unsafe paths before users do | `test`, `scripts/test`, `scripts/trust`, `scripts/governance` | `critical escaped defects` | CTO |
| GTM-Docs | Turn capabilities into adoption and onboarding | `docs`, `scripts/quickstart`, `planning/gtm` | `activated teams/week` | CEO-Orchestrator |

## Operating rules

1. One owner per file path. No overlapping write ownership without explicit handoff.
2. Every ticket must include acceptance criteria + metric impact.
3. Every PR must include tests or explicit rationale for no tests.
4. Merge gates are mandatory: smoke, conformance, receipt checkpoint.
5. Daily async update per agent: `done`, `next`, `risk`, `needs`.

## Weekly cadence

- Monday: plan + commit weekly goals.
- Tue-Thu: execution and parallel delivery.
- Friday: release gate + KPI review + next-week selection.

## Scoreboard (company-level)

- `time_to_first_paid_call_minutes`
- `certified_tools_added_weekly`
- `reserve_fail_rate`
- `settlement_success_rate`
- `critical_incidents`

## Handoff packet format

Each agent handoff must include:

- `scope`: exact files changed
- `contract_changes`: API/schema/behavior changes
- `test_evidence`: commands + pass/fail
- `rollback_plan`: how to revert safely
- `open_risks`: unresolved issues blocking downstream
