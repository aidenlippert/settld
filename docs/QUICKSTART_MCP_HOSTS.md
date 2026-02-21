# Quickstart: MCP Host Integrations (Codex, Claude, Cursor, OpenClaw)

Use this when you want to connect a host app to Settld MCP quickly.

For deeper MCP flow details and artifact examples, see `docs/QUICKSTART_MCP.md`.

## 0) Prerequisites

- Node.js 20+
- Settld API reachable (`http://127.0.0.1:3000` for local or your hosted API)
- Tenant API key (`keyId.secret`)

### Recommended: one command for all hosts

Use the unified onboarding wizard:

```bash
settld setup
```

It guides:

- host selection (`codex`/`claude`/`cursor`/`openclaw`)
- wallet mode (`managed`/`byo`/`none`)
- preflight checks (API health, tenant key probe, host config path check)
- policy apply + smoke check

If you need offline setup only, add `--no-preflight`.

If you only want environment validation without writing host config:

```bash
settld setup --preflight-only --report-path ./.tmp/setup-preflight.json
```

### Optional: One-command Circle env bootstrap (wallet IDs + token ID + entity secret)

If you are wiring Circle rails and do not want to manually hunt wallet/token/env values:

```bash
settld setup circle --api-key 'TEST_API_KEY:...' --mode auto --out-env ./.tmp/circle.env
```

What it does:

- auto-detects Circle API host (`api-sandbox` vs `api`)
- selects spend/escrow wallet IDs from your account
- discovers USDC token ID from wallet balances
- generates `CIRCLE_ENTITY_SECRET_HEX`
- requests faucet topups in sandbox mode
- prints shell exports and Railway-ready `KEY=VALUE` lines

## 1) One-command host setup (recommended)

### Fastest OpenClaw end-to-end path (wallet + host wiring)

If you want one command that does wallet bootstrap plus OpenClaw host setup:

```bash
settld setup openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --settld-api-key 'sk_live_xxx.yyy' \
  --profile-id engineering-spend \
  --out-env ./.tmp/openclaw.env
```

By default (`--wallet-bootstrap auto`):

- if `--circle-api-key` (or `CIRCLE_API_KEY`) is present, setup runs local Circle bootstrap.
- otherwise it calls the hosted onboarding endpoint (`/onboarding/wallet-bootstrap`) so users do not need local Circle credentials.

You can force either path:

```bash
# force local Circle bootstrap
settld setup openclaw ... --wallet-bootstrap local --circle-api-key 'TEST_API_KEY:...'

# force hosted wallet bootstrap
settld setup openclaw ... --wallet-bootstrap remote
```

This orchestrates:

- Circle wallet/token/env bootstrap
- OpenClaw MCP host config write
- Starter policy apply
- MCP smoke check

Each command below does all of this:

- writes Settld MCP config for the selected host
- sets runtime env values for that host config
- auto-generates `SETTLD_PAID_TOOLS_AGENT_PASSPORT` for paid tool policy binding
- applies starter policy profile `engineering-spend`
- runs a smoke check (`settld.about`)

### Codex

```bash
settld setup --non-interactive --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke
```

### Claude

```bash
settld setup --non-interactive --host claude --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke
```

### Cursor

```bash
settld setup --non-interactive --host cursor --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke
```

### OpenClaw

```bash
settld setup --non-interactive --host openclaw --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke
```

Managed wallet bootstrap mode (wallet env minted by onboarding endpoint):

```bash
settld setup --non-interactive --host codex --base-url https://api.settld.work --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode managed --wallet-bootstrap remote --profile-id engineering-spend --smoke
```

Common setup flags:

- `--skip-profile-apply`: host setup only, no policy apply
- `--wallet-mode none`: skip wallet rails entirely
- `--dry-run`: preview file updates only (no writes)

Sanity check anytime:

```bash
npm run mcp:probe
```

## 2) New policy wizard flow

If you only need a starter policy, keep `--profile-id engineering-spend` in `settld setup` and you are done.

If you want to build an SLA policy config step by step:

