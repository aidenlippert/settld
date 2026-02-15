import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

import { canonicalJsonStringify } from "../../../src/core/canonical-json.js";
import { keyIdFromPublicKeyPem, sha256Hex } from "../../../src/core/crypto.js";
import { signToolProviderSignatureV1 } from "../../../src/core/tool-provider-signature.js";

const PORT = Number(process.env.PORT ?? 9402);
if (!Number.isSafeInteger(PORT) || PORT <= 0) throw new Error("PORT must be a positive integer");
const BIND_HOST =
  typeof process.env.BIND_HOST === "string" && process.env.BIND_HOST.trim() !== "" ? process.env.BIND_HOST.trim() : null;

// Dev-only demo key. Do not reuse this key for any real workloads.
const PROVIDER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7zJ+oQLAO6F4Xewe7yJB1mv5TxsLo5bGZI7ZJPuFB6s=
-----END PUBLIC KEY-----\n`;
const PROVIDER_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJzGRPeTwBQESqFfShXcFhPhq7tUm1V9X92FU7ucZ+H4
-----END PRIVATE KEY-----\n`;
const PROVIDER_KEY_ID = keyIdFromPublicKeyPem(PROVIDER_PUBLIC_KEY_PEM);

const server = http.createServer((req, res) => {
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

  // "x402-style": if there's no payment proof header, require payment.
  const paid =
    (req.headers["x-payment"] && String(req.headers["x-payment"]).trim() !== "") ||
    (req.headers["x-payment-proof"] && String(req.headers["x-payment-proof"]).trim() !== "");
  if (!paid) {
    res.statusCode = 402;
    res.setHeader("x-payment-required", "amountCents=500; currency=USD; address=mock:payee; network=mocknet");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: "payment_required",
        hint: "retry with x-payment: paid (mock)"
      })
    );
    return;
  }

  const responseObj = {
    ok: true,
    resource: url.pathname,
    note: "this is a mock upstream response"
  };
  const responseCanonical = canonicalJsonStringify(responseObj);
  const responseHash = sha256Hex(responseCanonical);

  const signedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = signToolProviderSignatureV1({
    responseHash,
    nonce,
    signedAt,
    publicKeyPem: PROVIDER_PUBLIC_KEY_PEM,
    privateKeyPem: PROVIDER_PRIVATE_KEY_PEM
  });
  const fraud = ["1", "true", "yes", "on"].includes(String(url.searchParams.get("fraud") ?? "").trim().toLowerCase());
  const signatureBase64 = (() => {
    const b64 = String(signature.signatureBase64);
    if (!fraud) return b64;
    // Flip one bit so the signature is guaranteed to be invalid while still valid base64.
    const sigBytes = Buffer.from(b64, "base64");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0x01;
    return sigBytes.toString("base64");
  })();

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("x-settld-provider-key-id", PROVIDER_KEY_ID);
  res.setHeader("x-settld-provider-signed-at", signedAt);
  res.setHeader("x-settld-provider-nonce", nonce);
  res.setHeader("x-settld-provider-response-sha256", responseHash);
  res.setHeader("x-settld-provider-signature", signatureBase64);
  res.end(responseCanonical);
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
