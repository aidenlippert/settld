#!/usr/bin/env node
/**
 * Sprint 23 MCP spike: JSON-RPC 2.0 over stdio exposing curated Settld tools.
 *
 * - Transport: stdio
 * - Framing: newline-delimited JSON; also accepts Content-Length framed messages.
 * - Auth: x-proxy-api-key (SETTLD_API_KEY)
 *
 * Production hardening (SSE, auth variants, rate limiting, telemetry) is Sprint 25+.
 */

import crypto from "node:crypto";

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function jsonRpcError(code, message, data = null) {
  return { code, message, data };
}

function redactSecrets(value) {
  // Best-effort redaction for logs/results; do not rely on this for security.
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.startsWith("sk_") || value.startsWith("tok_")) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (String(k).toLowerCase().includes("secret") || String(k).toLowerCase().includes("password") || String(k).toLowerCase().includes("token")) {
        out[k] = "[redacted]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function contentText(text) {
  return { type: "text", text: String(text ?? "") };
}

function asTextResult(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [contentText(text)], isError: false };
}

function asErrorResult(err) {
  const out = {
    error: true,
    message: err?.message ?? String(err ?? "error"),
    details: err?.details ?? null,
    statusCode: err?.statusCode ?? null
  };
  return { content: [contentText(JSON.stringify(out, null, 2))], isError: true };
}

function makeIdempotencyKey(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function generateEd25519PublicKeyPem() {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" });
}

class StdioJsonRpcStream {
  constructor({ input, output }) {
    this.input = input;
    this.output = output;
    this._buf = Buffer.alloc(0);
    this._onMessage = null;
    this._onError = null;
    input.on("data", (chunk) => this._onData(chunk));
    input.on("error", (err) => this._emitError(err));
  }

  onMessage(fn) {
    this._onMessage = fn;
  }

  onError(fn) {
    this._onError = fn;
  }

  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    // Newline-delimited JSON output is sufficient for MCP clients; we also accept Content-Length on input.
    this.output.write(payload);
    this.output.write("\n");
  }

  _emitMessage(text) {
    if (this._onMessage) this._onMessage(text);
  }

  _emitError(err) {
    if (this._onError) this._onError(err);
  }

  _onData(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._buf = Buffer.concat([this._buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this._buf.length === 0) return;

      // Content-Length framed messages (LSP-style).
      const prefix = this._buf.slice(0, 15).toString("utf8");
      if (prefix === "Content-Length:") {
        const headerEnd = this._buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = this._buf.slice(0, headerEnd).toString("utf8");
        const m = header.match(/Content-Length:\\s*(\\d+)/i);
        if (!m) {
          this._emitError(new Error("invalid Content-Length framing (missing length)"));
          this._buf = Buffer.alloc(0);
          return;
        }
        const len = Number(m[1]);
        if (!Number.isFinite(len) || len < 0) {
          this._emitError(new Error("invalid Content-Length framing (bad length)"));
          this._buf = Buffer.alloc(0);
          return;
        }
        const start = headerEnd + 4;
        const end = start + len;
        if (this._buf.length < end) return;
        const jsonText = this._buf.slice(start, end).toString("utf8");
        this._buf = this._buf.slice(end);
        this._emitMessage(jsonText);
        continue;
      }

      // Newline-delimited JSON messages.
      const nl = this._buf.indexOf("\n");
      if (nl === -1) return;
      const line = this._buf.slice(0, nl).toString("utf8").trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      this._emitMessage(line);
    }
  }
}

