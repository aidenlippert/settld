# AgentPassport.v1

`AgentPassport.v1` defines the portable delegation identity envelope for an autonomous economic actor.

Status: Draft (architecture target; not fully enforced in runtime yet).

## Purpose

`AgentPassport.v1` is the root identity contract used to answer:

- which principal ultimately backs this agent,
- which keyset currently represents the agent,
- which delegation root authorizes spend/actions,
- which capability credentials the agent can present,
- which policy envelope bounds autonomous execution.

The object is designed to be stable, hash-addressable, and portable across hosts/runtimes.

## Required fields

- `schemaVersion` (const: `AgentPassport.v1`)
- `passportId`
- `agentId`
- `tenantId`
- `principalRef`
- `identityAnchors`
- `delegationRoot`
- `policyEnvelope`
- `status`
- `createdAt`
- `updatedAt`

## Principal binding

`principalRef` binds the agent to an accountable sponsor:

- `principalType`: `human` | `business` | `service` | `dao`
- `principalId`: stable principal identifier
- `jurisdiction`: optional compliance hint (for policy packs)

## Identity anchors

`identityAnchors` defines key discovery and verification roots:

- `did` (optional, DID URI)
- `jwksUri` (HTTPS URL)
- `activeKeyId`
- `keysetHash` (sha256 hex over normalized JWK set)

## Delegation root

`delegationRoot` pins the root authority chain used for autonomous actions:

- `rootGrantId`
- `rootGrantHash`
- `issuedAt`
- `expiresAt` (nullable)
- `revokedAt` (nullable)

A revoked root (`revokedAt != null`) MUST be treated as non-executable by strict policy engines.

## Capability credentials

`capabilityCredentials` is an optional array of machine-verifiable capability claims. Entries carry:

- `credentialType`
- `issuer`
- `credentialRef`
- `credentialHash`
- `issuedAt`
- `expiresAt` (nullable)

## Policy envelope

`policyEnvelope` binds baseline controls before request-level decisions:

- `maxPerCallCents`
- `maxDailyCents`
- `allowedRiskClasses` (`read|compute|action|financial`)
- `requireApprovalAboveCents` (nullable)
- `allowlistRefs` (optional references to provider/tool policy sets)

## Canonicalization + hashing

When used as an input to signatures or binding hashes:

1. canonicalize JSON with RFC 8785 (JCS),
2. hash canonical UTF-8 bytes with `sha256`,
3. encode as lowercase hex.

`AgentPassport.v1` does not require an embedded signature field in v1; signatures are expected in detached envelopes at transport/control layers.

## Schema

See `docs/spec/schemas/AgentPassport.v1.schema.json`.
