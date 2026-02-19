import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { Readable } from "node:stream";

import { parseX402PaymentRequired } from "../../../src/core/x402-gate.js";
import { canonicalJsonStringify } from "../../../src/core/canonical-json.js";
import { keyIdFromPublicKeyPem } from "../../../src/core/crypto.js";
import { buildToolProviderQuotePayloadV1, verifyToolProviderQuoteSignatureV1 } from "../../../src/core/provider-quote-signature.js";
import { computeSettldPayRequestBindingSha256V1 } from "../../../src/core/settld-pay-token.js";
import { computeToolProviderSignaturePayloadHashV1, verifyToolProviderSignatureV1 } from "../../../src/core/tool-provider-signature.js";

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

function parseCacheControlMaxAgeMs(value, fallbackMs) {
  const raw = typeof value === "string" ? value : "";
  const m = raw.match(/max-age\s*=\s*(\d+)/i);
  if (!m) return fallbackMs;
  const sec = Number(m[1]);
  if (!Number.isSafeInteger(sec) || sec < 0) return fallbackMs;
  return sec * 1000;
}

function normalizeOfferRef(value, { maxLen = 200 } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const out = String(value).trim();
  if (out.length > maxLen) return null;
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) return null;
  return out;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function jwkToSpkiPem(jwk) {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return null;
  if (String(jwk.kty ?? "") !== "OKP" || String(jwk.crv ?? "") !== "Ed25519") return null;
  if (typeof jwk.x !== "string" || jwk.x.trim() === "") return null;
  try {
    const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: String(jwk.x).trim() }, format: "jwk" });
    return key.export({ format: "pem", type: "spki" }).toString().trim();
  } catch {
    return null;
  }
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

