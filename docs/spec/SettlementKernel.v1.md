# SettlementKernel.v1

The **economic kernel** is the minimal, enforceable loop that turns:

`call a tool` -> `contract work` -> `prove outcome` -> `decide` -> `settle` -> `receipt`

This repo uses the following protocol objects to represent a paid tool call as *economically enforceable work*:

- `ToolCallAgreement.v1` (contract)
- `ToolCallEvidence.v1` (proof)
- `SettlementDecisionRecord.v1` (decision)
- `SettlementReceipt.v1` (final settlement receipt)

## Invariants

- **Binding:** each object references the prior objects by hash + artifactId (mix-and-match defense).
- **Signing:** agreement is signed by the payer agent; evidence is signed by the provider/tool signer; decision + receipt are signed by the verifier/settlement service.
- **Replayability:** the hashes are computed over RFC8785 canonical JSON (JCS) so independent implementations can reproduce them.
- **Idempotency:** settlement must be safe to retry without double-paying (idempotency key => same receipt).

