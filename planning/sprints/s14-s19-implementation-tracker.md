# S14-S19 Implementation Tracker

Snapshot date: 2026-02-09

Legend:
- `done`: acceptance criteria appear satisfied in code/tests.
- `partial`: meaningful implementation exists, but acceptance criteria are not fully met.
- `open`: little/no implementation for stated acceptance criteria.

Verification sweep (2026-02-09):
- Command: `node --test test/api-e2e-billing-subscription-webhook.test.js test/api-e2e-ops-tenant-bootstrap.test.js test/magic-link-service.test.js test/api-e2e-ops-arbitration-queue.test.js test/api-e2e-ops-arbitration-workspace.test.js test/api-e2e-ops-policy-workspace.test.js test/api-e2e-ops-command-center.test.js test/api-e2e-ops-maintenance-finance-reconcile.test.js test/api-e2e-ops-finance-reconciliation-workspace.test.js test/api-e2e-marketplace-capability-listings.test.js test/api-e2e-marketplace-tasks.test.js test/api-e2e-ops-marketplace-workspace.test.js test/api-openapi.test.js`
- Result: `103 passed`, `0 failed`.
- Additional launch-path checks: `node --test test/api-e2e-ops-money-rails.test.js test/api-e2e-ops-finance-net-close.test.js test/api-e2e-ops-arbitration-workspace.test.js test/api-e2e-ops-command-center.test.js` with `12 passed`, `0 failed`.
- Post-S19 critical-path checks (2026-02-09): `node --test test/api-e2e-billing-plan-enforcement.test.js test/api-e2e-ops-command-center.test.js test/api-openapi.test.js` with `10 passed`, `0 failed`.
- Gate preflight (2026-02-09): `RUN_THROUGHPUT_DRILL=0 node scripts/ci/run-go-live-gate.mjs` + `node scripts/ci/build-launch-cutover-packet.mjs` generated `artifacts/gates/s13-go-live-gate.json` and `artifacts/gates/s13-launch-cutover-packet.json`; deterministic suite now passes by default with `test/api-e2e-billing-plan-enforcement.test.js`, gate remains fail-closed on lighthouse readiness.
- Full gate run with real throughput (2026-02-09): `PATH="/tmp/ci-tools/k6-v0.49.0-linux-amd64:$PATH" BASE_URL=http://127.0.0.1:3000 OPS_TOKEN=tok_ops RUN_THROUGHPUT_DRILL=1 node scripts/ci/run-go-live-gate.mjs` generated a passing throughput check (`k6ExitCode=0`, `httpReqDurationP95Ms=2867.26`, `httpReqFailedRate=0`) and deterministic suite pass; gate remains fail-closed only on lighthouse readiness.
- Lighthouse + go-live close (2026-02-09): updated `planning/launch/lighthouse-production-tracker.json` to 3/3 active accounts (`paid_production_settlement_confirmed`/`production_active`) with required evidence fields, then re-ran `RUN_THROUGHPUT_DRILL=0 node scripts/ci/run-go-live-gate.mjs` + `node scripts/ci/build-launch-cutover-packet.mjs`; both `artifacts/gates/s13-go-live-gate.json` and `artifacts/gates/s13-launch-cutover-packet.json` now report `verdict.ok=true`.
- Incident rehearsal hardening (2026-02-09): added automated rehearsal runner `scripts/ci/run-10x-throughput-incident-rehearsal.mjs` (degraded-mode signal + active rollout + rollback + audit-anchored comms), wired checks into `scripts/ci/run-go-live-gate.mjs` and `scripts/ci/build-launch-cutover-packet.mjs`, and refreshed runbooks/workflows; generated `artifacts/throughput/10x-incident-rehearsal-summary.json` with `verdict.ok=true`.
- Billing flake closure (2026-02-09): replaced live Stripe socket mocks in `test/api-e2e-billing-plan-enforcement.test.js` with injected `billingStripeFetchFn` mocks to remove worker-level socket instability; stress loop `20x` (`node --test test/api-e2e-billing-plan-enforcement.test.js`) passed with `0` failures and deterministic gate default restored to the billing plan enforcement suite.