1. List templates:

```bash
npm run trust:wizard -- list --format text
```

2. Preview one template:

```bash
npm run trust:wizard -- show --template delivery_standard_v1 --format text
```

3. Render your policy config file:

```bash
npm run trust:wizard -- render --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --out ./policy.delivery.json --format json
```

4. Validate your overrides:

```bash
npm run trust:wizard -- validate --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --format json
```

## 3) Manual host config fallback

If you skip `settld setup`, export env in your shell:

```bash
export SETTLD_BASE_URL='http://127.0.0.1:3000'
export SETTLD_TENANT_ID='tenant_default'
export SETTLD_API_KEY='sk_live_xxx.yyy'
export SETTLD_PAID_TOOLS_BASE_URL='http://127.0.0.1:8402'
export SETTLD_PAID_TOOLS_AGENT_PASSPORT='{"schemaVersion":"X402AgentPassport.v1","sponsorRef":"sponsor_default","sponsorWalletRef":"wallet_engineering-spend","agentKeyId":"sk_live_xxx","policyRef":"engineering-spend","policyVersion":1,"delegationDepth":0}'
```

Default MCP stdio server definition:

```json
{
  "name": "settld",
  "command": "npx",
  "args": ["-y", "settld-mcp"],
  "env": {
    "SETTLD_BASE_URL": "http://127.0.0.1:3000",
    "SETTLD_TENANT_ID": "tenant_default",
    "SETTLD_API_KEY": "sk_live_xxx.yyy",
    "SETTLD_PAID_TOOLS_BASE_URL": "http://127.0.0.1:8402",
    "SETTLD_PAID_TOOLS_AGENT_PASSPORT": "{\"schemaVersion\":\"X402AgentPassport.v1\",\"sponsorRef\":\"sponsor_default\",\"sponsorWalletRef\":\"wallet_engineering-spend\",\"agentKeyId\":\"sk_live_xxx\",\"policyRef\":\"engineering-spend\",\"policyVersion\":1,\"delegationDepth\":0}"
  }
}
```

If your host cannot run stdio commands, use HTTP bridge:

```bash
MCP_HTTP_PORT=8787 npm run mcp:http
```

Then point the host to:

- MCP endpoint: `http://127.0.0.1:8787/rpc`
- Health endpoint: `http://127.0.0.1:8787/healthz`

## 4) OpenClaw skill package notes

If you publish Settld for OpenClaw/ClawHub as a skill package, use:

- `docs/integrations/openclaw/settld-mcp-skill/SKILL.md`
- `docs/integrations/openclaw/settld-mcp-skill/mcp-server.example.json`
- `docs/integrations/openclaw/CLAWHUB_PUBLISH_CHECKLIST.md`

Local check:

```bash
npm run mcp:probe -- --call settld.about '{}'
```

## 5) 5-minute validation checklist

0. Run hosted-style smoke once:

```bash
settld doctor
```

This prints a clear `PASS`/`FAIL` summary and the report path (default: `artifacts/ops/mcp-host-smoke.json`).

1. `npm run mcp:probe` passes locally.
2. Host discovers `settld.*` tools.
3. `settld.about` succeeds.
4. A paid tool call succeeds (`settld.exa_search_paid` or `settld.weather_current_paid`).
5. Artifact bundle exists from demo runs:
   - `artifacts/mcp-paid-exa/.../summary.json`
   - `artifacts/mcp-paid-weather/.../summary.json`

## 6) Troubleshooting

- `SETTLD_API_KEY must be a non-empty string`
  - API key is missing in host MCP env.
- Host cannot run `npx`
  - Install Node 20+ and ensure `npx` is in `PATH`, or use HTTP bridge mode.
- Paid tool call fails with gateway/connectivity errors
  - Check `SETTLD_PAID_TOOLS_BASE_URL` and confirm the gateway is running.
- Paid tool call fails with policy/passport validation errors
  - Re-run `settld setup` so the host MCP config gets a fresh `SETTLD_PAID_TOOLS_AGENT_PASSPORT`.
