# Trust OS v1 (Jira-Ready Backlog)

Date: 2026-02-20
Owner: CEO / Product / Platform
Release Name: `Trust OS v1`
Release Objective: Ship a production-grade, rail-agnostic inter-agent trust kernel with deterministic policy enforcement, dispute/reversal handling, auditable receipts, and operator controls.

## Scope Boundaries (v1)

In scope:
- Runtime decisions: `allow`, `challenge`, `deny`, `escalate`.
- Request binding, policy hash pinning, deterministic evidence/receipt export.
- Dispute lifecycle + arbitration verdict + automatic settlement/reversal outcome.
- Operator inbox (approval/escalation controls).
- One hardened rail adapter path.
- Three starter vertical profiles.

Out of scope:
- Policy marketplace and monetization.
- Full open discovery network.
- Building a new wallet rail.

## Program Milestones

- Milestone M1 (Sprint 1): Enforcement core + request binding + receipt schema freeze.
- Milestone M2 (Sprint 2): Dispute/reversal runtime + operator inbox MVP.
- Milestone M3 (Sprint 3): Rail adapter hardening + profile system + release gate.

## Epics

- `STLD-E2401` Policy Runtime Enforcement
- `STLD-E2402` Execution Binding + Evidence + Receipts
- `STLD-E2403` Dispute Court + Reversal Engine
- `STLD-E2404` Operator Inbox + Controls
- `STLD-E2405` Rail Adapter Hardening
- `STLD-E2406` Vertical Policy Profiles
- `STLD-E2407` QA, Conformance, and Release Gates

## Jira Ticket Backlog

### Epic `STLD-E2401` Policy Runtime Enforcement

#### `STLD-T2401`
- Type: Story
- Priority: P0
- Summary: Implement canonical runtime policy decision point (`allow/challenge/deny/escalate`) for all paid action paths.
- Owner: Backend Platform
- Estimate: 5d
- Dependencies: None
- Acceptance Criteria:
  - Every paid action path calls policy runtime before execution.
  - Decision output includes `decision`, `reasonCode`, `policyHash`, `policyVersion`, `decisionId`.
  - Deterministic decision output for same input and policy version.

#### `STLD-T2402`
- Type: Story
- Priority: P0
- Summary: Add stable reason code registry and API surface for denied/challenged/escalated actions.
- Owner: Backend Platform
- Estimate: 3d
- Dependencies: `STLD-T2401`
- Acceptance Criteria:
  - Reason codes are schema-validated and documented.
  - API responses expose reason code and remediation hints.
  - CLI/SDK map reason codes consistently.

#### `STLD-T2403`
- Type: Story
- Priority: P0
- Summary: Enforce policy evaluation at MCP entry points and bridge paths.
- Owner: MCP / Integrations
- Estimate: 3d
- Dependencies: `STLD-T2401`
- Acceptance Criteria:
  - MCP tool calls cannot bypass policy runtime.
  - MCP responses return policy decision metadata.
  - Integration tests cover allowed/challenged/denied flows.

#### `STLD-T2404`
- Type: Task
- Priority: P1
- Summary: Add policy decision metrics and latency SLO instrumentation.
- Owner: DevOps / Observability
- Estimate: 2d
- Dependencies: `STLD-T2401`
- Acceptance Criteria:
  - Metrics emitted: decision count by type/reason, eval latency p50/p95.
  - Dashboard and alert thresholds configured.

### Epic `STLD-E2402` Execution Binding + Evidence + Receipts

#### `STLD-T2410`
- Type: Story
- Priority: P0
- Summary: Enforce request binding between authorization token and canonical request fingerprint.
- Owner: Backend Platform
- Estimate: 4d
- Dependencies: `STLD-T2401`
- Acceptance Criteria:
  - Request mutation/replay attempts fail with deterministic error code.
  - Fingerprint algorithm is stable and versioned.
  - Test vectors added for strict and side-effecting modes.

#### `STLD-T2411`
- Type: Story
- Priority: P0
- Summary: Bind policy hash/version and request hash into settlement decision records.
- Owner: Backend Platform
- Estimate: 2d
- Dependencies: `STLD-T2410`
- Acceptance Criteria:
  - Decision records include policy/version/request binding fields.
  - Offline verifier validates these bindings.

