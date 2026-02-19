import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createApi } from "../src/api/app.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex } from "../src/core/crypto.js";
import { buildToolProviderQuotePayloadV1, signToolProviderQuoteSignatureV1 } from "../src/core/provider-quote-signature.js";
import { computeSettldPayRequestBindingSha256V1, parseSettldPayTokenV1 } from "../src/core/settld-pay-token.js";
import { signToolProviderSignatureV1 } from "../src/core/tool-provider-signature.js";
import { listenOnEphemeralLoopback } from "./lib/listen.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TENANT_ID = "tenant_default";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = http.createServer((_, res) => {
    res.statusCode = 204;
    res.end();
  });
  const { port } = await listenOnEphemeralLoopback(server, { hosts: ["127.0.0.1"] });
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function putAuthKey(api, { tenantId = DEFAULT_TENANT_ID } = {}) {
  const keyId = authKeyId();
  const secret = authKeySecret();
  const createdAt = typeof api.store?.nowIso === "function" ? api.store.nowIso() : new Date().toISOString();
  await api.store.putAuthKey({
    tenantId,
    authKey: {
      keyId,
      secretHash: hashAuthKeySecret(secret),
      scopes: ["ops_read", "ops_write", "finance_read", "finance_write", "audit_read"],
      status: "active",
      createdAt
    }
  });
  return `${keyId}.${secret}`;
}

async function waitForGatewayReady({ port, timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // retry until deadline
    }
    await sleep(100);
  }
  throw new Error("gateway did not become ready");
}

function onceProcessExit(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function buildProviderJwks(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const jwk = key.export({ format: "jwk" });
  return {
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        x: String(jwk.x ?? ""),
        kid: keyIdFromPublicKeyPem(publicKeyPem),
        use: "sig",
        alg: "EdDSA"
      }
    ]
  };
}

test("x402 gateway: retries with SettldPay token and returns verified response", async (t) => {
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const hasSettldPay = authHeader.toLowerCase().startsWith("settldpay ");
    const paymentHeader = typeof req.headers["x-payment"] === "string" ? req.headers["x-payment"] : null;
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      authorization: authHeader,
      xPayment: paymentHeader
    });
    if (!hasSettldPay) {
      res.writeHead(402, {
        "content-type": "application/json; charset=utf-8",
        "x-payment-required":
          "amountCents=500; currency=USD; toolId=mock_search; address=mock:payee; network=mocknet; requestBindingMode=strict; quoteRequired=1"
      });
      res.end(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, provider: "mock" }));
  });
  const upstreamBind = await listenOnEphemeralLoopback(upstream, { hosts: ["127.0.0.1"] });
  const upstreamBase = `http://127.0.0.1:${upstreamBind.port}`;

  const api = createApi();
  const apiServer = http.createServer(api.handle);
  const apiBind = await listenOnEphemeralLoopback(apiServer, { hosts: ["127.0.0.1"] });
  const apiBase = `http://127.0.0.1:${apiBind.port}`;
  const apiKey = await putAuthKey(api, { tenantId: DEFAULT_TENANT_ID });

  const gatewayPort = await reservePort();
  const gateway = spawn(process.execPath, ["services/x402-gateway/src/server.js"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      BIND_HOST: "127.0.0.1",
      SETTLD_API_URL: apiBase,
      SETTLD_API_KEY: apiKey,
      UPSTREAM_URL: upstreamBase,
      X402_AUTOFUND: "1"
    }
  });

  let stderrBuf = "";
  gateway.stderr.setEncoding("utf8");
  gateway.stderr.on("data", (chunk) => {
    stderrBuf += String(chunk);
  });

  let stdoutBuf = "";
  gateway.stdout.setEncoding("utf8");
  gateway.stdout.on("data", (chunk) => {
    stdoutBuf += String(chunk);
  });

  t.after(async () => {
    if (!gateway.killed) gateway.kill("SIGTERM");
    const exited = await Promise.race([onceProcessExit(gateway), sleep(1_500).then(() => null)]);
    if (!exited && !gateway.killed) gateway.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForGatewayReady({ port: gatewayPort });
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;

  const first = await fetch(`${gatewayBase}/tools/search?q=dentist`);
  assert.equal(first.status, 402);
  const gateId = first.headers.get("x-settld-gate-id");
  assert.ok(gateId && gateId.trim() !== "");

  const second = await fetch(`${gatewayBase}/tools/search?q=dentist`, {
    headers: {
      "x-settld-gate-id": gateId
    }
  });
  const secondText = await second.text();
  assert.equal(second.status, 200, `unexpected second status=${second.status} body=${secondText} requests=${JSON.stringify(upstreamRequests)}`);
  const secondJson = JSON.parse(secondText);
  assert.equal(secondJson.ok, true);
  assert.equal(second.headers.get("x-settld-settlement-status"), "released");
  assert.equal(second.headers.get("x-settld-verification-status"), "green");

  assert.equal(upstreamRequests.length >= 2, true);
  const paidCall = upstreamRequests.find((row) => row.authorization.toLowerCase().startsWith("settldpay "));
  assert.ok(paidCall, `expected SettldPay retry; stdout=${stdoutBuf} stderr=${stderrBuf}`);
  assert.ok(typeof paidCall.xPayment === "string" && paidCall.xPayment.length > 0);
  const token = paidCall.authorization.slice("SettldPay ".length).trim();
  const parsedToken = parseSettldPayTokenV1(token);
  const expectedRequestBindingSha256 = computeSettldPayRequestBindingSha256V1({
    method: "GET",
    host: `127.0.0.1:${upstreamBind.port}`,
    pathWithQuery: "/tools/search?q=dentist",
    bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  });
  assert.equal(parsedToken.payload.requestBindingMode, "strict");
  assert.equal(parsedToken.payload.requestBindingSha256, expectedRequestBindingSha256);
  assert.ok(typeof parsedToken.payload.quoteId === "string" && parsedToken.payload.quoteId.length > 0);

  const settlementRead = await fetch(`${apiBase}/runs/${encodeURIComponent(`x402_${gateId}`)}/settlement`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-proxy-tenant-id": DEFAULT_TENANT_ID
    }
  });
  const settlementText = await settlementRead.text();
  assert.equal(settlementRead.status, 200, settlementText);
  const settlementJson = JSON.parse(settlementText);
  assert.ok(
    typeof settlementJson?.decisionRecord?.bindings?.spendAuthorization?.delegationRef === "string" &&
      settlementJson.decisionRecord.bindings.spendAuthorization.delegationRef.length > 0
  );
});

