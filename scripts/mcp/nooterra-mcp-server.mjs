#!/usr/bin/env node
/**
 * Sprint 23 MCP spike: JSON-RPC 2.0 over stdio exposing curated Nooterra tools.
 *
 * - Transport: stdio
 * - Framing: newline-delimited JSON; also accepts Content-Length framed messages.
 * - Auth: x-proxy-api-key (NOOTERRA_API_KEY)
 *
 * Production hardening (SSE, auth variants, rate limiting, telemetry) is Sprint 25+.
 */

import crypto from "node:crypto";

import { fetchWithNooterraAutopay } from "../../packages/api-sdk/src/x402-autopay.js";

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNoUnknownKeys(value, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${name} has unsupported keys: ${unknown.join(", ")}`);
  }
}

function parseOptionalStringArg(value, name, { max = 512 } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new TypeError(`${name} must be <= ${max} characters`);
  return trimmed;
}

function parseOptionalBooleanArg(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function parseOptionalIntegerArg(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
  if (value < min) throw new TypeError(`${name} must be >= ${min}`);
  if (value > max) throw new TypeError(`${name} must be <= ${max}`);
  return value;
}

function parseOptionalEnumArg(value, name, allowedValues) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!allowedValues.includes(trimmed)) {
    throw new TypeError(`${name} must be one of: ${allowedValues.join("|")}`);
  }
  return trimmed;
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

function normalizeToolFailureMessage(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function detectToolResultFailure(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;

  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(result, key);
  const rawError = hasOwn("error") ? result.error : null;
  const hasError =
    rawError !== null &&
    rawError !== undefined &&
    !(typeof rawError === "string" && rawError.trim() === "");
  const statusCode =
    Number.isInteger(result.statusCode) ? result.statusCode : Number.isInteger(result.status) ? result.status : null;
  const okValue = hasOwn("ok") ? result.ok : undefined;
  const failed = okValue === false || hasError || (Number.isInteger(statusCode) && statusCode >= 400);
  if (!failed) return null;

  const rawErrorMessage =
    normalizeToolFailureMessage(rawError) ||
    (rawError && typeof rawError === "object"
      ? normalizeToolFailureMessage(rawError.message) || normalizeToolFailureMessage(rawError.error)
      : null);
  const message =
    rawErrorMessage ||
    normalizeToolFailureMessage(result.message) ||
    "tool result indicates upstream failure";
  const code =
    normalizeToolFailureMessage(result.code) ||
    (rawError && typeof rawError === "object" ? normalizeToolFailureMessage(rawError.code) : null);

  return {
    message,
    code,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    details: redactSecrets(result)
  };
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

function collectNooterraHeaders(responseHeaders) {
  const out = {};
  for (const [k, v] of responseHeaders.entries()) {
    const key = String(k).toLowerCase();
    if (key.startsWith("x-nooterra-")) out[key] = v;
  }
  return out;
}

function parseCsvHeader(value) {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
}

function normalizePolicyDecision(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["allow", "challenge", "deny", "escalate"].includes(raw) ? raw : null;
}

function parseNooterraDecisionMetadata(headers) {
  const policyVersionRaw = Number(headers["x-nooterra-policy-version"] ?? Number.NaN);
  const reasonCodes = parseCsvHeader(headers["x-nooterra-verification-codes"]);
  const reasonCode = typeof headers["x-nooterra-reason-code"] === "string" && headers["x-nooterra-reason-code"].trim() !== ""
    ? headers["x-nooterra-reason-code"].trim()
    : reasonCodes[0] ?? null;
  return {
    policyDecision: normalizePolicyDecision(headers["x-nooterra-policy-decision"]),
    decisionId: typeof headers["x-nooterra-decision-id"] === "string" && headers["x-nooterra-decision-id"].trim() !== ""
      ? headers["x-nooterra-decision-id"].trim()
      : null,
    policyHash:
      typeof headers["x-nooterra-policy-hash"] === "string" && /^[0-9a-f]{64}$/i.test(headers["x-nooterra-policy-hash"].trim())
        ? headers["x-nooterra-policy-hash"].trim().toLowerCase()
        : null,
    policyVersion: Number.isSafeInteger(policyVersionRaw) && policyVersionRaw > 0 ? policyVersionRaw : null,
    reasonCode,
    reasonCodes
  };
}

function assertPolicyRuntimeMetadata({ headers, toolName }) {
  const required = [
    "x-nooterra-settlement-status",
    "x-nooterra-verification-status",
    "x-nooterra-policy-decision",
    "x-nooterra-policy-hash",
    "x-nooterra-decision-id"
  ];
  const missing = required.filter((key) => typeof headers[key] !== "string" || headers[key].trim() === "");
  if (missing.length > 0) {
    const err = new Error(`${toolName} response missing nooterra policy runtime metadata`);
    err.code = "NOOTERRA_POLICY_RUNTIME_METADATA_MISSING";
    err.details = { missingHeaders: missing };
    throw err;
  }
  const metadata = parseNooterraDecisionMetadata(headers);
  if (!metadata.policyDecision) {
    const err = new Error(`${toolName} returned unsupported x-nooterra-policy-decision value`);
    err.code = "NOOTERRA_POLICY_RUNTIME_DECISION_INVALID";
    err.details = { policyDecision: headers["x-nooterra-policy-decision"] ?? null };
    throw err;
  }
  return metadata;
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

function makeNooterraClient({ baseUrl, tenantId, apiKey, protocol }) {
  let cachedProtocol = protocol || null;

  function parseSseFrame(frameText) {
    if (typeof frameText !== "string") return null;
    const normalized = frameText.replace(/\r/g, "");
    if (normalized.trim() === "") return null;
    const lines = normalized.split("\n");
    let eventName = "message";
    let eventId = null;
    const dataLines = [];
    let sawCommentOnlyLine = false;
    for (const line of lines) {
      if (line === "") continue;
      if (line.startsWith(":")) {
        sawCommentOnlyLine = true;
        continue;
      }
      const sepIndex = line.indexOf(":");
      const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
      let value = sepIndex === -1 ? "" : line.slice(sepIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value.trim() || "message";
      if (field === "id") eventId = value.trim() || null;
      if (field === "data") dataLines.push(value);
    }
    if (dataLines.length === 0) {
      if (sawCommentOnlyLine) return null;
      return { event: eventName, id: eventId, rawData: "", data: null };
    }
    const rawData = dataLines.join("\n");
    let data = rawData;
    if (rawData === "null") data = null;
    else {
      try {
        data = JSON.parse(rawData);
      } catch {
        data = rawData;
      }
    }
    return { event: eventName, id: eventId, rawData, data };
  }

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
      const hdr = res.headers.get("x-nooterra-protocol");
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
      ...(write ? { "x-nooterra-protocol": protocolHeader } : {}),
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
      if (json && typeof json.code === "string" && json.code.trim() !== "") {
        err.code = json.code.trim();
      }
      err.details = json && (json.details || json.errorDetails) ? (json.details || json.errorDetails) : json;
      throw err;
    }
    return json;
  }

  async function requestSseEvents(path, { headers = {}, maxEvents = 20, timeoutMs = 2000 } = {}) {
    const url = new URL(path, baseUrl);
    const controller = new AbortController();
    const timeout = Number(timeoutMs);
    const safeTimeoutMs = Number.isSafeInteger(timeout) && timeout >= 200 && timeout <= 30_000 ? timeout : 2000;
    const safeMaxEvents = Number.isSafeInteger(Number(maxEvents)) && Number(maxEvents) >= 1 ? Math.min(200, Number(maxEvents)) : 20;
    const h = {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-api-key": apiKey,
      accept: "text/event-stream",
      ...headers
    };
    let timer = null;
    try {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, safeTimeoutMs);
      timer.unref?.();

      let res;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: h,
          signal: controller.signal
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          return { events: [], lastEventId: null, truncated: false, timedOut: true };
        }
        throw err;
      }

      if (!res.ok) {
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        const msg =
          (json && (json.message || json.error)) ? String(json.message || json.error) :
          text ? String(text) :
          `HTTP ${res.status}`;
        const err = new Error(msg);
        err.statusCode = res.status;
        if (json && typeof json.code === "string" && json.code.trim() !== "") {
          err.code = json.code.trim();
        }
        err.details = json && (json.details || json.errorDetails) ? (json.details || json.errorDetails) : json;
        throw err;
      }

      if (!res.body || typeof res.body.getReader !== "function") {
        throw new TypeError("SSE response body is not a readable stream");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = "";
      let lastEventId = null;
      let truncated = false;
      try {
        for (;;) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (err) {
            if (err?.name === "AbortError") break;
            throw err;
          }
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          for (;;) {
            const splitIndex = buffer.indexOf("\n\n");
            if (splitIndex === -1) break;
            const frame = buffer.slice(0, splitIndex);
            buffer = buffer.slice(splitIndex + 2);
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            if (parsed.id) lastEventId = parsed.id;
            events.push(parsed);
            if (events.length >= safeMaxEvents) {
              truncated = true;
              try {
                controller.abort();
              } catch {}
              break;
            }
          }
          if (truncated) break;
        }
        if (!truncated) {
          buffer += decoder.decode();
          const parsed = parseSseFrame(buffer);
          if (parsed) {
            if (parsed.id) lastEventId = parsed.id;
            events.push(parsed);
            if (events.length > safeMaxEvents) {
              events.length = safeMaxEvents;
              truncated = true;
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
      return { events, lastEventId, truncated, timedOut: controller.signal.aborted && !truncated };
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    requestSseEvents,
    getRunPrevChainHash
  };
}

function makePaidToolsClient({ baseUrl, tenantId, fetchImpl = fetch, agentPassport = null }) {
  const normalizedBaseUrl = (() => {
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
    return baseUrl.trim();
  })();

  async function exaSearch({ query, numResults = 5 } = {}) {
    if (!normalizedBaseUrl) throw new Error("NOOTERRA_PAID_TOOLS_BASE_URL is required for nooterra.exa_search_paid");
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
    const res = await fetchWithNooterraAutopay(
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

    const headers = collectNooterraHeaders(res.headers);
    const decision = assertPolicyRuntimeMetadata({ headers, toolName: "nooterra.exa_search_paid" });

    return {
      ok: true,
      query: normalizedQuery,
      numResults: normalizedNumResults,
      response: json,
      headers,
      decision,
      challenge
    };
  }

  async function weatherCurrent({ city, unit = "c" } = {}) {
    if (!normalizedBaseUrl) throw new Error("NOOTERRA_PAID_TOOLS_BASE_URL is required for nooterra.weather_current_paid");
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
    const res = await fetchWithNooterraAutopay(
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

    const headers = collectNooterraHeaders(res.headers);
    const decision = assertPolicyRuntimeMetadata({ headers, toolName: "nooterra.weather_current_paid" });

    return {
      ok: true,
      city: normalizedCity,
      unit: normalizedUnit,
      response: json,
      headers,
      decision,
      challenge
    };
  }

  async function llmCompletion({ prompt, model = "gpt-4o-mini", maxTokens = 128 } = {}) {
    if (!normalizedBaseUrl) throw new Error("NOOTERRA_PAID_TOOLS_BASE_URL is required for nooterra.llm_completion_paid");
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
    const res = await fetchWithNooterraAutopay(
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

    const headers = collectNooterraHeaders(res.headers);
    const decision = assertPolicyRuntimeMetadata({ headers, toolName: "nooterra.llm_completion_paid" });

    return {
      ok: true,
      prompt: normalizedPrompt,
      model: normalizedModel,
      maxTokens: normalizedMaxTokens,
      response: json,
      headers,
      decision,
      challenge
    };
  }

  return { exaSearch, weatherCurrent, llmCompletion };
}

function buildTools() {
  return [
    {
      name: "nooterra.create_agreement",
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
      name: "nooterra.submit_evidence",
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
      name: "nooterra.settle_run",
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
      name: "nooterra.exa_search_paid",
      description: "Execute a paid Exa-style search through the x402 gateway with transparent Nooterra autopay.",
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
      name: "nooterra.weather_current_paid",
      description: "Fetch paid current weather through the x402 gateway with transparent Nooterra autopay.",
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
      name: "nooterra.llm_completion_paid",
      description: "Execute a paid LLM completion through the x402 gateway with transparent Nooterra autopay.",
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
      name: "nooterra.resolve_settlement",
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
      name: "nooterra.open_dispute",
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
      name: "nooterra.dispute_add_evidence",
      description: "Attach dispute evidence to an open dispute.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "evidenceRef"],
        properties: {
          runId: { type: "string" },
          disputeId: { type: ["string", "null"], default: null },
          evidenceRef: { type: "string" },
          submittedByAgentId: { type: ["string", "null"], default: null },
          reason: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.dispute_escalate",
      description: "Escalate an open dispute to a higher level (counterparty/arbiter/external).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "escalationLevel"],
        properties: {
          runId: { type: "string" },
          disputeId: { type: ["string", "null"], default: null },
          escalationLevel: { type: "string", enum: ["l1_counterparty", "l2_arbiter", "l3_external"] },
          channel: { type: ["string", "null"], default: null },
          escalatedByAgentId: { type: ["string", "null"], default: null },
          reason: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.dispute_close",
      description: "Close an open dispute with optional signed verdict material.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          disputeId: { type: ["string", "null"], default: null },
          resolution: { type: ["object", "null"], additionalProperties: true, default: null },
          verdict: { type: ["object", "null"], additionalProperties: true, default: null },
          arbitrationVerdict: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.arbitration_open",
      description: "Open an arbitration case for an already-open dispute.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          caseId: { type: ["string", "null"], default: null },
          disputeId: { type: ["string", "null"], default: null },
          arbiterAgentId: { type: ["string", "null"], default: null },
          panelCandidateAgentIds: { type: ["array", "null"], items: { type: "string" }, default: null },
          evidenceRefs: { type: ["array", "null"], items: { type: "string" }, default: null },
          summary: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.arbitration_issue_verdict",
      description: "Issue a signed arbitration verdict for a case.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId", "caseId", "arbitrationVerdict"],
        properties: {
          runId: { type: "string" },
          caseId: { type: "string" },
          arbitrationVerdict: { type: "object", additionalProperties: true },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.agreement_delegation_create",
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
      name: "nooterra.agreement_delegation_list",
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
      name: "nooterra.delegation_grant_issue",
      description: "Issue a DelegationGrant.v1 object (idempotent via idempotencyKey).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["delegatorAgentId", "delegateeAgentId", "maxPerCallCents", "maxTotalCents"],
        properties: {
          grantId: { type: ["string", "null"], default: null },
          delegatorAgentId: { type: "string" },
          delegateeAgentId: { type: "string" },
          allowedProviderIds: { type: ["array", "null"], items: { type: "string" }, default: null },
          allowedToolIds: { type: ["array", "null"], items: { type: "string" }, default: null },
          allowedRiskClasses: {
            type: ["array", "null"],
            items: { type: "string", enum: ["read", "compute", "action", "financial"] },
            default: null
          },
          sideEffectingAllowed: { type: ["boolean", "null"], default: null },
          currency: { type: "string", default: "USD" },
          maxPerCallCents: { type: "integer", minimum: 0 },
          maxTotalCents: { type: "integer", minimum: 0 },
          rootGrantHash: { type: ["string", "null"], default: null },
          parentGrantHash: { type: ["string", "null"], default: null },
          depth: { type: ["integer", "null"], minimum: 0, default: null },
          maxDelegationDepth: { type: ["integer", "null"], minimum: 0, default: null },
          issuedAt: { type: ["string", "null"], default: null },
          notBefore: { type: ["string", "null"], default: null },
          expiresAt: { type: ["string", "null"], default: null },
          revocable: { type: ["boolean", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.delegation_grant_get",
      description: "Fetch a delegation grant by grantId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["grantId"],
        properties: {
          grantId: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.delegation_grant_list",
      description: "List delegation grants with optional filters.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          grantId: { type: ["string", "null"], default: null },
          grantHash: { type: ["string", "null"], default: null },
          delegatorAgentId: { type: ["string", "null"], default: null },
          delegateeAgentId: { type: ["string", "null"], default: null },
          includeRevoked: { type: ["boolean", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.delegation_grant_revoke",
      description: "Revoke a delegation grant.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["grantId"],
        properties: {
          grantId: { type: "string" },
          revocationReasonCode: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.authority_grant_issue",
      description: "Issue an AuthorityGrant.v1 object (idempotent via idempotencyKey).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["principalRef", "granteeAgentId", "maxPerCallCents", "maxTotalCents"],
        properties: {
          grantId: { type: ["string", "null"], default: null },
          principalRef: {
            type: "object",
            additionalProperties: false,
            required: ["principalType", "principalId"],
            properties: {
              principalType: { type: "string", enum: ["human", "org", "service", "agent"] },
              principalId: { type: "string" }
            }
          },
          granteeAgentId: { type: "string" },
          allowedProviderIds: { type: ["array", "null"], items: { type: "string" }, default: null },
          allowedToolIds: { type: ["array", "null"], items: { type: "string" }, default: null },
          allowedRiskClasses: {
            type: ["array", "null"],
            items: { type: "string", enum: ["read", "compute", "action", "financial"] },
            default: null
          },
          sideEffectingAllowed: { type: ["boolean", "null"], default: null },
          currency: { type: "string", default: "USD" },
          maxPerCallCents: { type: "integer", minimum: 0 },
          maxTotalCents: { type: "integer", minimum: 0 },
          rootGrantHash: { type: ["string", "null"], default: null },
          parentGrantHash: { type: ["string", "null"], default: null },
          depth: { type: ["integer", "null"], minimum: 0, default: null },
          maxDelegationDepth: { type: ["integer", "null"], minimum: 0, default: null },
          issuedAt: { type: ["string", "null"], default: null },
          notBefore: { type: ["string", "null"], default: null },
          expiresAt: { type: ["string", "null"], default: null },
          revocable: { type: ["boolean", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.authority_grant_get",
      description: "Fetch an authority grant by grantId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["grantId"],
        properties: {
          grantId: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.authority_grant_list",
      description: "List authority grants with optional filters.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          grantId: { type: ["string", "null"], default: null },
          grantHash: { type: ["string", "null"], default: null },
          principalId: { type: ["string", "null"], default: null },
          granteeAgentId: { type: ["string", "null"], default: null },
          includeRevoked: { type: ["boolean", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.authority_grant_revoke",
      description: "Revoke an authority grant.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["grantId"],
        properties: {
          grantId: { type: "string" },
          revocationReasonCode: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.agent_card_upsert",
      description: "Create or update an AgentCard.v1 profile for discovery and matching.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          displayName: { type: ["string", "null"], default: null },
          description: { type: ["string", "null"], default: null },
          capabilities: { type: ["array", "null"], items: { type: "string" }, default: null },
          visibility: { type: ["string", "null"], enum: ["public", "tenant", "private", null], default: null },
          executionCoordinatorDid: { type: ["string", "null"], default: null },
          hostRuntime: { type: ["string", "null"], default: null },
          hostEndpoint: { type: ["string", "null"], default: null },
          hostProtocols: { type: ["array", "null"], items: { type: "string" }, default: null },
          priceHint: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              amountCents: { type: "integer", minimum: 0 },
              currency: { type: ["string", "null"], default: "USD" },
              unit: { type: ["string", "null"], default: "task" }
            }
          },
          attestations: { type: ["array", "null"], items: { type: "object", additionalProperties: true }, default: null },
          tools: {
            type: ["array", "null"],
            default: null,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["toolId"],
              properties: {
                schemaVersion: { type: ["string", "null"], default: "ToolDescriptor.v1" },
                toolId: { type: "string" },
                mcpToolName: { type: ["string", "null"], default: null },
                name: { type: ["string", "null"], default: null },
                description: { type: ["string", "null"], default: null },
                riskClass: { type: ["string", "null"], enum: ["read", "compute", "action", "financial", null], default: null },
                sideEffecting: { type: ["boolean", "null"], default: null },
                pricing: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  default: null,
                  properties: {
                    amountCents: { type: "integer", minimum: 0 },
                    currency: { type: ["string", "null"], default: "USD" },
                    unit: { type: ["string", "null"], default: "call" }
                  }
                },
                requiresEvidenceKinds: {
                  type: ["array", "null"],
                  default: null,
                  items: { type: "string", enum: ["artifact", "hash", "verification_report"] }
                },
                metadata: { type: ["object", "null"], additionalProperties: true, default: null }
              }
            }
          },
          policyCompatibility: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              schemaVersion: { type: ["string", "null"], default: "AgentCardPolicyCompatibility.v1" },
              supportsPolicyTemplates: { type: ["array", "null"], items: { type: "string" }, default: null },
              supportsEvidencePacks: { type: ["array", "null"], items: { type: "string" }, default: null }
            }
          },
          publish: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              schemaVersion: { type: ["string", "null"], default: "AgentCardPublish.v1" },
              algorithm: { type: ["string", "null"], default: "ed25519" },
              signerKeyId: { type: ["string", "null"], default: null },
              signedAt: { type: ["string", "null"], default: null },
              payloadHash: { type: ["string", "null"], default: null },
              signature: { type: ["string", "null"], default: null }
            }
          },
          tags: { type: ["array", "null"], items: { type: "string" }, default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.agent_discover",
      description: "Discover AgentCard.v1 records with capability/runtime/reputation filters (tenant or public scope).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: { type: ["string", "null"], enum: ["tenant", "public", null], default: "tenant" },
          capability: { type: ["string", "null"], default: null },
          executionCoordinatorDid: { type: ["string", "null"], default: null },
          toolId: { type: ["string", "null"], default: null },
          toolMcpName: { type: ["string", "null"], default: null },
          toolRiskClass: { type: ["string", "null"], enum: ["read", "compute", "action", "financial", null], default: null },
          toolSideEffecting: { type: ["boolean", "null"], default: null },
          toolMaxPriceCents: { type: ["integer", "null"], minimum: 0, default: null },
          toolRequiresEvidenceKind: { type: ["string", "null"], enum: ["artifact", "hash", "verification_report", null], default: null },
          supportsPolicyTemplate: { type: ["string", "null"], default: null },
          supportsEvidencePack: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["active", "suspended", "revoked", "all", null], default: null },
          visibility: { type: ["string", "null"], enum: ["public", "tenant", "private", "all", null], default: null },
          runtime: { type: ["string", "null"], default: null },
          requireCapabilityAttestation: { type: ["boolean", "null"], default: false },
          attestationMinLevel: { type: ["string", "null"], enum: ["self_claim", "attested", "certified", null], default: null },
          attestationIssuerAgentId: { type: ["string", "null"], default: null },
          includeAttestationMetadata: { type: ["boolean", "null"], default: false },
          minTrustScore: { type: ["integer", "null"], minimum: 0, maximum: 100, default: null },
          riskTier: { type: ["string", "null"], enum: ["low", "guarded", "elevated", "high", null], default: null },
          includeReputation: { type: ["boolean", "null"], default: true },
          reputationVersion: { type: ["string", "null"], enum: ["v1", "v2", null], default: "v2" },
          reputationWindow: { type: ["string", "null"], enum: ["7d", "30d", "allTime", null], default: "30d" },
          scoreStrategy: { type: ["string", "null"], enum: ["balanced", "recent_bias", "trust_weighted", null], default: "balanced" },
          requesterAgentId: { type: ["string", "null"], default: null },
          includeRoutingFactors: { type: ["boolean", "null"], default: false },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 100, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.agent_discover_stream",
      description: "Read bounded public AgentCard stream events (SSE) for discovery updates.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          capability: { type: ["string", "null"], default: null },
          executionCoordinatorDid: { type: ["string", "null"], default: null },
          toolId: { type: ["string", "null"], default: null },
          toolMcpName: { type: ["string", "null"], default: null },
          toolRiskClass: { type: ["string", "null"], enum: ["read", "compute", "action", "financial", null], default: null },
          toolSideEffecting: { type: ["boolean", "null"], default: null },
          toolMaxPriceCents: { type: ["integer", "null"], minimum: 0, default: null },
          toolRequiresEvidenceKind: { type: ["string", "null"], enum: ["artifact", "hash", "verification_report", null], default: null },
          status: { type: ["string", "null"], enum: ["active", "suspended", "revoked", "all", null], default: null },
          runtime: { type: ["string", "null"], default: null },
          sinceCursor: { type: ["string", "null"], default: null },
          lastEventId: { type: ["string", "null"], default: null },
          maxEvents: { type: ["integer", "null"], minimum: 1, maximum: 200, default: 20 },
          timeoutMs: { type: ["integer", "null"], minimum: 200, maximum: 30000, default: 2000 }
        }
      }
    },
    {
      name: "nooterra.agent_resolve",
      description: "Resolve a public agent reference via deterministic AgentLocator.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentRef"],
        properties: {
          agentRef: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.capability_attest",
      description: "Issue a signed capability attestation record for agent discovery/routing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["subjectAgentId", "capability"],
        properties: {
          attestationId: { type: ["string", "null"], default: null },
          subjectAgentId: { type: "string" },
          capability: { type: "string" },
          level: { type: ["string", "null"], enum: ["self_claim", "attested", "certified", null], default: "attested" },
          issuerAgentId: { type: ["string", "null"], default: null },
          issuedAt: { type: ["string", "null"], default: null },
          notBefore: { type: ["string", "null"], default: null },
          expiresAt: { type: ["string", "null"], default: null },
          signatureKeyId: { type: ["string", "null"], default: null },
          signature: { type: ["string", "null"], default: null },
          verificationMethod: { type: ["object", "null"], additionalProperties: true, default: null },
          evidenceRefs: { type: ["array", "null"], items: { type: "string" }, default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.capability_attestation_list",
      description: "List capability attestations with runtime validity status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          attestationId: { type: ["string", "null"], default: null },
          subjectAgentId: { type: ["string", "null"], default: null },
          issuerAgentId: { type: ["string", "null"], default: null },
          capability: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["valid", "expired", "not_active", "revoked", "all", null], default: null },
          at: { type: ["string", "null"], default: null },
          includeInvalid: { type: ["boolean", "null"], default: false },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.capability_attestation_revoke",
      description: "Revoke an existing capability attestation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["attestationId"],
        properties: {
          attestationId: { type: "string" },
          revokedAt: { type: ["string", "null"], default: null },
          reasonCode: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.task_quote_issue",
      description: "Issue a TaskQuote.v1 for a proposed delegated task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["buyerAgentId", "sellerAgentId", "requiredCapability", "amountCents"],
        properties: {
          quoteId: { type: ["string", "null"], default: null },
          buyerAgentId: { type: "string" },
          sellerAgentId: { type: "string" },
          requiredCapability: { type: "string" },
          traceId: { type: ["string", "null"], default: null },
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: ["string", "null"], default: "USD" },
          constraints: { type: ["object", "null"], additionalProperties: true, default: null },
          attestationRequirement: { type: ["object", "null"], additionalProperties: true, default: null },
          intentContract: { type: ["object", "null"], additionalProperties: true, default: null },
          intentActorAgentId: { type: ["string", "null"], default: null },
          intentEventId: { type: ["string", "null"], default: null },
          intentEventAt: { type: ["string", "null"], default: null },
          intentEventMetadata: { type: ["object", "null"], additionalProperties: true, default: null },
          expiresAt: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.task_quote_list",
      description: "List TaskQuote.v1 records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          quoteId: { type: ["string", "null"], default: null },
          buyerAgentId: { type: ["string", "null"], default: null },
          sellerAgentId: { type: ["string", "null"], default: null },
          requiredCapability: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["open", "accepted", "expired", "revoked", null], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.task_offer_issue",
      description: "Issue a TaskOffer.v1 in response to a task quote.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["buyerAgentId", "sellerAgentId", "amountCents"],
        properties: {
          offerId: { type: ["string", "null"], default: null },
          buyerAgentId: { type: "string" },
          sellerAgentId: { type: "string" },
          traceId: { type: ["string", "null"], default: null },
          quoteId: { type: ["string", "null"], default: null },
          quoteHash: { type: ["string", "null"], default: null },
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: ["string", "null"], default: "USD" },
          constraints: { type: ["object", "null"], additionalProperties: true, default: null },
          intentContract: { type: ["object", "null"], additionalProperties: true, default: null },
          intentActorAgentId: { type: ["string", "null"], default: null },
          intentEventId: { type: ["string", "null"], default: null },
          intentEventAt: { type: ["string", "null"], default: null },
          intentEventMetadata: { type: ["object", "null"], additionalProperties: true, default: null },
          intentPrevEventHash: { type: ["string", "null"], default: null },
          expiresAt: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.task_offer_list",
      description: "List TaskOffer.v1 records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          offerId: { type: ["string", "null"], default: null },
          buyerAgentId: { type: ["string", "null"], default: null },
          sellerAgentId: { type: ["string", "null"], default: null },
          quoteId: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["open", "accepted", "expired", "revoked", null], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.task_acceptance_issue",
      description: "Issue a TaskAcceptance.v1 to bind quote+offer for settlement.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["quoteId", "offerId", "acceptedByAgentId"],
        properties: {
          acceptanceId: { type: ["string", "null"], default: null },
          quoteId: { type: "string" },
          offerId: { type: "string" },
          acceptedByAgentId: { type: "string" },
          traceId: { type: ["string", "null"], default: null },
          acceptedAt: { type: ["string", "null"], default: null },
          intentContract: { type: ["object", "null"], additionalProperties: true, default: null },
          intentActorAgentId: { type: ["string", "null"], default: null },
          intentEventId: { type: ["string", "null"], default: null },
          intentEventAt: { type: ["string", "null"], default: null },
          intentEventMetadata: { type: ["object", "null"], additionalProperties: true, default: null },
          intentPrevEventHash: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.task_acceptance_list",
      description: "List TaskAcceptance.v1 records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          acceptanceId: { type: ["string", "null"], default: null },
          buyerAgentId: { type: ["string", "null"], default: null },
          sellerAgentId: { type: ["string", "null"], default: null },
          quoteId: { type: ["string", "null"], default: null },
          offerId: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["open", "accepted", "expired", "revoked", null], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.intent_propose",
      description: "Propose an IntentContract.v1 between two agents.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["proposerAgentId", "counterpartyAgentId", "objective", "budgetEnvelope"],
        properties: {
          intentId: { type: ["string", "null"], default: null },
          proposerAgentId: { type: "string" },
          counterpartyAgentId: { type: "string" },
          objective: { type: ["object", "array", "string", "number", "boolean"] },
          constraints: { type: ["object", "null"], additionalProperties: true, default: null },
          budgetEnvelope: { type: "object", additionalProperties: true },
          requiredApprovals: { type: ["array", "null"], items: { type: "object", additionalProperties: true }, default: null },
          successCriteria: { type: ["object", "null"], additionalProperties: true, default: null },
          terminationPolicy: { type: ["object", "null"], additionalProperties: true, default: null },
          proposedAt: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.intent_list",
      description: "List IntentContract.v1 records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          intentId: { type: ["string", "null"], default: null },
          proposerAgentId: { type: ["string", "null"], default: null },
          counterpartyAgentId: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["proposed", "countered", "accepted", null], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.intent_get",
      description: "Fetch an IntentContract.v1 by intentId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intentId"],
        properties: {
          intentId: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.intent_counter",
      description: "Create a counter IntentContract.v1 from an existing intent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intentId", "proposerAgentId"],
        properties: {
          intentId: { type: "string" },
          newIntentId: { type: ["string", "null"], default: null },
          proposerAgentId: { type: "string" },
          parentIntentHash: { type: ["string", "null"], default: null },
          objective: { type: ["object", "array", "string", "number", "boolean", "null"], default: null },
          constraints: { type: ["object", "null"], additionalProperties: true, default: null },
          budgetEnvelope: { type: ["object", "null"], additionalProperties: true, default: null },
          requiredApprovals: { type: ["array", "null"], items: { type: "object", additionalProperties: true }, default: null },
          successCriteria: { type: ["object", "null"], additionalProperties: true, default: null },
          terminationPolicy: { type: ["object", "null"], additionalProperties: true, default: null },
          proposedAt: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.intent_accept",
      description: "Accept an IntentContract.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["intentId", "acceptedByAgentId"],
        properties: {
          intentId: { type: "string" },
          acceptedByAgentId: { type: "string" },
          acceptedAt: { type: ["string", "null"], default: null },
          intentHash: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_create",
      description: "Create a SubAgentWorkOrder.v1 for delegated paid execution.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["principalAgentId", "subAgentId", "requiredCapability", "amountCents"],
        properties: {
          workOrderId: { type: ["string", "null"], default: null },
          parentTaskId: { type: ["string", "null"], default: null },
          principalAgentId: { type: "string" },
          subAgentId: { type: "string" },
          requiredCapability: { type: "string" },
          traceId: { type: ["string", "null"], default: null },
          x402ToolId: { type: ["string", "null"], default: null },
          x402ProviderId: { type: ["string", "null"], default: null },
          specification: { type: ["object", "null"], additionalProperties: true, default: null },
          amountCents: { type: "integer", minimum: 1 },
          currency: { type: ["string", "null"], default: "USD" },
          quoteId: { type: ["string", "null"], default: null },
          constraints: { type: ["object", "null"], additionalProperties: true, default: null },
          evidencePolicy: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              schemaVersion: { type: ["string", "null"], default: "WorkOrderSettlementEvidencePolicy.v1" },
              workOrderType: { type: ["string", "null"], default: null },
              release: {
                type: ["object", "null"],
                additionalProperties: false,
                default: null,
                properties: {
                  minEvidenceRefs: { type: ["integer", "null"], minimum: 0, default: null },
                  requiredKinds: {
                    type: ["array", "null"],
                    items: { type: "string", enum: ["artifact", "hash", "verification_report"] },
                    default: null
                  },
                  requireReceiptHashBinding: { type: ["boolean", "null"], default: null }
                }
              },
              refund: {
                type: ["object", "null"],
                additionalProperties: false,
                default: null,
                properties: {
                  minEvidenceRefs: { type: ["integer", "null"], minimum: 0, default: null },
                  requiredKinds: {
                    type: ["array", "null"],
                    items: { type: "string", enum: ["artifact", "hash", "verification_report"] },
                    default: null
                  },
                  requireReceiptHashBinding: { type: ["boolean", "null"], default: null }
                }
              }
            }
          },
          attestationRequirement: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["required"],
            default: null,
            properties: {
              required: { type: "boolean" },
              minLevel: { type: ["string", "null"], enum: ["self_claim", "attested", "certified", null], default: null },
              issuerAgentId: { type: ["string", "null"], default: null }
            }
          },
          requireCapabilityAttestation: { type: ["boolean", "null"], default: null },
          attestationMinLevel: { type: ["string", "null"], enum: ["self_claim", "attested", "certified", null], default: null },
          attestationIssuerAgentId: { type: ["string", "null"], default: null },
          delegationGrantRef: { type: ["string", "null"], default: null },
          authorityGrantRef: { type: ["string", "null"], default: null },
          requireAcceptedIntentHash: { type: ["boolean", "null"], default: null },
          intentRef: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              negotiationId: { type: "string" },
              intentId: { type: "string" },
              intentHash: { type: "string" },
              acceptedEventHash: { type: ["string", "null"], default: null }
            }
          },
          acceptanceRef: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              acceptanceId: { type: "string" },
              acceptanceHash: { type: ["string", "null"], default: null }
            }
          },
          intentBinding: {
            type: ["object", "null"],
            additionalProperties: false,
            default: null,
            properties: {
              intentId: { type: "string" },
              intentHash: { type: ["string", "null"], default: null },
              boundAt: { type: ["string", "null"], default: null }
            }
          },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_accept",
      description: "Accept a SubAgentWorkOrder.v1 by id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId"],
        properties: {
          workOrderId: { type: "string" },
          acceptedByAgentId: { type: ["string", "null"], default: null },
          acceptedAt: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_progress",
      description: "Append progress event to a SubAgentWorkOrder.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId"],
        properties: {
          workOrderId: { type: "string" },
          progressId: { type: ["string", "null"], default: null },
          eventType: { type: ["string", "null"], default: null },
          message: { type: ["string", "null"], default: null },
          percentComplete: { type: ["integer", "null"], minimum: 0, maximum: 100, default: null },
          evidenceRefs: { type: ["array", "null"], items: { type: "string" }, default: null },
          at: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_topup",
      description: "Append a metering top-up event for a SubAgentWorkOrder.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId", "topUpId", "amountCents"],
        properties: {
          workOrderId: { type: "string" },
          topUpId: { type: "string" },
          amountCents: { type: "integer", minimum: 1 },
          quantity: { type: ["integer", "null"], minimum: 1, default: null },
          currency: { type: ["string", "null"], default: null },
          eventKey: { type: ["string", "null"], default: null },
          occurredAt: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_metering_get",
      description: "Get work-order metering snapshot and Meter.v1 events.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId"],
        properties: {
          workOrderId: { type: "string" },
          includeMeters: { type: ["boolean", "null"], default: true },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_complete",
      description: "Complete a SubAgentWorkOrder.v1 and attach SubAgentCompletionReceipt.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId"],
        properties: {
          workOrderId: { type: "string" },
          receiptId: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["success", "failed", null], default: null },
          outputs: { type: ["object", "array", "null"], default: null },
          metrics: { type: ["object", "null"], additionalProperties: true, default: null },
          evidenceRefs: { type: ["array", "null"], items: { type: "string" }, default: null },
          amountCents: { type: ["integer", "null"], minimum: 0, default: null },
          currency: { type: ["string", "null"], default: null },
          intentHash: { type: ["string", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          intentHash: { type: ["string", "null"], default: null },
          deliveredAt: { type: ["string", "null"], default: null },
          completedAt: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.work_order_settle",
      description: "Bind x402 settlement evidence to a completed SubAgentWorkOrder.v1.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["workOrderId", "x402GateId", "x402RunId"],
        properties: {
          workOrderId: { type: "string" },
          completionReceiptId: { type: ["string", "null"], default: null },
          status: { type: ["string", "null"], enum: ["released", "refunded", null], default: null },
          x402GateId: { type: "string" },
          x402RunId: { type: "string" },
          x402SettlementStatus: { type: ["string", "null"], default: null },
          x402ReceiptId: { type: ["string", "null"], default: null },
          completionReceiptHash: { type: ["string", "null"], default: null },
          intentHash: { type: ["string", "null"], default: null },
          acceptanceHash: { type: ["string", "null"], default: null },
          intentHash: { type: ["string", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          authorityGrantRef: { type: ["string", "null"], default: null },
          settledAt: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_create",
      description: "Create a Session.v1 container for agent collaboration.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          visibility: { type: ["string", "null"], enum: ["public", "tenant", "private", null], default: null },
          participants: { type: ["array", "null"], items: { type: "string" }, default: null },
          principalId: { type: ["string", "null"], default: null },
          policyRef: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          createdAt: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_list",
      description: "List sessions with optional visibility/participant filters.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: ["string", "null"], default: null },
          visibility: { type: ["string", "null"], enum: ["public", "tenant", "private", null], default: null },
          participantAgentId: { type: ["string", "null"], default: null },
          principalId: { type: ["string", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.session_get",
      description: "Fetch a Session.v1 by sessionId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_events_list",
      description: "List SessionEvent entries for a session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null },
          eventType: { type: ["string", "null"], default: null },
          checkpointConsumerId: { type: ["string", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.session_event_checkpoint_get",
      description: "Read SessionEvent inbox relay checkpoint for a session consumer.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId", "checkpointConsumerId"],
        properties: {
          sessionId: { type: "string" },
          checkpointConsumerId: { type: "string" },
          principalId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_event_checkpoint_ack",
      description: "Advance SessionEvent inbox relay checkpoint (ack).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId", "checkpointConsumerId"],
        properties: {
          sessionId: { type: "string" },
          checkpointConsumerId: { type: "string" },
          sinceEventId: { type: ["string", "null"], default: null },
          principalId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_event_checkpoint_requeue",
      description: "Requeue SessionEvent inbox relay checkpoint to an earlier cursor.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId", "checkpointConsumerId"],
        properties: {
          sessionId: { type: "string" },
          checkpointConsumerId: { type: "string" },
          sinceEventId: { type: ["string", "null"], default: null },
          principalId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_events_stream",
      description: "Read bounded SessionEvent SSE updates for a session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null },
          eventType: { type: ["string", "null"], default: null },
          sinceEventId: { type: ["string", "null"], default: null },
          checkpointConsumerId: { type: ["string", "null"], default: null },
          lastEventId: { type: ["string", "null"], default: null },
          maxEvents: { type: ["integer", "null"], minimum: 1, maximum: 200, default: 20 },
          timeoutMs: { type: ["integer", "null"], minimum: 200, maximum: 30000, default: 2000 }
        }
      }
    },
    {
      name: "nooterra.session_event_append",
      description: "Append a SessionEvent.v1 to a session with chain precondition checks.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId", "eventType"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null },
          eventType: { type: "string" },
          payload: { type: ["object", "array", "string", "number", "boolean", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          at: { type: ["string", "null"], default: null },
          actor: { type: ["object", "null"], additionalProperties: true, default: null },
          expectedPrevChainHash: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_replay_pack_get",
      description: "Fetch a deterministic SessionReplayPack.v1 export for audit/replay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null },
          sign: { type: ["boolean", "null"], default: null },
          signerKeyId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.session_transcript_get",
      description: "Fetch a deterministic SessionTranscript.v1 digest export for lightweight audit/replay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          principalId: { type: ["string", "null"], default: null },
          sign: { type: ["boolean", "null"], default: null },
          signerKeyId: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.state_checkpoint_create",
      description: "Create a StateCheckpoint.v1 object bound to ArtifactRef.v1 state/diff refs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ownerAgentId", "stateRef"],
        properties: {
          checkpointId: { type: ["string", "null"], default: null },
          ownerAgentId: { type: "string" },
          projectId: { type: ["string", "null"], default: null },
          sessionId: { type: ["string", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          parentCheckpointId: { type: ["string", "null"], default: null },
          delegationGrantRef: { type: ["string", "null"], default: null },
          authorityGrantRef: { type: ["string", "null"], default: null },
          stateRef: {
            type: "object",
            additionalProperties: true,
            required: ["artifactId", "artifactHash"],
            properties: {
              schemaVersion: { type: ["string", "null"], default: "ArtifactRef.v1" },
              artifactId: { type: "string" },
              artifactHash: { type: "string" },
              artifactType: { type: ["string", "null"], default: null },
              tenantId: { type: ["string", "null"], default: null },
              metadata: { type: ["object", "null"], additionalProperties: true, default: null }
            }
          },
          diffRefs: {
            type: ["array", "null"],
            default: null,
            items: {
              type: "object",
              additionalProperties: true,
              required: ["artifactId", "artifactHash"],
              properties: {
                schemaVersion: { type: ["string", "null"], default: "ArtifactRef.v1" },
                artifactId: { type: "string" },
                artifactHash: { type: "string" },
                artifactType: { type: ["string", "null"], default: null },
                tenantId: { type: ["string", "null"], default: null },
                metadata: { type: ["object", "null"], additionalProperties: true, default: null }
              }
            }
          },
          redactionPolicyRef: { type: ["string", "null"], default: null },
          metadata: { type: ["object", "null"], additionalProperties: true, default: null },
          createdAt: { type: ["string", "null"], default: null },
          updatedAt: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.state_checkpoint_list",
      description: "List StateCheckpoint.v1 records with optional filters.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          checkpointId: { type: ["string", "null"], default: null },
          projectId: { type: ["string", "null"], default: null },
          sessionId: { type: ["string", "null"], default: null },
          ownerAgentId: { type: ["string", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.state_checkpoint_get",
      description: "Fetch a StateCheckpoint.v1 record by checkpointId.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["checkpointId"],
        properties: {
          checkpointId: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.audit_lineage_list",
      description: "Fetch deterministic AuditLineage.v1 records across sessions/tasks/work-orders/runs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentId: { type: ["string", "null"], default: null },
          sessionId: { type: ["string", "null"], default: null },
          runId: { type: ["string", "null"], default: null },
          workOrderId: { type: ["string", "null"], default: null },
          traceId: { type: ["string", "null"], default: null },
          includeSessionEvents: { type: ["boolean", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 1000, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null },
          scanLimit: { type: ["integer", "null"], minimum: 1, maximum: 5000, default: null }
        }
      }
    },
    {
      name: "nooterra.relationships_list",
      description: "List tenant-scoped RelationshipEdge.v1 records for an agent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          counterpartyAgentId: { type: ["string", "null"], default: null },
          reputationWindow: { type: ["string", "null"], enum: ["7d", "30d", "allTime", null], default: null },
          asOf: { type: ["string", "null"], default: null },
          visibility: { type: ["string", "null"], enum: ["all", "private", "public_summary", null], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.public_reputation_summary_get",
      description: "Fetch PublicAgentReputationSummary.v1 for an opted-in public agent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          reputationVersion: { type: ["string", "null"], enum: ["v1", "v2", null], default: null },
          reputationWindow: { type: ["string", "null"], enum: ["7d", "30d", "allTime", null], default: null },
          asOf: { type: ["string", "null"], default: null },
          includeRelationships: { type: ["boolean", "null"], default: null },
          relationshipLimit: { type: ["integer", "null"], minimum: 1, maximum: 100, default: null }
        }
      }
    },
    {
      name: "nooterra.interaction_graph_pack_get",
      description: "Fetch VerifiedInteractionGraphPack.v1 with optional deterministic signing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId"],
        properties: {
          agentId: { type: "string" },
          reputationVersion: { type: ["string", "null"], enum: ["v1", "v2", null], default: null },
          reputationWindow: { type: ["string", "null"], enum: ["7d", "30d", "allTime", null], default: null },
          asOf: { type: ["string", "null"], default: null },
          counterpartyAgentId: { type: ["string", "null"], default: null },
          visibility: { type: ["string", "null"], enum: ["all", "private", "public_summary", null], default: null },
          sign: { type: ["boolean", "null"], default: false },
          signerKeyId: { type: ["string", "null"], default: null },
          limit: { type: ["integer", "null"], minimum: 1, default: null },
          offset: { type: ["integer", "null"], minimum: 0, default: null }
        }
      }
    },
    {
      name: "nooterra.x402_gate_create",
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
          delegationGrantRef: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.x402_gate_verify",
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
      name: "nooterra.x402_gate_get",
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
      name: "nooterra.x402_agent_lifecycle_get",
      description: "Fetch the current X402AgentLifecycle.v1 status for an agent.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId"],
        properties: {
          agentId: { type: "string" }
        }
      }
    },
    {
      name: "nooterra.x402_agent_lifecycle_set",
      description: "Set X402 agent lifecycle status (fail-closed transition checks).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "status"],
        properties: {
          agentId: { type: "string" },
          status: {
            type: "string",
            enum: ["provisioned", "active", "throttled", "suspended", "quarantined", "decommissioned", "frozen", "archived"]
          },
          reasonCode: { type: ["string", "null"], default: null },
          reasonMessage: { type: ["string", "null"], default: null },
          idempotencyKey: { type: ["string", "null"], default: null }
        }
      }
    },
    {
      name: "nooterra.about",
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
  const baseUrl = process.env.NOOTERRA_BASE_URL || "http://127.0.0.1:3000";
  const tenantId = process.env.NOOTERRA_TENANT_ID || "tenant_default";
  const apiKey = process.env.NOOTERRA_API_KEY || "";
  const protocol = process.env.NOOTERRA_PROTOCOL || null;
  const paidToolsBaseUrl = process.env.NOOTERRA_PAID_TOOLS_BASE_URL || "http://127.0.0.1:8402";
  const paidToolsAgentPassport = parseOptionalJsonObject(
    process.env.NOOTERRA_PAID_TOOLS_AGENT_PASSPORT ?? null,
    "NOOTERRA_PAID_TOOLS_AGENT_PASSPORT"
  );

  assertNonEmptyString(baseUrl, "NOOTERRA_BASE_URL");
  assertNonEmptyString(tenantId, "NOOTERRA_TENANT_ID");
  assertNonEmptyString(apiKey, "NOOTERRA_API_KEY");

  // Operational hint: this server speaks JSON-RPC over stdin/stdout (MCP stdio transport).
  // Keep stdout strictly for JSON-RPC messages; print hints to stderr only.
  process.stderr.write("[mcp] ready (stdio). Use `npm run mcp:probe` or an MCP client; do not paste shell prompts.\n");

  const client = makeNooterraClient({ baseUrl, tenantId, apiKey, protocol });
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
              serverInfo: { name: "nooterra-mcp-spike", version: "s23" },
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
          if (name === "nooterra.about") {
            const discovered = await client.discoverProtocol();
            result = {
              ok: true,
              server: { name: "nooterra-mcp-spike", version: "s23" },
              config: redactSecrets({ baseUrl, tenantId, protocol: discovered, paidToolsBaseUrl })
            };
          } else if (name === "nooterra.exa_search_paid") {
            const query = String(args?.query ?? "").trim();
            assertNonEmptyString(query, "query");
            const numResults = args?.numResults ?? 5;
            result = await paidToolsClient.exaSearch({ query, numResults });
          } else if (name === "nooterra.weather_current_paid") {
            const city = String(args?.city ?? "").trim();
            assertNonEmptyString(city, "city");
            const unit = args?.unit ?? "c";
            result = await paidToolsClient.weatherCurrent({ city, unit });
          } else if (name === "nooterra.llm_completion_paid") {
            const prompt = String(args?.prompt ?? "").trim();
            assertNonEmptyString(prompt, "prompt");
            const model = args?.model ?? "gpt-4o-mini";
            const maxTokens = args?.maxTokens ?? 128;
            result = await paidToolsClient.llmCompletion({ prompt, model, maxTokens });
          } else if (name === "nooterra.create_agreement") {
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
          } else if (name === "nooterra.x402_gate_create") {
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
            if (typeof args?.delegationGrantRef === "string" && args.delegationGrantRef.trim() !== "") {
              body.delegationGrantRef = args.delegationGrantRef.trim();
            }
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
          } else if (name === "nooterra.agreement_delegation_create") {
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
          } else if (name === "nooterra.agreement_delegation_list") {
            const agreementHash = String(args?.agreementHash ?? "").trim().toLowerCase();
            if (!isSha256Hex(agreementHash)) throw new TypeError("agreementHash must be a sha256 hex string");
            const query = new URLSearchParams();
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const path = `/agreements/${encodeURIComponent(agreementHash)}/delegations${query.toString() ? `?${query.toString()}` : ""}`;
            const out = await client.requestJson(path, { method: "GET" });
            result = { ok: true, agreementHash, ...redactSecrets(out) };
          } else if (name === "nooterra.delegation_grant_issue") {
            const delegatorAgentId = String(args?.delegatorAgentId ?? "").trim();
            const delegateeAgentId = String(args?.delegateeAgentId ?? "").trim();
            assertNonEmptyString(delegatorAgentId, "delegatorAgentId");
            assertNonEmptyString(delegateeAgentId, "delegateeAgentId");
            const maxPerCallCents = Number(args?.maxPerCallCents);
            if (!Number.isSafeInteger(maxPerCallCents) || maxPerCallCents < 0) {
              throw new TypeError("maxPerCallCents must be a non-negative safe integer");
            }
            const maxTotalCents = Number(args?.maxTotalCents);
            if (!Number.isSafeInteger(maxTotalCents) || maxTotalCents < 0) {
              throw new TypeError("maxTotalCents must be a non-negative safe integer");
            }

            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_delegation_grant_issue");

            const body = {
              delegatorAgentId,
              delegateeAgentId,
              scope: {
                allowedRiskClasses: Array.isArray(args?.allowedRiskClasses)
                  ? args.allowedRiskClasses.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean)
                  : ["financial"],
                sideEffectingAllowed: args?.sideEffectingAllowed !== false
              },
              spendLimit: {
                currency: args?.currency ? String(args.currency).trim().toUpperCase() : "USD",
                maxPerCallCents,
                maxTotalCents
              },
              chainBinding: {
                rootGrantHash: typeof args?.rootGrantHash === "string" && args.rootGrantHash.trim() !== "" ? args.rootGrantHash.trim() : null,
                parentGrantHash:
                  typeof args?.parentGrantHash === "string" && args.parentGrantHash.trim() !== "" ? args.parentGrantHash.trim() : null,
                depth: Number.isSafeInteger(Number(args?.depth)) ? Number(args.depth) : 0,
                maxDelegationDepth:
                  Number.isSafeInteger(Number(args?.maxDelegationDepth)) && Number(args.maxDelegationDepth) >= 0
                    ? Number(args.maxDelegationDepth)
                    : Number.isSafeInteger(Number(args?.depth))
                      ? Number(args.depth)
                      : 0
              },
              validity: {
                ...(typeof args?.issuedAt === "string" && args.issuedAt.trim() !== "" ? { issuedAt: args.issuedAt.trim() } : {}),
                ...(typeof args?.notBefore === "string" && args.notBefore.trim() !== "" ? { notBefore: args.notBefore.trim() } : {}),
                ...(typeof args?.expiresAt === "string" && args.expiresAt.trim() !== "" ? { expiresAt: args.expiresAt.trim() } : {})
              },
              revocation: {
                revocable: args?.revocable !== false
              }
            };
            if (typeof args?.grantId === "string" && args.grantId.trim() !== "") body.grantId = args.grantId.trim();
            if (Array.isArray(args?.allowedProviderIds)) {
              body.scope.allowedProviderIds = args.allowedProviderIds.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            if (Array.isArray(args?.allowedToolIds)) {
              body.scope.allowedToolIds = args.allowedToolIds.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) {
              body.metadata = args.metadata;
            }

            const out = await client.requestJson("/delegation-grants", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.delegation_grant_get") {
            const grantId = String(args?.grantId ?? "").trim();
            assertNonEmptyString(grantId, "grantId");
            const out = await client.requestJson(`/delegation-grants/${encodeURIComponent(grantId)}`, { method: "GET" });
            result = { ok: true, grantId, ...redactSecrets(out) };
          } else if (name === "nooterra.delegation_grant_list") {
            const query = new URLSearchParams();
            if (typeof args?.grantId === "string" && args.grantId.trim() !== "") query.set("grantId", args.grantId.trim());
            if (typeof args?.grantHash === "string" && args.grantHash.trim() !== "") query.set("grantHash", args.grantHash.trim().toLowerCase());
            if (typeof args?.delegatorAgentId === "string" && args.delegatorAgentId.trim() !== "") {
              query.set("delegatorAgentId", args.delegatorAgentId.trim());
            }
            if (typeof args?.delegateeAgentId === "string" && args.delegateeAgentId.trim() !== "") {
              query.set("delegateeAgentId", args.delegateeAgentId.trim());
            }
            if (typeof args?.includeRevoked === "boolean") query.set("includeRevoked", args.includeRevoked ? "true" : "false");
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/delegation-grants${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.delegation_grant_revoke") {
            const grantId = String(args?.grantId ?? "").trim();
            assertNonEmptyString(grantId, "grantId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_delegation_grant_revoke");
            const body = {};
            if (typeof args?.revocationReasonCode === "string" && args.revocationReasonCode.trim() !== "") {
              body.revocationReasonCode = args.revocationReasonCode.trim();
            }
            const out = await client.requestJson(`/delegation-grants/${encodeURIComponent(grantId)}/revoke`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, grantId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.authority_grant_issue") {
            const principalRef = args?.principalRef && typeof args.principalRef === "object" && !Array.isArray(args.principalRef) ? args.principalRef : null;
            if (!principalRef) throw new TypeError("principalRef must be an object");
            const principalType = String(principalRef.principalType ?? "").trim().toLowerCase();
            const principalId = String(principalRef.principalId ?? "").trim();
            if (!["human", "org", "service", "agent"].includes(principalType)) {
              throw new TypeError("principalRef.principalType must be one of: human|org|service|agent");
            }
            assertNonEmptyString(principalId, "principalRef.principalId");
            const granteeAgentId = String(args?.granteeAgentId ?? "").trim();
            assertNonEmptyString(granteeAgentId, "granteeAgentId");
            const maxPerCallCents = Number(args?.maxPerCallCents);
            if (!Number.isSafeInteger(maxPerCallCents) || maxPerCallCents < 0) {
              throw new TypeError("maxPerCallCents must be a non-negative safe integer");
            }
            const maxTotalCents = Number(args?.maxTotalCents);
            if (!Number.isSafeInteger(maxTotalCents) || maxTotalCents < 0) {
              throw new TypeError("maxTotalCents must be a non-negative safe integer");
            }

            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_authority_grant_issue");

            const body = {
              principalRef: {
                principalType,
                principalId
              },
              granteeAgentId,
              scope: {
                allowedRiskClasses: Array.isArray(args?.allowedRiskClasses)
                  ? args.allowedRiskClasses.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean)
                  : ["financial"],
                sideEffectingAllowed: args?.sideEffectingAllowed !== false
              },
              spendEnvelope: {
                currency: args?.currency ? String(args.currency).trim().toUpperCase() : "USD",
                maxPerCallCents,
                maxTotalCents
              },
              chainBinding: {
                rootGrantHash: typeof args?.rootGrantHash === "string" && args.rootGrantHash.trim() !== "" ? args.rootGrantHash.trim() : null,
                parentGrantHash:
                  typeof args?.parentGrantHash === "string" && args.parentGrantHash.trim() !== "" ? args.parentGrantHash.trim() : null,
                depth: Number.isSafeInteger(Number(args?.depth)) ? Number(args.depth) : 0,
                maxDelegationDepth:
                  Number.isSafeInteger(Number(args?.maxDelegationDepth)) && Number(args.maxDelegationDepth) >= 0
                    ? Number(args.maxDelegationDepth)
                    : Number.isSafeInteger(Number(args?.depth))
                      ? Number(args.depth)
                      : 0
              },
              validity: {
                ...(typeof args?.issuedAt === "string" && args.issuedAt.trim() !== "" ? { issuedAt: args.issuedAt.trim() } : {}),
                ...(typeof args?.notBefore === "string" && args.notBefore.trim() !== "" ? { notBefore: args.notBefore.trim() } : {}),
                ...(typeof args?.expiresAt === "string" && args.expiresAt.trim() !== "" ? { expiresAt: args.expiresAt.trim() } : {})
              },
              revocation: {
                revocable: args?.revocable !== false
              }
            };
            if (typeof args?.grantId === "string" && args.grantId.trim() !== "") body.grantId = args.grantId.trim();
            if (Array.isArray(args?.allowedProviderIds)) {
              body.scope.allowedProviderIds = args.allowedProviderIds.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            if (Array.isArray(args?.allowedToolIds)) {
              body.scope.allowedToolIds = args.allowedToolIds.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) {
              body.metadata = args.metadata;
            }

            const out = await client.requestJson("/authority-grants", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.authority_grant_get") {
            const grantId = String(args?.grantId ?? "").trim();
            assertNonEmptyString(grantId, "grantId");
            const out = await client.requestJson(`/authority-grants/${encodeURIComponent(grantId)}`, { method: "GET" });
            result = { ok: true, grantId, ...redactSecrets(out) };
          } else if (name === "nooterra.authority_grant_list") {
            const query = new URLSearchParams();
            if (typeof args?.grantId === "string" && args.grantId.trim() !== "") query.set("grantId", args.grantId.trim());
            if (typeof args?.grantHash === "string" && args.grantHash.trim() !== "") query.set("grantHash", args.grantHash.trim().toLowerCase());
            if (typeof args?.principalId === "string" && args.principalId.trim() !== "") {
              query.set("principalId", args.principalId.trim());
            }
            if (typeof args?.granteeAgentId === "string" && args.granteeAgentId.trim() !== "") {
              query.set("granteeAgentId", args.granteeAgentId.trim());
            }
            if (typeof args?.includeRevoked === "boolean") query.set("includeRevoked", args.includeRevoked ? "true" : "false");
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/authority-grants${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.authority_grant_revoke") {
            const grantId = String(args?.grantId ?? "").trim();
            assertNonEmptyString(grantId, "grantId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_authority_grant_revoke");
            const body = {};
            if (typeof args?.revocationReasonCode === "string" && args.revocationReasonCode.trim() !== "") {
              body.revocationReasonCode = args.revocationReasonCode.trim();
            }
            const out = await client.requestJson(`/authority-grants/${encodeURIComponent(grantId)}/revoke`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, grantId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.agent_card_upsert") {
            const agentId = String(args?.agentId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_agent_card_upsert");

            const body = { agentId };
            if (typeof args?.displayName === "string" && args.displayName.trim() !== "") body.displayName = args.displayName.trim();
            if (typeof args?.description === "string" && args.description.trim() !== "") body.description = args.description.trim();
            if (Array.isArray(args?.capabilities)) body.capabilities = args.capabilities.map((v) => String(v ?? "").trim()).filter(Boolean);
            if (typeof args?.visibility === "string" && args.visibility.trim() !== "") body.visibility = args.visibility.trim().toLowerCase();
            if (typeof args?.executionCoordinatorDid === "string" && args.executionCoordinatorDid.trim() !== "") {
              body.executionCoordinatorDid = args.executionCoordinatorDid.trim();
            }
            if (typeof args?.hostRuntime === "string" && args.hostRuntime.trim() !== "") {
              body.host = body.host && typeof body.host === "object" ? body.host : {};
              body.host.runtime = args.hostRuntime.trim();
            }
            if (typeof args?.hostEndpoint === "string" && args.hostEndpoint.trim() !== "") {
              body.host = body.host && typeof body.host === "object" ? body.host : {};
              body.host.endpoint = args.hostEndpoint.trim();
            }
            if (Array.isArray(args?.hostProtocols)) {
              body.host = body.host && typeof body.host === "object" ? body.host : {};
              body.host.protocols = args.hostProtocols.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            if (args?.priceHint && typeof args.priceHint === "object" && !Array.isArray(args.priceHint)) {
              const amountCents = Number(args.priceHint.amountCents);
              if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
                throw new TypeError("priceHint.amountCents must be a non-negative safe integer");
              }
              body.priceHint = {
                amountCents,
                currency: typeof args.priceHint.currency === "string" && args.priceHint.currency.trim() !== "" ? args.priceHint.currency.trim() : "USD",
                unit: typeof args.priceHint.unit === "string" && args.priceHint.unit.trim() !== "" ? args.priceHint.unit.trim() : "task"
              };
            }
            if (Array.isArray(args?.attestations)) body.attestations = args.attestations;
            if (args?.tools !== null && args?.tools !== undefined) {
              if (!Array.isArray(args.tools)) throw new TypeError("tools must be an array");
              body.tools = args.tools.map((row, index) => {
                if (!row || typeof row !== "object" || Array.isArray(row)) {
                  throw new TypeError(`tools[${index}] must be an object`);
                }
                const toolId = parseOptionalStringArg(row.toolId, `tools[${index}].toolId`, { max: 200 });
                if (!toolId) throw new TypeError(`tools[${index}].toolId is required`);
                const out = { toolId };
                const schemaVersion = parseOptionalStringArg(row.schemaVersion, `tools[${index}].schemaVersion`, { max: 64 });
                if (schemaVersion) out.schemaVersion = schemaVersion;
                const mcpToolName = parseOptionalStringArg(row.mcpToolName, `tools[${index}].mcpToolName`, { max: 200 });
                if (mcpToolName) out.mcpToolName = mcpToolName;
                const nameText = parseOptionalStringArg(row.name, `tools[${index}].name`, { max: 200 });
                if (nameText) out.name = nameText;
                const description = parseOptionalStringArg(row.description, `tools[${index}].description`, { max: 2000 });
                if (description) out.description = description;
                const riskClass = parseOptionalEnumArg(row.riskClass, `tools[${index}].riskClass`, [
                  "read",
                  "compute",
                  "action",
                  "financial"
                ]);
                if (riskClass) out.riskClass = riskClass;
                const sideEffecting = parseOptionalBooleanArg(row.sideEffecting, `tools[${index}].sideEffecting`);
                if (sideEffecting !== null) out.sideEffecting = sideEffecting;
                if (row.pricing !== null && row.pricing !== undefined) {
                  assertPlainObject(row.pricing, `tools[${index}].pricing`);
                  const amountCents = parseOptionalIntegerArg(row.pricing.amountCents, `tools[${index}].pricing.amountCents`, {
                    min: 0
                  });
                  if (amountCents === null) throw new TypeError(`tools[${index}].pricing.amountCents is required`);
                  out.pricing = { amountCents };
                  const currency = parseOptionalStringArg(row.pricing.currency, `tools[${index}].pricing.currency`, { max: 8 });
                  if (currency) out.pricing.currency = currency;
                  const unit = parseOptionalStringArg(row.pricing.unit, `tools[${index}].pricing.unit`, { max: 64 });
                  if (unit) out.pricing.unit = unit;
                }
                if (row.requiresEvidenceKinds !== null && row.requiresEvidenceKinds !== undefined) {
                  if (!Array.isArray(row.requiresEvidenceKinds)) {
                    throw new TypeError(`tools[${index}].requiresEvidenceKinds must be an array`);
                  }
                  const kinds = row.requiresEvidenceKinds
                    .map((entry, kindIndex) =>
                      parseOptionalEnumArg(entry, `tools[${index}].requiresEvidenceKinds[${kindIndex}]`, [
                        "artifact",
                        "hash",
                        "verification_report"
                      ])
                    )
                    .filter(Boolean);
                  out.requiresEvidenceKinds = [...new Set(kinds)];
                }
                if (row.metadata !== null && row.metadata !== undefined) {
                  assertPlainObject(row.metadata, `tools[${index}].metadata`);
                  out.metadata = row.metadata;
                }
                return out;
              });
            }
            if (Array.isArray(args?.tags)) body.tags = args.tags.map((v) => String(v ?? "").trim()).filter(Boolean);
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            if (args?.policyCompatibility !== null && args?.policyCompatibility !== undefined) {
              assertPlainObject(args.policyCompatibility, "policyCompatibility");
              const policyCompatibility = {};
              const schemaVersion = parseOptionalStringArg(args.policyCompatibility.schemaVersion, "policyCompatibility.schemaVersion", {
                max: 64
              });
              if (schemaVersion) policyCompatibility.schemaVersion = schemaVersion;
              if (args.policyCompatibility.supportsPolicyTemplates !== null && args.policyCompatibility.supportsPolicyTemplates !== undefined) {
                if (!Array.isArray(args.policyCompatibility.supportsPolicyTemplates)) {
                  throw new TypeError("policyCompatibility.supportsPolicyTemplates must be an array");
                }
                policyCompatibility.supportsPolicyTemplates = args.policyCompatibility.supportsPolicyTemplates
                  .map((entry, index) =>
                    parseOptionalStringArg(entry, `policyCompatibility.supportsPolicyTemplates[${index}]`, { max: 200 })
                  )
                  .filter(Boolean);
              }
              if (args.policyCompatibility.supportsEvidencePacks !== null && args.policyCompatibility.supportsEvidencePacks !== undefined) {
                if (!Array.isArray(args.policyCompatibility.supportsEvidencePacks)) {
                  throw new TypeError("policyCompatibility.supportsEvidencePacks must be an array");
                }
                policyCompatibility.supportsEvidencePacks = args.policyCompatibility.supportsEvidencePacks
                  .map((entry, index) =>
                    parseOptionalStringArg(entry, `policyCompatibility.supportsEvidencePacks[${index}]`, { max: 200 })
                  )
                  .filter(Boolean);
              }
              body.policyCompatibility = policyCompatibility;
            }
            if (args?.publish !== null && args?.publish !== undefined) {
              assertPlainObject(args.publish, "publish");
              const publish = {};
              const schemaVersion = parseOptionalStringArg(args.publish.schemaVersion, "publish.schemaVersion", { max: 64 });
              if (schemaVersion) publish.schemaVersion = schemaVersion;
              const algorithm = parseOptionalStringArg(args.publish.algorithm, "publish.algorithm", { max: 32 });
              if (algorithm) publish.algorithm = algorithm;
              const signerKeyId = parseOptionalStringArg(args.publish.signerKeyId, "publish.signerKeyId", { max: 200 });
              if (signerKeyId) publish.signerKeyId = signerKeyId;
              const signedAt = parseOptionalStringArg(args.publish.signedAt, "publish.signedAt", { max: 128 });
              if (signedAt) publish.signedAt = signedAt;
              const payloadHash = parseOptionalStringArg(args.publish.payloadHash, "publish.payloadHash", { max: 64 });
              if (payloadHash) publish.payloadHash = payloadHash;
              const signature = parseOptionalStringArg(args.publish.signature, "publish.signature", { max: 8192 });
              if (signature) publish.signature = signature;
              body.publish = publish;
            }

            const out = await client.requestJson("/agent-cards", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, agentId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.agent_discover") {
            const discoverArgs = args === null || args === undefined ? {} : args;
            assertPlainObject(discoverArgs, "arguments");
            assertNoUnknownKeys(
              discoverArgs,
              [
                "scope",
                "capability",
                "executionCoordinatorDid",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
                "supportsPolicyTemplate",
                "supportsEvidencePack",
                "status",
                "visibility",
                "runtime",
                "requireCapabilityAttestation",
                "attestationMinLevel",
                "attestationIssuerAgentId",
                "includeAttestationMetadata",
                "minTrustScore",
                "riskTier",
                "includeReputation",
                "reputationVersion",
                "reputationWindow",
                "scoreStrategy",
                "requesterAgentId",
                "includeRoutingFactors",
                "limit",
                "offset"
              ],
              "nooterra.agent_discover arguments"
            );
            const query = new URLSearchParams();
            const scope = parseOptionalEnumArg(discoverArgs.scope, "scope", ["tenant", "public"]) ?? "tenant";
            const capability = parseOptionalStringArg(discoverArgs.capability, "capability", { max: 256 });
            if (capability) query.set("capability", capability);
            const executionCoordinatorDid = parseOptionalStringArg(discoverArgs.executionCoordinatorDid, "executionCoordinatorDid", { max: 256 });
            if (executionCoordinatorDid) query.set("executionCoordinatorDid", executionCoordinatorDid);
            const toolId = parseOptionalStringArg(discoverArgs.toolId, "toolId", { max: 200 });
            if (toolId) query.set("toolId", toolId);
            const toolMcpName = parseOptionalStringArg(discoverArgs.toolMcpName, "toolMcpName", { max: 200 });
            if (toolMcpName) query.set("toolMcpName", toolMcpName);
            const toolRiskClass = parseOptionalEnumArg(discoverArgs.toolRiskClass, "toolRiskClass", [
              "read",
              "compute",
              "action",
              "financial"
            ]);
            if (toolRiskClass) query.set("toolRiskClass", toolRiskClass);
            const toolSideEffecting = parseOptionalBooleanArg(discoverArgs.toolSideEffecting, "toolSideEffecting");
            if (toolSideEffecting !== null) query.set("toolSideEffecting", toolSideEffecting ? "true" : "false");
            const toolMaxPriceCents = parseOptionalIntegerArg(discoverArgs.toolMaxPriceCents, "toolMaxPriceCents", { min: 0 });
            if (toolMaxPriceCents !== null) query.set("toolMaxPriceCents", String(toolMaxPriceCents));
            const toolRequiresEvidenceKind = parseOptionalEnumArg(discoverArgs.toolRequiresEvidenceKind, "toolRequiresEvidenceKind", [
              "artifact",
              "hash",
              "verification_report"
            ]);
            if (toolRequiresEvidenceKind) query.set("toolRequiresEvidenceKind", toolRequiresEvidenceKind);
            const supportsPolicyTemplate = parseOptionalStringArg(discoverArgs.supportsPolicyTemplate, "supportsPolicyTemplate", { max: 200 });
            if (supportsPolicyTemplate) query.set("supportsPolicyTemplate", supportsPolicyTemplate);
            const supportsEvidencePack = parseOptionalStringArg(discoverArgs.supportsEvidencePack, "supportsEvidencePack", { max: 200 });
            if (supportsEvidencePack) query.set("supportsEvidencePack", supportsEvidencePack);
            const status = parseOptionalEnumArg(discoverArgs.status, "status", ["active", "suspended", "revoked", "all"]);
            if (status) query.set("status", status);
            const visibility = parseOptionalEnumArg(discoverArgs.visibility, "visibility", ["public", "tenant", "private", "all"]);
            if (scope === "public" && visibility && visibility !== "public") {
              throw new TypeError("visibility must be public when scope=public");
            }
            if (visibility) query.set("visibility", visibility);
            const runtime = parseOptionalStringArg(discoverArgs.runtime, "runtime", { max: 64 });
            if (runtime) query.set("runtime", runtime.toLowerCase());
            const requireCapabilityAttestation = parseOptionalBooleanArg(
              discoverArgs.requireCapabilityAttestation,
              "requireCapabilityAttestation"
            );
            if (requireCapabilityAttestation !== null) {
              query.set("requireCapabilityAttestation", requireCapabilityAttestation ? "true" : "false");
            }
            const attestationMinLevel = parseOptionalEnumArg(discoverArgs.attestationMinLevel, "attestationMinLevel", [
              "self_claim",
              "attested",
              "certified"
            ]);
            if (attestationMinLevel) query.set("attestationMinLevel", attestationMinLevel);
            const attestationIssuerAgentId = parseOptionalStringArg(discoverArgs.attestationIssuerAgentId, "attestationIssuerAgentId", {
              max: 200
            });
            if (attestationIssuerAgentId) query.set("attestationIssuerAgentId", attestationIssuerAgentId);
            const includeAttestationMetadata = parseOptionalBooleanArg(discoverArgs.includeAttestationMetadata, "includeAttestationMetadata");
            if (includeAttestationMetadata !== null) {
              query.set("includeAttestationMetadata", includeAttestationMetadata ? "true" : "false");
            }
            const minTrustScore = parseOptionalIntegerArg(discoverArgs.minTrustScore, "minTrustScore", { min: 0, max: 100 });
            if (minTrustScore !== null) query.set("minTrustScore", String(minTrustScore));
            const riskTier = parseOptionalEnumArg(discoverArgs.riskTier, "riskTier", ["low", "guarded", "elevated", "high"]);
            if (riskTier) query.set("riskTier", riskTier);
            const includeReputation = parseOptionalBooleanArg(discoverArgs.includeReputation, "includeReputation");
            if (includeReputation !== null) query.set("includeReputation", includeReputation ? "true" : "false");
            const reputationVersion = parseOptionalEnumArg(discoverArgs.reputationVersion, "reputationVersion", ["v1", "v2"]);
            if (reputationVersion) query.set("reputationVersion", reputationVersion);
            const reputationWindow = parseOptionalEnumArg(discoverArgs.reputationWindow, "reputationWindow", ["7d", "30d", "alltime"]);
            if (reputationWindow) query.set("reputationWindow", reputationWindow === "alltime" ? "allTime" : reputationWindow);
            const scoreStrategy = parseOptionalEnumArg(discoverArgs.scoreStrategy, "scoreStrategy", [
              "balanced",
              "recent_bias",
              "trust_weighted"
            ]);
            if (scoreStrategy) query.set("scoreStrategy", scoreStrategy);
            const requesterAgentId = parseOptionalStringArg(discoverArgs.requesterAgentId, "requesterAgentId", { max: 200 });
            if (requesterAgentId) query.set("requesterAgentId", requesterAgentId);
            const includeRoutingFactors = parseOptionalBooleanArg(discoverArgs.includeRoutingFactors, "includeRoutingFactors");
            if (includeRoutingFactors !== null) query.set("includeRoutingFactors", includeRoutingFactors ? "true" : "false");
            const limit = parseOptionalIntegerArg(discoverArgs.limit, "limit", { min: 1, max: 100 });
            if (limit !== null) query.set("limit", String(limit));
            const offset = parseOptionalIntegerArg(discoverArgs.offset, "offset", { min: 0 });
            if (offset !== null) query.set("offset", String(offset));
            const discoverPath = scope === "public" ? "/public/agent-cards/discover" : "/agent-cards/discover";
            const out = await client.requestJson(`${discoverPath}${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.agent_discover_stream") {
            const streamArgs = args === null || args === undefined ? {} : args;
            assertPlainObject(streamArgs, "arguments");
            assertNoUnknownKeys(
              streamArgs,
              [
                "capability",
                "executionCoordinatorDid",
                "toolId",
                "toolMcpName",
                "toolRiskClass",
                "toolSideEffecting",
                "toolMaxPriceCents",
                "toolRequiresEvidenceKind",
                "status",
                "runtime",
                "sinceCursor",
                "lastEventId",
                "maxEvents",
                "timeoutMs"
              ],
              "nooterra.agent_discover_stream arguments"
            );
            const query = new URLSearchParams();
            const capability = parseOptionalStringArg(streamArgs.capability, "capability", { max: 256 });
            if (capability) query.set("capability", capability);
            const executionCoordinatorDid = parseOptionalStringArg(streamArgs.executionCoordinatorDid, "executionCoordinatorDid", {
              max: 256
            });
            if (executionCoordinatorDid) query.set("executionCoordinatorDid", executionCoordinatorDid);
            const toolId = parseOptionalStringArg(streamArgs.toolId, "toolId", { max: 200 });
            if (toolId) query.set("toolId", toolId);
            const toolMcpName = parseOptionalStringArg(streamArgs.toolMcpName, "toolMcpName", { max: 200 });
            if (toolMcpName) query.set("toolMcpName", toolMcpName);
            const toolRiskClass = parseOptionalEnumArg(streamArgs.toolRiskClass, "toolRiskClass", [
              "read",
              "compute",
              "action",
              "financial"
            ]);
            if (toolRiskClass) query.set("toolRiskClass", toolRiskClass);
            const toolSideEffecting = parseOptionalBooleanArg(streamArgs.toolSideEffecting, "toolSideEffecting");
            if (toolSideEffecting !== null) query.set("toolSideEffecting", toolSideEffecting ? "true" : "false");
            const toolMaxPriceCents = parseOptionalIntegerArg(streamArgs.toolMaxPriceCents, "toolMaxPriceCents", { min: 0 });
            if (toolMaxPriceCents !== null) query.set("toolMaxPriceCents", String(toolMaxPriceCents));
            const toolRequiresEvidenceKind = parseOptionalEnumArg(streamArgs.toolRequiresEvidenceKind, "toolRequiresEvidenceKind", [
              "artifact",
              "hash",
              "verification_report"
            ]);
            if (toolRequiresEvidenceKind) query.set("toolRequiresEvidenceKind", toolRequiresEvidenceKind);
            const status = parseOptionalEnumArg(streamArgs.status, "status", ["active", "suspended", "revoked", "all"]);
            if (status) query.set("status", status);
            const runtime = parseOptionalStringArg(streamArgs.runtime, "runtime", { max: 64 });
            if (runtime) query.set("runtime", runtime.toLowerCase());
            const sinceCursor = parseOptionalStringArg(streamArgs.sinceCursor, "sinceCursor", { max: 512 });
            if (sinceCursor) query.set("sinceCursor", sinceCursor);
            const lastEventId = parseOptionalStringArg(streamArgs.lastEventId, "lastEventId", { max: 512 });
            const maxEvents = parseOptionalIntegerArg(streamArgs.maxEvents, "maxEvents", { min: 1, max: 200 });
            const timeoutMs = parseOptionalIntegerArg(streamArgs.timeoutMs, "timeoutMs", { min: 200, max: 30_000 });
            const out = await client.requestSseEvents(`/public/agent-cards/stream${query.toString() ? `?${query.toString()}` : ""}`, {
              headers: lastEventId ? { "last-event-id": lastEventId } : {},
              ...(maxEvents === null ? {} : { maxEvents }),
              ...(timeoutMs === null ? {} : { timeoutMs })
            });
            result = {
              ok: true,
              scope: "public",
              eventCount: Array.isArray(out?.events) ? out.events.length : 0,
              lastEventId: out?.lastEventId ?? null,
              truncated: out?.truncated === true,
              timedOut: out?.timedOut === true,
              events: redactSecrets(out?.events ?? [])
            };
          } else if (name === "nooterra.agent_resolve") {
            const resolveArgs = args === null || args === undefined ? {} : args;
            assertPlainObject(resolveArgs, "arguments");
            assertNoUnknownKeys(resolveArgs, ["agentRef"], "nooterra.agent_resolve arguments");
            const agentRef = parseOptionalStringArg(resolveArgs.agentRef, "agentRef", { max: 1024 });
            assertNonEmptyString(agentRef, "agentRef");
            const query = new URLSearchParams();
            query.set("agent", agentRef);
            const out = await client.requestJson(`/v1/public/agents/resolve?${query.toString()}`, { method: "GET" });
            result = { ok: true, agentRef, ...redactSecrets(out) };
          } else if (name === "nooterra.relationships_list") {
            const agentId = String(args?.agentId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            const query = new URLSearchParams();
            query.set("agentId", agentId);
            if (typeof args?.counterpartyAgentId === "string" && args.counterpartyAgentId.trim() !== "") {
              query.set("counterpartyAgentId", args.counterpartyAgentId.trim());
            }
            if (typeof args?.reputationWindow === "string" && args.reputationWindow.trim() !== "") {
              query.set("reputationWindow", args.reputationWindow.trim());
            }
            if (typeof args?.asOf === "string" && args.asOf.trim() !== "") query.set("asOf", args.asOf.trim());
            if (typeof args?.visibility === "string" && args.visibility.trim() !== "") {
              query.set("visibility", args.visibility.trim().toLowerCase());
            }
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/relationships?${query.toString()}`, { method: "GET" });
            result = { ok: true, agentId, ...redactSecrets(out) };
          } else if (name === "nooterra.public_reputation_summary_get") {
            const agentId = String(args?.agentId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            const query = new URLSearchParams();
            if (typeof args?.reputationVersion === "string" && args.reputationVersion.trim() !== "") {
              query.set("reputationVersion", args.reputationVersion.trim().toLowerCase());
            }
            if (typeof args?.reputationWindow === "string" && args.reputationWindow.trim() !== "") {
              query.set("reputationWindow", args.reputationWindow.trim());
            }
            if (typeof args?.asOf === "string" && args.asOf.trim() !== "") query.set("asOf", args.asOf.trim());
            if (typeof args?.includeRelationships === "boolean") {
              query.set("includeRelationships", args.includeRelationships ? "true" : "false");
            }
            if (Number.isSafeInteger(Number(args?.relationshipLimit)) && Number(args.relationshipLimit) > 0) {
              query.set("relationshipLimit", String(Number(args.relationshipLimit)));
            }
            const out = await client.requestJson(
              `/public/agents/${encodeURIComponent(agentId)}/reputation-summary${query.toString() ? `?${query.toString()}` : ""}`,
              { method: "GET" }
            );
            result = { ok: true, agentId, ...redactSecrets(out) };
          } else if (name === "nooterra.interaction_graph_pack_get") {
            const agentId = String(args?.agentId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            const query = new URLSearchParams();
            if (typeof args?.reputationVersion === "string" && args.reputationVersion.trim() !== "") {
              query.set("reputationVersion", args.reputationVersion.trim().toLowerCase());
            }
            if (typeof args?.reputationWindow === "string" && args.reputationWindow.trim() !== "") {
              query.set("reputationWindow", args.reputationWindow.trim());
            }
            if (typeof args?.asOf === "string" && args.asOf.trim() !== "") query.set("asOf", args.asOf.trim());
            if (typeof args?.counterpartyAgentId === "string" && args.counterpartyAgentId.trim() !== "") {
              query.set("counterpartyAgentId", args.counterpartyAgentId.trim());
            }
            if (typeof args?.visibility === "string" && args.visibility.trim() !== "") {
              query.set("visibility", args.visibility.trim().toLowerCase());
            }
            const sign = args?.sign === true;
            if (sign) query.set("sign", "true");
            if (typeof args?.signerKeyId === "string" && args.signerKeyId.trim() !== "") {
              if (!sign) throw new TypeError("signerKeyId requires sign=true");
              query.set("signerKeyId", args.signerKeyId.trim());
            }
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(
              `/agents/${encodeURIComponent(agentId)}/interaction-graph-pack${query.toString() ? `?${query.toString()}` : ""}`,
              { method: "GET" }
            );
            result = { ok: true, agentId, signed: sign, ...redactSecrets(out) };
          } else if (name === "nooterra.capability_attest") {
            const subjectAgentId = String(args?.subjectAgentId ?? "").trim();
            const capability = String(args?.capability ?? "").trim();
            assertNonEmptyString(subjectAgentId, "subjectAgentId");
            assertNonEmptyString(capability, "capability");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_capability_attest");
            const body = { subjectAgentId, capability };
            if (typeof args?.attestationId === "string" && args.attestationId.trim() !== "") body.attestationId = args.attestationId.trim();
            if (typeof args?.level === "string" && args.level.trim() !== "") body.level = args.level.trim().toLowerCase();
            if (typeof args?.issuerAgentId === "string" && args.issuerAgentId.trim() !== "") body.issuerAgentId = args.issuerAgentId.trim();
            if (args?.verificationMethod && typeof args.verificationMethod === "object" && !Array.isArray(args.verificationMethod)) {
              body.verificationMethod = args.verificationMethod;
            }
            if (Array.isArray(args?.evidenceRefs)) body.evidenceRefs = args.evidenceRefs.map((v) => String(v ?? "").trim()).filter(Boolean);
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const validity = {};
            if (typeof args?.issuedAt === "string" && args.issuedAt.trim() !== "") validity.issuedAt = args.issuedAt.trim();
            if (typeof args?.notBefore === "string" && args.notBefore.trim() !== "") validity.notBefore = args.notBefore.trim();
            if (typeof args?.expiresAt === "string" && args.expiresAt.trim() !== "") validity.expiresAt = args.expiresAt.trim();
            if (Object.keys(validity).length > 0) body.validity = validity;
            const signature = {};
            if (typeof args?.signatureKeyId === "string" && args.signatureKeyId.trim() !== "") signature.keyId = args.signatureKeyId.trim();
            if (typeof args?.signature === "string" && args.signature.trim() !== "") signature.signature = args.signature.trim();
            if (Object.keys(signature).length > 0) body.signature = signature;
            const out = await client.requestJson("/capability-attestations", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.capability_attestation_list") {
            const query = new URLSearchParams();
            if (typeof args?.attestationId === "string" && args.attestationId.trim() !== "") query.set("attestationId", args.attestationId.trim());
            if (typeof args?.subjectAgentId === "string" && args.subjectAgentId.trim() !== "") query.set("subjectAgentId", args.subjectAgentId.trim());
            if (typeof args?.issuerAgentId === "string" && args.issuerAgentId.trim() !== "") query.set("issuerAgentId", args.issuerAgentId.trim());
            if (typeof args?.capability === "string" && args.capability.trim() !== "") query.set("capability", args.capability.trim());
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim().toLowerCase());
            if (typeof args?.at === "string" && args.at.trim() !== "") query.set("at", args.at.trim());
            if (typeof args?.includeInvalid === "boolean") query.set("includeInvalid", args.includeInvalid ? "true" : "false");
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/capability-attestations${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.capability_attestation_revoke") {
            const attestationId = String(args?.attestationId ?? "").trim();
            assertNonEmptyString(attestationId, "attestationId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_capability_attestation_revoke");
            const body = {};
            if (typeof args?.revokedAt === "string" && args.revokedAt.trim() !== "") body.revokedAt = args.revokedAt.trim();
            if (typeof args?.reasonCode === "string" && args.reasonCode.trim() !== "") body.reasonCode = args.reasonCode.trim();
            const out = await client.requestJson(`/capability-attestations/${encodeURIComponent(attestationId)}/revoke`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, attestationId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.task_quote_issue") {
            const buyerAgentId = String(args?.buyerAgentId ?? "").trim();
            const sellerAgentId = String(args?.sellerAgentId ?? "").trim();
            const requiredCapability = String(args?.requiredCapability ?? "").trim();
            assertNonEmptyString(buyerAgentId, "buyerAgentId");
            assertNonEmptyString(sellerAgentId, "sellerAgentId");
            assertNonEmptyString(requiredCapability, "requiredCapability");
            const amountCents = Number(args?.amountCents);
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_task_quote_issue");
            const body = {
              buyerAgentId,
              sellerAgentId,
              requiredCapability,
              pricing: {
                amountCents,
                currency: typeof args?.currency === "string" && args.currency.trim() !== "" ? args.currency.trim() : "USD"
              }
            };
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") body.quoteId = args.quoteId.trim();
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (args?.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)) body.constraints = args.constraints;
            if (args?.attestationRequirement && typeof args.attestationRequirement === "object" && !Array.isArray(args.attestationRequirement)) {
              body.attestationRequirement = args.attestationRequirement;
            }
            if (args?.intentContract && typeof args.intentContract === "object" && !Array.isArray(args.intentContract)) {
              body.intentContract = args.intentContract;
            }
            if (typeof args?.intentActorAgentId === "string" && args.intentActorAgentId.trim() !== "") {
              body.intentActorAgentId = args.intentActorAgentId.trim();
            }
            if (typeof args?.intentEventId === "string" && args.intentEventId.trim() !== "") {
              body.intentEventId = args.intentEventId.trim();
            }
            if (typeof args?.intentEventAt === "string" && args.intentEventAt.trim() !== "") {
              body.intentEventAt = args.intentEventAt.trim();
            }
            if (args?.intentEventMetadata && typeof args.intentEventMetadata === "object" && !Array.isArray(args.intentEventMetadata)) {
              body.intentEventMetadata = args.intentEventMetadata;
            }
            if (typeof args?.expiresAt === "string" && args.expiresAt.trim() !== "") body.expiresAt = args.expiresAt.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson("/task-quotes", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.task_quote_list") {
            const query = new URLSearchParams();
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") query.set("quoteId", args.quoteId.trim());
            if (typeof args?.buyerAgentId === "string" && args.buyerAgentId.trim() !== "") query.set("buyerAgentId", args.buyerAgentId.trim());
            if (typeof args?.sellerAgentId === "string" && args.sellerAgentId.trim() !== "") query.set("sellerAgentId", args.sellerAgentId.trim());
            if (typeof args?.requiredCapability === "string" && args.requiredCapability.trim() !== "") {
              query.set("requiredCapability", args.requiredCapability.trim());
            }
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim().toLowerCase());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/task-quotes${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.task_offer_issue") {
            const buyerAgentId = String(args?.buyerAgentId ?? "").trim();
            const sellerAgentId = String(args?.sellerAgentId ?? "").trim();
            assertNonEmptyString(buyerAgentId, "buyerAgentId");
            assertNonEmptyString(sellerAgentId, "sellerAgentId");
            const amountCents = Number(args?.amountCents);
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_task_offer_issue");
            const body = {
              buyerAgentId,
              sellerAgentId,
              pricing: {
                amountCents,
                currency: typeof args?.currency === "string" && args.currency.trim() !== "" ? args.currency.trim() : "USD"
              }
            };
            if (typeof args?.offerId === "string" && args.offerId.trim() !== "") body.offerId = args.offerId.trim();
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") {
              body.quoteRef = {
                quoteId: args.quoteId.trim()
              };
              if (typeof args?.quoteHash === "string" && args.quoteHash.trim() !== "") {
                body.quoteRef.quoteHash = args.quoteHash.trim().toLowerCase();
              }
            }
            if (args?.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)) body.constraints = args.constraints;
            if (args?.intentContract && typeof args.intentContract === "object" && !Array.isArray(args.intentContract)) {
              body.intentContract = args.intentContract;
            }
            if (typeof args?.intentActorAgentId === "string" && args.intentActorAgentId.trim() !== "") {
              body.intentActorAgentId = args.intentActorAgentId.trim();
            }
            if (typeof args?.intentEventId === "string" && args.intentEventId.trim() !== "") {
              body.intentEventId = args.intentEventId.trim();
            }
            if (typeof args?.intentEventAt === "string" && args.intentEventAt.trim() !== "") {
              body.intentEventAt = args.intentEventAt.trim();
            }
            if (args?.intentEventMetadata && typeof args.intentEventMetadata === "object" && !Array.isArray(args.intentEventMetadata)) {
              body.intentEventMetadata = args.intentEventMetadata;
            }
            if (typeof args?.intentPrevEventHash === "string" && args.intentPrevEventHash.trim() !== "") {
              body.intentPrevEventHash = args.intentPrevEventHash.trim().toLowerCase();
            }
            if (typeof args?.expiresAt === "string" && args.expiresAt.trim() !== "") body.expiresAt = args.expiresAt.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson("/task-offers", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.task_offer_list") {
            const query = new URLSearchParams();
            if (typeof args?.offerId === "string" && args.offerId.trim() !== "") query.set("offerId", args.offerId.trim());
            if (typeof args?.buyerAgentId === "string" && args.buyerAgentId.trim() !== "") query.set("buyerAgentId", args.buyerAgentId.trim());
            if (typeof args?.sellerAgentId === "string" && args.sellerAgentId.trim() !== "") query.set("sellerAgentId", args.sellerAgentId.trim());
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") query.set("quoteId", args.quoteId.trim());
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim().toLowerCase());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/task-offers${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.task_acceptance_issue") {
            const quoteId = String(args?.quoteId ?? "").trim();
            const offerId = String(args?.offerId ?? "").trim();
            const acceptedByAgentId = String(args?.acceptedByAgentId ?? "").trim();
            assertNonEmptyString(quoteId, "quoteId");
            assertNonEmptyString(offerId, "offerId");
            assertNonEmptyString(acceptedByAgentId, "acceptedByAgentId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_task_acceptance_issue");
            const body = {
              quoteId,
              offerId,
              acceptedByAgentId
            };
            if (typeof args?.acceptanceId === "string" && args.acceptanceId.trim() !== "") body.acceptanceId = args.acceptanceId.trim();
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.acceptedAt === "string" && args.acceptedAt.trim() !== "") body.acceptedAt = args.acceptedAt.trim();
            if (args?.intentContract && typeof args.intentContract === "object" && !Array.isArray(args.intentContract)) {
              body.intentContract = args.intentContract;
            }
            if (typeof args?.intentActorAgentId === "string" && args.intentActorAgentId.trim() !== "") {
              body.intentActorAgentId = args.intentActorAgentId.trim();
            }
            if (typeof args?.intentEventId === "string" && args.intentEventId.trim() !== "") {
              body.intentEventId = args.intentEventId.trim();
            }
            if (typeof args?.intentEventAt === "string" && args.intentEventAt.trim() !== "") {
              body.intentEventAt = args.intentEventAt.trim();
            }
            if (args?.intentEventMetadata && typeof args.intentEventMetadata === "object" && !Array.isArray(args.intentEventMetadata)) {
              body.intentEventMetadata = args.intentEventMetadata;
            }
            if (typeof args?.intentPrevEventHash === "string" && args.intentPrevEventHash.trim() !== "") {
              body.intentPrevEventHash = args.intentPrevEventHash.trim().toLowerCase();
            }
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson("/task-acceptances", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.task_acceptance_list") {
            const query = new URLSearchParams();
            if (typeof args?.acceptanceId === "string" && args.acceptanceId.trim() !== "") query.set("acceptanceId", args.acceptanceId.trim());
            if (typeof args?.buyerAgentId === "string" && args.buyerAgentId.trim() !== "") query.set("buyerAgentId", args.buyerAgentId.trim());
            if (typeof args?.sellerAgentId === "string" && args.sellerAgentId.trim() !== "") query.set("sellerAgentId", args.sellerAgentId.trim());
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") query.set("quoteId", args.quoteId.trim());
            if (typeof args?.offerId === "string" && args.offerId.trim() !== "") query.set("offerId", args.offerId.trim());
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim().toLowerCase());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/task-acceptances${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.intent_propose") {
            const proposerAgentId = String(args?.proposerAgentId ?? "").trim();
            const counterpartyAgentId = String(args?.counterpartyAgentId ?? "").trim();
            assertNonEmptyString(proposerAgentId, "proposerAgentId");
            assertNonEmptyString(counterpartyAgentId, "counterpartyAgentId");
            if (args?.objective === null || args?.objective === undefined) throw new TypeError("objective is required");
            if (!args?.budgetEnvelope || typeof args.budgetEnvelope !== "object" || Array.isArray(args.budgetEnvelope)) {
              throw new TypeError("budgetEnvelope is required");
            }
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_intent_propose");
            const body = {
              proposerAgentId,
              counterpartyAgentId,
              objective: args.objective,
              budgetEnvelope: args.budgetEnvelope
            };
            if (typeof args?.intentId === "string" && args.intentId.trim() !== "") body.intentId = args.intentId.trim();
            if (args?.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)) body.constraints = args.constraints;
            if (Array.isArray(args?.requiredApprovals)) body.requiredApprovals = args.requiredApprovals;
            if (args?.successCriteria && typeof args.successCriteria === "object" && !Array.isArray(args.successCriteria)) {
              body.successCriteria = args.successCriteria;
            }
            if (args?.terminationPolicy && typeof args.terminationPolicy === "object" && !Array.isArray(args.terminationPolicy)) {
              body.terminationPolicy = args.terminationPolicy;
            }
            if (typeof args?.proposedAt === "string" && args.proposedAt.trim() !== "") body.proposedAt = args.proposedAt.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson("/intents/propose", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.intent_list") {
            const query = new URLSearchParams();
            if (typeof args?.intentId === "string" && args.intentId.trim() !== "") query.set("intentId", args.intentId.trim());
            if (typeof args?.proposerAgentId === "string" && args.proposerAgentId.trim() !== "") {
              query.set("proposerAgentId", args.proposerAgentId.trim());
            }
            if (typeof args?.counterpartyAgentId === "string" && args.counterpartyAgentId.trim() !== "") {
              query.set("counterpartyAgentId", args.counterpartyAgentId.trim());
            }
            if (typeof args?.status === "string" && args.status.trim() !== "") query.set("status", args.status.trim().toLowerCase());
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/intents${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.intent_get") {
            const intentId = String(args?.intentId ?? "").trim();
            assertNonEmptyString(intentId, "intentId");
            const out = await client.requestJson(`/intents/${encodeURIComponent(intentId)}`, { method: "GET" });
            result = { ok: true, intentId, ...redactSecrets(out) };
          } else if (name === "nooterra.intent_counter") {
            const intentId = String(args?.intentId ?? "").trim();
            const proposerAgentId = String(args?.proposerAgentId ?? "").trim();
            assertNonEmptyString(intentId, "intentId");
            assertNonEmptyString(proposerAgentId, "proposerAgentId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_intent_counter");
            const body = { proposerAgentId };
            if (typeof args?.newIntentId === "string" && args.newIntentId.trim() !== "") body.intentId = args.newIntentId.trim();
            if (typeof args?.parentIntentHash === "string" && args.parentIntentHash.trim() !== "") {
              body.parentIntentHash = args.parentIntentHash.trim().toLowerCase();
            }
            if (args?.objective !== undefined) body.objective = args.objective;
            if (args?.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)) body.constraints = args.constraints;
            if (args?.budgetEnvelope && typeof args.budgetEnvelope === "object" && !Array.isArray(args.budgetEnvelope)) {
              body.budgetEnvelope = args.budgetEnvelope;
            }
            if (Array.isArray(args?.requiredApprovals)) body.requiredApprovals = args.requiredApprovals;
            if (args?.successCriteria && typeof args.successCriteria === "object" && !Array.isArray(args.successCriteria)) {
              body.successCriteria = args.successCriteria;
            }
            if (args?.terminationPolicy && typeof args.terminationPolicy === "object" && !Array.isArray(args.terminationPolicy)) {
              body.terminationPolicy = args.terminationPolicy;
            }
            if (typeof args?.proposedAt === "string" && args.proposedAt.trim() !== "") body.proposedAt = args.proposedAt.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson(`/intents/${encodeURIComponent(intentId)}/counter`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, intentId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.intent_accept") {
            const intentId = String(args?.intentId ?? "").trim();
            const acceptedByAgentId = String(args?.acceptedByAgentId ?? "").trim();
            assertNonEmptyString(intentId, "intentId");
            assertNonEmptyString(acceptedByAgentId, "acceptedByAgentId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_intent_accept");
            const body = { acceptedByAgentId };
            if (typeof args?.acceptedAt === "string" && args.acceptedAt.trim() !== "") body.acceptedAt = args.acceptedAt.trim();
            if (typeof args?.intentHash === "string" && args.intentHash.trim() !== "") body.intentHash = args.intentHash.trim().toLowerCase();
            const out = await client.requestJson(`/intents/${encodeURIComponent(intentId)}/accept`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, intentId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_create") {
            const principalAgentId = String(args?.principalAgentId ?? "").trim();
            const subAgentId = String(args?.subAgentId ?? "").trim();
            const requiredCapability = String(args?.requiredCapability ?? "").trim();
            assertNonEmptyString(principalAgentId, "principalAgentId");
            assertNonEmptyString(subAgentId, "subAgentId");
            assertNonEmptyString(requiredCapability, "requiredCapability");
            const amountCents = Number(args?.amountCents);
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_create");
            const body = {
              principalAgentId,
              subAgentId,
              requiredCapability,
              pricing: {
                amountCents,
                currency: typeof args?.currency === "string" && args.currency.trim() !== "" ? args.currency.trim() : "USD"
              }
            };
            if (typeof args?.workOrderId === "string" && args.workOrderId.trim() !== "") body.workOrderId = args.workOrderId.trim();
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.parentTaskId === "string" && args.parentTaskId.trim() !== "") body.parentTaskId = args.parentTaskId.trim();
            if (args?.specification && typeof args.specification === "object" && !Array.isArray(args.specification)) body.specification = args.specification;
            if (typeof args?.quoteId === "string" && args.quoteId.trim() !== "") body.pricing.quoteId = args.quoteId.trim();
            if (typeof args?.x402ToolId === "string" && args.x402ToolId.trim() !== "") body.x402ToolId = args.x402ToolId.trim();
            if (typeof args?.x402ProviderId === "string" && args.x402ProviderId.trim() !== "") body.x402ProviderId = args.x402ProviderId.trim();
            if (args?.constraints && typeof args.constraints === "object" && !Array.isArray(args.constraints)) body.constraints = args.constraints;
            if (args?.evidencePolicy && typeof args.evidencePolicy === "object" && !Array.isArray(args.evidencePolicy)) {
              body.evidencePolicy = args.evidencePolicy;
            }
            if (args?.attestationRequirement && typeof args.attestationRequirement === "object" && !Array.isArray(args.attestationRequirement)) {
              const req = args.attestationRequirement;
              if (typeof req.required !== "boolean") throw new TypeError("attestationRequirement.required must be boolean");
              body.attestationRequirement = { required: req.required };
              if (typeof req.minLevel === "string" && req.minLevel.trim() !== "") {
                body.attestationRequirement.minLevel = req.minLevel.trim().toLowerCase();
              }
              if (typeof req.issuerAgentId === "string" && req.issuerAgentId.trim() !== "") {
                body.attestationRequirement.issuerAgentId = req.issuerAgentId.trim();
              }
            }
            if (typeof args?.requireCapabilityAttestation === "boolean") {
              body.requireCapabilityAttestation = args.requireCapabilityAttestation;
            }
            if (typeof args?.attestationMinLevel === "string" && args.attestationMinLevel.trim() !== "") {
              body.attestationMinLevel = args.attestationMinLevel.trim().toLowerCase();
            }
            if (typeof args?.attestationIssuerAgentId === "string" && args.attestationIssuerAgentId.trim() !== "") {
              body.attestationIssuerAgentId = args.attestationIssuerAgentId.trim();
            }
            if (typeof args?.delegationGrantRef === "string" && args.delegationGrantRef.trim() !== "") {
              body.delegationGrantRef = args.delegationGrantRef.trim();
            }
            if (typeof args?.authorityGrantRef === "string" && args.authorityGrantRef.trim() !== "") {
              body.authorityGrantRef = args.authorityGrantRef.trim();
            }
            if (typeof args?.requireAcceptedIntentHash === "boolean") {
              body.requireAcceptedIntentHash = args.requireAcceptedIntentHash;
            }
            if (args?.intentRef && typeof args.intentRef === "object" && !Array.isArray(args.intentRef)) {
              const negotiationId = String(args.intentRef.negotiationId ?? "").trim();
              const intentId = String(args.intentRef.intentId ?? "").trim();
              const intentHash = String(args.intentRef.intentHash ?? "").trim().toLowerCase();
              if (!negotiationId || !intentId || !intentHash) {
                throw new TypeError("intentRef requires negotiationId, intentId, and intentHash");
              }
              body.intentRef = {
                negotiationId,
                intentId,
                intentHash
              };
              if (typeof args.intentRef.acceptedEventHash === "string" && args.intentRef.acceptedEventHash.trim() !== "") {
                body.intentRef.acceptedEventHash = args.intentRef.acceptedEventHash.trim().toLowerCase();
              }
            }
            if (args?.acceptanceRef && typeof args.acceptanceRef === "object" && !Array.isArray(args.acceptanceRef)) {
              const acceptanceId = String(args.acceptanceRef.acceptanceId ?? "").trim();
              if (!acceptanceId) throw new TypeError("acceptanceRef.acceptanceId is required when acceptanceRef is provided");
              body.acceptanceRef = { acceptanceId };
              if (typeof args.acceptanceRef.acceptanceHash === "string" && args.acceptanceRef.acceptanceHash.trim() !== "") {
                body.acceptanceRef.acceptanceHash = args.acceptanceRef.acceptanceHash.trim().toLowerCase();
              }
            }
            if (args?.intentBinding && typeof args.intentBinding === "object" && !Array.isArray(args.intentBinding)) {
              const intentId = String(args.intentBinding.intentId ?? "").trim();
              if (!intentId) throw new TypeError("intentBinding.intentId is required when intentBinding is provided");
              body.intentBinding = { intentId };
              if (typeof args.intentBinding.intentHash === "string" && args.intentBinding.intentHash.trim() !== "") {
                body.intentBinding.intentHash = args.intentBinding.intentHash.trim().toLowerCase();
              }
              if (typeof args.intentBinding.boundAt === "string" && args.intentBinding.boundAt.trim() !== "") {
                body.intentBinding.boundAt = args.intentBinding.boundAt.trim();
              }
            }
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;

            const out = await client.requestJson("/work-orders", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_accept") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            assertNonEmptyString(workOrderId, "workOrderId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_accept");
            const body = {};
            if (typeof args?.acceptedByAgentId === "string" && args.acceptedByAgentId.trim() !== "") {
              body.acceptedByAgentId = args.acceptedByAgentId.trim();
            }
            if (typeof args?.acceptedAt === "string" && args.acceptedAt.trim() !== "") body.acceptedAt = args.acceptedAt.trim();
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/accept`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, workOrderId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_progress") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            assertNonEmptyString(workOrderId, "workOrderId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_progress");
            const body = {};
            if (typeof args?.progressId === "string" && args.progressId.trim() !== "") body.progressId = args.progressId.trim();
            if (typeof args?.eventType === "string" && args.eventType.trim() !== "") body.eventType = args.eventType.trim();
            if (typeof args?.message === "string" && args.message.trim() !== "") body.message = args.message.trim();
            if (args?.percentComplete !== null && args?.percentComplete !== undefined && args.percentComplete !== "") {
              const percentComplete = Number(args.percentComplete);
              if (!Number.isSafeInteger(percentComplete) || percentComplete < 0 || percentComplete > 100) {
                throw new TypeError("percentComplete must be an integer within 0..100");
              }
              body.percentComplete = percentComplete;
            }
            if (Array.isArray(args?.evidenceRefs)) body.evidenceRefs = args.evidenceRefs.map((v) => String(v ?? "").trim()).filter(Boolean);
            if (typeof args?.at === "string" && args.at.trim() !== "") body.at = args.at.trim();
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/progress`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, workOrderId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_topup") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            const topUpId = String(args?.topUpId ?? "").trim();
            const amountCents = Number(args?.amountCents);
            assertNonEmptyString(workOrderId, "workOrderId");
            assertNonEmptyString(topUpId, "topUpId");
            if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
              throw new TypeError("amountCents must be a positive safe integer");
            }
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_topup");
            const body = {
              topUpId,
              amountCents
            };
            if (args?.quantity !== null && args?.quantity !== undefined && args.quantity !== "") {
              const quantity = Number(args.quantity);
              if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("quantity must be a positive safe integer");
              body.quantity = quantity;
            }
            if (typeof args?.currency === "string" && args.currency.trim() !== "") body.currency = args.currency.trim();
            if (typeof args?.eventKey === "string" && args.eventKey.trim() !== "") body.eventKey = args.eventKey.trim();
            if (typeof args?.occurredAt === "string" && args.occurredAt.trim() !== "") body.occurredAt = args.occurredAt.trim();
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/topup`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, workOrderId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_metering_get") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            assertNonEmptyString(workOrderId, "workOrderId");
            const query = new URLSearchParams();
            if (typeof args?.includeMeters === "boolean") query.set("includeMeters", String(args.includeMeters));
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/metering${query.toString() ? `?${query.toString()}` : ""}`, {
              method: "GET"
            });
            result = { ok: true, workOrderId, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_complete") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            assertNonEmptyString(workOrderId, "workOrderId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_complete");
            const body = {};
            if (typeof args?.receiptId === "string" && args.receiptId.trim() !== "") body.receiptId = args.receiptId.trim();
            if (typeof args?.status === "string" && args.status.trim() !== "") body.status = args.status.trim().toLowerCase();
            if (Array.isArray(args?.outputs)) body.outputs = args.outputs;
            else if (args?.outputs && typeof args.outputs === "object") body.outputs = args.outputs;
            if (args?.metrics && typeof args.metrics === "object" && !Array.isArray(args.metrics)) body.metrics = args.metrics;
            if (Array.isArray(args?.evidenceRefs)) body.evidenceRefs = args.evidenceRefs.map((v) => String(v ?? "").trim()).filter(Boolean);
            if (args?.amountCents !== null && args?.amountCents !== undefined && args.amountCents !== "") {
              const amountCents = Number(args.amountCents);
              if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new TypeError("amountCents must be a non-negative safe integer");
              body.amountCents = amountCents;
            }
            if (typeof args?.currency === "string" && args.currency.trim() !== "") body.currency = args.currency.trim();
            if (typeof args?.intentHash === "string" && args.intentHash.trim() !== "") body.intentHash = args.intentHash.trim().toLowerCase();
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.intentHash === "string" && args.intentHash.trim() !== "") body.intentHash = args.intentHash.trim().toLowerCase();
            if (typeof args?.deliveredAt === "string" && args.deliveredAt.trim() !== "") body.deliveredAt = args.deliveredAt.trim();
            if (typeof args?.completedAt === "string" && args.completedAt.trim() !== "") body.completedAt = args.completedAt.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/complete`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, workOrderId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.work_order_settle") {
            const workOrderId = String(args?.workOrderId ?? "").trim();
            const x402GateId = String(args?.x402GateId ?? "").trim();
            const x402RunId = String(args?.x402RunId ?? "").trim();
            assertNonEmptyString(workOrderId, "workOrderId");
            assertNonEmptyString(x402GateId, "x402GateId");
            assertNonEmptyString(x402RunId, "x402RunId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_work_order_settle");
            const body = { x402GateId, x402RunId };
            if (typeof args?.completionReceiptId === "string" && args.completionReceiptId.trim() !== "") {
              body.completionReceiptId = args.completionReceiptId.trim();
            }
            if (typeof args?.status === "string" && args.status.trim() !== "") body.status = args.status.trim().toLowerCase();
            if (typeof args?.x402SettlementStatus === "string" && args.x402SettlementStatus.trim() !== "") {
              body.x402SettlementStatus = args.x402SettlementStatus.trim().toLowerCase();
            }
            if (typeof args?.x402ReceiptId === "string" && args.x402ReceiptId.trim() !== "") body.x402ReceiptId = args.x402ReceiptId.trim();
            if (typeof args?.completionReceiptHash === "string" && args.completionReceiptHash.trim() !== "") {
              body.completionReceiptHash = args.completionReceiptHash.trim().toLowerCase();
            }
            if (typeof args?.intentHash === "string" && args.intentHash.trim() !== "") {
              body.intentHash = args.intentHash.trim().toLowerCase();
            }
            if (typeof args?.acceptanceHash === "string" && args.acceptanceHash.trim() !== "") {
              body.acceptanceHash = args.acceptanceHash.trim().toLowerCase();
            }
            if (typeof args?.intentHash === "string" && args.intentHash.trim() !== "") {
              body.intentHash = args.intentHash.trim().toLowerCase();
            }
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.authorityGrantRef === "string" && args.authorityGrantRef.trim() !== "") {
              body.authorityGrantRef = args.authorityGrantRef.trim();
            }
            if (typeof args?.settledAt === "string" && args.settledAt.trim() !== "") body.settledAt = args.settledAt.trim();
            const out = await client.requestJson(`/work-orders/${encodeURIComponent(workOrderId)}/settle`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, workOrderId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.session_create") {
            const sessionId = String(args?.sessionId ?? "").trim();
            assertNonEmptyString(sessionId, "sessionId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_session_create");
            const body = { sessionId };
            if (typeof args?.visibility === "string" && args.visibility.trim() !== "") {
              body.visibility = args.visibility.trim().toLowerCase();
            }
            if (Array.isArray(args?.participants)) {
              body.participants = args.participants.map((v) => String(v ?? "").trim()).filter(Boolean);
            }
            const principalId =
              parseOptionalStringArg(args?.principalId, "principalId", { max: 200 }) ??
              (Array.isArray(body.participants) && body.participants.length > 0 ? String(body.participants[0]) : null);
            if (typeof args?.policyRef === "string" && args.policyRef.trim() !== "") body.policyRef = args.policyRef.trim();
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            if (typeof args?.createdAt === "string" && args.createdAt.trim() !== "") body.createdAt = args.createdAt.trim();
            const out = await client.requestJson("/sessions", {
              method: "POST",
              write: true,
              body,
              headers: principalId ? { "x-proxy-principal-id": principalId } : {},
              idem: idempotencyKey
            });
            result = { ok: true, sessionId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.session_list") {
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            const query = new URLSearchParams();
            if (typeof args?.sessionId === "string" && args.sessionId.trim() !== "") query.set("sessionId", args.sessionId.trim());
            if (typeof args?.visibility === "string" && args.visibility.trim() !== "") query.set("visibility", args.visibility.trim().toLowerCase());
            if (typeof args?.participantAgentId === "string" && args.participantAgentId.trim() !== "") {
              query.set("participantAgentId", args.participantAgentId.trim());
            }
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(`/sessions${query.toString() ? `?${query.toString()}` : ""}`, {
              method: "GET",
              headers: principalId ? { "x-proxy-principal-id": principalId } : {}
            });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.session_get") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            const out = await client.requestJson(`/sessions/${encodeURIComponent(sessionId)}`, {
              method: "GET",
              headers: principalId ? { "x-proxy-principal-id": principalId } : {}
            });
            result = { ok: true, sessionId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_events_list") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            const query = new URLSearchParams();
            if (typeof args?.eventType === "string" && args.eventType.trim() !== "") query.set("eventType", args.eventType.trim());
            if (typeof args?.checkpointConsumerId === "string" && args.checkpointConsumerId.trim() !== "") {
              query.set("checkpointConsumerId", args.checkpointConsumerId.trim());
            }
            if (Number.isSafeInteger(Number(args?.limit)) && Number(args.limit) > 0) query.set("limit", String(Number(args.limit)));
            if (Number.isSafeInteger(Number(args?.offset)) && Number(args.offset) >= 0) query.set("offset", String(Number(args.offset)));
            const out = await client.requestJson(
              `/sessions/${encodeURIComponent(sessionId)}/events${query.toString() ? `?${query.toString()}` : ""}`,
              {
                method: "GET",
                headers: principalId ? { "x-proxy-principal-id": principalId } : {}
              }
            );
            result = { ok: true, sessionId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_event_checkpoint_get") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const checkpointConsumerId = String(args?.checkpointConsumerId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            assertNonEmptyString(checkpointConsumerId, "checkpointConsumerId");
            const query = new URLSearchParams();
            query.set("checkpointConsumerId", checkpointConsumerId);
            const out = await client.requestJson(
              `/sessions/${encodeURIComponent(sessionId)}/events/checkpoint?${query.toString()}`,
              {
                method: "GET",
                headers: principalId ? { "x-proxy-principal-id": principalId } : {}
              }
            );
            result = { ok: true, sessionId, checkpointConsumerId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_event_checkpoint_ack") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const checkpointConsumerId = String(args?.checkpointConsumerId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            assertNonEmptyString(checkpointConsumerId, "checkpointConsumerId");
            const body = { checkpointConsumerId };
            if (typeof args?.sinceEventId === "string" && args.sinceEventId.trim() !== "") body.sinceEventId = args.sinceEventId.trim();
            else if (args?.sinceEventId === null) body.sinceEventId = null;
            const out = await client.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events/checkpoint`, {
              method: "POST",
              write: true,
              body,
              headers: principalId ? { "x-proxy-principal-id": principalId } : {}
            });
            result = { ok: true, sessionId, checkpointConsumerId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_event_checkpoint_requeue") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const checkpointConsumerId = String(args?.checkpointConsumerId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            assertNonEmptyString(checkpointConsumerId, "checkpointConsumerId");
            const body = { checkpointConsumerId };
            if (typeof args?.sinceEventId === "string" && args.sinceEventId.trim() !== "") body.sinceEventId = args.sinceEventId.trim();
            else if (args?.sinceEventId === null) body.sinceEventId = null;
            const out = await client.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events/checkpoint/requeue`, {
              method: "POST",
              write: true,
              body,
              headers: principalId ? { "x-proxy-principal-id": principalId } : {}
            });
            result = { ok: true, sessionId, checkpointConsumerId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_events_stream") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            const query = new URLSearchParams();
            if (typeof args?.eventType === "string" && args.eventType.trim() !== "") query.set("eventType", args.eventType.trim());
            if (typeof args?.sinceEventId === "string" && args.sinceEventId.trim() !== "") query.set("sinceEventId", args.sinceEventId.trim());
            if (typeof args?.checkpointConsumerId === "string" && args.checkpointConsumerId.trim() !== "") {
              query.set("checkpointConsumerId", args.checkpointConsumerId.trim());
            }
            const lastEventId = typeof args?.lastEventId === "string" && args.lastEventId.trim() !== "" ? args.lastEventId.trim() : null;
            const maxEvents = parseOptionalIntegerArg(args?.maxEvents, "maxEvents", { min: 1, max: 200 });
            const timeoutMs = parseOptionalIntegerArg(args?.timeoutMs, "timeoutMs", { min: 200, max: 30_000 });
            const out = await client.requestSseEvents(
              `/sessions/${encodeURIComponent(sessionId)}/events/stream${query.toString() ? `?${query.toString()}` : ""}`,
              {
                headers: {
                  ...(lastEventId ? { "last-event-id": lastEventId } : {}),
                  ...(principalId ? { "x-proxy-principal-id": principalId } : {})
                },
                ...(maxEvents === null ? {} : { maxEvents }),
                ...(timeoutMs === null ? {} : { timeoutMs })
              }
            );
            result = {
              ok: true,
              sessionId,
              eventCount: Array.isArray(out?.events) ? out.events.length : 0,
              lastEventId: out?.lastEventId ?? null,
              truncated: out?.truncated === true,
              timedOut: out?.timedOut === true,
              events: redactSecrets(out?.events ?? [])
            };
          } else if (name === "nooterra.session_event_append") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const eventType = String(args?.eventType ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            assertNonEmptyString(eventType, "eventType");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_session_event_append");
            let expectedPrevChainHash =
              typeof args?.expectedPrevChainHash === "string" && args.expectedPrevChainHash.trim() !== ""
                ? args.expectedPrevChainHash.trim()
                : null;
            if (!expectedPrevChainHash) {
              const eventsOut = await client.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events?limit=1&offset=0`, {
                method: "GET",
                headers: principalId ? { "x-proxy-principal-id": principalId } : {}
              });
              expectedPrevChainHash =
                typeof eventsOut?.currentPrevChainHash === "string" && eventsOut.currentPrevChainHash.trim() !== ""
                  ? eventsOut.currentPrevChainHash.trim()
                  : "null";
            }
            const body = { eventType };
            if (args?.payload !== undefined) body.payload = args.payload;
            if (typeof args?.traceId === "string" && args.traceId.trim() !== "") body.traceId = args.traceId.trim();
            if (typeof args?.at === "string" && args.at.trim() !== "") body.at = args.at.trim();
            if (args?.actor && typeof args.actor === "object" && !Array.isArray(args.actor)) body.actor = args.actor;
            const out = await client.requestJson(`/sessions/${encodeURIComponent(sessionId)}/events`, {
              method: "POST",
              write: true,
              body,
              headers: {
                "x-proxy-expected-prev-chain-hash": expectedPrevChainHash,
                ...(principalId ? { "x-proxy-principal-id": principalId } : {})
              },
              idem: idempotencyKey
            });
            result = { ok: true, sessionId, expectedPrevChainHash, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.session_replay_pack_get") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            const sign = parseOptionalBooleanArg(args?.sign, "sign");
            const signerKeyId = parseOptionalStringArg(args?.signerKeyId, "signerKeyId", { max: 200 });
            const query = new URLSearchParams();
            if (sign !== null) query.set("sign", String(sign));
            if (signerKeyId) query.set("signerKeyId", signerKeyId);
            const out = await client.requestJson(
              `/sessions/${encodeURIComponent(sessionId)}/replay-pack${query.toString() ? `?${query.toString()}` : ""}`,
              {
                method: "GET",
                headers: principalId ? { "x-proxy-principal-id": principalId } : {}
              }
            );
            result = { ok: true, sessionId, ...redactSecrets(out) };
          } else if (name === "nooterra.session_transcript_get") {
            const sessionId = String(args?.sessionId ?? "").trim();
            const principalId = parseOptionalStringArg(args?.principalId, "principalId", { max: 200 });
            assertNonEmptyString(sessionId, "sessionId");
            const sign = parseOptionalBooleanArg(args?.sign, "sign");
            const signerKeyId = parseOptionalStringArg(args?.signerKeyId, "signerKeyId", { max: 200 });
            const query = new URLSearchParams();
            if (sign !== null) query.set("sign", String(sign));
            if (signerKeyId) query.set("signerKeyId", signerKeyId);
            const out = await client.requestJson(
              `/sessions/${encodeURIComponent(sessionId)}/transcript${query.toString() ? `?${query.toString()}` : ""}`,
              {
                method: "GET",
                headers: principalId ? { "x-proxy-principal-id": principalId } : {}
              }
            );
            result = { ok: true, sessionId, ...redactSecrets(out) };
          } else if (name === "nooterra.state_checkpoint_create") {
            const ownerAgentId = String(args?.ownerAgentId ?? "").trim();
            assertNonEmptyString(ownerAgentId, "ownerAgentId");
            assertPlainObject(args?.stateRef, "stateRef");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_state_checkpoint_create");
            const body = {
              ownerAgentId,
              stateRef: args.stateRef
            };
            const checkpointId = parseOptionalStringArg(args?.checkpointId, "checkpointId", { max: 200 });
            if (checkpointId) body.checkpointId = checkpointId;
            const projectId = parseOptionalStringArg(args?.projectId, "projectId", { max: 200 });
            if (projectId) body.projectId = projectId;
            const sessionId = parseOptionalStringArg(args?.sessionId, "sessionId", { max: 200 });
            if (sessionId) body.sessionId = sessionId;
            const traceId = parseOptionalStringArg(args?.traceId, "traceId", { max: 256 });
            if (traceId) body.traceId = traceId;
            const parentCheckpointId = parseOptionalStringArg(args?.parentCheckpointId, "parentCheckpointId", { max: 200 });
            if (parentCheckpointId) body.parentCheckpointId = parentCheckpointId;
            const delegationGrantRef = parseOptionalStringArg(args?.delegationGrantRef, "delegationGrantRef", { max: 200 });
            if (delegationGrantRef) body.delegationGrantRef = delegationGrantRef;
            const authorityGrantRef = parseOptionalStringArg(args?.authorityGrantRef, "authorityGrantRef", { max: 200 });
            if (authorityGrantRef) body.authorityGrantRef = authorityGrantRef;
            if (args?.diffRefs !== null && args?.diffRefs !== undefined) {
              if (!Array.isArray(args.diffRefs)) throw new TypeError("diffRefs must be an array");
              body.diffRefs = args.diffRefs;
            }
            const redactionPolicyRef = parseOptionalStringArg(args?.redactionPolicyRef, "redactionPolicyRef", { max: 200 });
            if (redactionPolicyRef) body.redactionPolicyRef = redactionPolicyRef;
            if (args?.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)) body.metadata = args.metadata;
            const createdAt = parseOptionalStringArg(args?.createdAt, "createdAt", { max: 128 });
            if (createdAt) body.createdAt = createdAt;
            const updatedAt = parseOptionalStringArg(args?.updatedAt, "updatedAt", { max: 128 });
            if (updatedAt) body.updatedAt = updatedAt;
            const out = await client.requestJson("/state-checkpoints", {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.state_checkpoint_list") {
            const query = new URLSearchParams();
            const checkpointId = parseOptionalStringArg(args?.checkpointId, "checkpointId", { max: 200 });
            if (checkpointId) query.set("checkpointId", checkpointId);
            const projectId = parseOptionalStringArg(args?.projectId, "projectId", { max: 200 });
            if (projectId) query.set("projectId", projectId);
            const sessionId = parseOptionalStringArg(args?.sessionId, "sessionId", { max: 200 });
            if (sessionId) query.set("sessionId", sessionId);
            const ownerAgentId = parseOptionalStringArg(args?.ownerAgentId, "ownerAgentId", { max: 200 });
            if (ownerAgentId) query.set("ownerAgentId", ownerAgentId);
            const traceId = parseOptionalStringArg(args?.traceId, "traceId", { max: 256 });
            if (traceId) query.set("traceId", traceId);
            const limit = parseOptionalIntegerArg(args?.limit, "limit", { min: 1, max: 1000 });
            if (limit !== null) query.set("limit", String(limit));
            const offset = parseOptionalIntegerArg(args?.offset, "offset", { min: 0, max: 1_000_000 });
            if (offset !== null) query.set("offset", String(offset));
            const out = await client.requestJson(`/state-checkpoints${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.state_checkpoint_get") {
            const checkpointId = String(args?.checkpointId ?? "").trim();
            assertNonEmptyString(checkpointId, "checkpointId");
            const out = await client.requestJson(`/state-checkpoints/${encodeURIComponent(checkpointId)}`, { method: "GET" });
            result = { ok: true, checkpointId, ...redactSecrets(out) };
          } else if (name === "nooterra.audit_lineage_list") {
            const query = new URLSearchParams();
            const agentId = parseOptionalStringArg(args?.agentId, "agentId", { max: 256 });
            const sessionId = parseOptionalStringArg(args?.sessionId, "sessionId", { max: 256 });
            const runId = parseOptionalStringArg(args?.runId, "runId", { max: 256 });
            const workOrderId = parseOptionalStringArg(args?.workOrderId, "workOrderId", { max: 256 });
            const traceId = parseOptionalStringArg(args?.traceId, "traceId", { max: 256 });
            const includeSessionEvents = parseOptionalBooleanArg(args?.includeSessionEvents, "includeSessionEvents");
            const limit = parseOptionalIntegerArg(args?.limit, "limit", { min: 1, max: 1000 });
            const offset = parseOptionalIntegerArg(args?.offset, "offset", { min: 0, max: 1_000_000 });
            const scanLimit = parseOptionalIntegerArg(args?.scanLimit, "scanLimit", { min: 1, max: 5000 });

            if (agentId) query.set("agentId", agentId);
            if (sessionId) query.set("sessionId", sessionId);
            if (runId) query.set("runId", runId);
            if (workOrderId) query.set("workOrderId", workOrderId);
            if (traceId) query.set("traceId", traceId);
            if (includeSessionEvents !== null) query.set("includeSessionEvents", String(includeSessionEvents));
            if (limit !== null) query.set("limit", String(limit));
            if (offset !== null) query.set("offset", String(offset));
            if (scanLimit !== null) query.set("scanLimit", String(scanLimit));

            const out = await client.requestJson(`/ops/audit/lineage${query.toString() ? `?${query.toString()}` : ""}`, { method: "GET" });
            result = { ok: true, ...redactSecrets(out) };
          } else if (name === "nooterra.x402_gate_verify") {
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
          } else if (name === "nooterra.x402_gate_get") {
            const gateId = String(args?.gateId ?? "").trim();
            assertNonEmptyString(gateId, "gateId");
            const out = await client.requestJson(`/x402/gate/${encodeURIComponent(gateId)}`, { method: "GET" });
            result = { ok: true, gateId, ...redactSecrets(out) };
          } else if (name === "nooterra.x402_agent_lifecycle_get") {
            const agentId = String(args?.agentId ?? "").trim();
            assertNonEmptyString(agentId, "agentId");
            const out = await client.requestJson(`/x402/gate/agents/${encodeURIComponent(agentId)}/lifecycle`, { method: "GET" });
            result = { ok: true, agentId, ...redactSecrets(out) };
          } else if (name === "nooterra.x402_agent_lifecycle_set") {
            const agentId = String(args?.agentId ?? "").trim();
            const status = String(args?.status ?? "").trim().toLowerCase();
            assertNonEmptyString(agentId, "agentId");
            if (
              status !== "provisioned" &&
              status !== "active" &&
              status !== "throttled" &&
              status !== "suspended" &&
              status !== "quarantined" &&
              status !== "decommissioned" &&
              status !== "frozen" &&
              status !== "archived"
            ) {
              throw new TypeError(
                "status must be provisioned|active|throttled|suspended|quarantined|decommissioned|frozen|archived"
              );
            }
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_x402_agent_lifecycle_set");
            const body = {
              status,
              ...(typeof args?.reasonCode === "string" && args.reasonCode.trim() !== "" ? { reasonCode: args.reasonCode.trim() } : {}),
              ...(typeof args?.reasonMessage === "string" && args.reasonMessage.trim() !== ""
                ? { reasonMessage: args.reasonMessage.trim() }
                : {})
            };
            const out = await client.requestJson(`/x402/gate/agents/${encodeURIComponent(agentId)}/lifecycle`, {
              method: "POST",
              write: true,
              body,
              idem: idempotencyKey
            });
            result = { ok: true, agentId, status, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.submit_evidence") {
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
          } else if (name === "nooterra.settle_run") {
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
          } else if (name === "nooterra.open_dispute") {
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
          } else if (name === "nooterra.dispute_add_evidence") {
            const runId = String(args?.runId ?? "").trim();
            const evidenceRef = String(args?.evidenceRef ?? "").trim();
            assertNonEmptyString(runId, "runId");
            assertNonEmptyString(evidenceRef, "evidenceRef");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_dispute_evidence");
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/dispute/evidence`, {
              method: "POST",
              write: true,
              body: {
                disputeId: args?.disputeId ?? null,
                evidenceRef,
                submittedByAgentId: args?.submittedByAgentId ?? null,
                reason: args?.reason ?? null
              },
              idem: idempotencyKey
            });
            result = { ok: true, runId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.dispute_escalate") {
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            const escalationLevel = String(args?.escalationLevel ?? "").trim().toLowerCase();
            if (!["l1_counterparty", "l2_arbiter", "l3_external"].includes(escalationLevel)) {
              throw new TypeError("escalationLevel must be l1_counterparty|l2_arbiter|l3_external");
            }
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_dispute_escalate");
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/dispute/escalate`, {
              method: "POST",
              write: true,
              body: {
                disputeId: args?.disputeId ?? null,
                escalationLevel,
                channel: args?.channel ?? null,
                escalatedByAgentId: args?.escalatedByAgentId ?? null,
                reason: args?.reason ?? null
              },
              idem: idempotencyKey
            });
            result = { ok: true, runId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.dispute_close") {
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_dispute_close");
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/dispute/close`, {
              method: "POST",
              write: true,
              body: {
                disputeId: args?.disputeId ?? null,
                resolution: args?.resolution ?? null,
                verdict: args?.verdict ?? null,
                arbitrationVerdict: args?.arbitrationVerdict ?? null
              },
              idem: idempotencyKey
            });
            result = { ok: true, runId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.arbitration_open") {
            const runId = String(args?.runId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_arbitration_open");
            const panelCandidateAgentIds = Array.isArray(args?.panelCandidateAgentIds)
              ? args.panelCandidateAgentIds.map((v) => String(v ?? "").trim()).filter(Boolean)
              : null;
            const evidenceRefs = Array.isArray(args?.evidenceRefs) ? args.evidenceRefs.map((v) => String(v ?? "").trim()).filter(Boolean) : null;
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/arbitration/open`, {
              method: "POST",
              write: true,
              body: {
                caseId: args?.caseId ?? null,
                disputeId: args?.disputeId ?? null,
                arbiterAgentId: args?.arbiterAgentId ?? null,
                panelCandidateAgentIds,
                evidenceRefs,
                summary: args?.summary ?? null
              },
              idem: idempotencyKey
            });
            result = { ok: true, runId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.arbitration_issue_verdict") {
            const runId = String(args?.runId ?? "").trim();
            const caseId = String(args?.caseId ?? "").trim();
            assertNonEmptyString(runId, "runId");
            assertNonEmptyString(caseId, "caseId");
            if (!args?.arbitrationVerdict || typeof args.arbitrationVerdict !== "object" || Array.isArray(args.arbitrationVerdict)) {
              throw new TypeError("arbitrationVerdict must be an object");
            }
            const idempotencyKey =
              typeof args?.idempotencyKey === "string" && args.idempotencyKey.trim() !== ""
                ? args.idempotencyKey.trim()
                : makeIdempotencyKey("mcp_arbitration_verdict");
            const out = await client.requestJson(`/runs/${encodeURIComponent(runId)}/arbitration/verdict`, {
              method: "POST",
              write: true,
              body: {
                caseId,
                arbitrationVerdict: args.arbitrationVerdict
              },
              idem: idempotencyKey
            });
            result = { ok: true, runId, caseId, idempotencyKey, ...redactSecrets(out) };
          } else if (name === "nooterra.resolve_settlement") {
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
          const detectedFailure = detectToolResultFailure(result);
          if (detectedFailure) {
            const err = new Error(detectedFailure.message);
            if (detectedFailure.code) err.code = detectedFailure.code;
            if (Number.isInteger(detectedFailure.statusCode)) err.statusCode = detectedFailure.statusCode;
            err.details = detectedFailure.details ?? null;
            throw err;
          }
          const toolResult = { ...asTextResult({ tool: name, durationMs, result }), isError: false };
          if (!isNotification) stream.send({ jsonrpc: "2.0", id, result: toolResult });
        } catch (err) {
          const durationMs = nowMs() - started;
          const details =
            err?.details && typeof err.details === "object"
              ? err.details
              : null;
          const toolResult = {
            ...asErrorResult(err),
            content: [
              contentText(
                JSON.stringify(
                  {
                    tool: name,
                    durationMs,
                    error: err?.message ?? String(err),
                    code:
                      (details && typeof details.code === "string" && details.code.trim() !== ""
                        ? details.code.trim()
                        : typeof err?.code === "string" && err.code.trim() !== ""
                          ? err.code.trim()
                          : null),
                    statusCode: Number.isInteger(err?.statusCode) ? err.statusCode : null,
                    details
                  },
                  null,
                  2
                )
              )
            ]
          };
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