#### `STLD-T2412`
- Type: Story
- Priority: P0
- Summary: Ship `ReceiptBundle.v1` export with deterministic manifest and verification output.
- Owner: Protocol / Backend
- Estimate: 4d
- Dependencies: `STLD-T2411`
- Acceptance Criteria:
  - Receipt bundle includes decision, settlement, and verification artifacts.
  - Bundle verifies offline with strict mode.
  - Repeat export produces identical canonical hashes.

#### `STLD-T2413`
- Type: Task
- Priority: P1
- Summary: Add SDK helpers for receipt retrieval/export across JS and Python.
- Owner: SDK
- Estimate: 3d
- Dependencies: `STLD-T2412`
- Acceptance Criteria:
  - JS and Python SDK expose receipt export APIs.
  - SDK smoke tests cover end-to-end retrieval and verification.

### Epic `STLD-E2403` Dispute Court + Reversal Engine

#### `STLD-T2420`
- Type: Story
- Priority: P0
- Summary: Implement dispute case state machine (`opened`, `evidence_collected`, `under_review`, `verdict_issued`, `closed`).
- Owner: Backend Platform
- Estimate: 4d
- Dependencies: `STLD-T2411`
- Acceptance Criteria:
  - State transitions are deterministic and idempotent.
  - Invalid transitions are blocked with stable error codes.
  - Case timeline is append-only and signed.

#### `STLD-T2421`
- Type: Story
- Priority: P0
- Summary: Implement verdict application pipeline to trigger automatic release/refund/reversal outcomes.
- Owner: Backend Platform
- Estimate: 4d
- Dependencies: `STLD-T2420`
- Acceptance Criteria:
  - Verdict maps to deterministic financial outcome.
  - Reversal entries are balanced and idempotent.
  - Duplicate verdict processing does not double-settle.

#### `STLD-T2422`
- Type: Story
- Priority: P0
- Summary: Add dispute APIs and SDK wrappers for open/attach evidence/issue verdict.
- Owner: API + SDK
- Estimate: 3d
- Dependencies: `STLD-T2420`
- Acceptance Criteria:
  - APIs exposed with authz enforcement.
  - SDK wrappers for JS/Python and MCP tool surface.
  - Contract tests cover happy and failure cases.

#### `STLD-T2423`
- Type: Task
- Priority: P1
- Summary: Add dispute SLA timers and escalation triggers.
- Owner: Backend Platform
- Estimate: 2d
- Dependencies: `STLD-T2420`
- Acceptance Criteria:
  - Time-window breaches emit escalation events.
  - Alerts and dashboards for aging disputes.

### Epic `STLD-E2404` Operator Inbox + Controls

#### `STLD-T2430`
- Type: Story
- Priority: P0
- Summary: Build operator inbox page for challenged/escalated actions with approve/deny actions.
- Owner: Frontend
- Estimate: 5d
- Dependencies: `STLD-T2401`, `STLD-T2422`
- Acceptance Criteria:
  - Operators can view pending items with policy context and evidence refs.
  - Approve/deny writes signed operator action events.
  - Pagination/filtering by tenant and severity.

#### `STLD-T2431`
- Type: Story
- Priority: P0
- Summary: Implement emergency controls: pause agent, quarantine, revoke delegation, kill switch.
- Owner: Backend + Frontend
- Estimate: 4d
- Dependencies: `STLD-T2430`
- Acceptance Criteria:
  - Emergency actions are auditable and idempotent.
  - Paused/quarantined agents cannot execute paid actions.
  - Recovery flow documented and tested.

#### `STLD-T2432`
- Type: Task
- Priority: P1
- Summary: Add operator decision audit export for finance and compliance.
- Owner: Backend
- Estimate: 2d
- Dependencies: `STLD-T2430`
- Acceptance Criteria:
  - Export contains decision metadata, actor, timestamp, reason, linked receipt/case IDs.

### Epic `STLD-E2405` Rail Adapter Hardening

#### `STLD-T2440`
- Type: Story
- Priority: P0
- Summary: Harden one production adapter lane (`x402 + Stripe` or `x402 + AWAL`) under Trust OS enforcement.
- Owner: Integrations
- Estimate: 5d
- Dependencies: `STLD-T2403`, `STLD-T2412`, `STLD-T2421`
- Acceptance Criteria:
  - End-to-end flow uses adapter with Trust OS decisions.
  - Settlement and receipts remain deterministic.
  - Replay and mutation attacks are rejected in adapter path.