function makeSettldClient({ baseUrl, tenantId, apiKey, protocol }) {
  let cachedProtocol = protocol || null;

  async function discoverProtocol() {
    if (cachedProtocol) return cachedProtocol;
    try {
      const res = await fetch(new URL("/healthz", baseUrl), {
        method: "GET",
        headers: {
          "x-proxy-tenant-id": tenantId,
          "x-proxy-api-key": apiKey
        }
      });
      const hdr = res.headers.get("x-settld-protocol");
      if (hdr && String(hdr).trim() !== "") {
        cachedProtocol = String(hdr).trim();
        return cachedProtocol;
      }
    } catch {
      // Ignore; we will fallback.
    }
    cachedProtocol = cachedProtocol || "1.0";
    return cachedProtocol;
  }

  async function requestJson(path, { method = "GET", body = null, write = false, headers = {}, idem = null } = {}) {
    const url = new URL(path, baseUrl);
    const protocolHeader = write ? await discoverProtocol() : null;
    const h = {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-api-key": apiKey,
      ...(write ? { "x-settld-protocol": protocolHeader } : {}),
      ...(body !== null ? { "content-type": "application/json" } : {}),
      ...(idem ? { "x-idempotency-key": String(idem) } : {}),
      ...headers
    };
    const res = await fetch(url, {
      method,
      headers: h,
      body: body === null ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg =
        (json && (json.message || json.error)) ? String(json.message || json.error) :
        text ? String(text) :
        `HTTP ${res.status}`;
      const err = new Error(msg);
      err.statusCode = res.status;
      err.details = json && (json.details || json.errorDetails) ? (json.details || json.errorDetails) : json;
      throw err;
    }
    return json;
  }

  async function getRunPrevChainHash({ agentId, runId }) {
    const out = await requestJson(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, { method: "GET" });
    const events = Array.isArray(out?.events) ? out.events : [];
    const last = events.length ? events[events.length - 1] : null;
    const prev = last && typeof last.chainHash === "string" && last.chainHash.trim() !== "" ? last.chainHash : null;
    return { prevChainHash: prev, events };
  }

  return {
    discoverProtocol,
    requestJson,
    getRunPrevChainHash
  };
}

function buildTools() {
  return [
    {
      name: "settld.create_agreement",
      description:
        "Create a marketplace-backed agreement + run by registering payer/payee agents, funding payer, creating an RFQ, submitting a bid, and accepting it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          amountCents: { type: "integer", minimum: 1, default: 500 },
          currency: { type: "string", default: "USD" },
          title: { type: "string", default: "MCP spike agreement" },
          description: { type: ["string", "null"], default: null },
          capability: { type: "string", default: "agent-task:demo" },
          disputeWindowDays: { type: "integer", minimum: 0, default: 7 },
          payerDisplayName: { type: "string", default: "MCP Payer" },
          payeeDisplayName: { type: "string", default: "MCP Payee" }
        }
      }
    },
    {
      name: "settld.submit_evidence",
      description: "Append an EVIDENCE_ADDED event to an agent run (handles expected prevChainHash precondition).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "runId", "evidenceRef"],
        properties: {
          agentId: { type: "string" },
          runId: { type: "string" },
          evidenceRef: { type: "string" }
        }
      }
    },
    {
      name: "settld.settle_run",
      description: "Append a RUN_COMPLETED or RUN_FAILED event (triggers settlement auto-resolution).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "runId"],
        properties: {
          agentId: { type: "string" },
          runId: { type: "string" },
          outcome: { type: "string", enum: ["completed", "failed"], default: "completed" },
          outputRef: { type: ["string", "null"], default: null },
          errorCode: { type: ["string", "null"], default: null },
          errorMessage: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "settld.open_dispute",
      description: "Open a dispute on a resolved run settlement (requires dispute window still open).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          reason: { type: ["string", "null"], default: null },
          evidenceRefs: { type: "array", items: { type: "string" }, default: [] },
          waitMs: {
            type: "integer",
            minimum: 0,
            default: 0,
            description: "Optional: wait up to this many milliseconds for settlement resolution before opening the dispute."
          },
          disputeType: { type: ["string", "null"], default: null },
          priority: { type: ["string", "null"], default: null },
          channel: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "settld.about",
      description: "Return MCP server configuration (redacted).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    }
  ];
}

