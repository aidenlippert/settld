# SettlementReceipt.v2

`SettlementReceipt.v2` is a server-signed receipt representing the settlement outcome for a specific agreement.

Unlike `SettlementReceipt.v1`, this version supports **retention/holdback** semantics for a challenge window.

## Core fields

- `schemaVersion = "SettlementReceipt.v2"`
- `artifactType = "SettlementReceipt.v2"`
- `artifactId`
- `tenantId`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `decision`:
  - `artifactId`
  - `recordHash`
- `transfer` (immediate transfer applied at `settledAt`):
  - `payerAgentId`
  - `payeeAgentId`
  - `amountCents`
  - `currency`
- `agreementAmountCents` (the total agreed amount; makes the receipt replayable without fetching the agreement)
- `outcome`:
  - `paid`
  - `not_paid`
  - `expired`
  - `reversed` (reserved for dispute/adjustment systems)
- `retention` (optional; present only when `outcome = "paid"` and some amount is held):
  - `heldAmountCents`
  - `holdbackBps`
  - `challengeWindowMs`
  - `challengeUntil` (ISO date string)
- `ledger` (optional): implementation-defined ledger references
- `settledAt`

## Invariants

- Binding: `agreement` and `decision` references are hash+id bound.
- Paid invariants:
  - `transfer.amountCents + retention.heldAmountCents == agreementAmountCents` (when `retention` is present)
  - `retention` must be omitted when no funds are held.
- Non-paid invariants:
  - `transfer.amountCents == 0`
  - `retention` must be omitted.

## receiptHash + signature

- `receiptHash` is computed over the canonical JSON with `receiptHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `receiptHash`.

The signer is expected to be the settlement service key.

