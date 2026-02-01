import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: artifact sourceEventId uniqueness is tenant-scoped", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  try {
    const base = {
      jobId: "job_shared_id",
      artifactType: "WorkCertificate.v1",
      sourceEventId: "evt_shared",
      atChainHash: "ch_1"
    };

    await store.putArtifact({ tenantId: "tenant_a", artifact: { ...base, tenantId: "tenant_a", artifactId: "a1", artifactHash: "hash_a" } });
    await store.putArtifact({ tenantId: "tenant_b", artifact: { ...base, tenantId: "tenant_b", artifactId: "b1", artifactHash: "hash_b" } });

    const a = await store.listArtifacts({
      tenantId: "tenant_a",
      jobId: "job_shared_id",
      artifactType: "WorkCertificate.v1",
      sourceEventId: "evt_shared",
      limit: 10,
      offset: 0
    });
    const b = await store.listArtifacts({
      tenantId: "tenant_b",
      jobId: "job_shared_id",
      artifactType: "WorkCertificate.v1",
      sourceEventId: "evt_shared",
      limit: 10,
      offset: 0
    });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].artifactHash, "hash_a");
    assert.equal(b[0].artifactHash, "hash_b");
  } finally {
    await store.close();
  }
});

