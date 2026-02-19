# Quickstart: MCP Host Integrations (Claude, Cursor, Codex, OpenClaw)

Use this when you want to connect a real agent host to Settld MCP in under 5 minutes.

For core MCP flow details and paid-tool artifacts, see `docs/QUICKSTART_MCP.md`.

## 0) Prerequisites

- Node.js 20+
- Settld API reachable (`http://127.0.0.1:3000` for local or your hosted API)
- A tenant-scoped Settld API key (`keyId.secret` format)

Export env once in your shell:

```bash
export SETTLD_BASE_URL='http://127.0.0.1:3000'
export SETTLD_TENANT_ID='tenant_default'
export SETTLD_API_KEY='sk_live_xxx.yyy'
export SETTLD_PAID_TOOLS_BASE_URL='http://127.0.0.1:8402'
```

Sanity check the server before wiring any host:

```bash
npm run mcp:probe
```

## 1) Canonical MCP Server Definition

Most hosts that support MCP stdio need a command, args, and env.
Use this as your default server config:

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

If your host cannot spawn stdio commands, use HTTP bridge:

```bash
MCP_HTTP_PORT=8787 npm run mcp:http
```

Then point the host at:

- MCP endpoint: `http://127.0.0.1:8787/rpc`
- Health endpoint: `http://127.0.0.1:8787/healthz`

## 2) Claude

1. Open Claude MCP settings.
2. Add a new MCP server using the canonical config above.
3. Save and reconnect.
4. Ask Claude to call:
   - `settld.about`
   - `settld.exa_search_paid` with `{"query":"dentist near me chicago","numResults":3}`

Expected behavior:

- First paid call triggers x402 challenge/authorize/retry automatically in the MCP wrapper.
- Tool result includes Settld verification/settlement headers.

## 3) Cursor

1. Open Cursor MCP settings.
2. Add an MCP server using the same canonical stdio definition.
3. Reconnect tools.
4. Run:
   - `settld.about`
   - `settld.weather_current_paid` with `{"city":"Chicago","unit":"f"}`

Expected behavior:

- Paid tool returns response body plus `x-settld-*` headers captured by the tool bridge.

## 4) Codex

1. Open Codex MCP/tooling configuration.
2. Register Settld with the canonical stdio definition.
3. Reload tool discovery.
4. Run:
   - `settld.about`
   - `settld.exa_search_paid`

Expected behavior:

- Paid call resolves through the same x402 autopay flow.

## 5) OpenClaw

For OpenClaw, package Settld as a skill that declares MCP setup instructions.
Reference skill payload:

- `docs/integrations/openclaw/settld-mcp-skill/SKILL.md`
- `docs/integrations/openclaw/settld-mcp-skill/mcp-server.example.json`
- `docs/integrations/openclaw/CLAWHUB_PUBLISH_CHECKLIST.md`

Minimum skill payload should include:

- Name/description
- MCP server command (`npx -y settld-mcp`)
- Required env vars (`SETTLD_BASE_URL`, `SETTLD_TENANT_ID`, `SETTLD_API_KEY`, optional `SETTLD_PAID_TOOLS_BASE_URL`)
- A smoke prompt using `settld.about`

You can test locally first with:

```bash
npm run mcp:probe -- --call settld.about '{}'
```

## 6) 5-Minute Validation Checklist

1. `npm run mcp:probe` passes locally.
2. Host discovers Settld tools (`tools/list` includes `settld.*`).
3. `settld.about` succeeds.
4. One paid tool call succeeds (`settld.exa_search_paid` or `settld.weather_current_paid`).
5. You can see a resulting artifact bundle from paid demo runs:
   - `artifacts/mcp-paid-exa/.../summary.json`
   - `artifacts/mcp-paid-weather/.../summary.json`

## 7) Troubleshooting

- `SETTLD_API_KEY must be a non-empty string`
  - API key not injected into MCP server env.
- Host cannot run `npx`
  - Install Node 20+ and ensure `npx` is on PATH, or run HTTP bridge mode.
- Paid tool returns gateway/connectivity errors
  - Confirm `SETTLD_PAID_TOOLS_BASE_URL` points to a running gateway.
