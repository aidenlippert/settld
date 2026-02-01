import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: putArtifact enforces one artifact per (jobId + artifactType + sourceEventId)", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = "tenant_default";
  const jobId = `job_${schema}`;

  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  try {
    const base = {
      tenantId,
      jobId,
      artifactType: "WorkCertificate.v1",
      sourceEventId: "evt_1",
      atChainHash: "ch_1"
    };

    await store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_1", artifactHash: "hash_1" } });

    // Same (jobId + type + sourceEventId) with same hash should be idempotent.
    await store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_2", artifactHash: "hash_1" } });
    const artifacts = await store.listArtifacts({ tenantId, jobId, artifactType: "WorkCertificate.v1", sourceEventId: "evt_1", limit: 10, offset: 0 });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].artifactHash, "hash_1");

    await assert.rejects(
      () => store.putArtifact({ tenantId, artifact: { ...base, artifactId: "a_3", artifactHash: "hash_2" } }),
      (err) => err?.code === "ARTIFACT_SOURCE_EVENT_CONFLICT"
    );
  } finally {
    await store.close();
  }
});

