# Artifacts

Settld artifacts are immutable, verifiable JSON documents (often later delivered via webhook/S3) derived from an event-sourced job stream.

## Finance Finality: "Effective" Artifacts

For finance and audit workflows, the *economically final* artifact is determined by settlement:

- If a job is settled, the effective artifact is the one whose `sourceEventId` equals the `SETTLED` event id.
- If a job is not settled, the effective artifact is anchored to the proof event selected for the latest completion anchor.

API:

- `GET /jobs/:jobId/artifacts/effective?type=WorkCertificate.v1`

This endpoint exists so downstream systems do **not** reinvent "which certificate counts" (and accidentally treat ids as chronology).

## Listing Artifacts (Storage Listing)

API:

- `GET /jobs/:jobId/artifacts`
  - Optional filters: `type=…`, `sourceEventId=…`
  - Pagination: `limit=…` with either `offset=…` (simple) or `cursor=…` (seek).

Important: this endpoint is a *storage listing*. It is **not** a job timeline. Artifact creation time may lag source-event time due to worker retries, backfills, or delayed processing.

### Ordering Contract (Postgres)

For the Postgres store, artifact listing uses:

- `ORDER BY created_at DESC, artifact_id DESC`

This ordering is deterministic, but it is based on artifact persistence time (`created_at`), not source event time.

### Cursor Pagination (Postgres-only)

Cursor pagination is supported only when running with the Postgres-backed store.

Cursor semantics:

- The cursor is an opaque `base64url`-encoded JSON payload.
- It is a seek cursor over `(created_at, artifact_id)` matching the ordering above.

Moving dataset semantics:

- While you are paging, new artifacts may be inserted at the "top" (newer `created_at`).
- A cursor walk does not guarantee you will see inserts that occur after you started paging.
- If you need the latest artifacts, restart from the top (no cursor) or use `/artifacts/effective` for finance truth.

Cursor payload format (v1):

```json
{
  "v": 1,
  "order": "created_at_desc_artifact_id_desc",
  "createdAt": "2026-01-01T00:00:00.000000Z",
  "artifactId": "workcert_job_123_evt_456"
}
```
