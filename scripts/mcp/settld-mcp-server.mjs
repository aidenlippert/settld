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

import { fetchWithSettldAutopay } from "../../packages/api-sdk/src/x402-autopay.js";

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parseOptionalJsonObject(value, name) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const tryParse = (text) => {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError(`${name} must decode to a JSON object`);
    return parsed;
  };
  try {
    return tryParse(raw);
  } catch {
    try {
      const decoded = Buffer.from(raw, "base64url").toString("utf8");
      return tryParse(decoded);
    } catch (err) {
      throw new TypeError(`${name} must be JSON or base64url-encoded JSON`);
    }
  }
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

function sha256HexText(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim());
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

function makePaidToolsClient({ baseUrl, tenantId, fetchImpl = fetch, agentPassport = null }) {
  const normalizedBaseUrl = (() => {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    return baseUrl.trim();
  })();

  async function exaSearch({ query, numResults = 5 } = {}) {
    if (!normalizedBaseUrl) throw new Error("SETTLD_PAID_TOOLS_BASE_URL is required for settld.exa_search_paid");
    const normalizedQuery = String(query ?? "").trim();
    assertNonEmptyString(normalizedQuery, "query");

    const normalizedNumResultsRaw = Number(numResults ?? 5);
    if (!Number.isSafeInteger(normalizedNumResultsRaw) || normalizedNumResultsRaw < 1 || normalizedNumResultsRaw > 10) {
      throw new TypeError("numResults must be an integer between 1 and 10");
    }
    const normalizedNumResults = normalizedNumResultsRaw;

    const url = new URL("/exa/search", normalizedBaseUrl);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("numResults", String(normalizedNumResults));

    let challenge = null;
    const res = await fetchWithSettldAutopay(
      url,
      {
        method: "GET",
        headers: { "x-proxy-tenant-id": tenantId }
      },
      {
        fetch: fetchImpl,
        ...(agentPassport ? { agentPassport } : {}),
        onChallenge: (metadata) => {
          challenge = metadata;
        }
      }
    );
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.error ?? json?.message ?? text ?? `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.statusCode = res.status;
      err.details = json;
      throw err;
    }

    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith("x-settld-")) headers[k] = v;
    }

    return {
      ok: true,
      query: normalizedQuery,
      numResults: normalizedNumResults,
      response: json,
      headers,
      challenge
    };
  }

  async function weatherCurrent({ city, unit = "c" } = {}) {
    if (!normalizedBaseUrl) throw new Error("SETTLD_PAID_TOOLS_BASE_URL is required for settld.weather_current_paid");
    const normalizedCity = String(city ?? "").trim();
    assertNonEmptyString(normalizedCity, "city");

    const normalizedUnitRaw = String(unit ?? "c").trim().toLowerCase();
    if (normalizedUnitRaw !== "c" && normalizedUnitRaw !== "f") {
      throw new TypeError("unit must be c or f");
    }
    const normalizedUnit = normalizedUnitRaw;

    const url = new URL("/weather/current", normalizedBaseUrl);
    url.searchParams.set("city", normalizedCity);
    url.searchParams.set("unit", normalizedUnit);

    let challenge = null;
    const res = await fetchWithSettldAutopay(
      url,
      {
        method: "GET",
        headers: { "x-proxy-tenant-id": tenantId }
      },
      {
        fetch: fetchImpl,
        ...(agentPassport ? { agentPassport } : {}),
        onChallenge: (metadata) => {
          challenge = metadata;
        }
      }
    );
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.error ?? json?.message ?? text ?? `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.statusCode = res.status;
      err.details = json;
      throw err;
    }

    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith("x-settld-")) headers[k] = v;
    }

    return {
      ok: true,
      city: normalizedCity,
      unit: normalizedUnit,
      response: json,
      headers,
      challenge
    };
  }

  async function llmCompletion({ prompt, model = "gpt-4o-mini", maxTokens = 128 } = {}) {
    if (!normalizedBaseUrl) throw new Error("SETTLD_PAID_TOOLS_BASE_URL is required for settld.llm_completion_paid");
    const normalizedPrompt = String(prompt ?? "").trim();
    assertNonEmptyString(normalizedPrompt, "prompt");

    const normalizedModel = String(model ?? "").trim() || "gpt-4o-mini";
    const normalizedMaxTokensRaw = Number(maxTokens ?? 128);
    if (!Number.isSafeInteger(normalizedMaxTokensRaw) || normalizedMaxTokensRaw < 1 || normalizedMaxTokensRaw > 512) {
      throw new TypeError("maxTokens must be an integer between 1 and 512");
    }
    const normalizedMaxTokens = normalizedMaxTokensRaw;

    const url = new URL("/llm/completions", normalizedBaseUrl);
    url.searchParams.set("prompt", normalizedPrompt);
    url.searchParams.set("model", normalizedModel);
    url.searchParams.set("maxTokens", String(normalizedMaxTokens));

    let challenge = null;
    const res = await fetchWithSettldAutopay(
      url,
      {
        method: "GET",
        headers: { "x-proxy-tenant-id": tenantId }
      },
      {
        fetch: fetchImpl,
        ...(agentPassport ? { agentPassport } : {}),
        onChallenge: (metadata) => {
          challenge = metadata;
        }
      }
    );
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.error ?? json?.message ?? text ?? `HTTP ${res.status}`;
      const err = new Error(String(msg));
      err.statusCode = res.status;
      err.details = json;
      throw err;
    }

    const headers = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith("x-settld-")) headers[k] = v;
    }

    return {
      ok: true,
      prompt: normalizedPrompt,
      model: normalizedModel,
      maxTokens: normalizedMaxTokens,
      response: json,
      headers,
      challenge
    };
  }

  return { exaSearch, weatherCurrent, llmCompletion };
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
      name: "settld.exa_search_paid",
      description: "Execute a paid Exa-style search through the x402 gateway with transparent Settld autopay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          numResults: { type: "integer", minimum: 1, maximum: 10, default: 5 }
        }
      }
    },
    {
      name: "settld.weather_current_paid",
      description: "Fetch paid current weather through the x402 gateway with transparent Settld autopay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["city"],
        properties: {
          city: { type: "string" },
          unit: { type: "string", enum: ["c", "f"], default: "c" }
        }
      }
    },
    {
      name: "settld.llm_completion_paid",
      description: "Execute a paid LLM completion through the x402 gateway with transparent Settld autopay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          model: { type: "string", default: "gpt-4o-mini" },
          maxTokens: { type: "integer", minimum: 1, maximum: 512, default: 128 }
        }
      }
    },
    {
      name: "settld.resolve_settlement",
      description:
        "Manually resolve a run settlement (released/refunded). Useful for demos where the policy engine would otherwise leave the settlement locked.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          status: { type: "string", enum: ["released", "refunded"], default: "released" },
          releaseRatePct: { type: ["integer", "null"], minimum: 0, maximum: 100, default: null },
          releasedAmountCents: { type: ["integer", "null"], minimum: 0, default: null },
          refundedAmountCents: { type: ["integer", "null"], minimum: 0, default: null },
          reason: { type: ["string", "null"], default: null },
          resolvedByAgentId: { type: ["string", "null"], default: null }
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
      name: "settld.agreement_delegation_create",
      description: "Create an AgreementDelegation.v1 edge (idempotent via idempotencyKey).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["parentAgreementHash", "childAgreementHash", "delegatorAgentId", "delegateeAgentId", "budgetCapCents"],
        properties: {
          parentAgreementHash: { type: "string" },
          childAgreementHash: { type: "string" },
          delegatorAgentId: { type: "string" },
          delegateeAgentId: { type: "string" },
          budgetCapCents: { type: "integer", minimum: 1 },
          currency: { type: "string", default: "USD" },
          delegationDepth: { type: ["integer", "null"], minimum: 1, default: null },
          maxDelegationDepth: { type: ["integer", "null"], minimum: 1, default: null },
          ancestorChain: { type: ["array", "null"], items: { type: "string" }, default: null },
          delegationId: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "settld.agreement_delegation_list",
      description: "List agreement delegations touching an agreement hash.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agreementHash"],
        properties: {
          agreementHash: { type: "string" },
          status: { type: ["string", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "settld.x402_gate_create",
      description: "Create an x402 gate (idempotent via idempotencyKey). Generates payer/payee agent ids when omitted.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          gateId: { type: ["string", "null"], default: null },
          payerAgentId: { type: ["string", "null"], default: null },
          payeeAgentId: { type: ["string", "null"], default: null },
          amountCents: { type: "integer", minimum: 1, default: 500 },
          currency: { type: "string", default: "USD" },
          autoFundPayerCents: { type: ["integer", "null"], minimum: 0, default: null },
          toolId: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "settld.x402_gate_verify",
      description:
        "Verify and resolve an x402 gate. By default it first authorizes payment so MCP probe can run create -> verify -> get.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["gateId"],
        properties: {
          gateId: { type: "string" },
          ensureAuthorized: { type: "boolean", default: true },
          authorizeIdempotencyKey: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null },
          verificationStatus: { type: "string", enum: ["green", "amber", "red"], default: "green" },
          runStatus: { type: "string", enum: ["completed", "failed"], default: "completed" },
          requestSha256: { type: ["string", "null"], default: null },
          responseSha256: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "settld.x402_gate_get",
      description: "Fetch the current x402 gate record and linked settlement state.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["gateId"],
        properties: {
          gateId: { type: "string" }
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
  const paidToolsBaseUrl = process.env.SETTLD_PAID_TOOLS_BASE_URL || "http://127.0.0.1:8402";
  const paidToolsAgentPassport = parseOptionalJsonObject(
    process.env.SETTLD_PAID_TOOLS_AGENT_PASSPORT ?? null,
    "SETTLD_PAID_TOOLS_AGENT_PASSPORT"
  );

  assertNonEmptyString(baseUrl, "SETTLD_BASE_URL");
  assertNonEmptyString(tenantId, "SETTLD_TENANT_ID");
  assertNonEmptyString(apiKey, "SETTLD_API_KEY");

  // Operational hint: this server speaks JSON-RPC over stdin/stdout (MCP stdio transport).
  // Keep stdout strictly for JSON-RPC messages; print hints to stderr only.
  process.stderr.write("[mcp] ready (stdio). Use `npm run mcp:probe` or an MCP client; do not paste shell prompts.\n");

  const client = makeSettldClient({ baseUrl, tenantId, apiKey, protocol });
  const paidToolsClient = makePaidToolsClient({ baseUrl: paidToolsBaseUrl, tenantId, agentPassport: paidToolsAgentPassport });
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
              config: redactSecrets({ baseUrl, tenantId, protocol: discovered, paidToolsBaseUrl })
            };
          } else if (name === "settld.exa_search_paid") {
            const query = String(args?.query ?? "").trim();
            assertNonEmptyString(query, "query");
            const numResults = args?.numResults ?? 5;
            result = await paidToolsClient.exaSearch({ query, numResults });
          } else if (name === "settld.weather_current_paid") {
            const city = String(args?.city ?? "").trim();
            assertNonEmptyString(city, "city");
            const unit = args?.unit ?? "c";
            result = await paidToolsClient.weatherCurrent({ city, unit });
          } else if (name === "settld.llm_completion_paid") {
            const prompt = String(args?.prompt ?? "").trim();
            assertNonEmptyString(prompt, "prompt");
            const model = args?.model ?? "gpt-4o-mini";
            const maxTokens = args?.maxTokens ?? 128;
            result = await paidToolsClient.llmCompletion({ prompt, model, maxTokens });
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
          } else if (name === "settld.x402_gate_create") {
            const gateId = args?.gateId ? String(args.gateId).trim() : `x402gate_mcp_${crypto.randomUUID()}`;
            const payerAgentId = args?.payerAgentId ? String(args.payerAgentId).trim() : `agt_x402_payer_${crypto.randomUUID()}`;
            const payeeAgentId = args?.payeeAgentId ? String(args.payeeAgentId).trim() : `agt_x402_payee_${crypto.randomUUID()}`;
            assertNonEmptyString(gateId, "gateId");
            assertNonEmptyString(payerAgentId, "payerAgentId");
            assertNonEmptyString(payeeAgentId, "payeeAgentId");
            if (payerAgentId === payeeAgentId) throw new TypeError("payerAgentId and payeeAgentId must differ");

            const amountCents = Number(args?.amountCents ?? 500);
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
            const currency = args?.currency ? String(args.currency).trim().toUpperCase() : "USD";
            assertNonEmptyString(currency, "currency");

            const autoFundRaw = args?.autoFundPayerCents ?? amountCents;
            const autoFundPayerCents = Number(autoFundRaw);
            if (!Number.isSafeInteger(autoFundPayerCents) || autoFundPayerCents < 0) {
              throw new TypeError("autoFundPayerCents must be a non-negative safe integer");
            }

            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_x402_gate_create");

            const body = {
              gateId,
              payerAgentId,
              payeeAgentId,
              amountCents,
              currency,
              autoFundPayerCents
            };
            if (typeof args?.toolId === "string" && args.toolId.trim() !== "") body.toolId = args.toolId.trim();
            const out = await client.requestJson("/x402/gate/create", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = {
              ok: true,
              gateId,
              payerAgentId,
              payeeAgentId,
              idempotencyKey,
              ...redactSecrets(out)
            };
          } else if (name === "settld.agreement_delegation_create") {
            const parentAgreementHash = String(args?.parentAgreementHash ?? "").trim().toLowerCase();
            const childAgreementHash = String(args?.childAgreementHash ?? "").trim().toLowerCase();
            if (!isSha256Hex(parentAgreementHash)) throw new TypeError("parentAgreementHash must be a sha256 hex string");
            if (!isSha256Hex(childAgreementHash)) throw new TypeError("childAgreementHash must be a sha256 hex string");
            const delegatorAgentId = String(args?.delegatorAgentId ?? "").trim();
            const delegateeAgentId = String(args?.delegateeAgentId ?? "").trim();
            assertNonEmptyString(delegatorAgentId, "delegatorAgentId");
            assertNonEmptyString(delegateeAgentId, "delegateeAgentId");
            const budgetCapCents = Number(args?.budgetCapCents);
            if (!Number.isSafeInteger(budgetCapCents) || budgetCapCents <= 0) {
              throw new TypeError("budgetCapCents must be a positive safe integer");
            }
            const currency = args?.currency ? String(args.currency).trim().toUpperCase() : "USD";
            assertNonEmptyString(currency, "currency");

            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_agreement_delegation_create");

            const body = {
              childAgreementHash,
              delegatorAgentId,
              delegateeAgentId,
              budgetCapCents,
              currency
            };
            if (typeof args?.delegationId === "string" && args.delegationId.trim() !== "") body.delegationId = args.delegationId.trim();
            if (Number.isSafeInteger(Number(args?.delegationDepth)) && Number(args.delegationDepth) > 0) {
              body.delegationDepth = Number(args.delegationDepth);
            }
            if (Number.isSafeInteger(Number(args?.maxDelegationDepth)) && Number(args.maxDelegationDepth) > 0) {
              body.maxDelegationDepth = Number(args.maxDelegationDepth);
            }
            if (Array.isArray(args?.ancestorChain)) {
              body.ancestorChain = args.ancestorChain.map((v) => String(v ?? "").trim()).filter(Boolean);
            }

            const out = await client.requestJson(`/agreements/${encodeURIComponent(parentAgreementHash)}/delegations`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = {
              ok: true,
              parentAgreementHash,
              idempotencyKey,
              ...redactSecrets(out)
            };
          } else if (name === "settld.agreement_delegation_list") {
            const agreementHash = String(args?.agreementHash ?? "").trim().toLowerCase();
            if (!isSha256Hex(agreementHash)) throw new TypeError("agreementHash must be a sha256 hex string");
            const query = new URLSearchParams();
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const path = `/agreements/${encodeURIComponent(agreementHash)}/delegations${query.toString() ? `?${query.toString()}` : ""}`;
            const out = await client.requestJson(path, { method: "GET" });
            result = { ok: true, agreementHash, ...redactSecrets(out) };
          } else if (name === "settld.x402_gate_verify") {
            const gateId = String(args?.gateId ?? "").trim();
            assertNonEmptyString(gateId, "gateId");
            const ensureAuthorized = args?.ensureAuthorized !== false;

            const verificationStatusRaw = args?.verificationStatus ? String(args.verificationStatus).trim().toLowerCase() : "green";
            if (!["green", "amber", "red"].includes(verificationStatusRaw)) {
              throw new TypeError("verificationStatus must be green|amber|red");
            }
            const verificationStatus = verificationStatusRaw;

            const runStatusRaw = args?.runStatus ? String(args.runStatus).trim().toLowerCase() : "completed";
            if (!["completed", "failed"].includes(runStatusRaw)) {
              throw new TypeError("runStatus must be completed|failed");
            }
            const runStatus = runStatusRaw;

            const requestSha256 = (() => {
              if (typeof args?.requestSha256 === "string" && args.requestSha256.trim() !== "") return args.requestSha256.trim().toLowerCase();
              return sha256HexText(`mcp:x402:request:${gateId}`).toLowerCase();
            })();
            if (!isSha256Hex(requestSha256)) throw new TypeError("requestSha256 must be a sha256 hex string");
            const responseSha256 = (() => {
              if (typeof args?.responseSha256 === "string" && args.responseSha256.trim() !== "") return args.responseSha256.trim().toLowerCase();
              return sha256HexText(`mcp:x402:response:${gateId}`).toLowerCase();
            })();
            if (!isSha256Hex(responseSha256)) throw new TypeError("responseSha256 must be a sha256 hex string");

            const verifyIdempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_x402_gate_verify");
            const authorizeIdempotencyKey =
              typeof args?.authorizeIdempotencyKey === "string" && args.authorizeIdempotencyKey.trim() !== ""
                ? args.authorizeIdempotencyKey.trim()
                : makeIdempotencyKey("mcp_x402_gate_authorize");

            let authorizeOut = null;
            if (ensureAuthorized) {
              authorizeOut = await client.requestJson("/x402/gate/authorize-payment", {
                method: "POST",
                write: true,
                body: { gateId },
                idem: authorizeIdempotencyKey
              });
            }

            const verifyOut = await client.requestJson("/x402/gate/verify", {
              method: "POST",
              write: true,
              body: {
                gateId,
                verificationStatus,
                runStatus,
                policy: {
                  mode: "automatic",
                  rules: {
                    autoReleaseOnGreen: true,
                    greenReleaseRatePct: 100,
                    autoReleaseOnAmber: false,
                    amberReleaseRatePct: 0,
                    autoReleaseOnRed: true,
                    redReleaseRatePct: 0
                  }
                },
                verificationMethod: { mode: "deterministic", source: "mcp_x402_gate_verify_v1" },
                evidenceRefs: [`http:request_sha256:${requestSha256}`, `http:response_sha256:${responseSha256}`]
              },
              idem: verifyIdempotencyKey
            });

            result = {
              ok: true,
              gateId,
              ensureAuthorized,
              authorizeIdempotencyKey: ensureAuthorized ? authorizeIdempotencyKey : null,
              idempotencyKey: verifyIdempotencyKey,
              requestSha256,
              responseSha256,
              authorize: authorizeOut ? redactSecrets(authorizeOut) : null,
              verify: redactSecrets(verifyOut)
            };
          } else if (name === "settld.x402_gate_get") {
            const gateId = String(args?.gateId ?? "").trim();
            assertNonEmptyString(gateId, "gateId");
            const out = await client.requestJson(`/x402/gate/${encodeURIComponent(gateId)}`, { method: "GET" });
            result = { ok: true, gateId, ...redactSecrets(out) };
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
          } else if (name === "settld.resolve_settlement") {
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            const status = args?.status ? String(args.status).trim().toLowerCase() : "released";
            if (status !== "released" && status !== "refunded") throw new TypeError("status must be released|refunded");

            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/settlement/resolve`, {
              method: "POST",
              write: true,
              body: {
                status,
                releaseRatePct: args?.releaseRatePct ?? null,
                releasedAmountCents: args?.releasedAmountCents ?? null,
                refundedAmountCents: args?.refundedAmountCents ?? null,
                reason: args?.reason ?? null,
                resolvedByAgentId: args?.resolvedByAgentId ?? null
              },
              idem: makeIdempotencyKey("mcp_settlement_resolve")
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
