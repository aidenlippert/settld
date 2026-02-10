# SettlementDecisionRecord.v1

`SettlementDecisionRecord.v1` is a signed record of the verifier's decision for a specific (agreement, evidence) pair.

It answers: **why was this paid (or held/rejected)?**

## Core fields

- `schemaVersion = "SettlementDecisionRecord.v1"`
- `artifactType = "SettlementDecisionRecord.v1"`
- `artifactId`
- `tenantId`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `evidence`:
  - `artifactId`
  - `evidenceHash`
- `decision`: `approved|held|rejected`
- `modality`: `deterministic|attestation|manual`
- `verifier` (optional): verifier identity/version metadata (implementation-defined)
- `policy` (optional): effective policy snapshot/reference (implementation-defined)
- `decidedAt`

## recordHash + signature

- `recordHash` is computed over the canonical JSON with `recordHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `recordHash`.

The signer is expected to be the verifier/settlement service key.

