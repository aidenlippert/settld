# ToolCallEvidence.v1

`ToolCallEvidence.v1` is a signed evidence bundle for a tool call.

It binds evidence to a specific agreement, tool manifest hash, and timing window.

## Core fields

- `schemaVersion = "ToolCallEvidence.v1"`
- `artifactType = "ToolCallEvidence.v1"`
- `artifactId`
- `tenantId`
- `toolId`
- `toolManifestHash`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `call`:
  - `input` (any JSON)
  - `output` (any JSON)
  - `startedAt`
  - `completedAt`

## evidenceHash + signature

- `evidenceHash` is computed over the canonical JSON with `evidenceHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `evidenceHash`.

The signer is expected to be the provider/tool signer key (`signature.signerKeyId`), typically the same key that signs `ToolManifest.v1`.

