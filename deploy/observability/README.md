# Settld Observability Pack

This folder contains a minimal “pilot-safe” pack:

- Prometheus rules for the most important invariants/backlogs
- A small Grafana dashboard JSON you can import and customize

## Scraping

Settld exposes:

- `GET /metrics` (Prometheus text)
- `GET /healthz` (readiness with signals)
- `GET /health` (liveness)

In Kubernetes, point your scraper at the API service (default chart name: `*-api`) on port `3000` and path `/metrics`.

## Rules

`prometheus-rules.yml` assumes you scrape the API process (not the maintenance runner).

Key signals used:

- `outbox_pending_gauge{kind=...}`
- `deliveries_pending_gauge{state="pending"|"failed"}`
- `delivery_dlq_pending_total_gauge`
- `ingest_rejected_gauge`
- `maintenance_last_success_unixtime{kind="retention_cleanup"}`

## Grafana

Import `grafana-dashboard.json` as a starting point. It uses the same metric names as the rules.