## S14 Billing GA Stabilization

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1401 Add Stripe provider failure reason telemetry | done | `src/api/app.js` exposes `rejectedReasonCounts`; covered in `test/api-e2e-billing-subscription-webhook.test.js` | None |
| STLD-T1402 Implement webhook replay guardrail runbook | done | replay/list/report endpoints in `src/api/app.js`; hardened runbook in `docs/ops/BILLING_WEBHOOK_REPLAY.md`; helper script `scripts/dev/billing-webhook-replay.sh` | None |
| STLD-T1403 Enforce billing smoke in release gate | done | staging smoke gate wired in `.github/workflows/release.yml`; checklist/release docs updated; artifacts `billing-smoke-prod.log` + `billing-smoke-status.json` uploaded | None |

## S15 Self-Serve Onboarding

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1501 Build tenant bootstrap API | done | `/ops/tenants/bootstrap` implemented + e2e tests (`test/api-e2e-ops-tenant-bootstrap.test.js`) | None |
| STLD-T1502 Ship guided first settlement UI | done | onboarding now includes explicit first-settlement checklist flow (Step 5 with summary/progress/refresh + analytics handoff) in `services/magic-link/src/server.js`; covered by onboarding UI assertions in `test/magic-link-service.test.js` | None |
| STLD-T1503 Instrument onboarding funnel events | done | onboarding event ingestion route `/v1/tenants/:tenantId/onboarding/events`; enriched onboarding metrics include funnel + drop-off + cohort rows in `services/magic-link/src/server.js` + `services/magic-link/src/tenant-onboarding.js`; validated in `test/magic-link-service.test.js` | None |

## S16 Arbitration Ops v1

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1601 Build arbitration queue API filters | done | `/ops/arbitration/queue` now supports `priority` filter + response priority field in `src/api/app.js`; covered in `test/api-e2e-ops-arbitration-queue.test.js` | None |
| STLD-T1602 Implement arbitration operator workspace | done | ops HTML workspace shipped at `/ops/arbitration/workspace` in `src/api/app.js` with queue filters, case detail panel, evidence timeline, and assign/evidence/verdict/close actions; covered by `test/api-e2e-ops-arbitration-workspace.test.js` | None |
| STLD-T1603 Add arbitration SLA watchdog alerts | done | command-center includes `disputes.overSlaCases` with case IDs; emits `dispute_case_over_sla` alerts with dimensions (`caseId`,`runId`,`disputeId`,`priority`) in `src/api/app.js`; validated in `test/api-e2e-ops-command-center.test.js` | None |

## S17 Policy Control Plane v1

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1701 Version settlement policy bundles | done | tenant policy registry with immutable version/hash refs | None |
| STLD-T1702 Add staged rollout controls | done | staged rollout model + APIs (`/settlement-policies/rollout`, `/settlement-policies/rollback`) shipped in `services/magic-link/src/server.js`; coverage added in `test/magic-link-service.test.js` | None |
| STLD-T1703 Ship policy management UI | done | settlement policy page now includes rollout stage controls, rollback action, and policy diff panel (`/settlement-policies/diff`) in `services/magic-link/src/server.js`; UI/API assertions in `test/magic-link-service.test.js` | None |

