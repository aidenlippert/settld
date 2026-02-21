# Quickstart

Use this guide to onboard a host and create a policy with the fewest steps.

## 1) Prerequisites

- Node.js 20+
- Settld API reachable (`http://127.0.0.1:3000` locally)
- Tenant API key (`keyId.secret`)

## 2) One-command host setup

Each command below sets host MCP config, applies starter policy profile `engineering-spend`, and runs a smoke check.

### Codex

```bash
settld setup --yes --mode manual --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

### Claude

```bash
settld setup --yes --mode manual --host claude --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

### Cursor

```bash
settld setup --yes --mode manual --host cursor --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

### OpenClaw

```bash
settld setup --yes --mode manual --host openclaw --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

Useful flags:

- `--skip-profile-apply`: setup host only
- `--profile-file ./path/to/profile.json`: use your own profile file
- `--dry-run`: preview file updates only

## 3) New policy wizard flow

If you only need a starter policy, keep `--profile-id engineering-spend` in `settld setup` and you are done.

For template-based policy config:

```bash
npm run trust:wizard -- list --format text
npm run trust:wizard -- show --template delivery_standard_v1 --format text
npm run trust:wizard -- render --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --out ./policy.delivery.json --format json
npm run trust:wizard -- validate --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --format json
```

## 4) Hosted onboarding API loop (optional)

```bash
# 1) Mint bounded runtime config
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/runtime-bootstrap \
  -d '{"apiKey":{"create":true,"description":"quickstart runtime"}}'

# 2) Smoke test MCP initialize + tools/list
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/runtime-bootstrap/smoke-test \
  -d '{"env":{"SETTLD_BASE_URL":"http://127.0.0.1:3000","SETTLD_TENANT_ID":"<tenant_id>","SETTLD_API_KEY":"<runtime_key>"}}'

# 3) Run first paid call
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/first-paid-call \
  -d '{}'

# 4) Run conformance matrix for codex/claude/cursor/openclaw
curl -sS -X POST \
  -H "x-api-key: <admin_api_key>" \
  -H "x-idempotency-key: matrix_quickstart_1" \
  -H "content-type: application/json" \
  http://127.0.0.1:3090/v1/tenants/<tenant_id>/onboarding/conformance-matrix \
  -d '{"targets":["codex","claude","cursor","openclaw"]}'
```

## Expected results

- Host can call `settld.about`
- Starter policy profile is applied (or intentionally skipped)
- First paid call can complete
- Conformance matrix reports `ready=true` for selected hosts
