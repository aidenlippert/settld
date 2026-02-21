# Quickstart: MCP Host Integrations (Codex, Claude, Cursor, OpenClaw)

Use this when you want to connect a host app to Settld MCP quickly.

For deeper MCP flow details and artifact examples, see `docs/QUICKSTART_MCP.md`.

## 0) Prerequisites

- Node.js 20+
- Settld API reachable (`http://127.0.0.1:3000` for local or your hosted API)
- Tenant API key (`keyId.secret`)

## 1) One-command host setup (recommended)

Each command below does all of this:

- writes Settld MCP config for the selected host
- sets runtime env values for that host config
- applies starter policy profile `engineering-spend`
- runs a smoke check (`settld.about`)

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

Hosted bootstrap mode (runtime key minted by onboarding endpoint):

```bash
settld setup --yes --mode bootstrap --host codex --base-url https://api.settld.work --tenant-id tenant_default --bootstrap-api-key mlk_admin_xxx --bootstrap-key-id sk_runtime --bootstrap-scopes runs:read,runs:write --idempotency-key setup_codex_bootstrap_1
```

Common setup flags:

- `--skip-profile-apply`: host setup only, no policy apply
- `--profile-file ./path/to/profile.json`: use your own profile file
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
    "SETTLD_PAID_TOOLS_BASE_URL": "http://127.0.0.1:8402"
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
npm run test:ci:mcp-host-smoke
```

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
