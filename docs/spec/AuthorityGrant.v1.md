# AuthorityGrant.v1

`AuthorityGrant.v1` is a signed delegation of economic authority to an actor (typically an agent).

It exists to make “agent can pay for tool work” enforceable:

- spend is bounded
- tool access is bounded
- approvals can pin exact tool definitions (anti rug-pull)
- every settlement/decision can reference the grant that authorized it

## Hashing

`grantHash = sha256_hex( utf8( canonical_json_stringify( grant_without_grantHash_and_signature ) ) )`

Canonical JSON is RFC 8785 (JCS). See `CANONICAL_JSON.md`.

## Signature

`signature.signature` is an Ed25519 signature over the 32-byte digest of `grantHash`.

The signer is identified by `signature.signerKeyId`. Verifiers MUST verify the signature against the trusted public key
for that keyId.

## Required fields (v1)

- `schemaVersion` (const) — `"AuthorityGrant.v1"`
- `grantId` — stable identifier
- `tenantId`
- `grantedBy` — `{ actorType, actorId }`
- `grantedTo` — `{ actorType, actorId }`
- `limits`
  - `currency`
  - `maxPerTransactionCents`
  - `toolIds` — allowlist (empty means “no tools allowed”)
  - `pinnedManifests` — optional map of `toolId -> manifestHash` (when set, tool calls must match)
  - `expiresAt` — ISO datetime
- `issuedAt`
- `grantHash`
- `signature` — `{ signerKeyId, signedAt, signature }`

## Enforcement rules (kernel)

- Expiry: a grant MUST NOT authorize actions at or after `limits.expiresAt`.
- Tool allowlist: a grant MUST NOT authorize a tool call if `toolId` is not in `limits.toolIds`.
- Pinning: if `limits.pinnedManifests[toolId]` exists, the tool manifest used for execution MUST match the pinned hash.
- Spend: a grant MUST NOT authorize a transaction where `amountCents > limits.maxPerTransactionCents`.

