# Sprint S23-S32 Readiness Plan

Snapshot date: 2026-02-13

This file is the execution bridge from current P0 completion into the next major sprint band.

## Current state (repo-backed)

- Hosted baseline evidence passes for API health, scheduler presence, metrics presence, and billing catalog alignment on `api.settld.work`.
- Real-money Stripe paths are implemented and tested in `test/api-e2e-ops-money-rails.test.js`.
- Release/CI now includes deploy safety smoke and secret hygiene checks.
- Remaining hard gate before closing P0 operations evidence: run hosted-baseline backup/restore with real DB URLs and archive signed artifacts.

## Readiness definition for S23 start

S23 starts only when all items below are true:

- `artifacts/ops/hosted-baseline-staging.json` is `status=pass` with `runBackupRestore=true`.
- `artifacts/ops/hosted-baseline-prod.json` is `status=pass` with `runBackupRestore=true`.
- Chargeback evidence packet is generated and signed for at least one real tenant.
- Design-partner packet is generated from repeated runs without manual DB edits.

## Sprint map

| Sprint | Primary objective | Exit gate |
|---|---|---|
| S23 | Close P0 operations evidence + production hygiene | Hosted baseline staging/prod signed artifacts archived; backup/restore drill evidence attached |
| S24 | Money-rail production reconciliation hardening | Zero unresolved critical reconciliation mismatches for 7 consecutive days |
| S25 | Dispute/arbitration SLA closure | `disputes_over_sla_gauge` and `arbitration_over_sla_gauge` remain 0 for 7 days |
| S26 | Ledger close and finance packet reliability | Month-close + finance pack generation is deterministic across repeated runs |
| S27 | Hosted self-serve onboarding hardening | New tenant reaches first verified run in under 10 minutes on hosted infra |
| S28 | Live dashboard cutover from fixtures | Dashboard uses live APIs for status/finance/disputes in hosted env |
| S29 | Design-partner expansion (real-money) | Two design partners complete repeated real-money flows and reconciliation |
| S30 | Evidence-led enterprise controls | Signed run packets + verification exports bundled for procurement/security review |
| S31 | Throughput + resilience gates | Throughput drill + incident rehearsal pass under production-like traffic |
| S32 | Launch-readiness consolidation | Go-live packet refreshed with all gates green and rollback drill evidence |

## Immediate next 7-day backlog (critical path)

| ID | Item | Owner | Acceptance |
|---|---|---|---|
| STLD-S23-01 | Run staged backup/restore hosted-baseline with real DB URL secrets | DevOps | `hosted-baseline-staging.json` status is `pass` with `backupRestore.ok=true` |
| STLD-S23-02 | Run production backup/restore hosted-baseline with real DB URL secrets | DevOps | `hosted-baseline-prod.json` status is `pass` with `backupRestore.ok=true` |
| STLD-S23-03 | Drain outbox backlog and verify steady-state | Backend + Ops | `worker_outbox_pending_total_gauge` remains near zero after replay window |
| STLD-S23-04 | Triage replay/dispute/arbitration SLA gauges with explicit issue links | Backend + QA | Root-cause tickets created with owners and due dates |
| STLD-S23-05 | Generate and sign chargeback and design-partner evidence packets | PM + Ops | Artifacts committed/archived and linked from release checklist |

## Execution commands

Staging/prod hosted baseline with inline backup/restore:

```bash
npm run ops:hosted-baseline:evidence -- \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --ops-token "$SETTLD_STAGING_OPS_TOKEN" \
  --environment staging \
  --run-backup-restore true \
  --require-backup-restore true \
  --database-url "$DATABASE_URL" \
  --restore-database-url "$RESTORE_DATABASE_URL" \
  --backup-restore-evidence-path ./artifacts/ops/backup-restore-staging.json \
  --signing-key-file ./keys/ops-ed25519.pem \
  --signature-key-id ops_k1 \
  --out ./artifacts/ops/hosted-baseline-staging.json
```

Critical metrics probe:

```bash
curl -sS https://api.settld.work/metrics \
  -H "x-proxy-tenant-id: tenant_default" \
  -H "x-proxy-ops-token: $SETTLD_STAGING_OPS_TOKEN" \
  | rg 'replay_mismatch_gauge|disputes_over_sla_gauge|arbitration_over_sla_gauge|settlement_holds_over_24h_gauge|worker_outbox_pending_total_gauge|worker_deliveries_pending_total_gauge'
```
