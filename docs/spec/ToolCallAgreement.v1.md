# ToolCallAgreement.v1

`ToolCallAgreement.v1` binds a payable tool invocation to deterministic settlement terms.

The output is a hash-addressable agreement (`agreementHash`) that can be referenced by downstream holds, disputes, and receipts without trusting an online service.

## Fields

Required:

- `schemaVersion` (const: `ToolCallAgreement.v1`)
- `toolId` (string)
- `manifestHash` (sha256 hex; hash of the referenced `ToolManifest.v1`)
- `callId` (string; tool-call correlation id)
- `inputHash` (sha256 hex; hash of canonical JSON of the tool-call input payload)
- `acceptanceCriteria` (object or `null`)
- `settlementTerms` (object or `null`)
- `payerAgentId` (string or `null`)
- `payeeAgentId` (string or `null`)
- `createdAt` (ISO 8601 date-time)
- `agreementHash` (sha256 hex)

## Canonicalization + hashing

1. Canonicalize using RFC 8785 (JCS).
2. The `agreementHash` is `sha256` over UTF-8 bytes of canonical JSON of the **agreement core**:
   - the full `ToolCallAgreement.v1` object **excluding** the `agreementHash` field.

Implementations must treat the nullable fields (`acceptanceCriteria`, `settlementTerms`, `payerAgentId`, `payeeAgentId`) as present with explicit `null` when absent so `agreementHash` does not depend on “omitted vs null” representation.

## Schema

See `docs/spec/schemas/ToolCallAgreement.v1.schema.json`.