async function main() {
  const baseUrl = process.env.SETTLD_BASE_URL || "http://127.0.0.1:3000";
  const tenantId = process.env.SETTLD_TENANT_ID || "tenant_default";
  const apiKey = process.env.SETTLD_API_KEY || "";
  const protocol = process.env.SETTLD_PROTOCOL || null;

  assertNonEmptyString(baseUrl, "SETTLD_BASE_URL");
  assertNonEmptyString(tenantId, "SETTLD_TENANT_ID");
  assertNonEmptyString(apiKey, "SETTLD_API_KEY");

  // Operational hint: this server speaks JSON-RPC over stdin/stdout (MCP stdio transport).
  // Keep stdout strictly for JSON-RPC messages; print hints to stderr only.
  process.stderr.write("[mcp] ready (stdio). Use `npm run mcp:probe` or an MCP client; do not paste shell prompts.\n");

  const client = makeSettldClient({ baseUrl, tenantId, apiKey, protocol });
  const tools = buildTools();
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const stream = new StdioJsonRpcStream({ input: process.stdin, output: process.stdout });
  stream.onError((err) => {
    // Never write logs to stdout (reserved for JSON-RPC). stderr only.
    process.stderr.write(`[mcp] stream error: ${err?.message ?? err}\n`);
  });

  let negotiatedProtocolVersion = null;

  stream.onMessage(async (text) => {
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      // Invalid JSON from client: ignore (spike) but report on stderr.
      process.stderr.write(`[mcp] invalid json: ${String(parsed.error?.message ?? parsed.error)}\n`);
      return;
    }
    const msg = parsed.value;
    const id = msg?.id;
    const method = msg?.method;
    const isNotification = id === undefined || id === null;

    if (typeof method !== "string" || method.trim() === "") {
      if (!isNotification) {
        stream.send({ jsonrpc: "2.0", id, error: jsonRpcError(-32600, "Invalid Request") });
      }
      return;
    }

    try {
      if (method === "initialize") {
        const pv = msg?.params?.protocolVersion ? String(msg.params.protocolVersion) : null;
        negotiatedProtocolVersion = pv || negotiatedProtocolVersion || "2024-11-05";
        if (!isNotification) {
          stream.send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: negotiatedProtocolVersion,
              serverInfo: { name: "settld-mcp-spike", version: "s23" },
              capabilities: { tools: {} }
            }
          });
        }
        return;
      }

      if (method === "ping") {
        if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      if (method === "initialized" || method === "notifications/initialized") {
        return;
      }

      if (method === "tools/list") {
        if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: { tools } });
        return;
      }

      if (method === "tools/call") {
        const name = msg?.params?.name ? String(msg.params.name) : "";
        const args = msg?.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
        if (!toolByName.has(name)) {
          if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: { content: [contentText(`unknown tool: ${name}`)], isError: true } });
          return;
        }
        const started = nowMs();
        let result = null;
        try {
          if (name === "settld.about") {
            const discovered = await client.discoverProtocol();
            result = {
              ok: true,
              server: { name: "settld-mcp-spike", version: "s23" },
              config: redactSecrets({ baseUrl, tenantId, protocol: discovered })
            };
          } else if (name === "settld.create_agreement") {
            const amountCents = Number(args?.amountCents ?? 500);
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
            const currency = args?.currency ? String(args.currency).trim().toUpperCase() : "USD";
            const title = args?.title ? String(args.title).trim() : "MCP spike agreement";
            const description = args?.description === undefined ? null : args.description === null ? null : String(args.description);
            const capability = args?.capability ? String(args.capability).trim() : "agent-task:demo";
            const disputeWindowDaysRaw = args?.disputeWindowDays ?? 7;
            const disputeWindowDays = Number(disputeWindowDaysRaw);
            if (!Number.isSafeInteger(disputeWindowDays) || disputeWindowDays < 0) {
              throw new TypeError("disputeWindowDays must be a non-negative safe integer");
            }
            const payerDisplayName = args?.payerDisplayName ? String(args.payerDisplayName).trim() : "MCP Payer";
            const payeeDisplayName = args?.payeeDisplayName ? String(args.payeeDisplayName).trim() : "MCP Payee";

            // Register payer + payee agents.
            const payerPublicKeyPem = generateEd25519PublicKeyPem();
            const payeePublicKeyPem = generateEd25519PublicKeyPem();
            const payer = await client.requestJson("/agents/register", {
              method: "POST",
              body: { publicKeyPem: payerPublicKeyPem, displayName: payerDisplayName },
              idem: makeIdempotencyKey("mcp_agents_register_payer")
            });
            const payee = await client.requestJson("/agents/register", {
              method: "POST",
              body: { publicKeyPem: payeePublicKeyPem, displayName: payeeDisplayName },
              idem: makeIdempotencyKey("mcp_agents_register_payee")
            });
            const payerAgentId = payer?.agentIdentity?.agentId;
            const payeeAgentId = payee?.agentIdentity?.agentId;
            assertNonEmptyString(payerAgentId, "payerAgentId");
            assertNonEmptyString(payeeAgentId, "payeeAgentId");

            // Fund payer so escrow can lock later.
            await client.requestJson(`/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`, {
              method: "POST",
              write: true,
              body: { amountCents: amountCents * 2, currency },
              idem: makeIdempotencyKey("mcp_wallet_credit")
            });

            // Create RFQ.
            const rfqOut = await client.requestJson("/marketplace/rfqs", {
              method: "POST",
              body: {
                title,
                description,
                capability,
                posterAgentId: payerAgentId,
                budgetCents: amountCents,
                currency,
                metadata: { source: "mcp_spike" }
              },
              idem: makeIdempotencyKey("mcp_rfq")
            });
            const rfqId = rfqOut?.rfq?.rfqId;
            assertNonEmptyString(rfqId, "rfqId");

            // Submit bid.
            const bidOut = await client.requestJson(`/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`, {
              method: "POST",
              body: {
                bidderAgentId: payeeAgentId,
                amountCents,
                currency,
                etaSeconds: 60,
                note: "MCP spike bid"
              },
              idem: makeIdempotencyKey("mcp_bid")
            });
            const bidId = bidOut?.bid?.bidId;
            assertNonEmptyString(bidId, "bidId");

            // Accept bid => creates run + settlement + agreement.
            const acceptOut = await client.requestJson(`/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`, {
              method: "POST",
              body: {
                bidId,
                payerAgentId,
                disputeWindowDays,
                settlement: { payerAgentId }
              },
              idem: makeIdempotencyKey("mcp_accept")
            });
            const runId = acceptOut?.run?.runId ?? acceptOut?.run?.id ?? acceptOut?.run?.runId;
            const settlementId = acceptOut?.settlement?.settlementId ?? null;
            const agreementId = acceptOut?.agreement?.agreementId ?? acceptOut?.agreement?.id ?? null;

            result = {
              ok: true,
              payerAgentId,
              payeeAgentId,
              rfqId,
              bidId,
              runId,
              settlementId,
              agreementId,
              raw: redactSecrets(acceptOut)
            };
          } else if (name === "settld.submit_evidence") {
            const agentId = String(args?.agentId ?? "").trim();
            const runId = String(args?.runId ?? "").trim();
            const evidenceRef = String(args?.evidenceRef ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            assertNonEmptyString(runId, "runId");
            assertNonEmptyString(evidenceRef, "evidenceRef");

            const head = await client.getRunPrevChainHash({ agentId, runId });
            const out = await client.requestJson(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, {
              method: "POST",
              write: true,
              headers: { "x-proxy-expected-prev-chain-hash": head.prevChainHash === null ? "null" : String(head.prevChainHash) },
              // Note: event schemaVersion is an integer (default=1). Omit to use the default.
              body: { type: "EVIDENCE_ADDED", payload: { evidenceRef } },
              idem: makeIdempotencyKey("mcp_run_event_evidence")
            });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "settld.settle_run") {
            const agentId = String(args?.agentId ?? "").trim();
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            assertNonEmptyString(runId, "runId");

            const outcome = args?.outcome ? String(args.outcome).trim().toLowerCase() : "completed";
            if (outcome !== "completed" && outcome !== "failed") throw new TypeError("outcome must be completed|failed");

            const head = await client.getRunPrevChainHash({ agentId, runId });
            const body =
              outcome === "completed"
                ? { type: "RUN_COMPLETED", payload: { outputRef: args?.outputRef ?? null, metrics: null } }
                : { type: "RUN_FAILED", payload: { code: args?.errorCode ?? null, message: args?.errorMessage ?? null } };

            const out = await client.requestJson(`/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events`, {
              method: "POST",
              write: true,
              headers: { "x-proxy-expected-prev-chain-hash": head.prevChainHash === null ? "null" : String(head.prevChainHash) },
              body,
              idem: makeIdempotencyKey("mcp_run_event_terminal")
            });
            let settlement = null;
            try {
              settlement = await client.requestJson(`/runs/${encodeURIComponent(runId)}/settlement`, { method: "GET" });
            } catch {
              settlement = null;
            }
            result = { ok: true, ...redactSecrets(out), settlement };
          } else if (name === "settld.open_dispute") {
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            const evidenceRefs = Array.isArray(args?.evidenceRefs) ? args.evidenceRefs.map((v) => String(v ?? "").trim()).filter(Boolean) : [];

            const waitMsRaw = args?.waitMs ?? 0;
            const waitMs = Number(waitMsRaw);
            if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError("waitMs must be a non-negative safe integer");
            const deadline = nowMs() + Math.min(waitMs, 60_000);

            if (waitMs > 0) {
              // Wait for settlement resolution so `open` doesn't immediately 409 on interactive demos.
              // (The API requires settlement.status != locked to open a dispute.)
              // eslint-disable-next-line no-constant-condition
              while (true) {
                let settlement = null;
                try {
                  settlement = await client.requestJson(`/runs/${encodeURIComponent(runId)}/settlement`, { method: "GET" });
                } catch {
                  settlement = null;
                }
                const status = String(settlement?.status ?? "").toLowerCase();
                if (status && status !== "locked") break;
                if (nowMs() >= deadline) break;
                await sleep(500);
              }
            }
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/dispute/open`, {
              method: "POST",
              write: true,
              body: {
                reason: args?.reason ?? null,
                evidenceRefs,
                disputeType: args?.disputeType ?? null,
                disputePriority: args?.priority ?? null,
                disputeChannel: args?.channel ?? null
              },
              idem: makeIdempotencyKey("mcp_dispute_open")
            });
            result = { ok: true, ...redactSecrets(out) };
          } else {
            throw new Error(`tool not implemented: ${name}`);
          }

          const durationMs = nowMs() - started;
          const toolResult = { ...asTextResult({ tool: name, durationMs, result }), isError: false };
          if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: toolResult });
        } catch (err) {
          const durationMs = nowMs() - started;
          const toolResult = { ...asErrorResult(err), content: [contentText(JSON.stringify({ tool: name, durationMs, error: err?.message ?? String(err) }, null, 2))] };
          if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: toolResult });
        }
        return;
      }

      // Unknown method.
      if (!isNotification) {
        stream.send({ jsonrpc: "2.0", id, error: jsonRpcError(-32601, `Method not found: ${method}`) });
      }
    } catch (err) {
      if (!isNotification) {
        stream.send({ jsonrpc: "2.0", id, error: jsonRpcError(-32603, "Internal error", { message: err?.message ?? String(err) }) });
      }
    }
  });
}

main().catch((err) => {
  process.stderr.write(`[mcp] fatal: ${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 1;
});
