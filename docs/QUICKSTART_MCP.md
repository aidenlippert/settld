# Quickstart: MCP (Stdio Spike)

This quickstart connects an MCP-compatible agent/client to Settld using the Sprint 23 `stdio` MCP spike server.

## Prerequisites

- Node.js 20+
- A Settld API key with appropriate scopes (`keyId.secret` format)
- Settld API reachable (local `npm run dev:api` or hosted)

## One-Command Local Demo (Paid MCP Exa Flow)

Boots local API + provider wrapper + x402 gateway, runs MCP `settld.exa_search_paid`, verifies signatures/tokens, and writes an artifact bundle.

```bash
npm run demo:mcp-paid-exa
```

Circle sandbox mode (real reserve path):

```bash
SETTLD_DEMO_CIRCLE_MODE=sandbox \
X402_REQUIRE_EXTERNAL_RESERVE=1 \
npm run demo:mcp-paid-exa -- --circle=sandbox
```

Success output:

```text
PASS artifactDir=artifacts/mcp-paid-exa/...
gateId=...
```

Artifact bundle includes:

- `summary.json`
- `mcp-call.raw.json`
- `mcp-call.parsed.json`
- `response-body.json`
- `gate-state.json`
- `reserve-state.json`
- `provider-signature-verification.json`
- `settld-pay-token-verification.json`

## Run The MCP Server

Set environment variables:

```bash
export SETTLD_BASE_URL='https://api.settld.work'   # or http://127.0.0.1:3000
export SETTLD_TENANT_ID='tenant_default'
export SETTLD_API_KEY='sk_live_xxx.yyy'            # keyId.secret (do not commit)
export SETTLD_PROTOCOL='1.0'                       # optional; server will try to auto-discover
export SETTLD_PAID_TOOLS_BASE_URL='http://127.0.0.1:8402' # optional; paid x402 tools
```

Start the server:

```bash
npm run mcp:server
```

The server speaks JSON-RPC 2.0 over `stdio` and exposes curated tools.
If you run it in a normal terminal, it will just sit waiting for JSON-RPC input (this is expected). Use `mcp:probe` below to validate it end-to-end.

## Optional: HTTP Gateway (HTTP -> MCP stdio)

This is useful if you can do HTTP calls but cannot spawn a local MCP process.

```bash
export MCP_HTTP_PORT=8787
npm run mcp:http
```

Then send JSON-RPC requests:

```bash
curl -sS http://127.0.0.1:8787/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"curl","version":"0"},"capabilities":{}}}' | jq .
```

## Sanity Check (No Manual JSON Copy/Paste)

```bash
npm run mcp:probe
```

This spawns the MCP server, runs `initialize` and `tools/list`, prints the responses, and exits.

## Live Call Without Shell-JSON Footguns

If your terminal copy/paste keeps inserting line breaks, pass tool arguments via a JSON file:

```bash
cat > /tmp/settld-mcp-create-agreement.json <<'JSON'
{"amountCents":500,"currency":"USD","title":"MCP live probe","capability":"agent-task:demo","disputeWindowDays":7}
JSON

npm run -s mcp:probe -- --call-file settld.create_agreement /tmp/settld-mcp-create-agreement.json
```

Alternative that avoids paste issues entirely:

```bash
jq -n '{amountCents:500,currency:"USD",title:"MCP live probe",capability:"agent-task:demo",disputeWindowDays:7}' \
  > /tmp/settld-mcp-create-agreement.json
```

## Tool Flow (Typical)

1. Create an agreement (marketplace-backed) and a run:

Method: `tools/call`

Tool: `settld.create_agreement`

Arguments example:

```json
{
  "amountCents": 500,
  "currency": "USD",
  "title": "MCP spike agreement",
  "capability": "agent-task:demo",
  "disputeWindowDays": 7
}
```

2. Submit evidence for the run:

Tool: `settld.submit_evidence`

```json
{
  "agentId": "<payeeAgentId from create_agreement>",
  "runId": "<runId from create_agreement>",
  "evidenceRef": "evidence://demo/step-1"
}
```

3. Settle the run:

Tool: `settld.settle_run`

```json
{
  "agentId": "<payeeAgentId>",
  "runId": "<runId>",
  "outcome": "completed",
  "outputRef": "evidence://demo/output"
}
```

4. Resolve the settlement (so it is no longer `locked`):

Tool: `settld.resolve_settlement`

```json
{
  "runId": "<runId>",
  "status": "released",
  "reason": "demo settlement resolution"
}
```

5. Open a dispute (only valid within the dispute window):

Tool: `settld.open_dispute`

```json
{
  "runId": "<runId>",
  "reason": "Disputing for demo purposes",
  "evidenceRefs": ["evidence://demo/dispute/1"],
  "waitMs": 5000
}
```

## Paid Tool Flow (`settld.exa_search_paid`)

`settld.exa_search_paid` exercises the x402 path from MCP:

1. First call returns `402` from the paid endpoint.
2. MCP wrapper retries with `x-settld-gate-id`.
3. Gateway returns `200` and `x-settld-*` verification/settlement headers.

Run the local paid upstream + gateway from `docs/QUICKSTART_X402_GATEWAY.md`, then invoke:

```bash
cat > /tmp/settld-mcp-exa-search.json <<'JSON'
{"query":"dentist near me chicago","numResults":3}
JSON

SETTLD_PAID_TOOLS_BASE_URL='http://127.0.0.1:8402' \
npm run -s mcp:probe -- --call-file settld.exa_search_paid /tmp/settld-mcp-exa-search.json
```

The tool result includes:

- `response`: Exa-style search body.
- `headers`: captured `x-settld-*` verification/settlement headers.

## Notes

- Writes require `x-settld-protocol`. The MCP server sets this automatically for write calls.
- Run event appends require `x-proxy-expected-prev-chain-hash`. The MCP server fetches the current head and supplies it.
- This is a spike (Sprint 23). Production hardening (SSE transport, rate limiting, etc.) is planned for Sprint 25.
