# Event Envelope & Black Box Rules (v0.2)

Settld’s “black box” is an append-only, hash-chained event stream. The API rejects events that fail envelope, causality, or signer-policy validation.

## Envelope

Each stored event uses this shape:

- `v`: envelope version (currently `1`)
- `id`: event id (`evt_...`)
- `at`: ISO-8601 timestamp
- `streamId`: aggregate stream id (e.g. a job id)
- `type`: event type (e.g. `BOOKED`, `EN_ROUTE`)
- `actor`: `{ type, id }` (who initiated the action)
- `payload`: JSON payload (nullable)
- `payloadHash`: `sha256(canonical(eventPayload))`
- `prevChainHash`: previous event’s `chainHash` (or `null` for genesis)
- `chainHash`: `sha256(canonical(chainLink))`
- `signature`: base64 Ed25519 signature (nullable)
- `signerKeyId`: key id of the signer (nullable)

## Canonical hashing

Canonical JSON rules (implemented in `src/core/canonical-json.js`):

- Object keys are sorted deterministically.
- No `undefined`, non-finite numbers, or `-0`.
- Only JSON values (plain objects/arrays/strings/numbers/booleans/null).

Hashes:

- `payloadHash = sha256( canonicalJson({ v, id, at, streamId, type, actor, payload }) )`
- `chainHash = sha256( canonicalJson({ v, prevChainHash, payloadHash }) )`

Signatures:

- `signature = Ed25519.sign(payloadHash)`
- Verification uses the signer’s public key looked up by `signerKeyId`.

## Append-time acceptance rules

The server rejects an append if any of the following are true:

- The envelope is missing required fields for the append mode (draft vs finalized).
- `prevChainHash` does not match the current stream head (optimistic concurrency).
- The hash chain or signature verification fails.
- The event violates signature policy (who must sign what).
- The event would cause an illegal job state transition.

## Concurrency & idempotency

- **Optimistic concurrency**: draft events must include `x-proxy-expected-prev-chain-hash`, and the server returns `409` on mismatch.
- **Idempotency**: mutation endpoints accept `x-idempotency-key`; replays return the original response (and don’t append twice).
