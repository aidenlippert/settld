# Circle Sandbox E2E (Reserve Adapter)

This guide is for validating the x402 reserve path against Circle sandbox before enabling production mode.

## Goal

Prove the reserve contract used by `POST /x402/gate/authorize-payment`:

1. Reserve succeeds before token mint.
2. Reserve failure does not mint a token.
3. Reserve rollback path restores internal wallet state.

## Production safety defaults

The API is configured to fail closed in production-like environments:

- `X402_REQUIRE_EXTERNAL_RESERVE` defaults to `true` when `SETTLD_ENV=production|prod`, `NODE_ENV=production`, or `RAILWAY_ENVIRONMENT_NAME=production|prod`.
- `X402_CIRCLE_RESERVE_MODE` defaults to `production` in production-like environments.
- In local/test environments, defaults remain:
  - `X402_REQUIRE_EXTERNAL_RESERVE=false`
  - `X402_CIRCLE_RESERVE_MODE=stub`

To force explicit behavior in any environment, set both env vars directly.

## Required env

Set these for sandbox runs:

- `CIRCLE_E2E=1` (enables sandbox e2e tests)
- `CIRCLE_API_KEY` (sandbox key)
- `CIRCLE_BASE_URL=https://api-sandbox.circle.com`
- `CIRCLE_BLOCKCHAIN` (for example `BASE-SEPOLIA`)
- `CIRCLE_WALLET_ID_SPEND`
- `CIRCLE_WALLET_ID_ESCROW`
- `CIRCLE_TOKEN_ID_USDC`

Fastest way to generate these from your Circle account:

```bash
settld setup circle --api-key 'TEST_API_KEY:...' --mode auto --out-env ./.tmp/circle.env
```

Then load them:

```bash
set -a; source ./.tmp/circle.env; set +a
```

If your environment uses a different naming convention, map these into the adapter config before running tests.

## Suggested test flow

1. Verify spend wallet has sufficient USDC.
2. Call reserve (`spend -> escrow`) with idempotency key = gate id.
3. Poll transaction status until terminal/safe state.
4. Attempt rollback:
   - cancel when still cancellable, or
   - compensating transfer (`escrow -> spend`) when already confirmed.
5. Verify resulting balances + persisted reserve status.

## Run command

After adapter wiring is complete:

```bash
CIRCLE_E2E=1 node --test test/circle-sandbox-reserve-e2e.test.js
```

## Run full paid MCP demo in Circle mode

The demo now supports explicit reserve rail mode:

```bash
SETTLD_DEMO_CIRCLE_MODE=sandbox \
X402_REQUIRE_EXTERNAL_RESERVE=1 \
node scripts/demo/mcp-paid-exa.mjs --circle=sandbox
```

Artifacts include:

- `summary.json` with `circleMode`, `circleReserveId`, `reserveTransitions`, and `payoutDestination`.
- `reserve-state.json` with reserve details, transition timeline, and configured Circle rail metadata.

## Run paid MCP demo + batch settlement in Circle mode

This runs the same demo flow and then executes the batch payout worker against the generated artifact root:

```bash
SETTLD_DEMO_CIRCLE_MODE=sandbox \
SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1 \
SETTLD_DEMO_BATCH_PROVIDER_WALLET_ID="$CIRCLE_WALLET_ID_ESCROW" \
X402_REQUIRE_EXTERNAL_RESERVE=1 \
node scripts/demo/mcp-paid-exa.mjs --circle=sandbox
```

Additional artifacts:

- `batch-payout-registry.json`
- `batch-worker-state.json`
- `batch-settlement.json`

## Run sandbox-gated batch settlement E2E test

```bash
CIRCLE_E2E=1 CIRCLE_BATCH_E2E=1 node --test test/circle-sandbox-batch-settlement-e2e.test.js
```

This test:

1. Runs the paid MCP demo in sandbox mode with batch settlement enabled.
2. Confirms payout submission state is recorded.
3. Reruns the worker and verifies payout idempotency (no duplicate submit).

## Run the full Circle sandbox smoke gate

This command is the recommended "no-regression" check. It runs:

1. Optional faucet top-ups for spend/escrow wallets (can be disabled with `CIRCLE_SKIP_TOPUP=1`).
2. `test/circle-sandbox-reserve-e2e.test.js`
3. `test/circle-sandbox-batch-settlement-e2e.test.js`

```bash
npm run test:x402:circle:sandbox:smoke
```

Smoke output artifact:

- `artifacts/gates/x402-circle-sandbox-smoke.json`

## GitHub Actions smoke workflow

The repo includes `.github/workflows/x402-circle-sandbox-smoke.yml` for manual/nightly runs.

Required repo secrets:

- `CIRCLE_SANDBOX_API_KEY`
- `CIRCLE_SANDBOX_WALLET_ID_SPEND`
- `CIRCLE_SANDBOX_WALLET_ID_ESCROW`
- `CIRCLE_SANDBOX_TOKEN_ID_USDC`
- `CIRCLE_SANDBOX_ENTITY_SECRET_HEX`

Optional repo secrets:

- `CIRCLE_SANDBOX_BASE_URL` (defaults to `https://api.circle.com`)
- `CIRCLE_SANDBOX_BLOCKCHAIN` (defaults to `BASE-SEPOLIA`)

## Pass criteria

- Reserve call returns a stable `reserveId`.
- Repeated reserve calls with same gate id are idempotent.
- Failed reserves return `X402_RESERVE_FAILED` and leave no stranded internal escrow lock.
- Rollback returns funds to spend wallet (cancel or compensation).
