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
