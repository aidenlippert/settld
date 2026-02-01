import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/api/store.js";

test("memory store: putArtifact enforces one artifact per (jobId + artifactType + sourceEventId)", async () => {
  const store = createStore({ persistenceDir: null });
  const tenantId = "tenant_default";

  const base = {
    tenantId,
    jobId: "job_1",
    artifactType: "WorkCertificate.v1",
    sourceEventId: "evt_1"
  };

  await store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_1", artifactHash: "hash_1" } });

  const same = await store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_2", artifactHash: "hash_1" } });
  assert.equal(same?.artifactId ?? same?.id ?? null, "a_1");

  await assert.rejects(
    () => store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_3", artifactHash: "hash_2" } }),
    (err) => err?.code === "ARTIFACT_SOURCE_EVENT_CONFLICT"
  );
});

