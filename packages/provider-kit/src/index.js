import crypto from "node:crypto";

import { canonicalJsonStringify } from "./internal/canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex } from "./internal/crypto.js";
import { buildSettldPayKeysetV1 } from "./internal/settld-keys.js";
import { computeSettldPayRequestBindingSha256V1, verifySettldPayTokenV1 } from "./internal/settld-pay-token.js";
import { buildToolProviderQuotePayloadV1, signToolProviderQuoteSignatureV1 } from "./internal/provider-quote-signature.js";
import { signToolProviderSignatureV1 } from "./internal/tool-provider-signature.js";

function assertFn(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  return value;
}

function assertPositiveSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function assertNonNegativeSafeInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function sanitizeIdSegment(text, { maxLen = 96 } = {}) {
  const raw = String(text ?? "").trim();
  const safe = raw.replaceAll(/[^A-Za-z0-9:_-]/g, "_").slice(0, maxLen);
  return safe || "unknown";
}

const PROVIDER_QUOTE_HEADER = "x-settld-provider-quote";
const PROVIDER_QUOTE_SIGNATURE_HEADER = "x-settld-provider-quote-signature";

function toBase64UrlJson(value) {
  return Buffer.from(canonicalJsonStringify(value), "utf8").toString("base64url");
}

function parseCacheControlMaxAgeMs(value, fallbackMs) {
  const raw = typeof value === "string" ? value : "";
  const m = raw.match(/max-age\s*=\s*(\d+)/i);
  if (!m) return fallbackMs;
  const sec = Number(m[1]);
  if (!Number.isSafeInteger(sec) || sec < 0) return fallbackMs;
  return sec * 1000;
}

function normalizeCurrency(value) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "USD";
  const out = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,11}$/.test(out)) throw new TypeError("currency must match ^[A-Z][A-Z0-9_]{2,11}$");
  return out;
}

function normalizeRequestBindingMode(value, { fallback = "none" } = {}) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw === "none" || raw === "strict") return raw;
  throw new TypeError("requestBindingMode must be none|strict");
}

function normalizeBooleanLike(value, { fallback = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  throw new TypeError("boolean-like value must be 1|0|true|false|yes|no|on|off");
}

function normalizeSpendAuthorizationMode(value, { fallback = "optional" } = {}) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw === "optional" || raw === "required") return raw;
  throw new TypeError("spendAuthorizationMode must be optional|required");
}

function parseVerificationCode(err) {
  const code = typeof err?.code === "string" && err.code.trim() !== "" ? err.code.trim() : "SETTLD_PAY_VERIFICATION_ERROR";
  return code;
}

