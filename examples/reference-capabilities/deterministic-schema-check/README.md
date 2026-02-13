# Deterministic Reference Capability (Schema Check)

This reference shows a deterministic verifier selection that validates run completion metrics with a built-in schema-check plugin.

Use this verification method payload on bids/agreements:

```json
{
  "schemaVersion": "VerificationMethod.v1",
  "mode": "deterministic",
  "source": "verifier://settld/deterministic/schema-check-v1?latencyMaxMs=300&requireSettlementReleaseRatePct=1"
}
```

Run the end-to-end reference flow locally:

```sh
node examples/reference-capabilities/deterministic-schema-check/prove-marketplace.mjs
```

Expected settlement decision record behavior:

- `decisionRecord.schemaVersion = "SettlementDecisionRecord.v2"`
- `decisionRecord.verifierRef.modality = "deterministic"`
- `decisionRecord.verifierRef.verifierId = "settld.deterministic.schema-check"`
- a high latency completion (`latencyMs > latencyMaxMs`) is rejected deterministically
- settlement resolves to `status = refunded` with `releasedAmountCents = 0`

Replay/offline verification path:

1. Run kernel conformance:
   `./bin/settld.js conformance kernel --ops-token tok_ops`
2. Confirm marketplace replay case passes with deterministic verifier assertions.
3. Export and verify closepack for the same chain if desired:
   `./bin/settld.js closepack export --agreement-hash <hash> --ops-token tok_ops --out /tmp/closepack.zip`
   `./bin/settld.js closepack verify /tmp/closepack.zip`
