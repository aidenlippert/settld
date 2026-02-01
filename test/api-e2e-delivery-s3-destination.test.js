import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { computeArtifactHash } from "../src/core/artifacts.js";

test("delivery: supports s3/minio artifact drop destinations", async () => {
  const fetched = [];
  const fetchFn = async (url, init) => {
    fetched.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ?? null });
    return { status: 200, ok: true };
  };

  {
    const store = createStore();
    const api = createApi({
      store,
      now: () => "2026-01-01T00:00:00.000Z",
      fetchFn,
      exportDestinations: {
        tenant_default: [
          {
            destinationId: "drop_1",
            kind: "s3",
            endpoint: "http://minio.local:9000",
            region: "us-east-1",
            bucket: "settld-artifacts",
            accessKeyId: "minio",
            secretAccessKey: "miniosecret",
            forcePathStyle: true,
            prefix: "pilot"
          }
        ]
      }
    });

    const core = {
      schemaVersion: "WorkCertificate.v1",
      artifactType: "WorkCertificate.v1",
      artifactId: "cert_job_test_evt_1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      tenantId: "tenant_default",
      jobId: "job_test",
      jobVersion: 1,
      policyHash: null,
      eventProof: { lastChainHash: "chain", eventCount: 1, signatures: { signedEventCount: 0, signerKeyIds: [] } },
      job: { templateId: "reset_lite", status: "SETTLED" },
      evidence: []
    };
    const artifactHash = computeArtifactHash(core);
    const artifact = { ...core, artifactHash };
    await store.putArtifact({ tenantId: "tenant_default", artifact });

    await store.createDelivery({
      tenantId: "tenant_default",
      delivery: {
        destinationId: "drop_1",
        artifactType: "WorkCertificate.v1",
        artifactId: artifact.artifactId,
        artifactHash: artifact.artifactHash,
        dedupeKey: `tenant_default:drop_1:WorkCertificate.v1:${artifact.artifactId}:${artifact.artifactHash}`
      }
    });

    const r = await api.tickDeliveries({ maxMessages: 10 });
    assert.equal(r.processed.length, 1);
    assert.equal(fetched.length, 1);

    const call = fetched[0];
    assert.equal(call.method, "PUT");
    assert.ok(call.url.startsWith("http://minio.local:9000/settld-artifacts/"));
    assert.equal(call.headers["content-type"], "application/json; charset=utf-8");
    const delivered = JSON.parse(String(call.body ?? ""));
    assert.equal(delivered.artifactHash, artifact.artifactHash);
    assert.equal(delivered.artifactId, artifact.artifactId);
  }
});
