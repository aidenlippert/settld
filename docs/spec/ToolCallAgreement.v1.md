# ToolCallAgreement.v1

`ToolCallAgreement.v1` is a signed agreement for a paid tool call.

It binds:

- payer + payee
- tool identity (`toolId`) + pinned `ToolManifest.v1.manifestHash`
- authority delegation (`AuthorityGrant.v1` reference)
- the intended call input (via `inputHash`)
- price (`amountCents` + `currency`)

## Core fields

- `schemaVersion = "ToolCallAgreement.v1"`
- `artifactType = "ToolCallAgreement.v1"`
- `artifactId`
- `tenantId`
- `toolId`
- `toolManifestHash`
- `authorityGrantId`
- `authorityGrantHash`
- `payerAgentId`
- `payeeAgentId`
- `amountCents`
- `currency`
- `callId`: payer-chosen unique identifier for the call (used to bind evidence to intent)
- `inputHash`: sha256 of canonicalized tool-call input JSON
- `acceptanceCriteria` (optional): deterministic acceptance checks for this call (latency/output constraints and optional deterministic verifier selection)
- `settlementTerms` (optional): settlement semantics beyond "approve/reject"
  - `holdbackBps` (0..10000)
  - `challengeWindowMs` (>0; required when `holdbackBps > 0`)
- `createdAt`

## agreementHash + signature

- `agreementHash` is computed over the canonical JSON with `agreementHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `agreementHash` (hex digest bytes).

The signer is expected to be the payer agent key (`signature.signerKeyId`).
