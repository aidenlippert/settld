# Demo Talk Track (60–120 seconds)

## Setup (before the call)

```bash
npm run demo:delivery
```

Keep these files open in your editor:
- `demo/delivery-robot/output/latest/sample_ingest_request.json`
- `demo/delivery-robot/output/latest/timeline.json`
- `demo/delivery-robot/output/latest/WorkCertificate.v1.json`
- `demo/delivery-robot/output/latest/CreditMemo.v1.json`
- `demo/delivery-robot/output/latest/SettlementStatement.v1.json`

If anything fails live, open `demo/delivery-robot/output/latest/` and narrate from the JSON (no UI required).

## Script

1) “This is the **upstream telemetry** we ingest from a dispatch/ops platform.”
   - Show `sample_ingest_request.json` and point at `externalEventId`, `correlationKey`, and the job window.

2) “Settld appends facts into a **hash-chained job stream** (dispute-resistant).”
   - Show `timeline.json` and point at ordering + event types.

3) “The robot started after the booking window ended → SLA breach.”
   - In `timeline.json`, point at `SLA_BREACH_DETECTED` and the breach detail (`START_LATE` / `COMPLETE_LATE`).

4) “The SLA breach deterministically issues a credit and updates settlement.”
   - Quote is `$125.00` and the configured SLA credit is `$12.50`.
   - Show `CreditMemo.v1.json` (credit amount + reason + policyHash anchor).
   - Show `SettlementStatement.v1.json` (quoteAmountCents / slaCreditsCents / net).

5) “The certificate is the clean story: what happened, under what pinned policy, with proof anchors.”
   - Show `WorkCertificate.v1.json` (policyHash + event proof).

## Troubleshooting (one screen)

- If the generator exits nonzero: open `demo/delivery-robot/output/latest/steps.json` to see the last failing request.
- If ingest rejects: it will include a reason code in `sample_ingest_response.json`.
