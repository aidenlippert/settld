# SettlementReceipt.v1

`SettlementReceipt.v1` is a signed receipt representing the final settlement outcome and transfer.

It binds the transfer to a specific decision record (and therefore to the agreement + evidence).

## Core fields

- `schemaVersion = "SettlementReceipt.v1"`
- `artifactType = "SettlementReceipt.v1"`
- `artifactId`
- `tenantId`
- `decision`:
  - `artifactId`
  - `recordHash`
- `transfer`:
  - `payerAgentId`
  - `payeeAgentId`
  - `amountCents`
  - `currency`
- `ledger` (optional): ledger posting references (implementation-defined)
- `settledAt`

## receiptHash + signature

- `receiptHash` is computed over the canonical JSON with `receiptHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `receiptHash`.

The signer is expected to be the settlement service key.

