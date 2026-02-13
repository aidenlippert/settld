# Kernel v0

Kernel v0 is the protocol/control-plane surface for payable capability calls:

`agreement -> hold -> evidence -> decision -> receipt -> dispute -> verdict -> adjustment`

This page is the public contract for what is enforced now vs what is explicitly out of scope.

## Enforced In Kernel v0

- Deterministic IDs and idempotency on core financial artifacts (holdback adjustment IDs, dispute envelopes, replay artifacts).
- Tool-call holdback maintenance race hardening (open arbitration cases block auto-release).
- Signed dispute-open envelope for party-initiated disputes (`DisputeOpenEnvelope.v1`).
- Deterministic holdback adjustment issuance on verdict (`holdback_release` or `holdback_refund`).
- Replay evaluate and closepack export/verify for independent verification.
- `SettlementDecisionRecord.v2` emission default, with `policyHashUsed` and policy normalization pinning.
- Append-only `ReputationEvent.v1` facts with windowed query support (`/ops/reputation/facts`).

## Explicitly Not Enforced Yet

- Public money-rail GA behavior (chargebacks/refunds/KYB lifecycle) for all tenants.
- Hosted marketplace ranking policies on top of reputation facts.
- Universal deterministic verifier coverage across all capability types.
- Hosted click-to-try playground SLOs for untrusted anonymous traffic.

## Verification Entry Points

- Kernel conformance:
  - `./bin/settld.js conformance kernel --ops-token tok_ops`
- Closepack export and offline verify:
  - `./bin/settld.js closepack export --agreement-hash <sha256> --out /tmp/<agreementHash>.zip --ops-token tok_ops`
  - `./bin/settld.js closepack verify /tmp/<agreementHash>.zip`
- Tool-call replay evaluate:
  - `GET /ops/tool-calls/replay-evaluate?agreementHash=<sha256>`

## Stability Policy

- Kernel v0 aims for additive protocol evolution.
- Existing object versions remain verifiable (no flag day replacement of historical artifacts).
- New replay-critical requirements ship in versioned objects (for example, `SettlementDecisionRecord.v2`).
