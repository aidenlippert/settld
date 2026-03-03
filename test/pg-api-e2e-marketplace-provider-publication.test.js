import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { request } from "./api-test-harness.js";
import { buildNooterraPayKeysetV1 } from "../src/core/nooterra-keys.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { computePaidToolManifestHashV1 } from "../src/core/paid-tool-manifest.js";
import {
  PROVIDER_PUBLISH_PROOF_AUDIENCE,
  PROVIDER_PUBLISH_PROOF_TYPE,
  mintProviderPublishProofTokenV1
} from "../src/core/provider-publish-proof.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function listenServer(server, { host = "127.0.0.1" } = {}) {
  await new Promise((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  return { host, port: addr.port, url: `http://${host}:${addr.port}` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

(databaseUrl ? test : test.skip)("pg api e2e: marketplace provider publication survives refresh", async (t) => {
  const schema = makeSchema();
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

  const providerId = "prov_pg_publish";
  const publishProofKeys = createEd25519Keypair();
  const publishProofKeyId = keyIdFromPublicKeyPem(publishProofKeys.publicKeyPem);
  const publishProofJwks = buildNooterraPayKeysetV1({
    activeKey: {
      keyId: publishProofKeyId,
      publicKeyPem: publishProofKeys.publicKeyPem
    },
    refreshedAt: new Date().toISOString()
  });

  const jwksServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/provider-publish-jwks.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60"
      });
      res.end(JSON.stringify(publishProofJwks));
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  const jwksAddr = await listenServer(jwksServer);
  t.after(async () => {
    await closeServer(jwksServer);
  });

  try {
    const api = createApi({ store });
    const publishProofJwksUrl = `${jwksAddr.url}/.well-known/provider-publish-jwks.json`;
    const manifest = {
      schemaVersion: "PaidToolManifest.v2",
      providerId,
      upstreamBaseUrl: "https://provider.example",
      publishProofJwksUrl,
      capabilityTags: ["search"],
      defaults: {
        currency: "USD",
        amountCents: 100,
        idempotency: "idempotent",
        signatureMode: "required",
        toolClass: "read",
        riskLevel: "low",
        requiredSignatures: ["output"],
        requestBinding: "recommended"
      },
      tools: [
        {
          toolId: "tool.echo",
          mcpToolName: "tool.echo",
          description: "echo",
          method: "GET",
          upstreamPath: "/echo",
          paidPath: "/tool/echo",
          pricing: { amountCents: 100, currency: "USD" },
          auth: { mode: "none" },
          toolClass: "read",
          riskLevel: "low",
          capabilityTags: ["search"],
          security: {
            requiredSignatures: ["output"],
            requestBinding: "recommended"
          }
        }
      ]
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const publishProof = mintProviderPublishProofTokenV1({
      payload: {
        aud: PROVIDER_PUBLISH_PROOF_AUDIENCE,
        typ: PROVIDER_PUBLISH_PROOF_TYPE,
        manifestHash: computePaidToolManifestHashV1(manifest),
        providerId,
        iat: nowSec,
        exp: nowSec + 300
      },
      publicKeyPem: publishProofKeys.publicKeyPem,
      privateKeyPem: publishProofKeys.privateKeyPem,
      keyId: publishProofKeyId
    }).token;

    const published = await request(api, {
      method: "POST",
      path: "/marketplace/providers/publish",
      headers: { "x-idempotency-key": "pg_provider_publish_1" },
      body: {
        providerId,
        baseUrl: `${jwksAddr.url}/provider`,
        runConformance: false,
        publishProof,
        publishProofJwksUrl,
        manifest,
        tags: ["pg", "provider"]
      }
    });
    assert.equal(published.statusCode, 201, published.body);
    const providerRef = String(published.json?.publication?.providerRef ?? "");
    assert.ok(providerRef.length > 0);
    assert.equal(published.json?.publication?.providerId, providerId);
    assert.equal(published.json?.publication?.status, "draft");

    const listedBeforeRefresh = await request(api, {
      method: "GET",
      path: "/marketplace/providers?status=all&limit=20&offset=0"
    });
    assert.equal(listedBeforeRefresh.statusCode, 200, listedBeforeRefresh.body);
    assert.equal(listedBeforeRefresh.json?.total, 1);
    assert.equal(listedBeforeRefresh.json?.publications?.[0]?.providerRef, providerRef);

    await store.refreshFromDb();

    const listedAfterRefresh = await request(api, {
      method: "GET",
      path: "/marketplace/providers?status=all&limit=20&offset=0"
    });
    assert.equal(listedAfterRefresh.statusCode, 200, listedAfterRefresh.body);
    assert.equal(listedAfterRefresh.json?.total, 1);
    assert.equal(listedAfterRefresh.json?.publications?.[0]?.providerRef, providerRef);

    const fetchedAfterRefresh = await request(api, {
      method: "GET",
      path: `/marketplace/providers/${encodeURIComponent(providerId)}`
    });
    assert.equal(fetchedAfterRefresh.statusCode, 200, fetchedAfterRefresh.body);
    assert.equal(fetchedAfterRefresh.json?.publication?.providerId, providerId);

    const count = await store.pg.pool.query(
      "SELECT COUNT(*)::int AS c FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'marketplace_provider_publication'",
      ["tenant_default"]
    );
    assert.equal(Number(count.rows[0]?.c ?? 0), 1);
  } finally {
    await store.close();
  }
});
