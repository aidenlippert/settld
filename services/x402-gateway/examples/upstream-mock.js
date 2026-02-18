import http from "node:http";
import crypto from "node:crypto";

import { keyIdFromPublicKeyPem } from "../../../src/core/crypto.js";
import { createSettldPaidNodeHttpHandler } from "../../../packages/provider-kit/src/index.js";

function readBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  throw new Error(`${name} must be a boolean (1/0/true/false)`);
}

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function sanitizeIdSegment(text, { maxLen = 96 } = {}) {
  const raw = String(text ?? "").trim();
  const safe = raw.replaceAll(/[^A-Za-z0-9:_-]/g, "_").slice(0, maxLen);
  return safe || "unknown";
}

const PORT = Number(process.env.PORT ?? 9402);
if (!Number.isSafeInteger(PORT) || PORT <= 0) throw new Error("PORT must be a positive integer");
const BIND_HOST =
  typeof process.env.BIND_HOST === "string" && process.env.BIND_HOST.trim() !== "" ? process.env.BIND_HOST.trim() : null;

const PRICE_AMOUNT_CENTS = readIntEnv("SETTLD_PRICE_AMOUNT_CENTS", 500);
if (!Number.isSafeInteger(PRICE_AMOUNT_CENTS) || PRICE_AMOUNT_CENTS <= 0) {
  throw new Error("SETTLD_PRICE_AMOUNT_CENTS must be a positive integer");
}
const PRICE_CURRENCY =
  typeof process.env.SETTLD_PRICE_CURRENCY === "string" && process.env.SETTLD_PRICE_CURRENCY.trim() !== ""
    ? process.env.SETTLD_PRICE_CURRENCY.trim().toUpperCase()
    : "USD";
const PROVIDER_ID_CONFIG =
  typeof process.env.SETTLD_PROVIDER_ID === "string" && process.env.SETTLD_PROVIDER_ID.trim() !== ""
    ? process.env.SETTLD_PROVIDER_ID.trim()
    : null;
const PAYMENT_ADDRESS =
  typeof process.env.SETTLD_PAYMENT_ADDRESS === "string" && process.env.SETTLD_PAYMENT_ADDRESS.trim() !== ""
    ? process.env.SETTLD_PAYMENT_ADDRESS.trim()
    : "mock:payee";
const PAYMENT_NETWORK =
  typeof process.env.SETTLD_PAYMENT_NETWORK === "string" && process.env.SETTLD_PAYMENT_NETWORK.trim() !== ""
    ? process.env.SETTLD_PAYMENT_NETWORK.trim()
    : "mocknet";

const SETTLD_PAY_KEYSET_URL =
  typeof process.env.SETTLD_PAY_KEYSET_URL === "string" && process.env.SETTLD_PAY_KEYSET_URL.trim() !== ""
    ? process.env.SETTLD_PAY_KEYSET_URL.trim()
    : "http://127.0.0.1:3000/.well-known/settld-keys.json";
const SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS = readIntEnv("SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS", 300_000);
if (!Number.isSafeInteger(SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS) || SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS <= 0) {
  throw new Error("SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS must be a positive integer");
}
const SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS = readIntEnv("SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS", 3000);
if (!Number.isSafeInteger(SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS) || SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS <= 0) {
  throw new Error("SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS must be a positive integer");
}
const SETTLD_PAY_REPLAY_TTL_BUFFER_MS = readIntEnv("SETTLD_PAY_REPLAY_TTL_BUFFER_MS", 60_000);
if (!Number.isSafeInteger(SETTLD_PAY_REPLAY_TTL_BUFFER_MS) || SETTLD_PAY_REPLAY_TTL_BUFFER_MS < 0) {
  throw new Error("SETTLD_PAY_REPLAY_TTL_BUFFER_MS must be a non-negative integer");
}
const SETTLD_PAY_REPLAY_MAX_KEYS = readIntEnv("SETTLD_PAY_REPLAY_MAX_KEYS", 10_000);
if (!Number.isSafeInteger(SETTLD_PAY_REPLAY_MAX_KEYS) || SETTLD_PAY_REPLAY_MAX_KEYS <= 0) {
  throw new Error("SETTLD_PAY_REPLAY_MAX_KEYS must be a positive integer");
}
const SETTLD_PAY_PINNED_KID =
  typeof process.env.SETTLD_PAY_PINNED_KID === "string" && process.env.SETTLD_PAY_PINNED_KID.trim() !== ""
    ? process.env.SETTLD_PAY_PINNED_KID.trim()
    : null;
