# Core Primitives

Settld security and settlement correctness come from signed, hash-bound artifacts with deterministic relationships.

## Canonical transaction chain

Kernel v0 paid capability flow:

1. `ToolManifest`
2. `AuthorityGrant`
3. `ToolCallAgreement`
4. `FundingHold`
5. `ToolCallEvidence`
6. `SettlementDecisionRecord`
7. `SettlementReceipt`
8. Dispute branch (when needed):
   - `DisputeOpenEnvelope`
   - `ArbitrationCase`
   - `ArbitrationVerdict`
   - `SettlementAdjustment`

## Primitive purpose

### ToolManifest

Capability identity, interface details, verifier hints. Prevents silent identity swaps.

### AuthorityGrant

Constrains spend/scope/time. Prevents unauthorized settlement operations.

### ToolCallAgreement

Commits parties to exact terms including call commitment (`callId`, `inputHash`) and settlement terms.

### FundingHold

Reserves funds before work execution, enabling reliable provider execution with escrow semantics.

### ToolCallEvidence

Signed evidence binding execution facts to the agreement commitment.

### SettlementDecisionRecord

Deterministic evaluation outcome, reason codes, policy linkage, replay-critical facts.

### SettlementReceipt

Finalized settlement artifact describing effective outcome and accounting effect.

### Dispute artifacts

- `DisputeOpenEnvelope` proves opener legitimacy for non-admin opens.
- `ArbitrationCase` tracks active dispute subject.
- `ArbitrationVerdict` resolves dispute.
- `SettlementAdjustment` applies deterministic held-fund routing effect.

## Critical invariants

- One deterministic settlement result per agreement hash
- Evidence must match agreement commitment (`callId`/`inputHash`)
- Open arbitration case blocks holdback auto-release
- Deterministic adjustment identity prevents double-apply
- Replay checks compare recomputed vs stored decision path

## Determinism in practice

Determinism means:

- canonicalized artifact hashing
- explicit signer ownership
- deterministic artifact IDs for idempotent side effects
- reproducible replay/verification checks

It does not mean all policy semantics are universal truth. It means outcomes are provably tied to declared policy and evidence.

## Related references

- `docs/spec/README.md`
- `docs/spec/INVARIANTS.md`
- `docs/spec/SettlementDecisionRecord.v2.md`
- `docs/spec/DisputeOpenEnvelope.v1.md`
- `docs/spec/ClosePack.v1.md`
