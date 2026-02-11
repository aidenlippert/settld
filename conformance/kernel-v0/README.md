# Kernel Conformance (v0)

This conformance pack exercises Settld's **economic kernel control plane** behavior for:

- Tool-call holdback escrow (`FundingHold.v1`)
- Dispute opening (`ArbitrationCase.v1` metadata `caseType: "tool_call"`)
- Holdback maintenance freeze while a case is open
- Deterministic verdict adjustment issuance (`SettlementAdjustment.v1`)
- Run settlement replay evaluation (`GET /runs/:runId/settlement/replay-evaluate`)

It is intentionally **invariant-focused** (idempotency, deterministic IDs, and escrow safety), not deep object-equality snapshotting.

## Run

1. Start the API with an ops token that has `ops_write`:

Example (local):

```sh
PROXY_OPS_TOKENS='tok_ops:ops_read,ops_write,finance_read,finance_write,audit_read' npm run dev:api
```

Example (docker compose dev stack):

```sh
./bin/settld.js dev up
```

2. Run conformance:

```sh
./bin/settld.js conformance kernel --ops-token tok_ops
```

Optional:

```sh
node conformance/kernel-v0/run.mjs --ops-token tok_ops --case tool_call_holdback_release
node conformance/kernel-v0/run.mjs --ops-token tok_ops --case marketplace_run_replay_evaluate
node conformance/kernel-v0/run.mjs --ops-token tok_ops --list
```

Write a machine-readable report:

```sh
./bin/settld.js conformance kernel --ops-token tok_ops --json-out /tmp/settld-kernel-v0-report.json
```

The runner prints `INFO ...` lines with `agreementHash` / `runId` and direct links to:

- Kernel Explorer: `GET /ops/kernel/workspace?opsToken=...&agreementHash=...`
- Replay evaluate: `GET /runs/:runId/settlement/replay-evaluate`

## What It Asserts

- A holdback maintenance tick will **not auto-release** held funds when a matching tool-call arbitration case is open.
- On verdict issuance, the server creates **exactly one** deterministic adjustment:
  - `adjustmentId = sadj_agmt_${agreementHash}_holdback`
  - `kind = holdback_release` (payee win) or `holdback_refund` (payer win)
- Applying the same verdict again is **idempotent** (returns the existing adjustment and reports `alreadyExisted=true`).