function toHeaderObject(headers) {
  const out = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    for (const [k, v] of headers.entries()) out[k] = String(v);
    return out;
  }
  if (typeof headers === "object" && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

function toBodyBuffer(body) {
  if (body === undefined || body === null) {
    return { bodyBuffer: Buffer.from("", "utf8"), contentType: "application/json; charset=utf-8" };
  }
  if (Buffer.isBuffer(body)) return { bodyBuffer: Buffer.from(body), contentType: "application/octet-stream" };
  if (body instanceof Uint8Array) return { bodyBuffer: Buffer.from(body), contentType: "application/octet-stream" };
  if (typeof body === "string") return { bodyBuffer: Buffer.from(body, "utf8"), contentType: "text/plain; charset=utf-8" };
  return {
    bodyBuffer: Buffer.from(canonicalJsonStringify(body), "utf8"),
    contentType: "application/json; charset=utf-8"
  };
}

function methodSupportsBody(method) {
  const m = String(method ?? "GET").toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

async function readRequestBodyBuffer(req, { maxBytes = 1_000_000 } = {}) {
  const limit = assertPositiveSafeInt(maxBytes, "maxRequestBodyBytes");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      const err = new Error(`request body exceeds maxRequestBodyBytes (${limit})`);
      err.code = "SETTLD_PAY_REQUEST_BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function computeRequestBindingSha256({ req, url, bodyBuffer }) {
  const method = String(req?.method ?? "GET").toUpperCase();
  const host = String(req?.headers?.host ?? url?.host ?? "").trim().toLowerCase();
  const pathWithQuery = `${url?.pathname ?? "/"}${url?.search ?? ""}`;
  const bodySha256 = sha256Hex(Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from("", "utf8"));
  return computeSettldPayRequestBindingSha256V1({ method, host, pathWithQuery, bodySha256 });
}

function normalizeExecutionResult(raw) {
  const isEnvelope =
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !Buffer.isBuffer(raw) &&
    !(raw instanceof Uint8Array) &&
    (Object.hasOwn(raw, "body") || Object.hasOwn(raw, "statusCode") || Object.hasOwn(raw, "headers") || Object.hasOwn(raw, "contentType"));
  if (!isEnvelope) {
    return {
      statusCode: 200,
      headers: {},
      body: raw,
      contentType: null
    };
  }

  return {
    statusCode: Number.isSafeInteger(Number(raw.statusCode)) ? Number(raw.statusCode) : 200,
    headers: toHeaderObject(raw.headers),
    body: raw.body,
    contentType: typeof raw.contentType === "string" && raw.contentType.trim() !== "" ? raw.contentType.trim() : null
  };
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  throw new TypeError("fetch implementation is required");
}

function sendJson(res, { statusCode = 200, headers = {}, payload }) {
  const h = {
    ...headers,
    "content-type": "application/json; charset=utf-8"
  };
  res.writeHead(statusCode, h);
  res.end(JSON.stringify(payload));
}

function defaultProviderIdForRequest(req) {
  const host = typeof req?.headers?.host === "string" && req.headers.host.trim() !== "" ? req.headers.host.trim() : "provider";
  return `provider_${sanitizeIdSegment(host)}`;
}

export function parseSettldPayAuthorizationHeader(authorizationHeaderRaw) {
  const authorizationHeader = typeof authorizationHeaderRaw === "string" ? authorizationHeaderRaw.trim() : "";
  if (!authorizationHeader) return null;
  const lower = authorizationHeader.toLowerCase();
  if (!lower.startsWith("settldpay ")) return null;
  const token = authorizationHeader.slice("settldpay ".length).trim();
  return token || null;
}

export function buildPaymentRequiredHeaderValue(offer) {
  const fields = [
    `amountCents=${offer.amountCents}`,
    `currency=${offer.currency}`,
    `providerId=${offer.providerId}`,
    `toolId=${offer.toolId}`,
    `address=${offer.address}`,
    `network=${offer.network}`,
    `requestBindingMode=${offer.requestBindingMode ?? "none"}`
  ];
  if (offer.quoteRequired === true) fields.push("quoteRequired=1");
  if (typeof offer.quoteId === "string" && offer.quoteId.trim() !== "") fields.push(`quoteId=${offer.quoteId.trim()}`);
  if (offer.spendAuthorizationMode === "required") fields.push("spendAuthorizationMode=required");
  return fields.join("; ");
}

export function createInMemoryReplayStore({ maxKeys = 10_000 } = {}) {
  const cap = assertPositiveSafeInt(maxKeys, "maxKeys");
  const rows = new Map();

  function prune(nowMs = Date.now()) {
    for (const [k, row] of rows.entries()) {
      if (!row || !Number.isFinite(row.expiresAtMs) || row.expiresAtMs <= nowMs) rows.delete(k);
    }
    while (rows.size > cap) {
      const oldest = rows.keys().next().value;
      if (!oldest) break;
      rows.delete(oldest);
    }
  }

  return {
    get(key, nowMs = Date.now()) {
      prune(nowMs);
      const row = rows.get(key);
      if (!row || !Number.isFinite(row.expiresAtMs) || row.expiresAtMs <= nowMs) {
        rows.delete(key);
        return null;
      }
      return row;
    },
    set(key, row, nowMs = Date.now()) {
      prune(nowMs);
      rows.set(key, row);
      prune(nowMs);
    },
    prune,
    size() {
      return rows.size;
    }
  };
}

export function createSettldPayKeysetResolver({
  keysetUrl,
  fetch: fetchImpl = null,
  defaultMaxAgeMs = 300_000,
  fetchTimeoutMs = 3_000,
  pinnedPublicKeyPem = null,
  pinnedKeyId = null,
  pinnedOnly = false,
  pinnedMaxAgeMs = 3_600_000
} = {}) {
  const resolveFetchImpl = resolveFetch(fetchImpl);
  const cache = {
    keyset: null,
    expiresAtMs: 0,
    source: "none"
  };

  const normalizedDefaultMaxAgeMs = assertPositiveSafeInt(defaultMaxAgeMs, "defaultMaxAgeMs");
  const normalizedFetchTimeoutMs = assertPositiveSafeInt(fetchTimeoutMs, "fetchTimeoutMs");
  const normalizedPinnedMaxAgeMs = assertPositiveSafeInt(pinnedMaxAgeMs, "pinnedMaxAgeMs");

  const pinnedKeyset = (() => {
    if (typeof pinnedPublicKeyPem !== "string" || pinnedPublicKeyPem.trim() === "") return null;
    const derivedKid = keyIdFromPublicKeyPem(pinnedPublicKeyPem);
    const kid = typeof pinnedKeyId === "string" && pinnedKeyId.trim() !== "" ? pinnedKeyId.trim() : derivedKid;
    if (kid !== derivedKid) throw new TypeError("pinnedKeyId does not match pinnedPublicKeyPem");
    return buildSettldPayKeysetV1({
      activeKey: { keyId: kid, publicKeyPem: pinnedPublicKeyPem },
      fallbackKeys: [],
      refreshedAt: new Date().toISOString()
    });
  })();

  async function fetchSettldKeysetFromUrl() {
    if (typeof keysetUrl !== "string" || keysetUrl.trim() === "") {
      throw new TypeError("keysetUrl is required when pinnedOnly=false");
    }
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(normalizedFetchTimeoutMs) : undefined;
    const res = await resolveFetchImpl(keysetUrl, { method: "GET", ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`keyset fetch failed (${res.status}): ${text || "unknown"}`);
    }
    const keyset = await res.json();
    if (!keyset || typeof keyset !== "object" || Array.isArray(keyset) || !Array.isArray(keyset.keys) || keyset.keys.length === 0) {
      throw new Error("keyset response is invalid");
    }
    const maxAgeMs = parseCacheControlMaxAgeMs(res.headers.get("cache-control"), normalizedDefaultMaxAgeMs);
    return { keyset, maxAgeMs };
  }

  return {
    clearCache() {
      cache.keyset = null;
      cache.expiresAtMs = 0;
      cache.source = "none";
    },
    getSource() {
      return cache.source;
    },
    async getKeyset() {
      const nowMs = Date.now();
      if (cache.keyset && cache.expiresAtMs > nowMs) {
        return { keyset: cache.keyset, source: cache.source };
      }

      if (pinnedOnly) {
        if (!pinnedKeyset) throw new Error("pinnedOnly=true requires pinnedPublicKeyPem");
        cache.keyset = pinnedKeyset;
        cache.expiresAtMs = nowMs + normalizedPinnedMaxAgeMs;
        cache.source = "pinned-only";
        return { keyset: cache.keyset, source: cache.source };
      }

      try {
        const fetched = await fetchSettldKeysetFromUrl();
        cache.keyset = fetched.keyset;
        cache.expiresAtMs = nowMs + fetched.maxAgeMs;
        cache.source = "well-known";
        return { keyset: cache.keyset, source: cache.source };
      } catch (err) {
        if (!pinnedKeyset) throw err;
        cache.keyset = pinnedKeyset;
        cache.expiresAtMs = nowMs + normalizedPinnedMaxAgeMs;
        cache.source = "pinned-fallback";
        return { keyset: cache.keyset, source: cache.source };
      }
    }
  };
}

function normalizeOffer({ offer, req, url, providerId, providerIdForRequest, paymentAddress, paymentNetwork }) {
  const raw = offer && typeof offer === "object" && !Array.isArray(offer) ? offer : {};
  const amountCents = assertPositiveSafeInt(raw.amountCents, "priceFor().amountCents");
  const currency = normalizeCurrency(raw.currency);
  const idempotency =
    typeof raw.idempotency === "string" && raw.idempotency.trim() !== "" ? raw.idempotency.trim().toLowerCase() : null;
  const implicitBindingMode =
    idempotency === "non_idempotent" || idempotency === "side_effecting"
      ? "strict"
      : "none";
  const requestBindingMode = normalizeRequestBindingMode(raw.requestBindingMode, { fallback: implicitBindingMode });
  const quoteRequired = normalizeBooleanLike(raw.quoteRequired, { fallback: false });
  const quoteId =
    typeof raw.quoteId === "string" && raw.quoteId.trim() !== "" ? raw.quoteId.trim() : null;
  if (quoteId && !/^[A-Za-z0-9:_-]+$/.test(quoteId)) {
    throw new TypeError("priceFor().quoteId must match ^[A-Za-z0-9:_-]+$");
  }
  const spendAuthorizationMode = normalizeSpendAuthorizationMode(raw.spendAuthorizationMode, {
    fallback: quoteRequired ? "required" : "optional"
  });
  const rawProviderId = typeof raw.providerId === "string" && raw.providerId.trim() !== "" ? raw.providerId.trim() : null;
  const configuredProviderId = typeof providerId === "string" && providerId.trim() !== "" ? providerId.trim() : null;
  const providerFromFn =
    typeof providerIdForRequest === "function" ? String(providerIdForRequest({ req, url, offer: raw }) ?? "").trim() || null : null;
  const resolvedProviderId =
    rawProviderId ??
    configuredProviderId ??
    providerFromFn ??
    defaultProviderIdForRequest(req);
  if (!resolvedProviderId) throw new TypeError("providerId is required (option/providerIdForRequest/priceFor().providerId)");
  const toolId =
    typeof raw.toolId === "string" && raw.toolId.trim() !== ""
      ? raw.toolId.trim()
      : `${String(req?.method ?? "GET").toUpperCase()}:${String(url?.pathname ?? "/")}`;

  const address =
    typeof raw.address === "string" && raw.address.trim() !== ""
      ? raw.address.trim()
      : typeof paymentAddress === "string" && paymentAddress.trim() !== ""
        ? paymentAddress.trim()
        : "settld:provider";
  const network =
    typeof raw.network === "string" && raw.network.trim() !== ""
      ? raw.network.trim()
      : typeof paymentNetwork === "string" && paymentNetwork.trim() !== ""
        ? paymentNetwork.trim()
        : "settld";

  return {
    amountCents,
    currency,
    providerId: resolvedProviderId,
    toolId,
    address,
    network,
    requestBindingMode,
    quoteRequired,
    quoteId,
    spendAuthorizationMode
  };
}

function deriveQuoteId({ offer, req, url, requestBindingSha256 = null } = {}) {
  const seed = canonicalJsonStringify({
    providerId: offer.providerId,
    toolId: offer.toolId,
    amountCents: offer.amountCents,
    currency: offer.currency,
    requestBindingMode: offer.requestBindingMode ?? "none",
    requestBindingSha256: requestBindingSha256 ?? "",
    method: String(req?.method ?? "GET").toUpperCase(),
    pathWithQuery: `${url?.pathname ?? "/"}${url?.search ?? ""}`
  });
  return `pquote_${sha256Hex(seed).slice(0, 32)}`;
}

function buildSignedQuoteChallenge({
  offer,
  req,
  url,
  requestBindingSha256 = null,
  quoteTtlSeconds,
  publicKeyPem,
  privateKeyPem
} = {}) {
  const nowMs = Date.now();
  const quotedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + quoteTtlSeconds * 1000).toISOString();
  const quoteId =
    typeof offer.quoteId === "string" && offer.quoteId.trim() !== "" ? offer.quoteId.trim() : deriveQuoteId({ offer, req, url, requestBindingSha256 });
  const quote = buildToolProviderQuotePayloadV1({
    providerId: offer.providerId,
    toolId: offer.toolId,
    amountCents: offer.amountCents,
    currency: offer.currency,
    address: offer.address,
    network: offer.network,
    requestBindingMode: offer.requestBindingMode ?? "none",
    requestBindingSha256,
    quoteRequired: offer.quoteRequired === true,
    quoteId,
    spendAuthorizationMode: offer.spendAuthorizationMode ?? "optional",
    quotedAt,
    expiresAt
  });
  const signature = signToolProviderQuoteSignatureV1({
    quote,
    nonce: crypto.randomBytes(16).toString("hex"),
    signedAt: quotedAt,
    publicKeyPem,
    privateKeyPem
  });
  return {
    offer,
    quote,
    signature
  };
}

function sendPaymentRequired(res, { offer, quoteAttestation = null, code = "PAYMENT_REQUIRED", message = "payment required", details = null }) {
  const headerValue = buildPaymentRequiredHeaderValue(offer);
  const quoteHeaders =
    quoteAttestation && quoteAttestation.quote && quoteAttestation.signature
      ? {
          [PROVIDER_QUOTE_HEADER]: toBase64UrlJson(quoteAttestation.quote),
          [PROVIDER_QUOTE_SIGNATURE_HEADER]: toBase64UrlJson(quoteAttestation.signature)
        }
      : {};
  sendJson(res, {
    statusCode: 402,
    headers: {
      "x-payment-required": headerValue,
      "PAYMENT-REQUIRED": headerValue,
      "x-settld-payment-error": String(code),
      ...quoteHeaders
    },
    payload: {
      ok: false,
      error: "payment_required",
      code,
      message,
      offer,
      ...(quoteAttestation ? { quote: quoteAttestation.quote } : {}),
      ...(details ? { details } : {})
    }
  });
}

async function verifySettldPaymentToken({ token, offer, keysetResolver, expectedRequestBindingSha256 = null }) {
  let keysetResult;
  try {
    keysetResult = await keysetResolver.getKeyset();
  } catch (err) {
    return { ok: false, code: "SETTLD_PAY_KEYSET_UNAVAILABLE", message: err?.message ?? String(err ?? "") };
  }
  const keyset = keysetResult?.keyset ?? keysetResult;
  const keysetSource = typeof keysetResult?.source === "string" && keysetResult.source.trim() !== "" ? keysetResult.source : "unknown";

  let verified;
  try {
    verified = verifySettldPayTokenV1({ token, keyset, expectedRequestBindingSha256 });
  } catch (err) {
    return { ok: false, code: parseVerificationCode(err), message: err?.message ?? String(err ?? "") };
  }
  if (!verified?.ok) {
    return {
      ok: false,
      code: String(verified?.code ?? "SETTLD_PAY_VERIFICATION_ERROR"),
      message: verified?.message ?? "token verification failed",
      details: verified?.payload ? { payload: verified.payload } : null
    };
  }

  const payload = verified.payload ?? {};
  const payloadAud = String(payload.aud ?? "");
  const payloadPayeeProviderId = String(payload.payeeProviderId ?? "");
  if (payloadAud !== offer.providerId || payloadPayeeProviderId !== offer.providerId) {
    return {
      ok: false,
      code: "SETTLD_PAY_PROVIDER_MISMATCH",
      message: "token does not match provider offer",
      details: {
        expectedProviderId: offer.providerId,
        aud: payloadAud,
        payeeProviderId: payloadPayeeProviderId
      }
    };
  }

  const payloadAmountCents = Number(payload.amountCents ?? 0);
  if (!Number.isSafeInteger(payloadAmountCents) || payloadAmountCents !== offer.amountCents) {
    return {
      ok: false,
      code: "SETTLD_PAY_AMOUNT_MISMATCH",
      message: "token does not match provider offer",
      details: {
        expectedAmountCents: offer.amountCents,
        tokenAmountCents: payloadAmountCents
      }
    };
  }

  const payloadCurrency = String(payload.currency ?? "").toUpperCase();
  if (payloadCurrency !== offer.currency) {
    return {
      ok: false,
      code: "SETTLD_PAY_CURRENCY_MISMATCH",
      message: "token does not match provider offer",
      details: {
        expectedCurrency: offer.currency,
        tokenCurrency: payloadCurrency
      }
    };
  }

  const payloadQuoteId = typeof payload.quoteId === "string" ? payload.quoteId.trim() : "";
  if (offer.quoteRequired === true && !payloadQuoteId) {
    return {
      ok: false,
      code: "SETTLD_PAY_QUOTE_REQUIRED",
      message: "token is missing required quoteId"
    };
  }
  if (offer.quoteId && payloadQuoteId !== offer.quoteId) {
    return {
      ok: false,
      code: "SETTLD_PAY_QUOTE_MISMATCH",
      message: "token quoteId does not match provider offer",
      details: {
        expectedQuoteId: offer.quoteId,
        tokenQuoteId: payloadQuoteId || null
      }
    };
  }

  if (offer.spendAuthorizationMode === "required") {
    const payloadPolicyFingerprint =
      typeof payload.policyFingerprint === "string" ? payload.policyFingerprint.trim().toLowerCase() : "";
    const requiredClaims = [
      ["quoteId", payloadQuoteId],
      ["idempotencyKey", typeof payload.idempotencyKey === "string" ? payload.idempotencyKey.trim() : ""],
      ["nonce", typeof payload.nonce === "string" ? payload.nonce.trim() : ""],
      ["sponsorRef", typeof payload.sponsorRef === "string" ? payload.sponsorRef.trim() : ""],
      ["agentKeyId", typeof payload.agentKeyId === "string" ? payload.agentKeyId.trim() : ""],
      ["policyFingerprint", /^[0-9a-f]{64}$/.test(payloadPolicyFingerprint) ? payloadPolicyFingerprint : ""]
    ];
    const missingClaims = requiredClaims.filter(([, v]) => !v).map(([name]) => name);
    if (missingClaims.length > 0) {
      return {
        ok: false,
        code: "SETTLD_PAY_SPEND_AUTH_REQUIRED",
        message: "token is missing required spend-authorization claims",
        details: { missingClaims }
      };
    }
  }

  return {
    ok: true,
    verification: verified,
    keysetSource
  };
}

export function createSettldPaidNodeHttpHandler({
  providerId = null,
  providerIdForRequest = null,
  priceFor,
  execute,
  providerPublicKeyPem,
  providerPrivateKeyPem,
  paymentAddress = "settld:provider",
  paymentNetwork = "settld",
  replayStore = null,
  replayTtlBufferMs = 60_000,
  replayMaxKeys = 10_000,
  quoteTtlSeconds = 300,
  keysetResolver = null,
  settldPay = {},
  mutateSignature = null
} = {}) {
  const priceForFn = assertFn(priceFor, "priceFor");
  const executeFn = assertFn(execute, "execute");
  const publicKeyPem = assertNonEmptyString(providerPublicKeyPem, "providerPublicKeyPem");
  const privateKeyPem = assertNonEmptyString(providerPrivateKeyPem, "providerPrivateKeyPem");
  const normalizedReplayTtlBufferMs = assertNonNegativeSafeInt(replayTtlBufferMs, "replayTtlBufferMs");
  const normalizedQuoteTtlSeconds = assertPositiveSafeInt(quoteTtlSeconds, "quoteTtlSeconds");
  const signerKeyId = keyIdFromPublicKeyPem(publicKeyPem);
  const maxRequestBodyBytes = (() => {
    if (settldPay && typeof settldPay === "object" && !Array.isArray(settldPay) && settldPay.maxRequestBodyBytes !== undefined) {
      return assertPositiveSafeInt(settldPay.maxRequestBodyBytes, "settldPay.maxRequestBodyBytes");
    }
    return 1_000_000;
  })();
  const replay = replayStore ?? createInMemoryReplayStore({ maxKeys: replayMaxKeys });
  if (!replay || typeof replay.get !== "function" || typeof replay.set !== "function") {
    throw new TypeError("replayStore must implement get(key, nowMs) and set(key, row, nowMs)");
  }

  const resolver =
    keysetResolver && typeof keysetResolver.getKeyset === "function" ? keysetResolver : createSettldPayKeysetResolver(settldPay);

  async function paidHandler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    let offer;
    try {
      const rawOffer = await priceForFn({ req, url });
      offer = normalizeOffer({
        offer: rawOffer,
        req,
        url,
        providerId,
        providerIdForRequest,
        paymentAddress,
        paymentNetwork
      });
    } catch (err) {
      sendJson(res, {
        statusCode: 500,
        payload: {
          ok: false,
          error: "pricing_error",
          message: err?.message ?? String(err ?? "")
        }
      });
      return;
    }

    const strictRequestBinding = offer.requestBindingMode === "strict";
    let requestBodyBuffer = null;
    let requestBindingSha256 = null;
    if (strictRequestBinding) {
      try {
        requestBodyBuffer = methodSupportsBody(req?.method) ? await readRequestBodyBuffer(req, { maxBytes: maxRequestBodyBytes }) : Buffer.from("", "utf8");
        requestBindingSha256 = computeRequestBindingSha256({ req, url, bodyBuffer: requestBodyBuffer });
      } catch (err) {
        sendPaymentRequired(res, {
          offer,
          code: typeof err?.code === "string" && err.code.trim() !== "" ? err.code.trim() : "SETTLD_PAY_REQUEST_BINDING_INPUT_INVALID",
          message: err?.message ?? "request binding input invalid"
        });
        return;
      }
    }
    const quoteAttestation = buildSignedQuoteChallenge({
      offer,
      req,
      url,
      requestBindingSha256,
      quoteTtlSeconds: normalizedQuoteTtlSeconds,
      publicKeyPem,
      privateKeyPem
    });
    offer = quoteAttestation.offer;

    const token = parseSettldPayAuthorizationHeader(req.headers?.authorization);
    if (!token) {
      sendPaymentRequired(res, {
        offer,
        quoteAttestation,
        code: "PAYMENT_REQUIRED",
        message: "missing or invalid SettldPay authorization"
      });
      return;
    }

    const verified = await verifySettldPaymentToken({
      token,
      offer,
      keysetResolver: resolver,
      expectedRequestBindingSha256: requestBindingSha256
    });
    if (!verified.ok) {
      sendPaymentRequired(res, {
        offer,
        quoteAttestation,
        code: verified.code,
        message: verified.message ?? "payment token rejected",
        details: verified.details ?? null
      });
      return;
    }

    const verification = verified.verification;
    const payload = verification.payload ?? {};
    const replayKey = (() => {
      const authorizationRef = typeof payload.authorizationRef === "string" ? payload.authorizationRef.trim() : "";
      if (authorizationRef) return authorizationRef;
      const gateId = typeof payload.gateId === "string" ? payload.gateId.trim() : "";
      return gateId || verification.tokenSha256;
    })();
    const nowMs = Date.now();
    const replayExisting = replay.get(replayKey, nowMs);
    if (replayExisting) {
      const replayHeaders = {
        ...(replayExisting.headers ?? {}),
        "x-settld-provider-key-id": replayExisting.signature?.keyId ?? signerKeyId,
        "x-settld-provider-signed-at": replayExisting.signature?.signedAt ?? "",
        "x-settld-provider-nonce": replayExisting.signature?.nonce ?? "",
        "x-settld-provider-response-sha256": replayExisting.signature?.responseHash ?? "",
        "x-settld-provider-signature": replayExisting.signature?.signatureBase64 ?? "",
        "x-settld-provider-authorization-ref": String(payload.authorizationRef ?? ""),
        "x-settld-provider-gate-id": String(payload.gateId ?? ""),
        "x-settld-provider-quote-id": String(payload.quoteId ?? ""),
        "x-settld-provider-token-sha256": String(verification.tokenSha256 ?? ""),
        "x-settld-keyset-source": verified.keysetSource,
        "x-settld-provider-replay": "duplicate",
        "x-settld-request-binding-mode": replayExisting.requestBindingMode ?? offer.requestBindingMode ?? "none",
        "x-settld-request-binding-sha256": replayExisting.requestBindingSha256 ?? requestBindingSha256 ?? ""
      };
      if (!replayHeaders["content-type"]) replayHeaders["content-type"] = replayExisting.contentType ?? "application/json; charset=utf-8";
      res.writeHead(replayExisting.statusCode ?? 200, replayHeaders);
      res.end(replayExisting.bodyBuffer ?? Buffer.from("", "utf8"));
      return;
    }

    let execRaw;
    try {
      execRaw = await executeFn({ req, url, offer, verification, requestBodyBuffer, requestBindingSha256 });
    } catch (err) {
      sendJson(res, {
        statusCode: 500,
        payload: {
          ok: false,
          error: "provider_execution_error",
          message: err?.message ?? String(err ?? "")
        }
      });
      return;
    }
    const execResult = normalizeExecutionResult(execRaw);
    const body = toBodyBuffer(execResult.body);
    const contentType = execResult.contentType ?? execResult.headers["content-type"] ?? body.contentType;
    const responseHash = sha256Hex(body.bodyBuffer);
    const signedAt = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    let signature = signToolProviderSignatureV1({
      responseHash,
      nonce,
      signedAt,
      publicKeyPem,
      privateKeyPem
    });
    if (typeof mutateSignature === "function") {
      const maybeMutated = mutateSignature({
        signature,
        req,
        url,
        offer,
        verification,
        bodyBuffer: body.bodyBuffer
      });
      if (maybeMutated && typeof maybeMutated === "object") signature = maybeMutated;
    }

    const responseHeaders = {
      ...execResult.headers,
      "content-type": contentType,
      "x-settld-provider-key-id": signature.keyId ?? signerKeyId,
      "x-settld-provider-signed-at": signature.signedAt ?? signedAt,
      "x-settld-provider-nonce": signature.nonce ?? nonce,
      "x-settld-provider-response-sha256": signature.responseHash ?? responseHash,
      "x-settld-provider-signature": signature.signatureBase64 ?? "",
      "x-settld-provider-authorization-ref": String(payload.authorizationRef ?? ""),
      "x-settld-provider-gate-id": String(payload.gateId ?? ""),
      "x-settld-provider-quote-id": String(payload.quoteId ?? ""),
      "x-settld-provider-token-sha256": String(verification.tokenSha256 ?? ""),
      "x-settld-keyset-source": verified.keysetSource,
      "x-settld-request-binding-mode": offer.requestBindingMode ?? "none",
      "x-settld-request-binding-sha256": requestBindingSha256 ?? ""
    };
    res.writeHead(execResult.statusCode, responseHeaders);
    res.end(body.bodyBuffer);

    const replayExpiresAtMs = Number(payload.exp) * 1000 + normalizedReplayTtlBufferMs;
    replay.set(
      replayKey,
      {
        expiresAtMs: Number.isFinite(replayExpiresAtMs) ? replayExpiresAtMs : nowMs + 5 * 60_000,
        statusCode: execResult.statusCode,
        headers: execResult.headers,
        contentType,
        bodyBuffer: body.bodyBuffer,
        signature,
        requestBindingMode: offer.requestBindingMode ?? "none",
        requestBindingSha256: requestBindingSha256 ?? null
      },
      nowMs
    );
  }

  return paidHandler;
}