const SETTLD_PAY_PINNED_PUBLIC_KEY_PEM =
  typeof process.env.SETTLD_PAY_PINNED_PUBLIC_KEY_PEM === "string" && process.env.SETTLD_PAY_PINNED_PUBLIC_KEY_PEM.trim() !== ""
    ? process.env.SETTLD_PAY_PINNED_PUBLIC_KEY_PEM.trim()
    : null;
const SETTLD_PAY_PINNED_ONLY = readBoolEnv("SETTLD_PAY_PINNED_ONLY", false);
const SETTLD_PAY_PINNED_MAX_AGE_MS = readIntEnv("SETTLD_PAY_PINNED_MAX_AGE_MS", 3_600_000);
if (!Number.isSafeInteger(SETTLD_PAY_PINNED_MAX_AGE_MS) || SETTLD_PAY_PINNED_MAX_AGE_MS <= 0) {
  throw new Error("SETTLD_PAY_PINNED_MAX_AGE_MS must be a positive integer");
}

// Dev-only demo key. Do not reuse this key for any real workloads.
const PROVIDER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7zJ+oQLAO6F4Xewe7yJB1mv5TxsLo5bGZI7ZJPuFB6s=
-----END PUBLIC KEY-----`;
const PROVIDER_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJzGRPeTwBQESqFfShXcFhPhq7tUm1V9X92FU7ucZ+H4
-----END PRIVATE KEY-----`;
const PROVIDER_KEY_ID = keyIdFromPublicKeyPem(PROVIDER_PUBLIC_KEY_PEM);
const PROVIDER_PUBLIC_JWK = (() => {
  const jwk = crypto.createPublicKey(PROVIDER_PUBLIC_KEY_PEM).export({ format: "jwk" });
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: String(jwk.x ?? ""),
    kid: PROVIDER_KEY_ID,
    use: "sig",
    alg: "EdDSA"
  };
})();

function providerIdForRequest(req) {
  if (PROVIDER_ID_CONFIG) return PROVIDER_ID_CONFIG;
  const host = typeof req.headers.host === "string" && req.headers.host.trim() !== "" ? req.headers.host.trim() : `127.0.0.1:${PORT}`;
  return `agt_x402_payee_${sanitizeIdSegment(host)}`;
}

function sanitizeQuery(raw) {
  const text = String(raw ?? "").trim();
  return text || "empty-query";
}

function clampNumResults(raw) {
  const n = Number(raw ?? 5);
  if (!Number.isSafeInteger(n)) return 5;
  return Math.max(1, Math.min(10, n));
}

function sanitizeCity(raw) {
  const text = String(raw ?? "").trim();
  return text || "Unknown";
}

function normalizeTemperatureUnit(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "f" ? "f" : "c";
}

function sanitizePrompt(raw) {
  const text = String(raw ?? "").trim();
  return text || "empty prompt";
}

function normalizeMaxTokens(raw) {
  const n = Number(raw ?? 128);
  if (!Number.isSafeInteger(n)) return 128;
  return Math.max(1, Math.min(512, n));
}

function citySeed(city) {
  const text = String(city ?? "");
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) {
    sum += text.charCodeAt(i);
  }
  return sum;
}

function toolIdForRequest(req, url) {
  if (req.method === "GET" && url.pathname === "/exa/search") return "exa.search";
  if (req.method === "GET" && url.pathname === "/weather/current") return "weather.current";
  if (req.method === "GET" && url.pathname === "/llm/completions") return "llm.completion";
  return `${String(req.method ?? "GET").toUpperCase()}:${String(url.pathname ?? "/")}`;
}

function buildExaLikeResults({ query, numResults }) {
  const safeQuery = sanitizeQuery(query);
  const count = clampNumResults(numResults);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      rank: i + 1,
      title: `${safeQuery} result ${i + 1}`,
      url: `https://exa.mock/search/${encodeURIComponent(safeQuery)}/${i + 1}`,
      snippet: `Mock search result ${i + 1} for query: ${safeQuery}`
    });
  }
  return rows;
}

