# ReputationEvent.v1

`ReputationEvent.v1` is an append-only, deterministic artifact for recording economic reputation facts tied to settlement and dispute lifecycle changes.

It is intentionally facts-first: consumers aggregate event streams into scores and risk models without mutating historical records.

## Fields

Required:

- `schemaVersion` (const: `ReputationEvent.v1`)
- `artifactType` (const: `ReputationEvent.v1`)
- `artifactId` (must equal `eventId`)
- `eventId` (deterministic ID)
- `tenantId`
- `occurredAt` (ISO datetime)
- `eventKind`
  - `decision_approved`
  - `decision_rejected`
  - `holdback_auto_released`
  - `dispute_opened`
  - `verdict_issued`
  - `adjustment_applied`
- `subject`
  - `agentId` (reputation subject)
  - optional `toolId`
  - optional `counterpartyAgentId`
  - optional `role` (`payee|payer|arbiter|system`)
- `sourceRef`
  - `kind` (producer-defined reference namespace)
  - optional stable references (`artifactId`, `sourceId`, `hash`, `agreementHash`, `receiptHash`, `holdHash`, `decisionHash`, `verdictHash`, `runId`, `settlementId`, `disputeId`, `caseId`, `adjustmentId`)
  - must include at least one stable reference besides `kind`
- `facts` (object; structured event facts used for aggregation)
- `eventHash` (sha256 hex over immutable event core)

Optional fields are omitted when absent.

## Hashing

`eventHash` is computed as sha256 of RFC 8785 canonical JSON excluding:

- `eventHash`
- `artifactHash` (storage-level hash, if present)

## Deterministic ID Conventions

Recommended deterministic IDs for kernel v0 conformance:

- decision: `rep_dec_${decisionHash}`
- holdback auto-release: `rep_rel_${agreementHash}`
- dispute opened: `rep_dsp_${agreementHash}`
- verdict issued: `rep_vrd_${verdictHash}`
- adjustment applied: `rep_adj_${adjustmentId}`

## Invariants

- Events are append-only and immutable.
- Re-issuing the same event source must produce the same `eventId` and `eventHash`.
- Persistence must treat duplicate `eventId` with same hash as idempotent.

## Schema

See `docs/spec/schemas/ReputationEvent.v1.schema.json`.
