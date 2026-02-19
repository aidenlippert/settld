# Quickstart: MCP (Stdio Spike)

This quickstart connects an MCP-compatible agent/client to Settld using the Sprint 23 `stdio` MCP spike server.

For host-specific setup (Claude, Cursor, Codex, OpenClaw), see `docs/QUICKSTART_MCP_HOSTS.md`.

## Prerequisites

- Node.js 20+
- A Settld API key with appropriate scopes (`keyId.secret` format)
- Settld API reachable (local `npm run dev:api` or hosted)

## One-Command Local Demo (Paid MCP Exa Flow)

Boots local API + provider wrapper + x402 gateway, runs MCP `settld.exa_search_paid`, verifies signatures/tokens, and writes an artifact bundle.

To scaffold your own paid tool server quickly:

```bash
npx create-settld-paid-tool my-paid-tool
```

Run provider conformance/publish with machine-readable artifacts:

```bash
npm run provider:conformance -- \
  --manifest ./paid-tool-manifest.json \
  --base-url http://127.0.0.1:9402 \
  --api-url http://127.0.0.1:3000 \
  --api-key "$SETTLD_API_KEY" \
  --json-out artifacts/provider-conformance.json

npm run provider:publish -- \
  --manifest ./paid-tool-manifest.json \
  --base-url http://127.0.0.1:9402 \
  --api-url http://127.0.0.1:3000 \
  --api-key "$SETTLD_API_KEY" \
  --json-out artifacts/provider-publication.json \
  --conformance-json-out artifacts/provider-conformance-from-publish.json
```

Notes:

- `provider:conformance` exits non-zero when verdict is not `ok` (use `--allow-fail` to keep exit code `0`).
- `provider:publish` exits non-zero when `runConformance` is enabled and publication is not `certified` (use `--allow-fail` to keep exit code `0`).

```bash
npm run demo:mcp-paid-exa
npm run demo:mcp-paid-weather
npm run demo:mcp-paid-llm
```

Circle sandbox mode (real reserve path):

```bash
SETTLD_DEMO_CIRCLE_MODE=sandbox \
X402_REQUIRE_EXTERNAL_RESERVE=1 \
npm run demo:mcp-paid-exa -- --circle=sandbox
```

Circle sandbox mode with batch settlement execution:

```bash
SETTLD_DEMO_CIRCLE_MODE=sandbox \
SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1 \
SETTLD_DEMO_BATCH_PROVIDER_WALLET_ID="$CIRCLE_WALLET_ID_ESCROW" \
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
- `batch-payout-registry.json` (when `SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1`)
- `batch-worker-state.json` (when `SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1`)
- `batch-settlement.json` (when `SETTLD_DEMO_RUN_BATCH_SETTLEMENT=1`)

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

## x402 Gate Smoke (create -> verify -> get)

Run an end-to-end x402 gate flow over MCP with explicit idempotency keys:

```bash
npm run -s mcp:probe -- --x402-smoke
```

This performs:

1. `settld.x402_gate_create`
2. `settld.x402_gate_verify` (auto-authorize enabled by default)
3. `settld.x402_gate_get`

You can override payloads from a JSON file:

```bash
cat > /tmp/settld-mcp-x402-smoke.json <<'JSON'
{
  "create": {
    "amountCents": 250,
    "idempotencyKey": "mcp_probe_create_custom_1"
  },
  "verify": {
    "idempotencyKey": "mcp_probe_verify_custom_1",
    "authorizeIdempotencyKey": "mcp_probe_auth_custom_1"
  }
}
JSON

npm run -s mcp:probe -- --x402-smoke --x402-smoke-file /tmp/settld-mcp-x402-smoke.json
```

## Agreement Delegation Tools (create/list)

Create a delegation edge and list it via MCP:

```bash
cat > /tmp/settld-mcp-delegation-create.json <<'JSON'
{
  "parentAgreementHash": "1111111111111111111111111111111111111111111111111111111111111111",
  "childAgreementHash": "2222222222222222222222222222222222222222222222222222222222222222",
  "delegatorAgentId": "agt_parent",
  "delegateeAgentId": "agt_child",
  "budgetCapCents": 500,
  "idempotencyKey": "mcp_probe_delegation_create_1"
}
JSON

npm run -s mcp:probe -- --call-file settld.agreement_delegation_create /tmp/settld-mcp-delegation-create.json
npm run -s mcp:probe -- --call settld.agreement_delegation_list '{"agreementHash":"1111111111111111111111111111111111111111111111111111111111111111","status":"active","limit":20,"offset":0}'
```

`settld.agreement_delegation_create` responses include `delegation.delegationHash` for deterministic orchestration and audit bindings.

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

## Paid Tool Flows (`settld.exa_search_paid`, `settld.weather_current_paid`)

Both paid tools exercise the same x402 path from MCP:

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

Exa call result includes:

- `response`: Exa-style search body.
- `headers`: captured `x-settld-*` verification/settlement headers.

Weather call example:

```bash
cat > /tmp/settld-mcp-weather.json <<'JSON'
{"city":"Chicago","unit":"f"}
JSON

SETTLD_PAID_TOOLS_BASE_URL='http://127.0.0.1:8402' \
npm run -s mcp:probe -- --call-file settld.weather_current_paid /tmp/settld-mcp-weather.json
```

## Notes

- Writes require `x-settld-protocol`. The MCP server sets this automatically for write calls.
- Run event appends require `x-proxy-expected-prev-chain-hash`. The MCP server fetches the current head and supplies it.
- This is a spike (Sprint 23). Production hardening (SSE transport, rate limiting, etc.) is planned for Sprint 25.
