import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { Readable } from "node:stream";

import { parseX402PaymentRequired } from "../../../src/core/x402-gate.js";

function readRequiredEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") throw new Error(`${name} is required`);
  return raw.trim();
}

function readOptionalIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function readOptionalBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  throw new Error(`${name} must be a boolean (1/0/true/false)`);
}

function readOptionalStringEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  return String(raw).trim();
}

function sanitizeIdSegment(text, { maxLen = 96 } = {}) {
  const raw = String(text ?? "").trim();
  const safe = raw.replaceAll(/[^A-Za-z0-9:_-]/g, "_").slice(0, maxLen);
  return safe || "unknown";
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function stableIdemKey(prefix, input) {
  const h = sha256Hex(Buffer.from(String(input ?? ""), "utf8")).slice(0, 32);
  return `${prefix}_${h}`;
}

function extractAmountAndCurrency(fields) {
  if (!fields || typeof fields !== "object") return { ok: false, error: "missing_fields" };
  const keys = ["amountCents", "amount_cents", "priceCents", "price_cents", "price", "amount"];
  let amountCents = null;
  for (const k of keys) {
    if (fields[k] === null || fields[k] === undefined) continue;
    const n = Number(fields[k]);
    if (Number.isSafeInteger(n) && n > 0) {
      amountCents = n;
      break;
    }
  }
  if (amountCents === null) return { ok: false, error: "amount_not_found" };
  const currencyRaw = fields.currency ?? fields.ccy ?? "USD";
  const currency = String(currencyRaw ?? "USD")
    .trim()
    .toUpperCase();
  return { ok: true, amountCents, currency: currency || "USD" };
}

async function readBodyWithLimit(res, { maxBytes }) {
  if (!res?.body) return { ok: true, bytes: 0, buf: Buffer.alloc(0) };
  const stream = Readable.fromWeb(res.body);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) return { ok: false, error: "too_large", bytes: total };
    chunks.push(b);
  }
  return { ok: true, bytes: total, buf: Buffer.concat(chunks) };
}

const SETTLD_API_URL = new URL(readRequiredEnv("SETTLD_API_URL"));
const SETTLD_API_KEY = readRequiredEnv("SETTLD_API_KEY");
const UPSTREAM_URL = new URL(readRequiredEnv("UPSTREAM_URL"));
const PORT = readOptionalIntEnv("PORT", 8402);
const HOLDBACK_BPS = readOptionalIntEnv("HOLDBACK_BPS", 1000);
const DISPUTE_WINDOW_MS = readOptionalIntEnv("DISPUTE_WINDOW_MS", 86_400_000);
const X402_AUTOFUND = readOptionalBoolEnv("X402_AUTOFUND", false);
const BIND_HOST = readOptionalStringEnv("BIND_HOST", null);

if (HOLDBACK_BPS < 0 || HOLDBACK_BPS > 10_000) throw new Error("HOLDBACK_BPS must be within 0..10000");
if (DISPUTE_WINDOW_MS < 0) throw new Error("DISPUTE_WINDOW_MS must be >= 0");

const SETTLD_PROTOCOL = "1.0";
const DEFAULT_TENANT_ID = "tenant_default";

function tenantIdForRequest(req) {
  const raw = req?.headers?.["x-proxy-tenant-id"];
  const t = String(raw ?? "").trim();
  return t || DEFAULT_TENANT_ID;
}

function derivePayerAgentId() {
  const keyId = String(SETTLD_API_KEY.split(".")[0] ?? "").trim();
  return `agt_x402_payer_${sanitizeIdSegment(keyId || "api_key")}`;
}

function derivePayeeAgentId() {
  const host = UPSTREAM_URL.host || UPSTREAM_URL.hostname || "upstream";
  return `agt_x402_payee_${sanitizeIdSegment(host)}`;
}