function buildResponseObject(req, url) {
  if (req.method === "GET" && url.pathname === "/exa/search") {
    return {
      ok: true,
      provider: "exa-mock",
      query: sanitizeQuery(url.searchParams.get("q")),
      numResults: clampNumResults(url.searchParams.get("numResults")),
      results: buildExaLikeResults({
        query: url.searchParams.get("q"),
        numResults: url.searchParams.get("numResults")
      })
    };
  }
  if (req.method === "GET" && url.pathname === "/weather/current") {
    const city = sanitizeCity(url.searchParams.get("city"));
    const unit = normalizeTemperatureUnit(url.searchParams.get("unit"));
    const seed = citySeed(city);
    const tempC = ((seed % 360) - 40) / 10;
    const temperature = unit === "f" ? Math.round((tempC * 9) / 5 + 32) : Math.round(tempC * 10) / 10;
    const conditions = ["sunny", "cloudy", "rain", "windy", "fog"];
    return {
      ok: true,
      provider: "weather-mock",
      city,
      unit,
      current: {
        temperature,
        condition: conditions[seed % conditions.length],
        observedAt: "2026-01-01T00:00:00.000Z"
      }
    };
  }
  if (req.method === "GET" && url.pathname === "/llm/completions") {
    const prompt = sanitizePrompt(url.searchParams.get("prompt"));
    const maxTokens = normalizeMaxTokens(url.searchParams.get("maxTokens"));
    const model = String(url.searchParams.get("model") ?? "").trim() || "gpt-4o-mini";
    const promptWordCount = prompt.split(/\s+/u).filter(Boolean).length;
    const inputTokens = Math.max(1, promptWordCount * 2);
    const outputTokens = Math.max(8, Math.min(maxTokens, 64));
    return {
      ok: true,
      provider: "llm-mock",
      model,
      prompt,
      outputText: `Summary: ${prompt.slice(0, 120)}`,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      }
    };
  }
  return {
    ok: true,
    resource: url.pathname,
    note: "this is a mock upstream response"
  };
}

const paidHandler = createSettldPaidNodeHttpHandler({
  providerIdForRequest: ({ req }) => providerIdForRequest(req),
  priceFor: ({ req, url }) => ({
    amountCents: PRICE_AMOUNT_CENTS,
    currency: PRICE_CURRENCY,
    providerId: providerIdForRequest(req),
    toolId: toolIdForRequest(req, url)
  }),
  providerPublicKeyPem: PROVIDER_PUBLIC_KEY_PEM,
  providerPrivateKeyPem: PROVIDER_PRIVATE_KEY_PEM,
  paymentAddress: PAYMENT_ADDRESS,
  paymentNetwork: PAYMENT_NETWORK,
  replayTtlBufferMs: SETTLD_PAY_REPLAY_TTL_BUFFER_MS,
  replayMaxKeys: SETTLD_PAY_REPLAY_MAX_KEYS,
  settldPay: {
    keysetUrl: SETTLD_PAY_KEYSET_URL,
    defaultMaxAgeMs: SETTLD_PAY_KEYSET_DEFAULT_MAX_AGE_MS,
    fetchTimeoutMs: SETTLD_PAY_KEYSET_FETCH_TIMEOUT_MS,
    pinnedPublicKeyPem: SETTLD_PAY_PINNED_PUBLIC_KEY_PEM,
    pinnedKeyId: SETTLD_PAY_PINNED_KID,
    pinnedOnly: SETTLD_PAY_PINNED_ONLY,
    pinnedMaxAgeMs: SETTLD_PAY_PINNED_MAX_AGE_MS
  },
  mutateSignature: ({ signature, url }) => {
    const fraud = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("fraud") ?? "").trim().toLowerCase());
    if (!fraud) return signature;
    const sigBytes = Buffer.from(String(signature.signatureBase64 ?? ""), "base64");
    if (sigBytes.length > 0) sigBytes[0] = sigBytes[0] ^ 0x01;
    return {
      ...signature,
      signatureBase64: sigBytes.toString("base64")
    };
  },
  execute: async ({ req, url }) => ({ body: buildResponseObject(req, url) })
});

async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/settld/provider-key") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        algorithm: "ed25519",
        keyId: PROVIDER_KEY_ID,
        publicKeyPem: PROVIDER_PUBLIC_KEY_PEM
      })
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/.well-known/settld-provider-keys.json") {
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=86400"
    });
    res.end(
      JSON.stringify({
        schemaVersion: "ToolProviderKeyset.v1",
        refreshedAt: new Date().toISOString(),
        keys: [PROVIDER_PUBLIC_JWK]
      })
    );
    return;
  }

  await paidHandler(req, res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: "upstream_error",
        message: err?.message ?? String(err ?? "")
      })
    );
  });
});

if (BIND_HOST) {
  server.listen(PORT, BIND_HOST, () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, service: "x402-upstream-mock", host: BIND_HOST, port: PORT }));
  });
} else {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, service: "x402-upstream-mock", port: PORT }));
  });
}
