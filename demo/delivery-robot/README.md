# Demo: Delivery Robot (Late Delivery → SLA Credit)

This demo is designed to be **bulletproof**:
- Runs **in-process** (no ports, no Docker, no external deps).
- Produces real Settld artifacts as JSON.
- Includes an upstream “telemetry ingest” example (`/ingest/proxy`).

## Practical checklist (demo-ready?)

| Question | Answer |
|---|---|
| Can you run it locally? | Yes: `npm run demo:delivery` |
| Can you upload sample telemetry? | Yes: `sample_ingest_request.json` → `/ingest/proxy` |
| Does it output something? | Yes: `WorkCertificate.v1.json`, `SettlementStatement.v1.json`, `CreditMemo.v1.json` |
| Have you used it end-to-end once? | Yes: run the command and open `output/latest/` |

## Run (30 seconds)

```bash
npm run demo:delivery
```

Outputs land in:
- `demo/delivery-robot/output/latest/` (overwrite each run)
- `demo/delivery-robot/output/<runId>/` (archived per run)

Open these files during the demo:
- `demo/delivery-robot/output/latest/sample_ingest_request.json`
- `demo/delivery-robot/output/latest/timeline.json`
- `demo/delivery-robot/output/latest/WorkCertificate.v1.json`
- `demo/delivery-robot/output/latest/CreditMemo.v1.json` (if present)
- `demo/delivery-robot/output/latest/SettlementStatement.v1.json`

## Story / Talk Track (2 minutes)

1) **Upstream facts in**: we ingest dispatch evaluation telemetry (`/ingest/proxy`) and correlate it to the job.
2) **Robot signs execution**: the robot appends signed events to the job stream (tamper-evident chain).
3) **SLA breach detected**: the robot starts after the booking window ends → Settld emits `SLA_BREACH_DETECTED`.
4) **Credit issued + settlement updates**: quote is `$125.00` and the configured SLA credit is `$12.50` → Settld emits `SLA_CREDIT_ISSUED`, generates `CreditMemo.v1`, and updates `SettlementStatement.v1`.

## “Before vs After”

See `demo/delivery-robot/before-after.md`.
