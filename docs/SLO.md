# Service Level Objectives (SLO) — v1

This document defines a minimal, explicit set of SLOs for Settld as a finance-grade system-of-record service.

These SLOs are enforced in CI (kind smoke) via a post-run `/metrics` snapshot check (`scripts/slo/check.mjs`).

## SLO-1: API availability (no 5xx during smoke)

**Objective**

- During the Kubernetes smoke lifecycle, the Settld API must not emit HTTP 5xx responses.

**Metric**

- `http_requests_total{status="5xx"}` derived from `http_requests_total{status="<code>"}`

**Threshold**

- `sum(http_requests_total{status=~"5.."}) == 0` for the duration of the smoke run.

**Why**

Any 5xx indicates server-side failure (misconfig, migration issues, DB issues, regressions).

## SLO-2: Delivery rails health (no DLQ / no stuck backlog at end-of-run)

**Objective**

- At the end of the smoke run, there is no delivery DLQ backlog and no stuck delivery backlog.

**Metrics**

- `delivery_dlq_pending_total_gauge`
- `deliveries_pending_gauge{state="pending"}`
- `deliveries_pending_gauge{state="failed"}`

**Thresholds**

- `delivery_dlq_pending_total_gauge == 0`
- `deliveries_pending_gauge{state="pending"} == 0`
- `deliveries_pending_gauge{state="failed"} == 0`

**Why**

DLQ backlog is an on-call page. Pending backlog at end-of-run implies workers are stuck or PG is unhealthy.

## SLO-3: Outbox boundedness (no runaway backlog at end-of-run)

**Objective**

- At the end of the smoke run, total outbox pending work is below a safe bound.

**Metric**

- `outbox_pending_gauge{kind=...}`

**Threshold**

- `sum(outbox_pending_gauge) <= 200` (CI default; configurable)

**Why**

If the outbox is growing without being drained, the system is not steady-state safe.

## SLO-4: Onboarding first-paid-call runtime (host readiness)

**Objective**

- Across supported hosts in the compatibility matrix, first-paid-call runtime remains within a deterministic p95 bound.

**Metric**

- `onboarding_first_paid_call_runtime_ms_p95_gauge` (fallbacks supported by gate script: `first_paid_call_runtime_ms_p95_gauge`, `first_paid_call_latency_ms_p95_gauge`)

**Threshold**

- `p95 <= 2000ms` (default; configurable via `SLO_ONBOARDING_FIRST_PAID_CALL_P95_MAX_MS`)

## SLO-5: Policy decision runtime (latency + errors)

**Objective**

- Policy decision runtime stays fast and low-error on readiness runs.

**Metrics**

- `policy_decision_latency_ms_p95_gauge` (fallbacks supported by gate script)
- policy decision totals and error totals (`policy_decisions_total` + `outcome=error`, with supported fallbacks)

**Thresholds**

- `policy decision p95 <= 250ms` (default; configurable via `SLO_POLICY_DECISION_LATENCY_P95_MAX_MS`)
- `policy decision error rate <= 1%` (default; configurable via `SLO_POLICY_DECISION_ERROR_RATE_MAX_PCT`)

## SLO-6: Host onboarding success rate (clean environment)

**Objective**

- Supported hosts must pass deterministic `settld setup --preflight-only` onboarding checks at or above a configured success rate under isolated HOME paths.

**Metrics**

- `onboarding_host_setup_attempts_total_gauge{host=...}`
- `onboarding_host_setup_success_total_gauge{host=...}`
- `onboarding_host_setup_failure_total_gauge{host=...}`
- `onboarding_host_setup_success_rate_pct_gauge{host=...}`

**Threshold**

- Per-host success rate must be `>= 90%` by default (configurable with `ONBOARDING_HOST_SUCCESS_RATE_MIN_PCT`).

**Why**

Preflight success under clean homes verifies host bootstrap reliability and catches host-specific config drift before production cutover.

## CI enforcement

- Script: `scripts/slo/check.mjs`
- Source of truth: `/metrics` snapshot taken after the smoke lifecycle completes.
- Thresholds are configurable via env (see script header).
- Onboarding/policy readiness gate: `scripts/ci/run-onboarding-policy-slo-gate.mjs`
- Host matrix input: `artifacts/ops/mcp-host-cert-matrix.json`
- Output artifact: `artifacts/gates/onboarding-policy-slo-gate.json`
- Onboarding host success gate: `scripts/ci/run-onboarding-host-success-gate.mjs`
- Output artifact: `artifacts/gates/onboarding-host-success-gate.json`
- Metrics output directory: `artifacts/ops/onboarding-host-success/`
- Deterministic binding: onboarding gates emit `artifactHashScope` + `artifactHash` over canonical report core.
- Gates are fail-closed when required host checks/metrics are missing or thresholds are breached.
- CI wiring:
  - `tests / onboarding_policy_slo_gate` generates matrix + metrics snapshot and runs the onboarding gate.
  - `tests / onboarding_host_success_gate` runs clean-home preflight onboarding checks per supported host and emits host metrics artifacts.
