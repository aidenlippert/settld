# ToolCallDisputeOpen.v1

`ToolCallDisputeOpen.v1` is a **counterparty-signed** request to open an arbitration case for a paid tool-call settlement.

It binds:

- the tool identity (`toolId`)
- the economic agreement (`ToolCallAgreement.v1`)
- the settlement receipt (`SettlementReceipt.v2`)
- the claimant identity (`openedByAgentId`)

## Core fields

- `schemaVersion = "ToolCallDisputeOpen.v1"`
- `artifactType = "ToolCallDisputeOpen.v1"`
- `artifactId`
- `tenantId`
- `toolId`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `receipt`:
  - `artifactId`
  - `receiptHash`
- `openedByAgentId`
- `reasonCode` (optional)
- `reason` (optional)
- `evidenceRefs` (array; may be empty)
- `openedAt`

## disputeHash + signature

- `disputeHash` is computed over canonical JSON with `disputeHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `disputeHash`.

