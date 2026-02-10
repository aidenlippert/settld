# ToolManifest.v1

`ToolManifest.v1` is a signed, versioned description of a callable tool/capability.

Its primary purpose is **anti-rug-pull pinning**: when a client approves a tool, it can pin the exact `manifestHash`.
If the tool definition changes later (name/description/schema/pricing/transport), the `manifestHash` changes and the
call must be re-approved.

## Hashing

`manifestHash = sha256_hex( utf8( canonical_json_stringify( manifest_without_manifestHash_and_signature ) ) )`

Canonical JSON is RFC 8785 (JCS). See `CANONICAL_JSON.md`.

## Signature

`signature.signature` is an Ed25519 signature over the 32-byte digest of `manifestHash`.

The signer is identified by `signature.signerKeyId`. Verifiers MUST verify the signature against the trusted public key
for that keyId (trust distribution is out-of-scope for this object).

## Required fields (v1)

- `schemaVersion` (const) — `"ToolManifest.v1"`
- `toolId` — stable identifier (caller-visible)
- `tenantId` — owner namespace
- `name` — human-readable name
- `tool` — tool schema envelope (name/description/input schema)
- `transport` — how to reach the tool (v1 supports `kind: "mcp"`)
- `createdAt`, `updatedAt`
- `manifestHash`
- `signature` — `{ signerKeyId, signedAt, signature }`

## Pinning rule

If a client holds an approval/authority grant that pins `manifestHash`, then executing the tool MUST fail-closed when
the provided/loaded `ToolManifest.v1.manifestHash` does not exactly match the pinned value.

