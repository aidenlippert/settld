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

## CI enforcement

- Script: `scripts/slo/check.mjs`
- Source of truth: `/metrics` snapshot taken after the smoke lifecycle completes.
- Thresholds are configurable via env (see script header).

