# Alerts & Runbook (v1)

This file defines a minimal “pilot-safe” alert pack and the exact first actions to take when something pages.

Settld invariants still apply during incidents:
- never accept an invalid chain
- never duplicate external effects
- never break ledger balance / month-close immutability

## Metrics endpoints

- `GET /metrics` emits Prometheus text.
  - Requires an `ops_read` auth key and `x-proxy-tenant-id` header (recommended: a dedicated key for metrics scraping).
- `GET /healthz` emits a quick JSON status (DB + backlog signals).
- `GET /ops/status` emits a human-oriented status summary (requires `ops_read`).

## High-signal alerts (recommended)

### 1) Delivery DLQ nonzero (customer impact likely)

**Trigger**
- `delivery_dlq_pending_total_gauge > 0` for 5m

**First actions**
- Call `GET /ops/status` and inspect:
  - `backlog.deliveriesFailed`
  - `backlog.deliveryDlqTopDestinations`
- List failed deliveries: `GET /ops/deliveries?state=failed&limit=200`
- If it’s a transient downstream issue, requeue one and confirm it progresses:
  - `POST /ops/deliveries/:id/requeue`
- If a single destination is broken, fix downstream credentials/endpoint first (do not “mass requeue into a black hole”).

### 2) Outbox backlog stuck (system falling behind)

**Trigger**
- `outbox_pending_gauge > 1000` for 10m

**First actions**
- Call `GET /ops/status` and inspect `backlog.outboxByKind` to see which topic is stuck.
- Confirm worker progress in logs:
  - outbox claim/start/end
  - delivery retry/DLQ transitions
- If deliveries are the bottleneck, check Delivery DLQ alert steps above.

### 3) Ledger apply failures (finance correctness risk)

**Trigger**
- `increase(ledger_apply_fail_total[5m]) > 0`

**First actions**
- Treat as “stop-the-world” for finance exports until understood.
- Inspect logs for `ledger.apply.*` around the failure and identify the entry/job IDs.
- Verify DB invariants: ledger entries must net to zero; no double-application.

### 4) Ingest rejects spiking (upstream breaking / hostile input)

**Trigger**
- `increase(ingest_rejected_total[5m]) > 50` (tune per pilot volume)

**First actions**
- Call `GET /ops/status` and inspect `reasons.topIngestRejected`.
- Inspect DLQ: `GET /ops/dlq?type=ingest&limit=200`
- If the rejects are signature/chain/time issues, fix upstream immediately (do not disable validation).

### 5) Retention cleanup stale / failing (unbounded growth risk)

**Trigger**
- `time() - maintenance_last_success_unixtime{kind="retention_cleanup"} > 3600` (tune to your cadence)
  - If you run cleanup every 300s, 3600s implies “missed many runs”.
- `maintenance_last_run_ok_gauge{kind="retention_cleanup"} == 0` for 10m

**First actions**
- Check the latest retention audit record:
  - `GET /ops/status` → `maintenance.retentionCleanup`
  - or `GET /ops/audit?limit=50` and filter for `MAINTENANCE_RETENTION_RUN`
- Run an audited manual cleanup (dry run first):
  - `POST /ops/maintenance/retention/run` with `{ "dryRun": true }`
  - then re-run with `{ "dryRun": false }` if counts look sane
- If cleanup keeps failing, check DB health and recent migrations first (cleanup is intentionally bounded and should not take locks for long).

### 6) Stripe replayable dead-letter backlog (billing drift risk)

**Trigger**
- `GET /ops/finance/billing/providers/stripe/reconcile/report?limit=200` returns:
  - `replayableRejectedCount > 0` for 15m, or
  - rapidly growing `rejectedReasonCounts.reconcile_apply_failed`.

**First actions**
- Snapshot report + candidate dead-letter events:
  - `GET /ops/finance/billing/providers/stripe/reconcile/report?limit=200`
  - `GET /ops/finance/billing/providers/stripe/dead-letter?limit=200`
