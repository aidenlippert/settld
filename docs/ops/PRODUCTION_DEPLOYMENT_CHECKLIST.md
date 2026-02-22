# Production Deployment Checklist

Use this checklist to launch and verify a real hosted Settld environment.

## Phase 0: Preflight

1. Confirm branch protection includes:
   - `tests / kernel_v0_ship_gate`
   - `tests / production_cutover_gate`
   - `tests / offline_verification_parity_gate` (NOO-50)
   - `tests / onboarding_policy_slo_gate`
   - `tests / onboarding_host_success_gate`
   - `tests / deploy_safety_smoke` (hosted baseline evidence path)
2. Confirm release workflow is blocked unless NOO-50 and the kernel/cutover gates are green for the release commit.
3. Confirm release workflow runs NOO-65 promotion guard and blocks publish lanes if `release-promotion-guard.json` verdict is not pass/override-pass.
4. Confirm staging and production have separate domains, databases, secrets, and signer keys.
5. Confirm required services are deployable: `npm run start:prod`, `npm run start:maintenance`, `npm run start:x402-gateway`.
6. Configure GitHub Environment `production_cutover_gate` with:
   - `PROD_BASE_URL`
   - `PROD_TENANT_ID`
   - `PROD_OPS_TOKEN`
   - optional `PROD_PROTOCOL` (`1.0`)
7. Require manual reviewers on `production_cutover_gate` before workflow secret access.

## Phase 1: Environment + secrets

1. Provision Postgres and store `DATABASE_URL`.
2. Set `STORE=pg`, `NODE_ENV=production`, `PROXY_MIGRATE_ON_STARTUP=1`.
3. Set scoped `PROXY_OPS_TOKENS`.
4. Configure rate limits and quotas from `docs/CONFIG.md`.
5. Configure gateway secrets: `SETTLD_API_URL`, `SETTLD_API_KEY`, `UPSTREAM_URL`.

## Phase 2: Deploy services

1. Deploy `settld-api`.
2. Deploy `settld-maintenance`.
3. Deploy `x402-gateway`.
4. Verify service health:

```bash
curl -fsS https://api.settld.work/healthz
curl -fsS https://gateway.settld.work/healthz
```

## Phase 3: Baseline ops verification

1. Run hosted baseline evidence command:

```bash
npm run ops:hosted-baseline:evidence -- \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --ops-token "$SETTLD_OPS_TOKEN" \
  --environment production \
  --out ./artifacts/ops/hosted-baseline-evidence-production.json
```

2. Confirm alert metric presence and health signals.
3. Run backup/restore drill evidence path at least once before opening customer traffic.

## Phase 4: MCP compatibility verification

1. Run core MCP automated tests:

```bash
node --test \
  test/mcp-stdio-spike.test.js \
  test/mcp-http-gateway.test.js \
  test/mcp-paid-exa-tool.test.js \
  test/mcp-paid-weather-tool.test.js \
  test/mcp-paid-llm-tool.test.js \
  test/demo-mcp-paid-exa.test.js
```

2. Run the hosted-style MCP smoke gate (API + magic-link bootstrap + MCP probe):

```bash
npm run test:ci:mcp-host-smoke
```

This emits a machine-readable report at:

`artifacts/ops/mcp-host-smoke.json`

3. Run host quickstart validation from `docs/QUICKSTART_MCP_HOSTS.md` for:
   Claude, Cursor, Codex, and OpenClaw.

4. Update `docs/ops/MCP_COMPATIBILITY_MATRIX.md` with pass/fail + date.

5. Run clean-env onboarding host success gate:

```bash
npm run test:ops:onboarding-host-success-gate -- \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --api-key "$SETTLD_API_KEY" \
  --attempts 3 \
  --min-success-rate-pct 90 \
  --report artifacts/gates/onboarding-host-success-gate.json \
  --metrics-dir artifacts/ops/onboarding-host-success
```

## Phase 5: Paid call + receipt proof

1. Run a paid demo flow:

```bash
npm run demo:mcp-paid-exa
```

2. Confirm artifacts exist:
   `artifacts/mcp-paid-exa/.../summary.json` and gate/settlement evidence files in the same run directory.
3. Verify receipt path using existing verifier tooling.

## Phase 6: Go-live decision gate

Ship only when all are true:

1. Kernel v0 ship gate, production cutover gate, and NOO-50 parity gate are green.
2. Onboarding/policy SLO gate is green (`artifacts/gates/onboarding-policy-slo-gate.json`).
3. Onboarding host success gate is green (`artifacts/gates/onboarding-host-success-gate.json`).
4. Hosted baseline evidence is green.
5. Go-live gate and launch cutover packet reports are present:
   - `artifacts/gates/s13-go-live-gate.json`
   - `artifacts/gates/s13-launch-cutover-packet.json`
   - generated from a successful `go-live-gate` workflow run for the release commit
6. NOO-65 promotion guard passes with required artifact binding (`artifacts/gates/release-promotion-guard.json`).
7. MCP compatibility matrix is green for supported hosts.
8. Paid MCP run artifacts verify cleanly.
9. Rollback runbook has been rehearsed.

Run the live environment cutover gate before opening traffic:

`Actions -> production-cutover-gate -> Run workflow`

## Phase 7: Post-release

1. Monitor `/metrics` + SLO dashboards.
2. Track weekly reliability report (`docs/ops/X402_PILOT_WEEKLY_METRICS.md`).
3. Re-run compatibility checks on every major host release.
