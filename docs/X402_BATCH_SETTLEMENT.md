# X402 Batch Settlement Worker

This worker creates deterministic provider payout batches from paid MCP/x402 demo artifacts and can optionally submit those batches to Circle rails.

## Purpose

- Aggregate released x402 gates by provider and currency.
- Emit deterministic payout manifests and per-provider batch files.
- Persist idempotency state so reruns do not double-settle the same gate.
- Optionally execute payouts (`--execute-circle`) with retry-safe batch state.

By default it remains artifact-driven (manifest-only) and does not call external payout rails.

## Inputs

1. Artifact root with run directories (default `artifacts/mcp-paid-exa`).
2. Provider payout registry (`X402ProviderPayoutRegistry.v1`).
3. Worker state file (`X402BatchWorkerState.v1`).

Registry example: `docs/examples/x402-provider-payout-registry.example.json`

## Run

```bash
npm run settlement:x402:batch -- \
  --artifact-root artifacts/mcp-paid-exa \
  --registry docs/examples/x402-provider-payout-registry.example.json
```

Dry run (no state mutation):

```bash
npm run settlement:x402:batch -- \
  --artifact-root artifacts/mcp-paid-exa \
  --registry docs/examples/x402-provider-payout-registry.example.json \
  --dry-run
```

Execute payouts in stub mode (safe local flow):

```bash
npm run settlement:x402:batch -- \
  --artifact-root artifacts/mcp-paid-exa \
  --registry docs/examples/x402-provider-payout-registry.example.json \
  --execute-circle \
  --circle-mode stub
```

Execute payouts in Circle sandbox mode:

```bash
npm run settlement:x402:batch -- \
  --artifact-root artifacts/mcp-paid-exa \
  --registry docs/examples/x402-provider-payout-registry.example.json \
  --execute-circle \
  --circle-mode sandbox
```

## Outputs

Each run writes:

- `payout-manifest.json`
- `payout-manifest.meta.json` (`manifestHash` + optional signature)
- `batches/<batchId>.json` for each provider batch

Default output root:

`artifacts/settlement/x402-batches/<timestamp>/`

## Idempotency

State file tracks processed gates by `gateId` and persisted batch payout status:

- first run: eligible released gates are batched and recorded
- subsequent runs: previously processed gates are skipped for new batch creation
- when `--execute-circle` is enabled:
  - `submitted` batches are not re-submitted
  - `failed` batches are retried until `maxAttempts` is reached

`--dry-run` always skips payout execution even when `--execute-circle` is provided.

State path default:

`artifacts/settlement/x402-batch-state.json`

## Circle execution env

Required when `--execute-circle --circle-mode sandbox|production`:

- `CIRCLE_API_KEY`
- `CIRCLE_WALLET_ID_SPEND`
- `CIRCLE_TOKEN_ID_USDC`
- `CIRCLE_ENTITY_SECRET_CIPHERTEXT_TEMPLATE`
  - or `CIRCLE_ENTITY_SECRET_CIPHERTEXT` with `CIRCLE_ALLOW_STATIC_ENTITY_SECRET=1`

Optional:

- `CIRCLE_BASE_URL`
- `CIRCLE_BLOCKCHAIN`
- `CIRCLE_TIMEOUT_MS`

## Optional manifest signing

Set both env vars:

- `SETTLD_BATCH_SIGNER_PUBLIC_KEY_PEM`
- `SETTLD_BATCH_SIGNER_PRIVATE_KEY_PEM`

If present, the worker adds an Ed25519 signature to `payout-manifest.meta.json`.
