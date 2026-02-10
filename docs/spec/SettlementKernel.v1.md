# SettlementKernel.v1

The **economic kernel** is the minimal, enforceable loop that turns:

`call a tool` -> `contract work` -> `prove outcome` -> `decide` -> `settle` -> `receipt`

This repo uses the following protocol objects to represent a paid tool call as *economically enforceable work*:

- `ToolCallAgreement.v1` (contract)
- `FundingHold.v1` (funding guarantee / pre-authorization)
- `ToolCallEvidence.v1` (proof)
- `SettlementDecisionRecord.v1` (decision)
- `SettlementReceipt.v2` (settlement receipt; supports retention/holdback challenge windows)
- `SettlementAdjustment.v1` (adjustments: holdback release/refund)

## Invariants

- **Binding:** each object references the prior objects by hash + artifactId (mix-and-match defense).
- **Intent commitment:** agreements commit to the intended call input via `inputHash`, and evidence must match it.
- **Signing:** agreement is signed by the payer agent; evidence is signed by the provider/tool signer; decision + receipt are signed by the verifier/settlement service.
- **Funding guarantee:** settlement must only occur after a `FundingHold.v1` exists for the agreement, and settlement must consume (release/refund) the held funds.
- **Replayability:** the hashes are computed over RFC8785 canonical JSON (JCS) so independent implementations can reproduce them.
- **Idempotency:** settlement must be safe to retry without double-paying (idempotency key => same receipt).
- **Uniqueness:** at most one settlement receipt may exist per `agreementHash`.
