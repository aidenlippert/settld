import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { appendChainedEvent, createChainedEvent } from "../src/core/event-chain.js";
import { hmacSignArtifact } from "../src/core/artifacts.js";
import { request } from "./api-test-harness.js";

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

test("tenant guardrails: same jobId does not bleed (artifacts, deliveries, evidence)", async () => {
  const store = createStore();
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
  store.commitTx({ at: nowAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantA, jobId, events: jobCreatedA }] });

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
  store.commitTx({ at: nowAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantB, jobId, events: jobCreatedB }] });

  // Evidence only in tenantB.
  const existingB = store.jobEvents.get(`${tenantB}\n${jobId}`) ?? [];
  const evidenceAt = new Date(Date.parse(nowAt) + 1).toISOString();
  const withEvidence = appendChainedEvent({
    events: existingB,
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
  store.commitTx({ at: evidenceAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId: tenantB, jobId, events: [evidenceEvent] }] });

  // Same artifactId across tenants, different hashes.
  await store.putArtifact({
    tenantId: tenantA,
    artifact: { artifactId: "art_shared", artifactType: "WorkCertificate.v1", jobId, artifactHash: "hash_a", createdAt: nowAt }
  });
  await store.putArtifact({
    tenantId: tenantB,
    artifact: { artifactId: "art_shared", artifactType: "WorkCertificate.v1", jobId, artifactHash: "hash_b", createdAt: nowAt }
  });

  // Same dedupeKey across tenants, different hashes.
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

  // Auth key is tenant-scoped: same token cannot be used by swapping tenant header.
  const crossTenant = await request(api, {
    method: "GET",
    path: "/ops/deliveries",
    headers: { authorization: authA.authorization, "x-proxy-tenant-id": tenantB },
    auth: "none"
  });
  assert.equal(crossTenant.statusCode, 403);
});

test("exports/ack: signature required, idempotent, tenant-scoped", async () => {
  const tenantA = "tenant_a";
  const tenantB = "tenant_b";
  const destinationId = "dest_ack";
  const secretA = "secret_a";
  const secretB = "secret_b";

  const store = createStore();
  const api = createApi({
    store,
    exportDestinations: {
      [tenantA]: [{ destinationId, kind: "webhook", url: "https://example.com/webhook", secret: secretA }],
      [tenantB]: [{ destinationId, kind: "webhook", url: "https://example.com/webhook", secret: secretB }]
    }
  });

  const delivery = await store.createDelivery({
    tenantId: tenantA,
    delivery: {
      destinationId,
      artifactType: "WorkCertificate.v1",
      artifactId: "art_ack",
      artifactHash: "hash_ack",
      dedupeKey: "dedupe_ack"
    }
  });

  const timestamp = new Date().toISOString();
  const body = { deliveryId: delivery.deliveryId, artifactHash: "hash_ack", receivedAt: timestamp };
  const signature = hmacSignArtifact({ secret: secretA, timestamp, bodyJson: body });

  const ok = await request(api, {
    method: "POST",
    path: "/exports/ack",
    headers: {
      "x-proxy-tenant-id": tenantA,
      "x-proxy-destination-id": destinationId,
      "x-proxy-timestamp": timestamp,
      "x-proxy-signature": signature
    },
    body,
    auth: "none"
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json?.ok, true);

  // Duplicate ACK is harmless.
  const dup = await request(api, {
    method: "POST",
    path: "/exports/ack",
    headers: {
      "x-proxy-tenant-id": tenantA,
      "x-proxy-destination-id": destinationId,
      "x-proxy-timestamp": timestamp,
      "x-proxy-signature": signature
    },
    body,
    auth: "none"
  });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json?.ok, true);

  // Cannot forge without secret.
  const forged = await request(api, {
    method: "POST",
    path: "/exports/ack",
    headers: {
      "x-proxy-tenant-id": tenantA,
      "x-proxy-destination-id": destinationId,
      "x-proxy-timestamp": timestamp,
      "x-proxy-signature": "bad"
    },
    body,
    auth: "none"
  });
  assert.equal(forged.statusCode, 403);

  // Wrong tenant cannot ACK (tenantB secret is different, so signature mismatch).
  const wrongTenant = await request(api, {
    method: "POST",
    path: "/exports/ack",
    headers: {
      "x-proxy-tenant-id": tenantB,
      "x-proxy-destination-id": destinationId,
      "x-proxy-timestamp": timestamp,
      "x-proxy-signature": signature
    },
    body,
    auth: "none"
  });
  assert.equal(wrongTenant.statusCode, 403);

  // Even with tenantB secret, tenantB cannot ACK tenantA's delivery (no record in that tenant).
  const signatureB = hmacSignArtifact({ secret: secretB, timestamp, bodyJson: body });
  const missing = await request(api, {
    method: "POST",
    path: "/exports/ack",
    headers: {
      "x-proxy-tenant-id": tenantB,
      "x-proxy-destination-id": destinationId,
      "x-proxy-timestamp": timestamp,
      "x-proxy-signature": signatureB
    },
    body,
    auth: "none"
  });
  assert.equal(missing.statusCode, 404);
});

