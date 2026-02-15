# AgentIdentity.v1

`AgentIdentity.v1` defines a portable, tenant-scoped identity record for autonomous agents.

This object is intended to be:

- deterministic (stable field names + required core fields),
- cryptographically bound (primary verification key is explicit), and
- reusable across API, SDK, and future trust/reputation surfaces.

## Schema

See `schemas/AgentIdentity.v1.schema.json`.

## Canonicalization and hashing

When `AgentIdentity.v1` is signed or hashed by higher-level protocols:

- canonicalize the JSON with RFC 8785 (JCS),
- hash canonical UTF-8 bytes with `sha256`,
- represent digests as lowercase hex.

`AgentIdentity.v1` itself does not require an embedded signature field in v1.

## Required fields

- `schemaVersion` (const: `AgentIdentity.v1`)
- `agentId` (stable identifier)
- `tenantId` (tenant scope)
- `displayName` (human-readable label)
- `status` (`active` | `suspended` | `revoked`)
- `owner` (operator linkage)
- `keys` (primary verification key descriptor)
- `capabilities` (declared capability identifiers)
- `createdAt` / `updatedAt` (ISO date-time)

## Owner linkage

`owner` binds the autonomous identity to an accountable controller:

- `ownerType`: `human` | `business` | `service`
- `ownerId`: stable owner identifier

## Key descriptor

`keys` defines the active verification material for the identity:

- `keyId`: derived or assigned key identifier
- `algorithm`: currently `ed25519`
- `publicKeyPem`: PEM-encoded public key

## Optional policy hints

`walletPolicy` carries optional spend/approval constraints for downstream settlement systems:

- `maxPerTransactionCents`
- `maxDailyCents`
- `requireApprovalAboveCents`

These fields are optional and non-normative in v1. Implementations MAY enforce them when creating holds/settlements (for example, rejecting a settlement when `amountCents > maxPerTransactionCents` or when an out-of-band approval gate is required above `requireApprovalAboveCents`).

Implementation note (this repo): the Settld API enforces `maxPerTransactionCents`, `maxDailyCents`, and `requireApprovalAboveCents` on settlement/hold creation paths that lock escrow from an agent wallet.
