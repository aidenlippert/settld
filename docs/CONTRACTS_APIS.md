# Contracts APIs (Legacy vs Contracts-as-Code)

Settld exposes two separate “contracts” API families on purpose.

## Legacy: `/ops/contracts` (policy upsert)

- Semantics: mutable upsert of “policy templates” (JSON `policies.*` blobs).
- Compatibility: kept for existing integrations and tests.
- Output: legacy `contract` records with `contractVersion` incrementing per upsert.

Use this when you want to keep the existing quoting/booking contract behavior.

## Contracts-as-Code: `/ops/contracts-v2` (hash-addressed documents)

- Semantics: immutable, hash-addressed `ContractDocument.v1` documents with optional signatures and an activation step.
- Output: v2 contract records that carry `contractHash`, `policyHash`, and `compilerId`.
- Jobs pin hashes at booking-time (so later edits cannot retroactively change what governed the job).

Use this when you need audit-grade pinning (hashes), signing, and deterministic compilation.

## Capabilities

`GET /capabilities` advertises which contract APIs and schema/compiler versions the server supports.
