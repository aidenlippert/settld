import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";
import { buildSettldPayKeysetV1 } from "../src/core/settld-keys.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createSettldPaidNodeHttpHandler } from "../packages/provider-kit/src/index.js";

async function listenServer(server, { host = "127.0.0.1" } = {}) {
  await new Promise((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  return { host, port: addr.port, url: `http://${host}:${addr.port}` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("API e2e: provider publish v0 certifies and lists provider", async (t) => {
  const api = createApi();
  const settldKeyId = keyIdFromPublicKeyPem(api.store.serverSigner.publicKeyPem);
  assert.equal(api.store.serverSigner.keyId, settldKeyId);

  const keysetServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/settld-keys.json") {
      const keyset = buildSettldPayKeysetV1({
        activeKey: {
          keyId: settldKeyId,
          publicKeyPem: api.store.serverSigner.publicKeyPem
        },
        refreshedAt: new Date().toISOString()
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60"
      });
      res.end(JSON.stringify(keyset));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const keysetAddr = await listenServer(keysetServer);
  t.after(async () => {
    await closeServer(keysetServer);
  });

  const providerId = "prov_publish_demo";
  const providerKeys = createEd25519Keypair();
  const providerKeyId = keyIdFromPublicKeyPem(providerKeys.publicKeyPem);
  const paidHandler = createSettldPaidNodeHttpHandler({
    providerId,
    providerPublicKeyPem: providerKeys.publicKeyPem,
    providerPrivateKeyPem: providerKeys.privateKeyPem,
    priceFor: () => ({
      amountCents: 500,
      currency: "USD",
      providerId,
      toolId: "bridge.search"
    }),
    paymentAddress: "mock:payee",
    paymentNetwork: "mocknet",
    settldPay: {
      keysetUrl: `${keysetAddr.url}/.well-known/settld-keys.json`
    },
    execute: async ({ url }) => ({
      body: {
        ok: true,
        provider: "provider-publish-e2e",
        query: url.searchParams.get("q") ?? ""
      }
    })
  });

  const providerServer = http.createServer((req, res) => {
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
          keyId: providerKeyId,
          publicKeyPem: providerKeys.publicKeyPem
        })
      );
      return;
    }
    if (url.pathname === "/tool/search") {
      paidHandler(req, res).catch((err) => {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "provider_error", message: err?.message ?? String(err ?? "") }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  const providerAddr = await listenServer(providerServer);
  t.after(async () => {
    await closeServer(providerServer);
  });

  const manifest = {
    schemaVersion: "PaidToolManifest.v1",
    providerId,
    upstreamBaseUrl: "https://provider.example",
    defaults: {
      currency: "USD",
      amountCents: 500,
      idempotency: "idempotent",
      signatureMode: "required"
    },
    tools: [
      {
        toolId: "bridge.search",
        mcpToolName: "bridge.search",
        description: "search bridge",
        method: "GET",
        upstreamPath: "/search",
        paidPath: "/tool/search",
        pricing: { amountCents: 500, currency: "USD" },
        auth: { mode: "none" }
      }
    ]
  };

  const published = await request(api, {
    method: "POST",
    path: "/marketplace/providers/publish",
    headers: { "x-idempotency-key": "publish_provider_e2e_1" },
    body: {
      providerId,
      baseUrl: providerAddr.url,
      providerSigningPublicKeyPem: providerKeys.publicKeyPem,
      manifest,
      tags: ["search", "demo"]
    }
  });
  assert.equal(published.statusCode, 201, published.body);
  assert.equal(published.json?.publication?.providerId, providerId);
  assert.equal(published.json?.publication?.status, "certified", published.body);
  assert.equal(published.json?.publication?.certified, true);
  assert.equal(published.json?.publication?.conformanceReport?.verdict?.ok, true);
  assert.equal(published.json?.publication?.providerSigning?.keyId, providerKeyId);

  const replay = await request(api, {
    method: "POST",
    path: "/marketplace/providers/publish",
    headers: { "x-idempotency-key": "publish_provider_e2e_1" },
    body: {
      providerId,
      baseUrl: providerAddr.url,
      providerSigningPublicKeyPem: providerKeys.publicKeyPem,
      manifest,
      tags: ["search", "demo"]
    }
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.deepEqual(replay.json, published.json);

  const listed = await request(api, {
    method: "GET",
    path: "/marketplace/providers?status=certified&limit=20&offset=0"
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json?.total, 1);
  assert.equal(listed.json?.publications?.[0]?.providerId, providerId);
  assert.equal(listed.json?.publications?.[0]?.certified, true);
  assert.equal(listed.json?.publications?.[0]?.toolCount, 1);
  assert.equal(typeof listed.json?.publications?.[0]?.certificationBadge?.badgeHash, "string");
  assert.equal(listed.json?.publications?.[0]?.certificationBadge?.providerId, providerId);

  const toolListed = await request(api, {
    method: "GET",
    path: "/marketplace/tools?status=certified&limit=20&offset=0"
  });
  assert.equal(toolListed.statusCode, 200, toolListed.body);
  assert.equal(toolListed.json?.total, 1);
  assert.equal(toolListed.json?.tools?.[0]?.providerId, providerId);
  assert.equal(toolListed.json?.tools?.[0]?.toolId, "bridge.search");
  assert.equal(toolListed.json?.tools?.[0]?.pricing?.amountCents, 500);
  assert.equal(toolListed.json?.tools?.[0]?.pricing?.currency, "USD");
  assert.equal(typeof toolListed.json?.tools?.[0]?.certificationBadge?.badgeHash, "string");

  const toolFiltered = await request(api, {
    method: "GET",
    path: "/marketplace/tools?status=certified&toolId=bridge.search&tags=search&q=bridge"
  });
  assert.equal(toolFiltered.statusCode, 200, toolFiltered.body);
  assert.equal(toolFiltered.json?.total, 1);
  assert.equal(toolFiltered.json?.tools?.[0]?.toolId, "bridge.search");

  const fetched = await request(api, {
    method: "GET",
    path: `/marketplace/providers/${encodeURIComponent(providerId)}`
  });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.json?.publication?.providerId, providerId);
  assert.equal(fetched.json?.publication?.conformanceReport?.verdict?.ok, true);
  assert.equal(fetched.json?.certificationBadge?.providerId, providerId);
  assert.equal(fetched.json?.certificationBadge?.certified, true);
  assert.equal(typeof fetched.json?.certificationBadge?.badgeHash, "string");

  const badgeOne = await request(api, {
    method: "GET",
    path: `/marketplace/providers/${encodeURIComponent(providerId)}/badge`
  });
  assert.equal(badgeOne.statusCode, 200, badgeOne.body);
  assert.equal(badgeOne.json?.badge?.providerId, providerId);
  assert.equal(badgeOne.json?.badge?.certified, true);
  assert.equal(typeof badgeOne.json?.badge?.badgeHash, "string");

  const badgeTwo = await request(api, {
    method: "GET",
    path: `/marketplace/providers/${encodeURIComponent(providerId)}/badge`
  });
  assert.equal(badgeTwo.statusCode, 200, badgeTwo.body);
  assert.deepEqual(badgeTwo.json, badgeOne.json);

  const conformanceRun = await request(api, {
    method: "POST",
    path: "/marketplace/providers/conformance/run",
    body: {
      providerId,
      baseUrl: providerAddr.url,
      providerSigningPublicKeyPem: providerKeys.publicKeyPem,
      manifest
    }
  });
  assert.equal(conformanceRun.statusCode, 200, conformanceRun.body);
  assert.equal(conformanceRun.json?.report?.verdict?.ok, true);
  const strictCheck = (conformanceRun.json?.report?.checks ?? []).find((row) => row?.id === "strict_request_binding_enforced");
  assert.ok(strictCheck);
  assert.equal(strictCheck?.ok, true);
  assert.equal(strictCheck?.details?.required, false);
});
