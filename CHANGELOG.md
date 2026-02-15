# Changelog

All notable changes to Settld should be documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and aims for [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Agreement delegation primitive: `AgreementDelegation.v1` protocol spec + schema + vectors, and core builder/validator to support parent->child agreement linking in multi-hop agent chains.
- A2A discovery surface: `GET /.well-known/agent.json` publishes a Settld settlement Agent Card for A2A-compatible agent discovery.
- x402 verify-before-release wedge: `/x402/gate/*` API endpoints plus the in-repo thin proxy service `services/x402-gateway/` for converting upstream `HTTP 402` into `hold -> verify -> release/refund` settlement flows.
- GitHub Actions publish workflow for the x402 gateway image (`ghcr.io/aidenlippert/settld/x402-gateway:latest`).
- Self-serve onboarding email sequence automation for Magic Link tenants (`welcome`, `sample_verified_nudge`, `first_settlement_completed`) with idempotent state + outbox/smtp delivery modes (`services/magic-link/src/onboarding-email-sequence.js`).
- Self-serve referral instrumentation and benchmark reporting: onboarding events now accept `referral_link_shared` / `referral_signup`, onboarding metrics expose referral conversion fields, and CI can build `artifacts/launch/self-serve-benchmark-report.json` via `scripts/ci/build-self-serve-benchmark-report.mjs`.
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
- Money rail operations/provider events are now persisted through store-backed adapters (memory + Postgres), so operation state survives API/adapter restarts.
- Run-level settlement creation now preserves `settlement.disputeWindowDays`, enabling deterministic post-settlement dispute-open behavior for direct run flows.
- Added plan-aware verified-run hard-limit enforcement in run terminal paths; when exceeded, terminal run events are rejected with `402 BILLING_PLAN_LIMIT_EXCEEDED`.

### Added
- Money rail provider event ingestion endpoint: `POST /ops/money-rails/{providerId}/events/ingest`, including deterministic provider-status to canonical-state mapping and idempotent event replay semantics.
- Money rail reconciliation endpoint: `GET /ops/finance/money-rails/reconcile` to deterministically compare period payout instructions against provider operations and surface critical mismatches (`missing`, `amount/currency drift`, `terminal failures`, `unexpected operations`).
- Escrow net-close endpoints: `GET /ops/finance/net-close` for deterministic snapshot/reconciliation and `POST /ops/finance/net-close/execute` for gated execution when invariants pass, both with optional persisted `EscrowNetClose.v1` artifacts.
- Billable usage event pipeline primitives: durable store support, `GET /ops/finance/billable-events` query endpoint, and deterministic emissions for verified runs, settled volume, and arbitration usage paths.
- Self-serve billing control-plane endpoints:
  - `GET /ops/finance/billing/catalog`
  - `GET /ops/finance/billing/plan`
  - `PUT /ops/finance/billing/plan`
  - `GET /ops/finance/billing/summary`
- Billing plan catalog + estimation primitives (`src/core/billing-plans.js`) and tenant billing defaults in API store config.
