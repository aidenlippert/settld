# DisputeOpenEnvelope.v1

`DisputeOpenEnvelope.v1` is the signed opener-proof artifact for tool-call arbitration case creation.

It binds the dispute subject (`agreementHash`, `receiptHash`, `holdHash`) and opener identity into a deterministic, replayable signature envelope.

## Required fields

- `schemaVersion` (const: `DisputeOpenEnvelope.v1`)
- `artifactType` (const: `DisputeOpenEnvelope.v1`)
- `artifactId` (must equal `envelopeId`)
- `envelopeId`
- `caseId`
- `tenantId`
- `agreementHash` (sha256 hex)
- `receiptHash` (sha256 hex)
- `holdHash` (sha256 hex)
- `openedByAgentId`
- `openedAt` (ISO date-time)
- `reasonCode` (stable machine code, uppercase snake-case)
- `nonce` (caller-generated uniqueness value)
- `signerKeyId`
- `envelopeHash` (sha256 over canonical envelope core)
- `signature` (base64 Ed25519 signature over `envelopeHash`)

## Deterministic IDs

- Recommended envelope ID convention for tool-call disputes:
  - `dopen_case_${caseId}`

## Canonicalization and hashing

1. Build canonical core object excluding `envelopeHash`, `signature`, and `artifactHash`.
2. Compute `envelopeHash = sha256(canonical-json(core))`.
3. Verify `signature` against `envelopeHash` using `signerKeyId` public key.

## Verification requirements

- `openedByAgentId` must match the signer agent identity key referenced by `signerKeyId`.
- Subject hashes in envelope must match the arbitration-open request + hold bindings.
- For non-admin opens, a valid `DisputeOpenEnvelope.v1` is required.

See `docs/spec/schemas/DisputeOpenEnvelope.v1.schema.json`.
