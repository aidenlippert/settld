# DelegationGrant.v1

`DelegationGrant.v1` defines a deterministic delegated-authority grant between two agents.

Status: Draft (architecture target; not fully enforced in runtime yet).

## Purpose

`DelegationGrant.v1` encodes bounded authority transfer for autonomous execution:

- who delegated to whom,
- what capability/risk scope is allowed,
- what spend envelope is permitted,
- how deep the delegation chain can extend,
- when the grant is valid and revocable.

## Required fields

- `schemaVersion` (const: `DelegationGrant.v1`)
- `grantId`
- `tenantId`
- `delegatorAgentId`
- `delegateeAgentId`
- `scope`
- `spendLimit`
- `chainBinding`
- `validity`
- `revocation`
- `createdAt`
- `grantHash`

## Scope model

`scope` defines the maximal authority window:

- `allowedProviderIds` (optional)
- `allowedToolIds` (optional)
- `allowedRiskClasses` (required)
- `sideEffectingAllowed` (required boolean)

If `sideEffectingAllowed=false`, strict policy engines MUST reject side-effecting execution intents even if tool/provider is allowlisted.

## Spend envelope

`spendLimit` defines bounded economic authority:

- `currency`
- `maxPerCallCents`
- `maxTotalCents`

Implementations SHOULD track cumulative spend against `maxTotalCents` using immutable receipt references.

## Chain binding

`chainBinding` binds grant placement in delegation topology:

- `rootGrantHash`
- `parentGrantHash` (nullable)
- `depth`
- `maxDelegationDepth`

A child grant is valid only when `depth <= maxDelegationDepth` and parent is valid/non-revoked.

## Validity + revocation

`validity`:

- `issuedAt`
- `notBefore`
- `expiresAt`

`revocation`:

- `revocable`
- `revokedAt` (nullable)
- `revocationReasonCode` (nullable)

## Canonicalization + hashing

`grantHash` is computed over canonical JSON of the full object excluding `grantHash`:

1. canonicalize JSON with RFC 8785 (JCS),
2. hash canonical UTF-8 bytes using `sha256`,
3. encode lowercase hex.

Detached signatures may be applied by transport/control layers; v1 does not require an embedded signature field.

## Schema

See `docs/spec/schemas/DelegationGrant.v1.schema.json`.
