import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex } from "../src/core/crypto.js";
import { verifyToolProviderQuoteSignatureV1 } from "../src/core/provider-quote-signature.js";
import { buildSettldPayPayloadV1, mintSettldPayTokenV1 } from "../src/core/settld-pay-token.js";
import { buildSettldPayKeysetV1 } from "../src/core/settld-keys.js";
import { computeToolProviderSignaturePayloadHashV1, verifyToolProviderSignatureV1 } from "../src/core/tool-provider-signature.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const server = http.createServer((_, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  const port = addr.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`health check timeout: ${url}`);
}

function onceProcessExit(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function buildKeyset(keys) {
  const rows = Array.isArray(keys) ? keys : [];
  if (rows.length === 0) throw new Error("keys are required");
  const [activeKey, ...fallbackKeys] = rows;
  return buildSettldPayKeysetV1({ activeKey, fallbackKeys, refreshedAt: new Date().toISOString() });
}

function mintSettldPay({ signer, providerId, amountCents = 500, currency = "USD", authorizationRef, gateId, ttlSeconds = 300 }) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const payload = buildSettldPayPayloadV1({
    iss: "settld",
    aud: providerId,
    gateId,
    authorizationRef,
    amountCents,
    currency,
    payeeProviderId: providerId,
    iat: nowUnix,
    exp: nowUnix + ttlSeconds
  });
  const minted = mintSettldPayTokenV1({
    payload,
    keyId: keyIdFromPublicKeyPem(signer.publicKeyPem),
    publicKeyPem: signer.publicKeyPem,
    privateKeyPem: signer.privateKeyPem
  });
  return minted.token;
}

function parseBase64UrlJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8"));
}

