# ToolCallEvidence.v1

`ToolCallEvidence.v1` records the outcome of a tool invocation (`outputHash`, optional references/metrics) and binds it to a `ToolCallAgreement.v1` via `agreementHash`.

The output is a hash-addressable evidence record (`evidenceHash`) that can be optionally signed by an agent key.

## Fields

Required:

- `schemaVersion` (const: `ToolCallEvidence.v1`)
- `agreementHash` (sha256 hex; points to `ToolCallAgreement.v1`)
- `callId` (string; must match the agreement `callId`)
- `inputHash` (sha256 hex; must match the agreement `inputHash`)
- `outputHash` (sha256 hex; hash of canonical JSON of the tool-call output payload)
- `outputRef` (string or `null`; optional pointer to stored output)
- `metrics` (object or `null`; optional timing/quality metrics)
- `startedAt` (ISO 8601 date-time)
- `completedAt` (ISO 8601 date-time)
- `createdAt` (ISO 8601 date-time)
- `evidenceHash` (sha256 hex)

Optional:

- `signature` (object): Ed25519 signature over `evidenceHash`
  - `algorithm` (const: `ed25519`)
  - `signerKeyId` (string)
  - `evidenceHash` (sha256 hex; must equal the parent `evidenceHash`)
  - `signature` (base64)

## Canonicalization + hashing

1. Canonicalize using RFC 8785 (JCS).
2. The `evidenceHash` is `sha256` over UTF-8 bytes of canonical JSON of the **evidence core**:
   - the full `ToolCallEvidence.v1` object excluding `evidenceHash` and `signature`.

Implementations must treat the nullable fields (`outputRef`, `metrics`) as present with explicit `null` when absent so `evidenceHash` does not depend on “omitted vs null” representation.

## Signing

- When present, `signature.signature` is an Ed25519 signature over the **bytes** of `evidenceHash` (hex), base64-encoded.
- Verifiers should ensure `signature.evidenceHash` matches the enclosing `evidenceHash` before verifying the signature.

## Schema

See `docs/spec/schemas/ToolCallEvidence.v1.schema.json`.

