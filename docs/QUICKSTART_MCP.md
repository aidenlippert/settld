# Quickstart: MCP (Stdio Spike)

This quickstart connects an MCP-compatible agent/client to Settld using the Sprint 23 `stdio` MCP spike server.

## Prerequisites

- Node.js 20+
- A Settld API key with appropriate scopes (`keyId.secret` format)
- Settld API reachable (local `npm run dev:api` or hosted)

## Run The MCP Server

Set environment variables:

```bash
export SETTLD_BASE_URL='https://api.settld.work'   # or http://127.0.0.1:3000
export SETTLD_TENANT_ID='tenant_default'
export SETTLD_API_KEY='sk_live_xxx.yyy'            # keyId.secret (do not commit)
export SETTLD_PROTOCOL='1.0'                       # optional; server will try to auto-discover
```

Start the server:

```bash
npm run mcp:server
```

The server speaks JSON-RPC 2.0 over `stdio` and exposes curated tools.
If you run it in a normal terminal, it will just sit waiting for JSON-RPC input (this is expected). Use `mcp:probe` below to validate it end-to-end.

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

4. Open a dispute (only valid within the dispute window):

Tool: `settld.open_dispute`

```json
{
  "runId": "<runId>",
  "reason": "Disputing for demo purposes",
  "evidenceRefs": ["evidence://demo/dispute/1"],
  "waitMs": 5000
}
```

## Notes

- Writes require `x-settld-protocol`. The MCP server sets this automatically for write calls.
- Run event appends require `x-proxy-expected-prev-chain-hash`. The MCP server fetches the current head and supplies it.
- This is a spike (Sprint 23). Production hardening (SSE transport, rate limiting, etc.) is planned for Sprint 25.
