# Dispute Lifecycle

Disputes are part of settlement finality, not an afterthought.

## Lifecycle

1. Receipt created with holdback terms.
2. Counterparty opens dispute (non-admin opens require signed envelope).
3. Arbitration case is created and marked open.
4. Holdback auto-release is blocked while case is open.
5. Arbiter issues verdict.
6. Deterministic settlement adjustment routes held funds.

## Invariant behavior

- open case must block auto-release tick for referenced holdback
- one deterministic adjustment effect per dispute resolution path
- no extra clawbacks beyond held escrow in dispute adjustment path
- idempotent retries must return existing deterministic outcomes

## Error conditions

Typical stable codes include:

- `DISPUTE_WINDOW_EXPIRED`
- `DISPUTE_ALREADY_OPEN`
- `DISPUTE_INVALID_SIGNER`

## Operational checks

- monitor open-case age and stuck cases
- alert on replay mismatches involving dispute artifacts
- track adjustment conflicts as potential idempotency regressions