test("x402 gateway: enforces signed provider quote when provider key is configured", async (t) => {
  const providerSigner = createEd25519Keypair();
  const providerPublicKeyPem = providerSigner.publicKeyPem.trim();
  const providerId = "prov_signed_quotes";
  const toolId = "mock_search";
  const amountCents = 700;
  const currency = "USD";
  const quoteId = "pquote_signed_1";

  const upstream = http.createServer((req, res) => {
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const hasSettldPay = authHeader.toLowerCase().startsWith("settldpay ");
    if (!hasSettldPay) {
      const host = String(req.headers.host ?? "");
      const url = new URL(req.url ?? "/", `http://${host || "127.0.0.1"}`);
      const requestBindingSha256 = computeSettldPayRequestBindingSha256V1({
        method: String(req.method ?? "GET").toUpperCase(),
        host,
        pathWithQuery: `${url.pathname}${url.search}`,
        bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      });
      const quotedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const quotePayload = buildToolProviderQuotePayloadV1({
        providerId,
        toolId,
        amountCents,
        currency,
        address: "mock:payee",
        network: "mocknet",
        requestBindingMode: "strict",
        requestBindingSha256,
        quoteRequired: true,
        quoteId,
        spendAuthorizationMode: "required",
        quotedAt,
        expiresAt
      });
      const quoteSignature = signToolProviderQuoteSignatureV1({
        quote: quotePayload,
        nonce: crypto.randomBytes(16).toString("hex"),
        signedAt: quotedAt,
        publicKeyPem: providerPublicKeyPem,
        privateKeyPem: providerSigner.privateKeyPem
      });
      res.writeHead(402, {
        "content-type": "application/json; charset=utf-8",
        "x-payment-required": `amountCents=${amountCents}; currency=${currency}; providerId=${providerId}; toolId=${toolId}; address=mock:payee; network=mocknet; requestBindingMode=strict; quoteRequired=1; quoteId=${quoteId}; spendAuthorizationMode=required`,
        "x-settld-provider-quote": Buffer.from(JSON.stringify(quotePayload), "utf8").toString("base64url"),
        "x-settld-provider-quote-signature": Buffer.from(JSON.stringify(quoteSignature), "utf8").toString("base64url")
      });
      res.end(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }));
      return;
    }
    const responseBody = { ok: true, provider: "mock-signed" };
    const responseText = canonicalJsonStringify(responseBody);
    const responseHash = sha256Hex(responseText);
    const signedAt = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = signToolProviderSignatureV1({
      responseHash,
      nonce,
      signedAt,
      publicKeyPem: providerPublicKeyPem,
      privateKeyPem: providerSigner.privateKeyPem
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-settld-provider-key-id": signature.keyId,
      "x-settld-provider-signed-at": signature.signedAt,
      "x-settld-provider-nonce": signature.nonce,
      "x-settld-provider-response-sha256": signature.responseHash,
      "x-settld-provider-signature": signature.signatureBase64
    });
    res.end(responseText);
  });
  const upstreamBind = await listenOnEphemeralLoopback(upstream, { hosts: ["127.0.0.1"] });
  const upstreamBase = `http://127.0.0.1:${upstreamBind.port}`;

  const api = createApi();
  const apiServer = http.createServer(api.handle);
  const apiBind = await listenOnEphemeralLoopback(apiServer, { hosts: ["127.0.0.1"] });
  const apiBase = `http://127.0.0.1:${apiBind.port}`;
  const apiKey = await putAuthKey(api, { tenantId: DEFAULT_TENANT_ID });

  const gatewayPort = await reservePort();
  const gateway = spawn(process.execPath, ["services/x402-gateway/src/server.js"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      BIND_HOST: "127.0.0.1",
      SETTLD_API_URL: apiBase,
      SETTLD_API_KEY: apiKey,
      UPSTREAM_URL: upstreamBase,
      X402_AUTOFUND: "1",
      X402_PROVIDER_PUBLIC_KEY_PEM: providerPublicKeyPem
    }
  });

  t.after(async () => {
    if (!gateway.killed) gateway.kill("SIGTERM");
    const exited = await Promise.race([onceProcessExit(gateway), sleep(1_500).then(() => null)]);
    if (!exited && !gateway.killed) gateway.kill("SIGKILL");
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForGatewayReady({ port: gatewayPort });
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;

  const first = await fetch(`${gatewayBase}/tools/search?q=orthodontist`);
  assert.equal(first.status, 402);
  const gateId = first.headers.get("x-settld-gate-id");
  assert.ok(gateId && gateId.trim() !== "");

  const second = await fetch(`${gatewayBase}/tools/search?q=orthodontist`, {
    headers: {
      "x-settld-gate-id": gateId
    }
  });
  assert.equal(second.status, 200, await second.text());
  assert.equal(second.headers.get("x-settld-settlement-status"), "released");
  assert.equal(second.headers.get("x-settld-verification-status"), "green");
});

