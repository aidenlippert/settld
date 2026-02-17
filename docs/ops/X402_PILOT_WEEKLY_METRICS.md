# X402 Pilot Weekly Reliability Metrics

Use this report to publish weekly reliability numbers for the Circle-backed paid tool pilot.

The report is artifact-driven and summarizes paid MCP/x402 runs under `artifacts/mcp-paid-exa`.

## Why this exists

Before broad provider expansion, the pilot must prove:

- reserve behavior is stable,
- token and provider signature verification are stable,
- settlement execution is stable.

This command produces a deterministic JSON report you can commit or attach to release notes.

## Run

```bash
npm run ops:x402:pilot:weekly-report -- \
  --artifact-root artifacts/mcp-paid-exa \
  --days 7 \
  --out artifacts/ops/x402-pilot-reliability-report.json
```

Optional reliability gates:

```bash
npm run ops:x402:pilot:weekly-report -- \
  --artifact-root artifacts/mcp-paid-exa \
  --days 7 \
  --max-reserve-fail-rate 0.10 \
  --max-token-verify-fail-rate 0.01 \
  --max-provider-sig-fail-rate 0.01 \
  --min-settlement-success-rate 0.98
```

If threshold gates are supplied, command exit code is non-zero when any gate fails.

## Output schema

`X402PilotReliabilityReport.v1` includes:

- `runCounts`
  - `runsInWindow`
  - `infraBootFailures`
  - `toolCallAttempts`
  - `successfulPaidCalls`
- `metrics`
  - `timeToFirstPaidCallMs`
  - `reserveFailRate`
  - `tokenVerifyFailRate`
  - `providerSigFailRate`
  - `settlementSuccessRate`
  - `replayDuplicateRate`
- `samples`
  - run ids for reserve/token/signature/settlement failures
- `verdict`
  - threshold check results when thresholds are passed

## Metric notes

- `reserveFailRate` is inferred from attempted runs with `gateway_error` today.
- Infrastructure boot failures are excluded from economic reliability denominators.
- `replayDuplicateRate` uses provider replay counters emitted by paid demo artifacts (`provider-replay-probe.json` or `summary.replayCounters`).

## Recommended weekly publish set

- `timeToFirstPaidCallMs`
- `reserveFailRate`
- `tokenVerifyFailRate`
- `providerSigFailRate`
- `settlementSuccessRate`
- `replayDuplicateRate`

Keep provider expansion gated on these metrics, not on raw demo volume.