- Execute dry-run replay, then live replay if dry-run is clean:
  - `POST /ops/finance/billing/providers/stripe/dead-letter/replay`
- Validate post-replay counters and billing plan state.
- Follow `docs/ops/BILLING_WEBHOOK_REPLAY.md` end-to-end and attach snapshots to incident notes.

### 7) Replay mismatches detected (determinism break)

**Trigger**
- `replay_mismatch_gauge > 0` for 5m

**First actions**
- Treat as critical correctness incident.
- Check `/ops/status` and `/ops/tool-calls/replay-evaluate` for affected agreement hashes.
- Freeze rollout/cutover changes and investigate policy/version drift before resuming.

### 8) Disputes over SLA / arbitration over SLA

**Trigger**
- `disputes_over_sla_gauge > 0` for 10m
- `arbitration_over_sla_gauge > 0` for 10m

**First actions**
- Inspect `/ops/status` command center dispute section and case backlog.
- Prioritize oldest open disputes and assign arbiter coverage immediately.
- If backlog is systemic, scale operator staffing/worker capacity before requeueing traffic.

### 9) Stuck holds (economic lock risk)

**Trigger**
- `settlement_holds_over_24h_gauge > 0` for 15m

**First actions**
- Inspect hold status via `/ops/tool-calls/holds`.
- Correlate open disputes and challenge windows for affected agreement hashes.
- If holds are blocked by missing verdicts, escalate arbitration path.

### 10) Worker lag (delivery backlog)

**Trigger**
- `worker_deliveries_pending_total_gauge > 1000` for 10m

**First actions**
- Check `/ops/status` backlog and destination health.
- Verify worker process uptime and claim/retry logs.
- Scale worker replicas or reduce downstream failure rate before reprocessing.

## Prometheus rule examples

These are examples; tune thresholds for your pilot volume and SLOs.

```yaml
groups:
  - name: settld.alerts
    rules:
      - alert: SettldDeliveryDLQNonzero
        expr: delivery_dlq_pending_total_gauge > 0
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "Settld deliveries in DLQ"
          runbook: "docs/ALERTS.md#1-delivery-dlq-nonzero-customer-impact-likely"

      - alert: SettldOutboxBacklogHigh
        expr: outbox_pending_gauge > 1000
        for: 10m
        labels: { severity: page }
        annotations:
          summary: "Settld outbox backlog high"
          runbook: "docs/ALERTS.md#2-outbox-backlog-stuck-system-falling-behind"

      - alert: SettldLedgerApplyFailures
        expr: increase(ledger_apply_fail_total[5m]) > 0
        for: 0m
        labels: { severity: page }
        annotations:
          summary: "Settld ledger apply failures detected"
          runbook: "docs/ALERTS.md#3-ledger-apply-failures-finance-correctness-risk"

      - alert: SettldIngestRejectSpike
        expr: increase(ingest_rejected_total[5m]) > 50
        for: 5m
        labels: { severity: warn }
        annotations:
          summary: "Settld ingest rejects spiking"
          runbook: "docs/ALERTS.md#4-ingest-rejects-spiking-upstream-breaking--hostile-input"

      - alert: SettldMaintenanceStaleRetention
        expr: time() - maintenance_last_success_unixtime{kind="retention_cleanup"} > 3600
        for: 10m
        labels: { severity: warn }
        annotations:
          summary: "Settld retention cleanup not succeeding"
          runbook: "docs/ALERTS.md#5-retention-cleanup-stale--failing-unbounded-growth-risk"

      - alert: SettldReplayMismatchDetected
        expr: replay_mismatch_gauge > 0
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "Replay mismatches detected"
          runbook: "docs/ALERTS.md#7-replay-mismatches-detected-determinism-break"
```

## Notes on cardinality

- `outbox_pending_gauge{kind=...}` is low-cardinality (bounded set of topics).
- `delivery_dlq_pending_by_destination_gauge{destinationId=...}` only exposes the top 10 destinations by DLQ depth to stay alertable without exploding metric series.