test("provider kit hardening: offline SettldPay verification, replay handling, and key rotation", async (t) => {
  const providerId = "prov_exa_mock";

  const signerA = createEd25519Keypair();
  const signerB = createEd25519Keypair();

  const keysetState = {
    rows: [{ keyId: keyIdFromPublicKeyPem(signerA.publicKeyPem), publicKeyPem: signerA.publicKeyPem }],
    maxAgeSec: 1,
    hits: 0
  };

  const keysetServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/settld-keys.json") {
      keysetState.hits += 1;
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${keysetState.maxAgeSec}`
      });
      res.end(JSON.stringify(buildKeyset(keysetState.rows)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const keysetPort = await reservePort();
  await new Promise((resolve) => keysetServer.listen(keysetPort, "127.0.0.1", resolve));

  const upstreamPort = await reservePort();
  const upstream = spawn(process.execPath, ["services/x402-gateway/examples/upstream-mock.js"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BIND_HOST: "127.0.0.1",
      PORT: String(upstreamPort),
      SETTLD_PROVIDER_ID: providerId,
      SETTLD_PAY_KEYSET_URL: `http://127.0.0.1:${keysetPort}/.well-known/settld-keys.json`
    }
  });

  let stderrBuf = "";
  upstream.stderr.setEncoding("utf8");
  upstream.stderr.on("data", (chunk) => {
    stderrBuf += String(chunk);
  });

  t.after(async () => {
    if (!upstream.killed) upstream.kill("SIGTERM");
    const exited = await Promise.race([onceProcessExit(upstream), sleep(1_500).then(() => null)]);
    if (!exited && !upstream.killed) upstream.kill("SIGKILL");
    await new Promise((resolve) => keysetServer.close(resolve));
  });

  const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
  await waitForHealth(`${upstreamBase}/healthz`);

  const providerKeyRes = await fetch(`${upstreamBase}/settld/provider-key`);
  assert.equal(providerKeyRes.status, 200);
  const providerKey = await providerKeyRes.json();
  const providerPublicKeyPem = String(providerKey?.publicKeyPem ?? "");
  assert.ok(providerPublicKeyPem.includes("BEGIN PUBLIC KEY"));
  const providerJwksRes = await fetch(`${upstreamBase}/.well-known/settld-provider-keys.json`);
  assert.equal(providerJwksRes.status, 200);
  const providerJwks = await providerJwksRes.json();
  assert.equal(providerJwks?.schemaVersion, "ToolProviderKeyset.v1");
  assert.equal(Array.isArray(providerJwks?.keys), true);
  assert.equal(providerJwks.keys[0]?.kid, providerKey.keyId);

  const challengeMissing = await fetch(`${upstreamBase}/exa/search?q=dentist&numResults=2`);
  assert.equal(challengeMissing.status, 402);
  assert.ok(challengeMissing.headers.get("x-payment-required"));
  assert.ok(challengeMissing.headers.get("payment-required"));
  const challengeHeader = String(challengeMissing.headers.get("x-payment-required") ?? "");
  assert.match(challengeHeader, /amountCents=500/);
  assert.match(challengeHeader, /currency=USD/);
  assert.match(challengeHeader, /providerId=prov_exa_mock/);
  assert.match(challengeHeader, /toolId=exa\.search/);
  const quotePayload = parseBase64UrlJson(challengeMissing.headers.get("x-settld-provider-quote"));
  const quoteSignature = parseBase64UrlJson(challengeMissing.headers.get("x-settld-provider-quote-signature"));
  assert.ok(quotePayload && quoteSignature);
  assert.equal(quotePayload.providerId, providerId);
  assert.equal(quotePayload.toolId, "exa.search");
  assert.equal(quotePayload.amountCents, 500);
  assert.equal(quotePayload.currency, "USD");
  assert.equal(verifyToolProviderQuoteSignatureV1({ quote: quotePayload, signature: quoteSignature, publicKeyPem: providerPublicKeyPem }), true);

  const malformed = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: "SettldPay not_a_token" }
  });
  assert.equal(malformed.status, 402);
  assert.equal(malformed.headers.get("x-settld-payment-error"), "SETTLD_PAY_VERIFICATION_ERROR");

  const unknownSigner = createEd25519Keypair();
  const unknownToken = mintSettldPay({
    signer: unknownSigner,
    providerId,
    authorizationRef: "auth_unknown_1",
    gateId: "gate_unknown_1"
  });
  const unknownKid = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${unknownToken}` }
  });
  assert.equal(unknownKid.status, 402);
  assert.equal(unknownKid.headers.get("x-settld-payment-error"), "SETTLD_PAY_UNKNOWN_KID");

  const expiredPayload = buildSettldPayPayloadV1({
    iss: "settld",
    aud: providerId,
    gateId: "gate_expired_1",
    authorizationRef: "auth_expired_1",
    amountCents: 500,
    currency: "USD",
    payeeProviderId: providerId,
    iat: Math.floor(Date.now() / 1000) - 600,
    exp: Math.floor(Date.now() / 1000) - 300
  });
  const expiredToken = mintSettldPayTokenV1({
    payload: expiredPayload,
    keyId: keyIdFromPublicKeyPem(signerA.publicKeyPem),
    publicKeyPem: signerA.publicKeyPem,
    privateKeyPem: signerA.privateKeyPem
  }).token;
  const expired = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${expiredToken}` }
  });
  assert.equal(expired.status, 402);
  assert.equal(expired.headers.get("x-settld-payment-error"), "SETTLD_PAY_EXPIRED");

  const wrongProviderToken = mintSettldPay({
    signer: signerA,
    providerId: "prov_other",
    authorizationRef: "auth_provider_bad_1",
    gateId: "gate_provider_bad_1"
  });
  const wrongProvider = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${wrongProviderToken}` }
  });
  assert.equal(wrongProvider.status, 402);
  assert.equal(wrongProvider.headers.get("x-settld-payment-error"), "SETTLD_PAY_PROVIDER_MISMATCH");

  const amountMismatchToken = mintSettldPay({
    signer: signerA,
    providerId,
    amountCents: 999,
    authorizationRef: "auth_amount_bad_1",
    gateId: "gate_amount_bad_1"
  });
  const amountMismatch = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${amountMismatchToken}` }
  });
  assert.equal(amountMismatch.status, 402);
  assert.equal(amountMismatch.headers.get("x-settld-payment-error"), "SETTLD_PAY_AMOUNT_MISMATCH");

  const validToken = mintSettldPay({
    signer: signerA,
    providerId,
    authorizationRef: "auth_valid_1",
    gateId: "gate_valid_1"
  });
  const valid = await fetch(`${upstreamBase}/exa/search?q=dentist&numResults=2`, {
    headers: { authorization: `SettldPay ${validToken}` }
  });
  assert.equal(valid.status, 200, `stderr=${stderrBuf}`);
  const validText = await valid.text();
  const validBody = JSON.parse(validText);
  assert.equal(validBody.ok, true);
  assert.equal(validBody.provider, "exa-mock");

  const responseHash = sha256Hex(canonicalJsonStringify(validBody));
  assert.equal(valid.headers.get("x-settld-provider-response-sha256"), responseHash);
  const signature = {
    schemaVersion: "ToolProviderSignature.v1",
    algorithm: "ed25519",
    keyId: String(valid.headers.get("x-settld-provider-key-id") ?? ""),
    signedAt: String(valid.headers.get("x-settld-provider-signed-at") ?? ""),
    nonce: String(valid.headers.get("x-settld-provider-nonce") ?? ""),
    responseHash,
    payloadHash: computeToolProviderSignaturePayloadHashV1({
      responseHash,
      nonce: String(valid.headers.get("x-settld-provider-nonce") ?? ""),
      signedAt: String(valid.headers.get("x-settld-provider-signed-at") ?? "")
    }),
    signatureBase64: String(valid.headers.get("x-settld-provider-signature") ?? "")
  };
  assert.equal(verifyToolProviderSignatureV1({ signature, publicKeyPem: providerPublicKeyPem }), true);

  const duplicate = await fetch(`${upstreamBase}/exa/search?q=dentist&numResults=2`, {
    headers: { authorization: `SettldPay ${validToken}` }
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.headers.get("x-settld-provider-replay"), "duplicate");
  const duplicateText = await duplicate.text();
  assert.equal(duplicateText, validText);
  assert.equal(duplicate.headers.get("x-settld-provider-signature"), valid.headers.get("x-settld-provider-signature"));

  keysetState.rows = [
    { keyId: keyIdFromPublicKeyPem(signerA.publicKeyPem), publicKeyPem: signerA.publicKeyPem },
    { keyId: keyIdFromPublicKeyPem(signerB.publicKeyPem), publicKeyPem: signerB.publicKeyPem }
  ];

  await sleep(1_200);

  const rotatedBToken = mintSettldPay({
    signer: signerB,
    providerId,
    authorizationRef: "auth_rotated_b_1",
    gateId: "gate_rotated_b_1"
  });
  const rotatedB = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${rotatedBToken}` }
  });
  assert.equal(rotatedB.status, 200);

  const rotatedAToken = mintSettldPay({
    signer: signerA,
    providerId,
    authorizationRef: "auth_rotated_a_1",
    gateId: "gate_rotated_a_1"
  });
  const rotatedA = await fetch(`${upstreamBase}/exa/search?q=dentist`, {
    headers: { authorization: `SettldPay ${rotatedAToken}` }
  });
  assert.equal(rotatedA.status, 200);

  assert.equal(keysetState.hits >= 2, true, `expected keyset to be fetched at least twice, got ${keysetState.hits}`);
});
