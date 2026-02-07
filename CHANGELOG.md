# Changelog

All notable changes to Settld should be documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and aims for [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Producer bootstrap tooling: `settld-trust` (trust/key init) and `settld-produce` (jobproof/monthproof/financepack bundle generation) in `packages/artifact-produce/`.
- `ProduceCliOutput.v1` spec + schema for `settld-produce --format json`.
- Delegated signing (no private keys on disk): `settld-produce --signer remote` and RemoteSigner tooling contract (`docs/spec/REMOTE_SIGNER.md`).
- Backup/restore verification drill scripts (`scripts/backup-restore-test.sh`, `scripts/backup-restore/*`)
- Tenant isolation fuzz-style regression test (`test/tenant-isolation-fuzz.test.js`)
- Ops runbook (`docs/RUNBOOK.md`)
- Deprecation policy (`docs/DEPRECATION.md`)
- Ops command-center API: `GET /ops/network/command-center` with reliability, determinism, settlement/dispute, trust, and fee-estimate summaries, plus end-to-end coverage in `test/api-e2e-ops-command-center.test.js`.
- Ops command-center alerting controls: threshold query params + optional alert artifact persistence/delivery (`CommandCenterAlert.v1`) when `persistAlerts=true` (`ops_write` required).
- Ops finance reconciliation API: `GET /ops/finance/reconcile` with deterministic report hash + optional persisted relay artifact (`ReconcileReport.v1`) when `persist=true` (`finance_write` required), plus end-to-end coverage in `test/api-e2e-ops-finance-reconcile.test.js`.
- Escrow/netting hardening: tenant-scoped escrow operation idempotency keys, tenant-safe escrow journal entry IDs, and expanded atomic failure + high-frequency invariants coverage in `test/escrow-ledger.test.js` and `test/escrow-netting-invariants.test.js`.

### Changed
- Run dispute close now enforces the appeal window when a signed arbiter verdict is submitted (`POST /runs/{runId}/dispute/close`): late verdicts are rejected with `409 appeal window has closed`, while administrative closes without verdict remain allowed for already-open disputes.
- Money rail provider handling now supports explicit production-mode configuration (`moneyRailMode`, `moneyRailProviderConfigs`, `moneyRailDefaultProviderId`) with fail-fast guards against implicit stub usage in production.

### Added
- Money rail provider event ingestion endpoint: `POST /ops/money-rails/{providerId}/events/ingest`, including deterministic provider-status to canonical-state mapping and idempotent event replay semantics.
