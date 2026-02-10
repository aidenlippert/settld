# SettlementAdjustment.v1

`SettlementAdjustment.v1` is a server-signed artifact that applies a deterministic ledger adjustment tied to a prior settlement receipt.

It is used for:

- holdback release after the challenge window closes
- holdback refund on dispute outcomes (future)

## Core fields

- `schemaVersion = "SettlementAdjustment.v1"`
- `artifactType = "SettlementAdjustment.v1"`
- `artifactId`
- `tenantId`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `receipt`:
  - `artifactId`
  - `receiptHash`
- `payerAgentId`
- `payeeAgentId`
- `currency`
- `kind`:
  - `holdback_release`
  - `holdback_refund`
  - `holdback_split`
- `amounts`:
  - `releaseToPayeeCents` (>= 0)
  - `refundToPayerCents` (>= 0)
  At least one must be non-zero.
- `ledger` (optional): implementation-defined ledger references
- `appliedAt`

## adjustmentHash + signature

- `adjustmentHash` is computed over canonical JSON with `adjustmentHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `adjustmentHash`.

The signer is expected to be the settlement service key.
