# SettlementReceipt.v1

`SettlementReceipt.v1` is the canonical settlement-finality artifact for one `AgentRunSettlement.v1` transition.

It binds money movement and finality to a `SettlementDecisionRecord` (`v1` or `v2`) through `decisionRef`.

## Purpose

- provide an immutable receipt of what settled (`released|refunded`, amounts, rate);
- capture finality mode/state (`internal_ledger`, `pending|final`);
- make downstream audit/reputation updates hash-addressable via `receiptHash`.

## Required fields

- `schemaVersion` (const: `SettlementReceipt.v1`)
- `receiptId`
- `tenantId`
- `runId`
- `settlementId`
- `decisionRef` (`decisionId`, `decisionHash`)
- `status`
- `amountCents`
- `releasedAmountCents`
- `refundedAmountCents`
- `releaseRatePct`
- `currency`
- `runStatus`
- `resolutionEventId`
- `finalityProvider`
- `finalityState`
- `settledAt`
- `createdAt`
- `receiptHash`

Optional fields:

- `bindings` (object) mirroring decision-time authorization/request/response binding context:
  - `authorizationRef`
  - `token` (`kid`, `sha256`, `expiresAt`)
  - `request` (`sha256`)
  - `response` (`status`, `sha256`)
  - `providerSig` (`required`, `present`, `verified`, `providerKeyId`, `error`)
  - `reserve` (`adapter`, `mode`, `reserveId`, `status`)
  - `policyDecisionFingerprint` (`fingerprintVersion`, `policyId`, `policyVersion`, `policyHash`, `verificationMethodHash`, `evaluationHash`)

## Internal finality semantics (`Kernel v0`)

- `finalityProvider` is `internal_ledger`.
- `finalityState` is:
  - `pending` while settlement is still `locked`,
  - `final` after one-way resolution to `released|refunded`.

## Canonicalization and hashing

`receiptHash` is computed over canonical JSON after removing `receiptHash`:

1. canonicalize JSON with RFC 8785 (JCS),
2. hash canonical UTF-8 bytes using `sha256`,
3. encode as lowercase hex.

## Schema

See `schemas/SettlementReceipt.v1.schema.json`.