function normalizeOfferBool(value, { fallback = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function normalizeStrictRequestBindingMode(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = String(value).trim().toLowerCase();
  return raw === "strict" ? "strict" : null;
}

function computeStrictRequestBindingSha256ForRetry({ reqMethod, upstreamUrl }) {
  const method = String(reqMethod ?? "GET").toUpperCase();
  const host = String(upstreamUrl.host ?? "").trim().toLowerCase();
  const pathWithQuery = `${upstreamUrl.pathname}${upstreamUrl.search}`;
  const emptyBodySha256 = sha256Hex(Buffer.from("", "utf8"));
  return computeSettldPayRequestBindingSha256V1({ method, host, pathWithQuery, bodySha256: emptyBodySha256 });
}

function createProviderKeyResolver({
  providerPublicKeyPem = null,
  providerJwksUrl = null,
  defaultMaxAgeMs = 300_000,
  fetchTimeoutMs = 3_000
} = {}) {
  const staticPem = typeof providerPublicKeyPem === "string" && providerPublicKeyPem.trim() !== "" ? providerPublicKeyPem.trim() : null;
  const staticKid = staticPem ? keyIdFromPublicKeyPem(staticPem) : null;
  const jwksUrl = typeof providerJwksUrl === "string" && providerJwksUrl.trim() !== "" ? providerJwksUrl.trim() : null;
  const normalizedDefaultMaxAgeMs = Number.isSafeInteger(Number(defaultMaxAgeMs)) && Number(defaultMaxAgeMs) > 0 ? Number(defaultMaxAgeMs) : 300_000;
  const normalizedFetchTimeoutMs = Number.isSafeInteger(Number(fetchTimeoutMs)) && Number(fetchTimeoutMs) > 0 ? Number(fetchTimeoutMs) : 3_000;

  const cache = {
    keysById: new Map(staticKid ? [[staticKid, { publicKeyPem: staticPem, source: "static" }]] : []),
    expiresAtMs: 0
  };

  async function refresh() {
    if (!jwksUrl) return false;
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(normalizedFetchTimeoutMs) : undefined;
    const res = await fetch(jwksUrl, { method: "GET", ...(signal ? { signal } : {}) });
    if (!res.ok) throw new Error(`provider jwks fetch failed (${res.status})`);
    const payload = await res.json();
    const rows = Array.isArray(payload?.keys) ? payload.keys : [];
    const keysById = new Map();
    for (const row of rows) {
      const publicKeyPem = jwkToSpkiPem(row);
      if (!publicKeyPem) continue;
      const derivedKid = keyIdFromPublicKeyPem(publicKeyPem);
      keysById.set(derivedKid, { publicKeyPem, source: "jwks", kid: derivedKid });
      const rowKid = normalizeOfferRef(row?.kid, { maxLen: 200 });
      if (rowKid && rowKid !== derivedKid) {
        keysById.set(rowKid, { publicKeyPem, source: "jwks", kid: rowKid });
      }
    }
    if (staticKid && staticPem && !keysById.has(staticKid)) {
      keysById.set(staticKid, { publicKeyPem: staticPem, source: "static", kid: staticKid });
    }
    if (keysById.size > 0) {
      cache.keysById = keysById;
      cache.expiresAtMs = Date.now() + parseCacheControlMaxAgeMs(res.headers.get("cache-control"), normalizedDefaultMaxAgeMs);
      return true;
    }
    if (staticKid && staticPem) {
      cache.keysById = new Map([[staticKid, { publicKeyPem: staticPem, source: "static", kid: staticKid }]]);
      cache.expiresAtMs = Date.now() + normalizedDefaultMaxAgeMs;
      return true;
    }
    return false;
  }

  return {
    enabled: Boolean(staticPem || jwksUrl),
    staticKeyId: staticKid,
    async resolveByKeyId(keyId) {
      const wantedKeyId = normalizeOfferRef(keyId, { maxLen: 200 });
      const nowMs = Date.now();
      const keyFromCache = wantedKeyId ? cache.keysById.get(wantedKeyId) ?? null : null;
      if (keyFromCache && cache.expiresAtMs > nowMs) return keyFromCache;
      if (cache.expiresAtMs <= nowMs || (wantedKeyId && !cache.keysById.has(wantedKeyId))) {
        try {
          await refresh();
        } catch {
          // keep stale cache and/or static fallback
        }
      }
      if (wantedKeyId) {
        const resolved = cache.keysById.get(wantedKeyId);
        if (resolved) return resolved;
      }
      if (staticKid && staticPem && (!wantedKeyId || wantedKeyId === staticKid)) {
        return { publicKeyPem: staticPem, source: "static", kid: staticKid };
      }
      return null;
    }
  };
}

function parseBase64UrlJson(rawValue) {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseProviderQuoteHeaders(headers) {
  return {
    quote: parseBase64UrlJson(headers?.["x-settld-provider-quote"] ?? headers?.["X-Settld-Provider-Quote"] ?? null),
    signature: parseBase64UrlJson(
      headers?.["x-settld-provider-quote-signature"] ?? headers?.["X-Settld-Provider-Quote-Signature"] ?? null
    )
  };
}

async function verifyProviderQuoteChallenge({
  offerFields,
  amountCents,
  currency,
  requestBindingMode,
  requestBindingSha256,
  providerKeyResolver,
  quoteHeaders
} = {}) {
  if (!providerKeyResolver?.enabled) {
    return { ok: true, quote: null };
  }
  const quote = quoteHeaders?.quote;
  const signature = quoteHeaders?.signature;
  if (!quote || !signature) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_SIGNATURE_MISSING",
      message: "provider quote signature is required but missing"
    };
  }
  let normalizedQuote;
  try {
    normalizedQuote = buildToolProviderQuotePayloadV1(quote);
  } catch (err) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_INVALID",
      message: err?.message ?? "provider quote payload invalid"
    };
  }
  const signatureKeyId = normalizeOfferRef(signature?.keyId, { maxLen: 200 });
  const providerKey = signatureKeyId ? await providerKeyResolver.resolveByKeyId(signatureKeyId) : null;
  if (!providerKey?.publicKeyPem) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_KEY_ID_UNKNOWN",
      message: "provider quote key id is unknown"
    };
  }
  let signatureValid = false;
  try {
    signatureValid = verifyToolProviderQuoteSignatureV1({
      quote: normalizedQuote,
      signature,
      publicKeyPem: providerKey.publicKeyPem
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_SIGNATURE_INVALID",
      message: "provider quote signature verification failed"
    };
  }

  const offerProviderId = normalizeOfferRef(offerFields?.providerId);
  const offerToolId = normalizeOfferRef(offerFields?.toolId);
  const offerQuoteId = normalizeOfferRef(offerFields?.quoteId);
  const offerQuoteRequired = normalizeOfferBool(offerFields?.quoteRequired, { fallback: false });
  const offerSpendAuthorizationMode = normalizeOfferRef(offerFields?.spendAuthorizationMode, { maxLen: 32 });
  const expectedBindingMode = requestBindingMode ?? "none";

  if (offerProviderId && normalizedQuote.providerId !== offerProviderId) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_PROVIDER_MISMATCH", message: "provider quote providerId mismatch" };
  }
  if (offerToolId && normalizedQuote.toolId !== offerToolId) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_TOOL_MISMATCH", message: "provider quote toolId mismatch" };
  }
  if (normalizedQuote.amountCents !== amountCents) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_AMOUNT_MISMATCH", message: "provider quote amount mismatch" };
  }
  if (String(normalizedQuote.currency).toUpperCase() !== String(currency).toUpperCase()) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_CURRENCY_MISMATCH", message: "provider quote currency mismatch" };
  }
  if (normalizedQuote.requestBindingMode !== expectedBindingMode) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_BINDING_MODE_MISMATCH",
      message: "provider quote request binding mode mismatch"
    };
  }
  if (expectedBindingMode === "strict") {
    if (String(normalizedQuote.requestBindingSha256 ?? "") !== String(requestBindingSha256 ?? "")) {
      return {
        ok: false,
        code: "X402_PROVIDER_QUOTE_BINDING_HASH_MISMATCH",
        message: "provider quote request binding hash mismatch"
      };
    }
  }
  if (offerQuoteRequired && normalizedQuote.quoteRequired !== true) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_REQUIRED_MISMATCH", message: "provider quoteRequired mismatch" };
  }
  if (offerQuoteId && String(normalizedQuote.quoteId ?? "") !== offerQuoteId) {
    return { ok: false, code: "X402_PROVIDER_QUOTE_ID_MISMATCH", message: "provider quoteId mismatch" };
  }
  if (offerSpendAuthorizationMode && String(normalizedQuote.spendAuthorizationMode ?? "") !== offerSpendAuthorizationMode) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_SPEND_AUTH_MODE_MISMATCH",
      message: "provider quote spendAuthorizationMode mismatch"
    };
  }
  if (Date.parse(String(normalizedQuote.expiresAt ?? "")) <= Date.now()) {
    return {
      ok: false,
      code: "X402_PROVIDER_QUOTE_EXPIRED",
      message: "provider quote expired"
    };
  }
  return {
    ok: true,
    quote: normalizedQuote,
    signature: {
      schemaVersion: String(signature.schemaVersion ?? ""),
      keyId: String(signature.keyId ?? ""),
      signedAt: String(signature.signedAt ?? ""),
      nonce: String(signature.nonce ?? ""),
      payloadHash: String(signature.payloadHash ?? ""),
      signatureBase64: String(signature.signatureBase64 ?? "")
    },
    key: providerKey
  };
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
const HOLDBACK_BPS = readOptionalIntEnv("HOLDBACK_BPS", 0);
const DISPUTE_WINDOW_MS = readOptionalIntEnv("DISPUTE_WINDOW_MS", 3_600_000);
const X402_AUTOFUND = readOptionalBoolEnv("X402_AUTOFUND", false);
const BIND_HOST = readOptionalStringEnv("BIND_HOST", null);
const X402_PROVIDER_PUBLIC_KEY_PEM = readOptionalStringEnv("X402_PROVIDER_PUBLIC_KEY_PEM", null);
const X402_PROVIDER_JWKS_URL = readOptionalStringEnv("X402_PROVIDER_JWKS_URL", null);
const X402_PROVIDER_KEYSET_DEFAULT_MAX_AGE_MS = readOptionalIntEnv("X402_PROVIDER_KEYSET_DEFAULT_MAX_AGE_MS", 300_000);
const X402_PROVIDER_KEYSET_FETCH_TIMEOUT_MS = readOptionalIntEnv("X402_PROVIDER_KEYSET_FETCH_TIMEOUT_MS", 3_000);
const providerKeyResolver = createProviderKeyResolver({
  providerPublicKeyPem: X402_PROVIDER_PUBLIC_KEY_PEM,
  providerJwksUrl: X402_PROVIDER_JWKS_URL,
  defaultMaxAgeMs: X402_PROVIDER_KEYSET_DEFAULT_MAX_AGE_MS,
  fetchTimeoutMs: X402_PROVIDER_KEYSET_FETCH_TIMEOUT_MS
});

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
  const gateId = req.headers["x-settld-gate-id"] ? String(req.headers["x-settld-gate-id"]).trim() : null;
  let providerQuoteVerification = null;

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstreamRes = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
    redirect: "manual",
    signal: ac.signal
  });

  // If upstream requests payment, create a Settld gate and return the 402 to the client.
  if (upstreamRes.status === 402) {
    if (gateId) {
      if (hasBody) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "x-settld-gate-id": gateId });
        res.end(JSON.stringify({ ok: false, error: "gateway_retry_requires_buffered_body", gateId }));
        return;
      }
      const paymentRequiredHeaders = Object.fromEntries(upstreamRes.headers.entries());
      const parsedOffer = parseX402PaymentRequired(paymentRequiredHeaders);
      const offerFields = parsedOffer.ok && parsedOffer.fields && typeof parsedOffer.fields === "object" ? parsedOffer.fields : {};
      const requestBindingMode = normalizeStrictRequestBindingMode(offerFields.requestBindingMode);
      const quoteRequired = normalizeOfferBool(offerFields.quoteRequired, { fallback: false });
      const offerQuoteId = normalizeOfferRef(offerFields.quoteId);
      const offerProviderId = normalizeOfferRef(offerFields.providerId);
      const offerToolId = normalizeOfferRef(offerFields.toolId);
      const parsedAmount = extractAmountAndCurrency(offerFields);
      if (!parsedAmount.ok) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "x-settld-gate-id": gateId });
        res.end(JSON.stringify({ ok: false, error: "gateway_offer_invalid", gateId, reason: parsedAmount.error }));
        return;
      }
      let requestBindingSha256 = null;
      if (requestBindingMode === "strict") {
        requestBindingSha256 = computeStrictRequestBindingSha256ForRetry({ reqMethod: req.method, upstreamUrl });
      }
      const quoteHeaders = parseProviderQuoteHeaders(paymentRequiredHeaders);
      const quoteVerified = await verifyProviderQuoteChallenge({
        offerFields,
        amountCents: parsedAmount.amountCents,
        currency: parsedAmount.currency,
        requestBindingMode,
        requestBindingSha256,
        providerKeyResolver,
        quoteHeaders
      });
      if (!quoteVerified.ok) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "x-settld-gate-id": gateId });
        res.end(
          JSON.stringify({
            ok: false,
            error: "gateway_provider_quote_verification_failed",
            gateId,
            code: quoteVerified.code,
            message: quoteVerified.message
          })
        );
        return;
      }
      const verifiedQuote = quoteVerified.quote;
      providerQuoteVerification = quoteVerified.ok
        ? {
            required: providerKeyResolver.enabled,
            verified: true,
            quote: verifiedQuote,
            signature: quoteVerified.signature ?? null,
            key: quoteVerified.key ?? null
          }
        : null;
      let quoted = null;
      const challengeQuoteId = verifiedQuote?.quoteId ? String(verifiedQuote.quoteId) : offerQuoteId ?? null;
      const shouldFetchQuote = quoteRequired || requestBindingMode === "strict" || Boolean(challengeQuoteId);
      if (shouldFetchQuote) {
        quoted = await settldJson("/x402/gate/quote", {
          tenantId,
          method: "POST",
          idempotencyKey: stableIdemKey(
            "x402_quote",
            `${gateId}\n${requestBindingMode ?? "none"}\n${requestBindingSha256 ?? ""}\n${challengeQuoteId ?? ""}`
          ),
          body: {
            gateId,
            ...(requestBindingMode === "strict"
              ? {
                  requestBindingMode: "strict",
                  requestBindingSha256
                }
              : {}),
            ...(offerProviderId ? { providerId: offerProviderId } : {}),
            ...(offerToolId ? { toolId: offerToolId } : {}),
            ...(challengeQuoteId ? { quoteId: challengeQuoteId } : {})
          }
        });
      }
      const authz = await settldJson("/x402/gate/authorize-payment", {
        tenantId,
        method: "POST",
        idempotencyKey: stableIdemKey(
          "x402_authz",
          `${gateId}\n${requestBindingMode ?? "none"}\n${requestBindingSha256 ?? ""}\n${
            quoted?.quote?.quoteId ?? verifiedQuote?.quoteId ?? offerQuoteId ?? ""
          }`
        ),
        body: {
          gateId,
          ...(requestBindingMode === "strict"
            ? {
                requestBindingMode: "strict",
            requestBindingSha256
            }
          : {}),
          ...(quoted?.quote?.quoteId
            ? { quoteId: String(quoted.quote.quoteId) }
            : challengeQuoteId
              ? { quoteId: challengeQuoteId }
                : {})
        }
      });
      const token = typeof authz?.token === "string" ? authz.token.trim() : "";
      if (!token) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "x-settld-gate-id": gateId });
        res.end(JSON.stringify({ ok: false, error: "gateway_authorization_token_missing", gateId }));
        return;
      }
      headers.set("authorization", `SettldPay ${token}`);
      // Back-compat with the local upstream mock; provider wrappers can rely on Authorization only.
      headers.set("x-payment", token);
      if (typeof authz?.authorizationRef === "string" && authz.authorizationRef.trim() !== "") {
        headers.set("x-settld-authorization-ref", authz.authorizationRef.trim());
      }
      if (typeof authz?.quoteId === "string" && authz.quoteId.trim() !== "") {
        headers.set("x-settld-quote-id", authz.quoteId.trim());
      } else if (quoted?.quote?.quoteId) {
        headers.set("x-settld-quote-id", String(quoted.quote.quoteId));
      }
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: undefined,
        redirect: "manual",
        signal: ac.signal
      });
    }

    if (upstreamRes.status === 402 && gateId) {
      const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
      outHeaders["x-settld-gate-id"] = gateId;
      res.writeHead(402, outHeaders);
      res.end(await upstreamRes.text());
      return;
    }

    if (!gateId) {
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
      const offeredToolId = normalizeOfferRef(parsed.fields?.toolId);

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
          ...(offeredToolId ? { toolId: offeredToolId } : {}),
          ...(X402_PROVIDER_PUBLIC_KEY_PEM ? { providerPublicKeyPem: X402_PROVIDER_PUBLIC_KEY_PEM } : {}),
          paymentRequiredHeader: { "x-payment-required": parsed.raw }
        }
      });

      const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
      outHeaders["x-settld-gate-id"] = String(gateCreate?.gate?.gateId ?? "");
      res.writeHead(402, outHeaders);
      res.end(await upstreamRes.text());
      return;
    }
  }
  if (!gateId) {
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body).pipe(res);
    } else {
      res.end();
    }
    return;
  }

  const requestSha256ForEvidence = computeStrictRequestBindingSha256ForRetry({ reqMethod: req.method, upstreamUrl });

  try {
    // For "paid" requests, capture a small deterministic response hash and verify before returning.
    const capture = await readBodyWithLimit(upstreamRes, { maxBytes: 2 * 1024 * 1024 });
    if (!capture.ok) {
      const gateVerify = await settldJson("/x402/gate/verify", {
        tenantId,
        method: "POST",
        idempotencyKey: stableIdemKey("x402_verify", `${gateId}\nUNVERIFIABLE\n${upstreamRes.status}`),
        body: {
          gateId,
          verificationStatus: "red",
          runStatus: "failed",
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
          verificationMethod: { mode: "deterministic", source: "gateway_unverifiable_v1", attestor: null },
          verificationCodes: ["X402_GATEWAY_RESPONSE_TOO_LARGE"],
          evidenceRefs: [`http:request_sha256:${requestSha256ForEvidence}`, `http:status:${upstreamRes.status}`]
        }
      });

      const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
      outHeaders["x-settld-gate-id"] = gateId;
      outHeaders["x-settld-settlement-status"] = String(gateVerify?.settlement?.status ?? "");
      outHeaders["x-settld-released-amount-cents"] = String(gateVerify?.settlement?.releasedAmountCents ?? "");
      outHeaders["x-settld-refunded-amount-cents"] = String(gateVerify?.settlement?.refundedAmountCents ?? "");
      if (gateVerify?.gate?.decision?.verificationStatus) {
        outHeaders["x-settld-verification-status"] = String(gateVerify.gate.decision.verificationStatus);
      }
      if (Array.isArray(gateVerify?.gate?.decision?.reasonCodes) && gateVerify.gate.decision.reasonCodes.length > 0) {
        outHeaders["x-settld-verification-codes"] = gateVerify.gate.decision.reasonCodes.join(",");
      }
      if (gateVerify?.gate?.holdback?.status) outHeaders["x-settld-holdback-status"] = String(gateVerify.gate.holdback.status);
      if (gateVerify?.gate?.holdback?.amountCents !== undefined) outHeaders["x-settld-holdback-amount-cents"] = String(gateVerify.gate.holdback.amountCents);

      res.writeHead(502, outHeaders);
      res.end(`gateway: response too large to verify (>${2 * 1024 * 1024} bytes); refunded`);
      return;
    }
    const contentType = String(upstreamRes.headers.get("content-type") ?? "");
    const respHash = (() => {
      // If upstream returns JSON, hash canonical JSON instead of raw bytes to avoid whitespace/ordering drift.
      if (contentType.toLowerCase().includes("application/json")) {
        try {
          const parsed = JSON.parse(capture.buf.toString("utf8"));
          return sha256Hex(canonicalJsonStringify(parsed));
        } catch {}
      }
      return sha256Hex(capture.buf);
    })();

    const providerReasonCodes = [];
    let providerSignature = null;
    let providerSignaturePublicKeyPem = null;
    if (providerKeyResolver.enabled) {
      const keyId = upstreamRes.headers.get("x-settld-provider-key-id");
      const signedAt = upstreamRes.headers.get("x-settld-provider-signed-at");
      const nonce = upstreamRes.headers.get("x-settld-provider-nonce");
      const signedResponseHash = upstreamRes.headers.get("x-settld-provider-response-sha256");
      const signatureBase64 = upstreamRes.headers.get("x-settld-provider-signature");

      if (!keyId || !signedAt || !nonce || !signedResponseHash || !signatureBase64) {
        providerReasonCodes.push("X402_PROVIDER_SIGNATURE_MISSING");
      } else if (String(signedResponseHash).trim().toLowerCase() !== respHash) {
        providerReasonCodes.push("X402_PROVIDER_RESPONSE_HASH_MISMATCH");
      } else {
        try {
          const normalizedKeyId = String(keyId).trim();
          const resolvedProviderKey = await providerKeyResolver.resolveByKeyId(normalizedKeyId);
          if (!resolvedProviderKey?.publicKeyPem) {
            providerReasonCodes.push("X402_PROVIDER_KEY_ID_UNKNOWN");
            throw new Error("provider key id unknown");
          }
          providerSignaturePublicKeyPem = resolvedProviderKey.publicKeyPem;
          const payloadHash = computeToolProviderSignaturePayloadHashV1({ responseHash: respHash, nonce, signedAt });
          providerSignature = {
            schemaVersion: "ToolProviderSignature.v1",
            algorithm: "ed25519",
            keyId: normalizedKeyId,
            signedAt: String(signedAt).trim(),
            nonce: String(nonce).trim(),
            responseHash: respHash,
            payloadHash,
            signatureBase64: String(signatureBase64).trim()
          };
          let ok = false;
          try {
            ok = verifyToolProviderSignatureV1({ signature: providerSignature, publicKeyPem: providerSignaturePublicKeyPem });
          } catch {
            ok = false;
          }
          if (!ok) providerReasonCodes.push("X402_PROVIDER_SIGNATURE_INVALID");
        } catch {
          if (!providerReasonCodes.includes("X402_PROVIDER_KEY_ID_UNKNOWN")) {
            providerReasonCodes.push("X402_PROVIDER_SIGNATURE_INVALID");
          }
        }
      }
    }

    // Deterministic default: release 100% on PASS; refund 100% on FAIL.
    const policy = {
      mode: "automatic",
      rules: {
        autoReleaseOnGreen: true,
        greenReleaseRatePct: 100,
        autoReleaseOnAmber: false,
        amberReleaseRatePct: 0,
        autoReleaseOnRed: true,
        redReleaseRatePct: 0
      }
    };

    const gateVerify = await settldJson("/x402/gate/verify", {
      tenantId,
      method: "POST",
      idempotencyKey: stableIdemKey("x402_verify", `${gateId}\n${respHash}`),
      body: {
        gateId,
        verificationStatus:
          upstreamRes.ok && (!providerKeyResolver.enabled || providerReasonCodes.length === 0) ? "green" : "red",
        runStatus: upstreamRes.ok ? "completed" : "failed",
        policy,
        verificationMethod: {
          mode: providerKeyResolver.enabled ? "attested" : "deterministic",
          source: providerKeyResolver.enabled ? "provider_signature_v1" : "http_status_v1",
          attestor: providerSignature?.keyId ?? null
        },
        ...(providerSignature && providerSignaturePublicKeyPem
          ? { providerSignature: { ...providerSignature, publicKeyPem: providerSignaturePublicKeyPem } }
          : {}),
        ...(providerQuoteVerification?.quote && providerQuoteVerification?.signature
          ? {
              providerQuotePayload: providerQuoteVerification.quote,
              providerQuoteSignature: {
                schemaVersion: String(providerQuoteVerification.signature.schemaVersion ?? ""),
                algorithm: String(providerQuoteVerification.signature.algorithm ?? ""),
                keyId: String(providerQuoteVerification.signature.keyId ?? ""),
                signedAt: String(providerQuoteVerification.signature.signedAt ?? ""),
                nonce: String(providerQuoteVerification.signature.nonce ?? ""),
                payloadHash: String(providerQuoteVerification.signature.payloadHash ?? ""),
                signatureBase64: String(providerQuoteVerification.signature.signatureBase64 ?? ""),
                quoteId:
                  typeof providerQuoteVerification.quote.quoteId === "string"
                    ? providerQuoteVerification.quote.quoteId
                    : null,
                quoteSha256: sha256Hex(canonicalJsonStringify(providerQuoteVerification.quote)),
                publicKeyPem:
                  typeof providerQuoteVerification.key?.publicKeyPem === "string"
                    ? providerQuoteVerification.key.publicKeyPem
                    : null
              }
            }
          : {}),
        verificationCodes: providerReasonCodes,
        evidenceRefs: [
          `http:request_sha256:${requestSha256ForEvidence}`,
          `http:response_sha256:${respHash}`,
          `http:status:${upstreamRes.status}`,
          ...(providerQuoteVerification?.quote
            ? [
                `provider_quote:quote_id:${String(providerQuoteVerification.quote.quoteId ?? "")}`,
                `provider_quote:payload_sha256:${sha256Hex(canonicalJsonStringify(providerQuoteVerification.quote))}`
              ]
            : []),
          ...(providerSignature
            ? [
                `provider:key_id:${providerSignature.keyId}`,
                `provider:signed_at:${providerSignature.signedAt}`,
                `provider:nonce:${providerSignature.nonce}`,
                `provider:payload_sha256:${providerSignature.payloadHash}`,
                `provider:sig_b64:${providerSignature.signatureBase64}`
              ]
            : [])
        ]
      }
    });

    const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
    outHeaders["x-settld-gate-id"] = gateId;
    outHeaders["x-settld-response-sha256"] = respHash;
    outHeaders["x-settld-settlement-status"] = String(gateVerify?.settlement?.status ?? "");
    outHeaders["x-settld-released-amount-cents"] = String(gateVerify?.settlement?.releasedAmountCents ?? "");
    outHeaders["x-settld-refunded-amount-cents"] = String(gateVerify?.settlement?.refundedAmountCents ?? "");
    if (gateVerify?.gate?.decision?.verificationStatus) {
      outHeaders["x-settld-verification-status"] = String(gateVerify.gate.decision.verificationStatus);
    }
    if (Array.isArray(gateVerify?.gate?.decision?.reasonCodes) && gateVerify.gate.decision.reasonCodes.length > 0) {
      outHeaders["x-settld-verification-codes"] = gateVerify.gate.decision.reasonCodes.join(",");
    }
    if (gateVerify?.gate?.holdback?.status) outHeaders["x-settld-holdback-status"] = String(gateVerify.gate.holdback.status);
    if (gateVerify?.gate?.holdback?.amountCents !== undefined) outHeaders["x-settld-holdback-amount-cents"] = String(gateVerify.gate.holdback.amountCents);

    res.writeHead(upstreamRes.status, outHeaders);
    res.end(capture.buf);
  } catch (err) {
    // Best-effort: if anything goes wrong after a hold exists, force the gate red to refund instead of stranding escrow.
    let gateVerify = null;
    try {
      gateVerify = await settldJson("/x402/gate/verify", {
        tenantId,
        method: "POST",
        idempotencyKey: stableIdemKey("x402_verify", `${gateId}\nERROR\n${upstreamRes.status}`),
        body: {
          gateId,
          verificationStatus: "red",
          runStatus: "failed",
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
          verificationMethod: { mode: "deterministic", source: "gateway_error_v1", attestor: null },
          verificationCodes: ["X402_GATEWAY_ERROR"],
          evidenceRefs: [`http:request_sha256:${requestSha256ForEvidence}`, `http:status:${upstreamRes.status}`]
        }
      });
    } catch {}

    const outHeaders = Object.fromEntries(upstreamRes.headers.entries());
    outHeaders["x-settld-gate-id"] = gateId;
    if (gateVerify) {
      outHeaders["x-settld-settlement-status"] = String(gateVerify?.settlement?.status ?? "");
      outHeaders["x-settld-released-amount-cents"] = String(gateVerify?.settlement?.releasedAmountCents ?? "");
      outHeaders["x-settld-refunded-amount-cents"] = String(gateVerify?.settlement?.refundedAmountCents ?? "");
      if (gateVerify?.gate?.decision?.verificationStatus) {
        outHeaders["x-settld-verification-status"] = String(gateVerify.gate.decision.verificationStatus);
      }
      if (Array.isArray(gateVerify?.gate?.decision?.reasonCodes) && gateVerify.gate.decision.reasonCodes.length > 0) {
        outHeaders["x-settld-verification-codes"] = gateVerify.gate.decision.reasonCodes.join(",");
      }
      if (gateVerify?.gate?.holdback?.status) outHeaders["x-settld-holdback-status"] = String(gateVerify.gate.holdback.status);
      if (gateVerify?.gate?.holdback?.amountCents !== undefined) outHeaders["x-settld-holdback-amount-cents"] = String(gateVerify.gate.holdback.amountCents);
    }

    res.writeHead(502, outHeaders);
    res.end(`gateway error: ${err?.message ?? String(err ?? "")}`);
  }
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
