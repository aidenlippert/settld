import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/api/store.js";

test("memory store: artifact sourceEventId uniqueness is tenant-scoped", async () => {
  const store = createStore({ persistenceDir: null });

  const base = {
    jobId: "job_shared_id",
    artifactType: "WorkCertificate.v1",
    sourceEventId: "evt_shared"
  };

  await store.putArtifact({ tenantId: "tenant_a", artifact: { ...base, tenantId: "tenant_a", artifactId: "a1", artifactHash: "hash_a" } });
  await store.putArtifact({ tenantId: "tenant_b", artifact: { ...base, tenantId: "tenant_b", artifactId: "b1", artifactHash: "hash_b" } });

  const a = await store.listArtifacts({ tenantId: "tenant_a", jobId: "job_shared_id" });
  const b = await store.listArtifacts({ tenantId: "tenant_b", jobId: "job_shared_id" });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].artifactHash, "hash_a");
  assert.equal(b[0].artifactHash, "hash_b");
});