async function settldJson(path, { tenantId, method, idempotencyKey = null, body } = {}) {
  const res = await fetch(new URL(path, SETTLD_API_URL), {
    method: method ?? "POST",
    headers: {
      authorization: `Bearer ${SETTLD_API_KEY}`,
      "x-proxy-tenant-id": String(tenantId ?? DEFAULT_TENANT_ID),
      "x-settld-protocol": SETTLD_PROTOCOL,
      ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body ?? {})
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = json?.message ?? json?.error ?? text ?? `HTTP ${res.status}`;
    const err = new Error(`Settld ${method ?? "POST"} ${path} failed: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function handleProxy(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const tenantId = tenantIdForRequest(req);
  const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_URL);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === "host") continue;
    if (Array.isArray(v)) headers.set(k, v.join(","));
    else headers.set(k, String(v));
  }

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstreamRes = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
    signal: ac.signal
  });

  // If upstream requests payment, create a Settld gate and return the 402 to the client.
  if (upstreamRes.status === 402) {
    const headersObj = Object.fromEntries(upstreamRes.headers.entries());
    const parsed = parseX402PaymentRequired(headersObj);
    if (!parsed.ok) {
      res.writeHead(402, Object.fromEntries(upstreamRes.headers.entries()));
      res.end(await upstreamRes.text());
      return;
    }
    const amount = extractAmountAndCurrency(parsed.fields);
    if (!amount.ok) {
      res.writeHead(402, Object.fromEntries(upstreamRes.headers.entries()));
      res.end(await upstreamRes.text());
      return;
    }

    const payerAgentId = derivePayerAgentId();
    const payeeAgentId = derivePayeeAgentId();
    const gateCreate = await settldJson("/x402/gate/create", {
      tenantId,
      method: "POST",
      idempotencyKey: stableIdemKey("x402_create", `${upstreamUrl.toString()}\n${parsed.raw}\n${payerAgentId}\n${payeeAgentId}`),
      body: {
        payerAgentId,
        payeeAgentId,
        amountCents: amount.amountCents,
        currency: amount.currency,
        // Local-demo-only: lets the gate create an escrow hold without integrating a real payment rail.
        ...(X402_AUTOFUND ? { autoFundPayerCents: amount.amountCents } : {}),
        holdbackBps: HOLDBACK_BPS,
        disputeWindowMs: DISPUTE_WINDOW_MS,
        paymentRequiredHeader: { "x-payment-required": parsed.raw }
      }
    });

    const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
    outHeaders["x-settld-gate-id"] = String(gateCreate?.gate?.gateId ?? "");
    res.writeHead(402, outHeaders);
    res.end(await upstreamRes.text());
    return;
  }

  const gateId = req.headers["x-settld-gate-id"] ? String(req.headers["x-settld-gate-id"]).trim() : null;
  if (!gateId) {
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body).pipe(res);
    } else {
      res.end();
    }
    return;
  }

  // For "paid" requests, capture a small deterministic response hash and verify before returning.
  const capture = await readBodyWithLimit(upstreamRes, { maxBytes: 2 * 1024 * 1024 });
  if (!capture.ok) {
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
    res.end(`gateway: response too large to verify (>${2 * 1024 * 1024} bytes)`);
    return;
  }
  const respHash = sha256Hex(capture.buf);

  const gateVerify = await settldJson("/x402/gate/verify", {
    tenantId,
    method: "POST",
    idempotencyKey: stableIdemKey("x402_verify", `${gateId}\n${respHash}`),
    body: {
      gateId,
      verificationStatus: upstreamRes.ok ? "green" : "red",
      runStatus: upstreamRes.ok ? "completed" : "failed",
      evidenceRefs: [`http:response_sha256:${respHash}`, `http:status:${upstreamRes.status}`]
    }
  });

  const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
  outHeaders["x-settld-gate-id"] = gateId;
  outHeaders["x-settld-settlement-status"] = String(gateVerify?.settlement?.status ?? "");
  outHeaders["x-settld-released-amount-cents"] = String(gateVerify?.settlement?.releasedAmountCents ?? "");
  outHeaders["x-settld-refunded-amount-cents"] = String(gateVerify?.settlement?.refundedAmountCents ?? "");
  if (gateVerify?.gate?.holdback?.status) outHeaders["x-settld-holdback-status"] = String(gateVerify.gate.holdback.status);
  if (gateVerify?.gate?.holdback?.amountCents !== undefined) outHeaders["x-settld-holdback-amount-cents"] = String(gateVerify.gate.holdback.amountCents);

  res.writeHead(upstreamRes.status, outHeaders);
  res.end(capture.buf);
}

const server = http.createServer((req, res) => {
  handleProxy(req, res).catch((err) => {
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "gateway_error", message: err?.message ?? String(err ?? "") }));
  });
});

const listenCb = () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ok: true,
      service: "x402-gateway",
      ...(BIND_HOST ? { host: BIND_HOST } : {}),
      port: PORT,
      upstreamUrl: UPSTREAM_URL.toString(),
      settldApiUrl: SETTLD_API_URL.toString(),
      holdbackBps: HOLDBACK_BPS,
      disputeWindowMs: DISPUTE_WINDOW_MS
    })
  );
};
if (BIND_HOST) server.listen(PORT, BIND_HOST, listenCb);
else server.listen(PORT, listenCb);