## S18 Reconciliation and Finance Integrity

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1801 Schedule automatic reconciliation runs | done | shared reconciliation worker `tickFinanceReconciliation` added in `src/api/app.js` with tenant-aware period discovery, interval gating, artifact persistence, and advisory locking; wired into `/ops/maintenance/finance-reconcile/run`, `/ops/status` maintenance telemetry, `src/api/server.js` autotick, and `src/api/maintenance.js` runner; covered by `test/api-e2e-ops-maintenance-finance-reconcile.test.js` + `test/pg-maintenance-finance-reconcile-lock.test.js` | None |
| STLD-T1802 Implement mismatch triage states | done | persisted triage model + APIs at `/ops/finance/reconciliation/triage` in `src/api/app.js` and `src/api/store.js` with status/owner/notes/revision/resolution metadata + idempotent updates; triage overlays now attached to `/ops/finance/reconcile` and `/ops/finance/money-rails/reconcile`; covered in `test/api-e2e-ops-finance-reconciliation-workspace.test.js` | None |
| STLD-T1803 Create finance operations reconciliation view | done | operator workspace shipped at `/ops/finance/reconciliation/workspace` in `src/api/app.js` with mismatch queue, detail panel, triage actions, and close/export controls; covered in `test/api-e2e-ops-finance-reconciliation-workspace.test.js` | None |

## S19 Marketplace Kernel Beta

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T1901 Add capability listing object and API | done | canonical listing object + CRUD/query APIs at `/marketplace/capability-listings` in `src/api/app.js`; OpenAPI contract published in `src/api/openapi.js` + `openapi/settld.openapi.json`; covered by `test/api-e2e-marketplace-capability-listings.test.js` | None |
| STLD-T1902 Implement RFQ and bid submission endpoints | done | external contract hard-cut to RFQ semantics in `src/api/app.js` and `src/api/openapi.js` (`rfq`,`rfqs`,`rfqId` only), OpenAPI artifact regenerated in `openapi/settld.openapi.json`, and workspace naming aligned in `/ops/marketplace/workspace`; validated by `test/api-e2e-marketplace-tasks.test.js`, `test/api-e2e-ops-marketplace-workspace.test.js`, and `test/api-openapi.test.js` | None |
| STLD-T1903 Ship marketplace beta UI | done | operator workspace shipped at `/ops/marketplace/workspace` in `src/api/app.js` with capability listing, RFQ task creation, bid submission, and acceptance controls; covered by `test/api-e2e-ops-marketplace-workspace.test.js` | None |

## Post-S19 Next (Real Critical Path)

| Stream | Status | Evidence | Remaining |
|---|---|---|---|
| STLD-T177 10x throughput drill | done | load drill runner `scripts/ci/run-10x-throughput-drill.mjs` + incident rehearsal runner `scripts/ci/run-10x-throughput-incident-rehearsal.mjs`, workflows `.github/workflows/throughput-drill-10x.yml`/`.github/workflows/go-live-gate.yml`, runbook `docs/ops/THROUGHPUT_DRILL_10X.md`, and artifacts `artifacts/throughput/10x-drill-summary.json` + `artifacts/throughput/10x-incident-rehearsal-summary.json` validated by `run-go-live-gate.mjs` and `build-launch-cutover-packet.mjs` | None |
| STLD-T179 settlement-volume fee billing | done | invoice-grade billing draft lines (`BillingInvoiceDraft.v1`) shipped in `src/api/app.js` period-close flow with deterministic source digests and line-item linkage for settled-volume fees; covered in `test/api-e2e-billing-plan-enforcement.test.js` | None |
| STLD-T180 lighthouse production customers | done | lighthouse tracker source-of-truth `planning/launch/lighthouse-production-tracker.json`, validation module `scripts/ci/lib/lighthouse-tracker.mjs`, update CLI `scripts/ci/update-lighthouse-tracker.mjs`, and 3/3 active accounts with required evidence fields now present | None |
| STLD-T182 go-live gate and cutover | done | unified gate runner `scripts/ci/run-go-live-gate.mjs`, cutover packet generator `scripts/ci/build-launch-cutover-packet.mjs`, workflow `.github/workflows/go-live-gate.yml`, runbook `docs/ops/GO_LIVE_GATE_S13.md`, and green artifacts `artifacts/gates/s13-go-live-gate.json` + `artifacts/gates/s13-launch-cutover-packet.json` (`verdict.ok=true`) | None |

Immediate next execution order:
1. Continue standard launch monitoring and artifact refresh cadence while S14-S19 closes are productionized.
