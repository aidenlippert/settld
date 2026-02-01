import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: artifact cursor preserves microsecond precision (no gaps across pages)", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = "tenant_default";
  const jobId = `job_${schema}`;

  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  try {
    // Insert two artifacts with created_at in the same millisecond but different microseconds.
    // If cursor createdAt is truncated to milliseconds, the second row will be skipped by the seek predicate.
    const createdAtNewer = "2026-01-01T00:00:00.123789Z";
    const createdAtOlder = "2026-01-01T00:00:00.123456Z";

    const insert = async ({ artifactId, artifactHash, sourceEventId, createdAt }) => {
      const artifactJson = {
        artifactType: "WorkCertificate.v1",
        artifactId,
        artifactHash,
        tenantId,
        jobId,
        sourceEventId,
        atChainHash: "ch_1",
        schemaVersion: "WorkCertificate.v1",
        generatedAt: createdAt
      };
      await store.pg.pool.query(
        `
          INSERT INTO artifacts (tenant_id, artifact_id, artifact_type, job_id, at_chain_hash, source_event_id, artifact_hash, artifact_json, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)
        `,
        [tenantId, artifactId, "WorkCertificate.v1", jobId, "ch_1", sourceEventId, artifactHash, artifactJson, createdAt]
      );
    };

    await insert({ artifactId: "a_newer", artifactHash: "h_newer", sourceEventId: "evt_newer", createdAt: createdAtNewer });
    await insert({ artifactId: "a_older", artifactHash: "h_older", sourceEventId: "evt_older", createdAt: createdAtOlder });

    const firstPage = await store.listArtifacts({ tenantId, jobId, includeDbMeta: true, limit: 1, offset: 0 });
    assert.equal(firstPage.length, 1);
    assert.equal(firstPage[0].artifact.artifactId, "a_newer");
    assert.equal(firstPage[0].db.createdAt, "2026-01-01T00:00:00.123789Z");

    const cursor = { createdAt: firstPage[0].db.createdAt, artifactId: firstPage[0].db.artifactId };
    const secondPage = await store.listArtifacts({
      tenantId,
      jobId,
      includeDbMeta: true,
      beforeCreatedAt: cursor.createdAt,
      beforeArtifactId: cursor.artifactId,
      limit: 1,
      offset: 0
    });
    assert.equal(secondPage.length, 1);
    assert.equal(secondPage[0].artifact.artifactId, "a_older");
    assert.equal(secondPage[0].db.createdAt, "2026-01-01T00:00:00.123456Z");
  } finally {
    await store.close();
  }
});

