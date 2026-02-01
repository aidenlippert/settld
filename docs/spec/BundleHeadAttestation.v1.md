# BundleHeadAttestation.v1

`BundleHeadAttestation.v1` is canonical JSON stored at `attestation/bundle_head_attestation.json`.

In strict mode, finance-grade bundles require this attestation.

## Purpose

- Commit to a specific bundle by signing:
  - `manifestHash`
  - and the relevant nested heads (e.g., FinancePack commits to MonthProof manifest/attestation).

## Core fields

- `schemaVersion = "BundleHeadAttestation.v1"`
- `kind`: the bundle kind/type (e.g. `JobProofBundle.v1`, `MonthProofBundle.v1`, `FinancePackBundle.v1`)
- `tenantId`
- `scope`: kind-specific scope object (e.g. `{jobId}` or `{period}`)
- `generatedAt`: bundle generation time (best-effort timestamp)
- `manifestHash`: bundle manifest hash
- `heads`: kind-specific head commitments
- `signedAt`: attestation signing time (server time)
- `signerKeyId`
- `attestationHash`: canonical hash of the attestation core (signature excluded)
- `signature`: base64 Ed25519 signature over `attestationHash`

## Validity requirements (strict mode)

- Signature must verify with the governed server key identified by `signerKeyId`.
- The signer key must be governed/valid per the embedded governance stream rules.
- `manifestHash` must match the bundle’s computed manifest hash.

