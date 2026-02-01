import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: listArtifacts seek pagination (created_at, artifact_id) has no gaps or duplicates", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = "tenant_default";
  const jobId = `job_${schema}`;

  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  try {
    // Insert a bunch of artifacts for one job.
    for (let i = 0; i < 25; i += 1) {
      await store.putArtifact({
        tenantId,
        artifact: {
          tenantId,
          jobId,
          artifactType: "WorkCertificate.v1",
          artifactId: `a_${String(i).padStart(3, "0")}`,
          artifactHash: `hash_${i}`,
          atChainHash: `ch_${i}`,
          sourceEventId: `evt_${i}`
        }
      });
    }

    const all = await store.listArtifacts({ tenantId, jobId, includeDbMeta: true, limit: 200, offset: 0 });
    assert.equal(all.length, 25);
    const allIds = all.map((r) => r.artifact.artifactId);

    const pageSize = 7;
    const seen = [];
    let cursor = null;
    for (;;) {
      const page = await store.listArtifacts({
        tenantId,
        jobId,
        includeDbMeta: true,
        beforeCreatedAt: cursor?.createdAt ?? null,
        beforeArtifactId: cursor?.artifactId ?? null,
        limit: pageSize,
        offset: 0
      });
      for (const row of page) seen.push(row.artifact.artifactId);
      if (page.length < pageSize) break;
      const last = page[page.length - 1];
      cursor = { createdAt: last.db.createdAt, artifactId: last.db.artifactId };
    }

    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
    assert.deepEqual(seen, allIds);
  } finally {
    await store.close();
  }
});

