# Onboarding Runtime Loop

This runbook covers the production onboarding control loop:

`runtime bootstrap -> MCP smoke -> first paid call -> conformance matrix`

## Prerequisites

- Control plane admin API key (`x-api-key`)
- Tenant ID
- Settld API + ops token configured on Magic Link service
- MCP server executable available (`npx -y settld-mcp`)

## CLI fast path (host + starter policy)

Use one command per host:

```bash
settld setup --yes --mode manual --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
settld setup --yes --mode manual --host claude --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
settld setup --yes --mode manual --host cursor --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
settld setup --yes --mode manual --host openclaw --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

Useful flags:

- `--skip-profile-apply` for host setup only
- `--profile-file ./path/to/profile.json` to apply your own profile
- `--dry-run` to preview writes only

Policy wizard flow (template-based):

```bash
npm run trust:wizard -- list --format text
npm run trust:wizard -- show --template delivery_standard_v1 --format text
npm run trust:wizard -- render --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --out ./policy.delivery.json --format json
npm run trust:wizard -- validate --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --format json
```

## Hosted API golden path

1. Generate runtime credentials:

```bash
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/runtime-bootstrap \
  -d '{"apiKey":{"create":true,"description":"onboarding runtime key"}}'
```

2. Run MCP smoke test:

```bash
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/runtime-bootstrap/smoke-test \
  -d '{"env":{"SETTLD_BASE_URL":"<api_base_url>","SETTLD_TENANT_ID":"<tenant_id>","SETTLD_API_KEY":"<runtime_key>"}}'
```

3. Run first paid flow:

```bash
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/first-paid-call \
  -d '{}'
```

4. Run conformance matrix (recommended with idempotency key):

```bash
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "x-idempotency-key: matrix_<tenant_id>_<build_id>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/conformance-matrix \
  -d '{"targets":["codex","claude","cursor","openclaw"]}'
```

## Replay and History

- Read first paid call history:

```bash
curl -sS \
  -H "x-api-key: <admin_api_key>" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/first-paid-call/history
```

- Replay a prior first paid call attempt (no new spend attempt):

```bash
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/first-paid-call \
  -d '{"replayAttemptId":"fpc_<attempt_id>"}'
```

## Failure Playbook

- `RUNTIME_BOOTSTRAP_UNCONFIGURED`
  - Verify `MAGIC_LINK_SETTLD_API_BASE_URL` and `MAGIC_LINK_SETTLD_OPS_TOKEN` are both set.

- `MCP_SMOKE_TEST_FAILED`
  - Confirm env values from bootstrap output are unmodified.
  - Confirm MCP package is resolvable in runtime host.

- `SETTLD_API_CALL_FAILED` / step-specific paid-call failure
  - Check response `step` and `message`.
  - Re-run first paid call and compare attempt history.

- `RATE_LIMITED` on conformance matrix
  - Honor `retryAfterSeconds`.
  - Reduce automated matrix frequency.
  - Use `x-idempotency-key` to safely retry same operation.

- `INVALID_IDEMPOTENCY_KEY`
  - Ensure key is single-line and <= 160 chars.

## Audit Expectations

After successful runs, audit logs should contain:

- `TENANT_RUNTIME_BOOTSTRAP_ISSUED`
- `TENANT_RUNTIME_MCP_SMOKE_TESTED`
- `TENANT_RUNTIME_FIRST_PAID_CALL_COMPLETED`
- `TENANT_RUNTIME_CONFORMANCE_MATRIX_RUN`
