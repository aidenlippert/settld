# ExecutionIntent.v1

`ExecutionIntent.v1` defines the canonical pre-execution authorization target for autonomous tool calls.

Status: Draft (architecture target; not fully enforced in runtime yet).

## Purpose

`ExecutionIntent.v1` bridges planning and policy enforcement by pinning:

- exact request fingerprint target,
- risk class and expected side-effect profile,
- spend/loss bounds,
- policy binding used for authorization,
- replay-critical temporal/idempotency context.

It is the object policy engines/risk engines should evaluate before minting spend authorization.

## Required fields

- `schemaVersion` (const: `ExecutionIntent.v1`)
- `intentId`
- `tenantId`
- `agentId`
- `requestFingerprint`
- `riskProfile`
- `spendBounds`
- `policyBinding`
- `idempotencyKey`
- `nonce`
- `expiresAt`
- `createdAt`
- `intentHash`

Optional:

- `runId`
- `agreementHash`
- `quoteId`

## Request fingerprint

`requestFingerprint` captures immutable request identity:

- `canonicalization` (`rfc8785-jcs`)
- `method`
- `path`
- `querySha256`
- `bodySha256`
- `requestSha256`

`requestSha256` SHOULD represent the canonical hash used by authorization tokens in strict request-binding mode.

## Risk profile

`riskProfile` includes:

- `riskClass`: `read|compute|action|financial`
- `sideEffecting`: boolean
- `expectedDeterminism`: `deterministic|bounded_nondeterministic|open_nondeterministic`
- `maxLossCents`
- `requiresHumanApproval`: boolean

## Spend bounds + policy binding

`spendBounds`:

- `currency`
- `maxAmountCents`

`policyBinding`:

- `policyId`
- `policyVersion`
- `policyHash`
- `verificationMethodHash`

Together they define the deterministic authorization envelope used in decision receipts.

## Canonicalization + hashing

`intentHash` is computed over canonical JSON of the full object excluding `intentHash`:

1. canonicalize JSON with RFC 8785 (JCS),
2. hash canonical UTF-8 bytes with `sha256`,
3. encode lowercase hex.

## Schema

See `docs/spec/schemas/ExecutionIntent.v1.schema.json`.
