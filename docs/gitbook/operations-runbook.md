# Operations Runbook

Minimum operator posture for reliable kernel operation.

## Daily checks

- health endpoint response and DB latency
- replay mismatch count
- open dispute backlog
- pending/failed maintenance jobs

## Incident priorities

P0:

- replay mismatches on finalized settlements
- deterministic adjustment duplication risk
- settlement endpoint signing failures

P1:

- dispute queue lag beyond SLA
- closepack verify regressions in release candidate

## Recovery patterns

- use deterministic IDs + idempotent handlers before manual intervention
- re-run conformance after hotfixes
- archive closepack + replay reports for each incident timeline

## Release minimum

- tests green
- conformance green
- closepack verify sample green
- release artifacts/checksums generated
