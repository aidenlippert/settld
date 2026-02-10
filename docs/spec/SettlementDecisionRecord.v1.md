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
- `modality`: `cryptographic|deterministic|attested|manual`
- `verifierRef` (optional): verifier identity/version reference metadata (implementation-defined)
- `policyRef` (optional): effective policy reference metadata (implementation-defined)
- `reasonCodes`: stable reason code set for the decision (implementation-defined)
- `evaluationSummary` (optional): structured summary sufficient to explain the decision (implementation-defined)
- `decidedAt`

## recordHash + signature

- `recordHash` is computed over the canonical JSON with `recordHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `recordHash`.

The signer is expected to be the verifier/settlement service key.