test("x402 gateway: verifies provider signatures via JWKS URL", async (t) => {
  const providerSigner = createEd25519Keypair();
  const providerPublicKeyPem = providerSigner.publicKeyPem.trim();
  const providerId = "prov_jwks_quotes";
  const toolId = "mock_search";
  const amountCents = 725;
  const currency = "USD";
  const quoteId = "pquote_jwks_1";

  const jwksServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/settld-provider-keys.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60"
      });
      res.end(JSON.stringify(buildProviderJwks(providerPublicKeyPem)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  const jwksBind = await listenOnEphemeralLoopback(jwksServer, { hosts: ["127.0.0.1"] });
  const jwksUrl = `http://127.0.0.1:${jwksBind.port}/.well-known/settld-provider-keys.json`;

  const upstream = http.createServer((req, res) => {
    const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const hasSettldPay = authHeader.toLowerCase().startsWith("settldpay ");
    if (!hasSettldPay) {
      const host = String(req.headers.host ?? "");
      const url = new URL(req.url ?? "/", `http://${host || "127.0.0.1"}`);
      const requestBindingSha256 = computeSettldPayRequestBindingSha256V1({
        method: String(req.method ?? "GET").toUpperCase(),
        host,
        pathWithQuery: `${url.pathname}${url.search}`,
        bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      });
      const quotedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const quotePayload = buildToolProviderQuotePayloadV1({
        providerId,
        toolId,
        amountCents,
        currency,
        address: "mock:payee",
        network: "mocknet",
        requestBindingMode: "strict",
        requestBindingSha256,
        quoteRequired: true,
        quoteId,
        spendAuthorizationMode: "required",
        quotedAt,
        expiresAt
      });
      const quoteSignature = signToolProviderQuoteSignatureV1({
        quote: quotePayload,
        nonce: crypto.randomBytes(16).toString("hex"),
        signedAt: quotedAt,
        publicKeyPem: providerPublicKeyPem,
        privateKeyPem: providerSigner.privateKeyPem
      });
      res.writeHead(402, {
        "content-type": "application/json; charset=utf-8",
        "x-payment-required": `amountCents=${amountCents}; currency=${currency}; providerId=${providerId}; toolId=${toolId}; address=mock:payee; network=mocknet; requestBindingMode=strict; quoteRequired=1; quoteId=${quoteId}; spendAuthorizationMode=required`,
        "x-settld-provider-quote": Buffer.from(JSON.stringify(quotePayload), "utf8").toString("base64url"),
        "x-settld-provider-quote-signature": Buffer.from(JSON.stringify(quoteSignature), "utf8").toString("base64url")
      });
      res.end(JSON.stringify({ ok: false, code: "PAYMENT_REQUIRED" }));
      return;
    }
    const responseBody = { ok: true, provider: "mock-jwks" };
    const responseText = canonicalJsonStringify(responseBody);
    const responseHash = sha256Hex(responseText);
    const signedAt = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = signToolProviderSignatureV1({
      responseHash,
      nonce,
      signedAt,
      publicKeyPem: providerPublicKeyPem,
      privateKeyPem: providerSigner.privateKeyPem
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-settld-provider-key-id": signature.keyId,
      "x-settld-provider-signed-at": signature.signedAt,
      "x-settld-provider-nonce": signature.nonce,
      "x-settld-provider-response-sha256": signature.responseHash,
      "x-settld-provider-signature": signature.signatureBase64
    });
    res.end(responseText);
  });
  const upstreamBind = await listenOnEphemeralLoopback(upstream, { hosts: ["127.0.0.1"] });
  const upstreamBase = `http://127.0.0.1:${upstreamBind.port}`;

  const api = createApi();
  const apiServer = http.createServer(api.handle);
  const apiBind = await listenOnEphemeralLoopback(apiServer, { hosts: ["127.0.0.1"] });
  const apiBase = `http://127.0.0.1:${apiBind.port}`;
  const apiKey = await putAuthKey(api, { tenantId: DEFAULT_TENANT_ID });

  const gatewayPort = await reservePort();
  const gateway = spawn(process.execPath, ["services/x402-gateway/src/server.js"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      BIND_HOST: "127.0.0.1",
      SETTLD_API_URL: apiBase,
      SETTLD_API_KEY: apiKey,
      UPSTREAM_URL: upstreamBase,
      X402_AUTOFUND: "1",
      X402_PROVIDER_JWKS_URL: jwksUrl
    }
  });

  t.after(async () => {
    if (!gateway.killed) gateway.kill("SIGTERM");
    const exited = await Promise.race([onceProcessExit(gateway), sleep(1_500).then(() => null)]);
    if (!exited && !gateway.killed) gateway.kill("SIGKILL");
    await new Promise((resolve) => jwksServer.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => apiServer.close(resolve));
  });

  await waitForGatewayReady({ port: gatewayPort });
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;

  const first = await fetch(`${gatewayBase}/tools/search?q=periodontist`);
  assert.equal(first.status, 402);
  const gateId = first.headers.get("x-settld-gate-id");
  assert.ok(gateId && gateId.trim() !== "");

  const second = await fetch(`${gatewayBase}/tools/search?q=periodontist`, {
    headers: {
      "x-settld-gate-id": gateId
    }
  });
  assert.equal(second.status, 200, await second.text());
  assert.equal(second.headers.get("x-settld-settlement-status"), "released");
  assert.equal(second.headers.get("x-settld-verification-status"), "green");
});
