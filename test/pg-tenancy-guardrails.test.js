import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { appendChainedEvent, createChainedEvent } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `ten_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll("-", "_");
}

async function createApiKey(store, { tenantId, scopes }) {
  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecret(secret);
  const createdAt = typeof store.nowIso === "function" ? store.nowIso() : new Date().toISOString();
  await store.putAuthKey({
    tenantId,
    authKey: {
      keyId,
      secretHash,
      scopes,
      status: "active",
      createdAt
    }
  });
  return { tenantId, keyId, secret, authorization: `Bearer ${keyId}.${secret}` };
}

(databaseUrl ? test : test.skip)("pg: tenant boundary holds for shared IDs", async () => {
  const schema = makeSchema();
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  try {
    const api = createApi({ store });
    const tenantA = "tenant_a";
    const tenantB = "tenant_b";
    const scopes = ["ops_write", "finance_write", "audit_read"];

    const authA = await createApiKey(store, { tenantId: tenantA, scopes });
    const authB = await createApiKey(store, { tenantId: tenantB, scopes });

    const jobId = "job_shared";
    const nowAt = new Date().toISOString();

    const jobCreatedA = appendChainedEvent({
      events: [],
      event: createChainedEvent({
        streamId: jobId,
        type: "JOB_CREATED",
        at: nowAt,
        actor: { type: "system", id: "test" },
        payload: { tenantId: tenantA, templateId: "reset_lite", constraints: {} }
      }),
      signer: store.serverSigner
    });
    await store.commitTx({ at: nowAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantA, jobId, events: jobCreatedA }] });

    const jobCreatedB = appendChainedEvent({
      events: [],
      event: createChainedEvent({
        streamId: jobId,
        type: "JOB_CREATED",
        at: nowAt,
        actor: { type: "system", id: "test" },
        payload: { tenantId: tenantB, templateId: "reset_lite", constraints: {} }
      }),
      signer: store.serverSigner
    });
    await store.commitTx({ at: nowAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantB, jobId, events: jobCreatedB }] });

    const evidenceAt = new Date(Date.parse(nowAt) + 1).toISOString();
    const withEvidence = appendChainedEvent({
      events: jobCreatedB,
      event: createChainedEvent({
        streamId: jobId,
        type: "EVIDENCE_CAPTURED",
        at: evidenceAt,
        actor: { type: "ops", id: "test" },
        payload: {
          jobId,
          incidentId: "inc_test",
          evidenceId: "ev_1",
          evidenceRef: "obj://test/evidence/ev_1",
          kind: "VIDEO_CLIP",
          durationSeconds: 1,
          contentType: "video/mp4"
        }
      }),
      signer: store.serverSigner
    });
    const evidenceEvent = withEvidence[withEvidence.length - 1];
    await store.commitTx({ at: evidenceAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantB, jobId, events: [evidenceEvent] }] });

    await store.putArtifact({
      tenantId: tenantA,
      artifact: { artifactId: "art_shared", artifactType: "WorkCertificate.v1", jobId, artifactHash: "hash_a", createdAt: nowAt }
    });
    await store.putArtifact({
      tenantId: tenantB,
      artifact: { artifactId: "art_shared", artifactType: "WorkCertificate.v1", jobId, artifactHash: "hash_b", createdAt: nowAt }
    });

    await store.createDelivery({
      tenantId: tenantA,
      delivery: {
        destinationId: "dest",
        artifactType: "WorkCertificate.v1",
        artifactId: "art_shared",
        artifactHash: "hash_a",
        dedupeKey: "dedupe_shared"
      }
    });
    await store.createDelivery({
      tenantId: tenantB,
      delivery: {
        destinationId: "dest",
        artifactType: "WorkCertificate.v1",
        artifactId: "art_shared",
        artifactHash: "hash_b",
        dedupeKey: "dedupe_shared"
      }
    });

    const artifactsA = await request(api, {
      method: "GET",
      path: `/jobs/${jobId}/artifacts`,
      headers: { authorization: authA.authorization, "x-proxy-tenant-id": tenantA },
      auth: "none"
    });
    assert.equal(artifactsA.statusCode, 200);
    const hashesA = (artifactsA.json?.artifacts ?? []).map((a) => a?.artifactHash).filter(Boolean);
    assert.ok(hashesA.includes("hash_a"));
    assert.ok(!hashesA.includes("hash_b"));

    const deliveriesA = await request(api, {
      method: "GET",
      path: "/ops/deliveries",
      headers: { authorization: authA.authorization, "x-proxy-tenant-id": tenantA },
      auth: "none"
    });
    assert.equal(deliveriesA.statusCode, 200);
    const deliveryHashesA = (deliveriesA.json?.deliveries ?? []).map((d) => d?.artifactHash).filter(Boolean);
    assert.ok(deliveryHashesA.includes("hash_a"));
    assert.ok(!deliveryHashesA.includes("hash_b"));

    const evidenceA = await request(api, {
      method: "GET",
      path: `/jobs/${jobId}/evidence`,
      headers: { authorization: authA.authorization, "x-proxy-tenant-id": tenantA },
      auth: "none"
    });
    assert.equal(evidenceA.statusCode, 200);
    assert.equal(Array.isArray(evidenceA.json?.evidence?.evidence) ? evidenceA.json.evidence.evidence.length : 0, 0);

    const evidenceB = await request(api, {
      method: "GET",
      path: `/jobs/${jobId}/evidence`,
      headers: { authorization: authB.authorization, "x-proxy-tenant-id": tenantB },
      auth: "none"
    });
    assert.equal(evidenceB.statusCode, 200);
    assert.ok((evidenceB.json?.evidence?.evidence ?? []).some((e) => e?.evidenceId === "ev_1"));
  } finally {
    await store.close();
  }
});

