import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createSettldPaidNodeHttpHandler } from "../packages/provider-kit/src/index.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import {
  buildSettldPayPayloadV1,
  computeSettldPayRequestBindingSha256V1,
  mintSettldPayTokenV1
} from "../src/core/settld-pay-token.js";

async function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: "unhandled" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

test("provider kit strict request binding rejects changed request body", async (t) => {
  const settldSigner = createEd25519Keypair();
  const providerSigner = createEd25519Keypair();
  const providerId = "prov_actions";
  const amountCents = 1200;
  const currency = "USD";

  const handler = createSettldPaidNodeHttpHandler({
    providerId,
    priceFor: async () => ({
      providerId,
      toolId: "send_email",
      amountCents,
      currency,
      requestBindingMode: "strict"
    }),
    execute: async ({ requestBodyBuffer }) => ({
      statusCode: 200,
      body: {
        ok: true,
        receivedBytes: Buffer.isBuffer(requestBodyBuffer) ? requestBodyBuffer.length : 0
      }
    }),
    providerPublicKeyPem: providerSigner.publicKeyPem,
    providerPrivateKeyPem: providerSigner.privateKeyPem,
    settldPay: {
      pinnedOnly: true,
      pinnedPublicKeyPem: settldSigner.publicKeyPem
    }
  });

  const svc = await startServer(handler);
  t.after(async () => {
    await svc.close();
  });

  const nowUnix = Math.floor(Date.now() / 1000);
  const requestPath = "/actions/send?dryRun=0";
  const requestUrl = new URL(requestPath, svc.baseUrl);
  const originalBody = JSON.stringify({ to: "alice@example.com", subject: "Hello" });
  const originalBodySha256 = sha256Hex(Buffer.from(originalBody, "utf8"));
  const requestBindingSha256 = computeSettldPayRequestBindingSha256V1({
    method: "POST",
    host: requestUrl.host,
    pathWithQuery: `${requestUrl.pathname}${requestUrl.search}`,
    bodySha256: originalBodySha256
  });

  const tokenPayload = buildSettldPayPayloadV1({
    iss: "settld",
    aud: providerId,
    gateId: "gate_strict_1",
    authorizationRef: "auth_gate_strict_1",
    amountCents,
    currency,
    payeeProviderId: providerId,
    requestBindingMode: "strict",
    requestBindingSha256,
    iat: nowUnix,
    exp: nowUnix + 300
  });
  const token = mintSettldPayTokenV1({
    payload: tokenPayload,
    publicKeyPem: settldSigner.publicKeyPem,
    privateKeyPem: settldSigner.privateKeyPem
  }).token;

  const okResponse = await fetch(requestUrl, {
    method: "POST",
    headers: {
      authorization: `SettldPay ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: originalBody
  });
  const okBodyText = await okResponse.text();
  assert.equal(okResponse.status, 200, okBodyText);
  assert.equal(okResponse.headers.get("x-settld-request-binding-mode"), "strict");
  assert.equal(okResponse.headers.get("x-settld-request-binding-sha256"), requestBindingSha256);
  const okJson = JSON.parse(okBodyText);
  assert.equal(okJson.ok, true);
  assert.equal(okJson.receivedBytes, Buffer.byteLength(originalBody, "utf8"));

  const changedBody = JSON.stringify({ to: "alice@example.com", subject: "Tampered" });
  const mismatchResponse = await fetch(requestUrl, {
    method: "POST",
    headers: {
      authorization: `SettldPay ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: changedBody
  });
  assert.equal(mismatchResponse.status, 402);
  const mismatchJson = await mismatchResponse.json();
  assert.equal(mismatchJson?.code, "SETTLD_PAY_REQUEST_BINDING_MISMATCH");
});