#### `STLD-T2441`
- Type: Task
- Priority: P1
- Summary: Add adapter conformance tests and CI gate.
- Owner: QA / Integrations
- Estimate: 2d
- Dependencies: `STLD-T2440`
- Acceptance Criteria:
  - CI fails on adapter regressions.
  - Conformance report artifact uploaded per run.

### Epic `STLD-E2406` Vertical Policy Profiles

#### `STLD-T2450`
- Type: Story
- Priority: P0
- Summary: Implement profile schema and profile hashing/signing contract.
- Owner: Protocol + Backend
- Estimate: 3d
- Dependencies: `STLD-T2401`
- Acceptance Criteria:
  - Profile schema supports limits, allowlists, approval tiers, dispute defaults, compliance toggles.
  - Profile hash is embedded in decisions/receipts.

#### `STLD-T2451`
- Type: Story
- Priority: P0
- Summary: Add CLI commands: `settld profile init`, `validate`, `simulate`.
- Owner: CLI
- Estimate: 4d
- Dependencies: `STLD-T2450`
- Acceptance Criteria:
  - `init` scaffolds profile manifest and rules.
  - `validate` performs schema + semantic checks.
  - `simulate` runs policy against provided scenarios and outputs deterministic results.

#### `STLD-T2452`
- Type: Story
- Priority: P0
- Summary: Ship three starter profiles: `engineering-spend`, `procurement`, `data-api-buyer`.
- Owner: Product + Backend
- Estimate: 3d
- Dependencies: `STLD-T2451`
- Acceptance Criteria:
  - Profiles are packaged and documented.
  - Simulation fixtures pass in CI.

#### `STLD-T2453`
- Type: Task
- Priority: P1
- Summary: Add profile docs and quickstart guides in MkDocs/GitBook.
- Owner: Docs
- Estimate: 2d
- Dependencies: `STLD-T2452`
- Acceptance Criteria:
  - Docs include usage, simulation examples, and troubleshooting.

### Epic `STLD-E2407` QA, Conformance, and Release Gates

#### `STLD-T2460`
- Type: Story
- Priority: P0
- Summary: Add security regression tests for replay, token mutation, bypass attempts, and unauthorized escalation actions.
- Owner: QA / Security
- Estimate: 3d
- Dependencies: `STLD-T2410`, `STLD-T2431`
- Acceptance Criteria:
  - Automated test suite covers top abuse paths.
  - CI blocks release on failures.

#### `STLD-T2461`
- Type: Story
- Priority: P0
- Summary: Add end-to-end deterministic test: challenge -> operator approve -> execute -> receipt -> dispute -> verdict -> reversal.
- Owner: QA
- Estimate: 3d
- Dependencies: `STLD-T2422`, `STLD-T2430`
- Acceptance Criteria:
  - E2E test runs in CI and emits artifact traces.
  - Idempotency and deterministic output asserted.

#### `STLD-T2462`
- Type: Task
- Priority: P0
- Summary: Enforce release gate checklist for Trust OS v1 (conformance, receipts, disputes, adapters, docs).
- Owner: DevOps
- Estimate: 2d
- Dependencies: `STLD-T2460`, `STLD-T2461`, `STLD-T2441`, `STLD-T2453`
- Acceptance Criteria:
  - Release workflow blocks tag publish if any gate fails.
  - Release artifact bundle includes proof of all required checks.

## Sprint Plan (Suggested)

### Sprint 1 (Weeks 1-2)
- `STLD-T2401`, `STLD-T2402`, `STLD-T2403`, `STLD-T2410`, `STLD-T2411`, `STLD-T2460`

### Sprint 2 (Weeks 3-4)
- `STLD-T2412`, `STLD-T2420`, `STLD-T2421`, `STLD-T2422`, `STLD-T2430`, `STLD-T2431`

### Sprint 3 (Weeks 5-6)
- `STLD-T2440`, `STLD-T2441`, `STLD-T2450`, `STLD-T2451`, `STLD-T2452`, `STLD-T2461`, `STLD-T2462`, `STLD-T2453`

## Release Exit Criteria (Trust OS v1)

- Runtime policy enforcement is mandatory for all paid actions.
- Request binding enforcement blocks replay/mutation attempts.
- Receipt bundle export verifies offline in strict mode.
- Dispute->verdict->financial outcome is deterministic and replay-safe.
- Operator emergency controls are audited and tested.
- One rail adapter path is production-hardened and conformance-gated.
- Three vertical profiles are documented and simulation-tested.
