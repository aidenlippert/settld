import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";
import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeCursorV1({ createdAt, artifactId }) {
  const payload = { v: 1, order: "created_at_desc_artifact_id_desc", createdAt, artifactId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

(databaseUrl ? test : test.skip)("pg api: /jobs/:jobId/artifacts cursor pagination preserves microsecond precision", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const api = createApi({ store });
  try {
    const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;

    const tenantId = "tenant_default";
    const artifactType = "WorkCertificate.v1";
    const atChainHash = "ch_test";
    const hash64 = "0".repeat(64);

    await store.pg.pool.query(
      `
        INSERT INTO artifacts (
          tenant_id, artifact_id, artifact_type, job_id, at_chain_hash, source_event_id, artifact_hash, artifact_json, created_at
        ) VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9),
          ($1,$10,$3,$4,$5,$11,$7,$12,$13)
      `,
      [
        tenantId,
        "art_ms1",
        artifactType,
        jobId,
        atChainHash,
        "ev_ms1",
        hash64,
        JSON.stringify({ artifactId: "art_ms1", artifactType, jobId }),
        "2026-01-01T00:00:00.123456Z",
        "art_ms2",
        "ev_ms2",
        JSON.stringify({ artifactId: "art_ms2", artifactType, jobId }),
        "2026-01-01T00:00:00.123457Z"
      ]
    );

    const startCursor = makeCursorV1({ createdAt: "9999-12-31T23:59:59.999999Z", artifactId: "zzzzzzzz" });

    const page1 = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts?cursor=${startCursor}&limit=1` });
    assert.equal(page1.statusCode, 200);
    assert.equal(Array.isArray(page1.json?.artifacts), true);
    assert.equal(page1.json.artifacts.length, 1);
    assert.equal(page1.json.artifacts[0]?.artifactId, "art_ms2");
    assert.equal(typeof page1.json?.nextCursor, "string");
    assert.equal(page1.json?.hasMore, true);

    const page2 = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts?cursor=${page1.json.nextCursor}&limit=1` });
    assert.equal(page2.statusCode, 200);
    assert.equal(page2.json.artifacts.length, 1);
    assert.equal(page2.json.artifacts[0]?.artifactId, "art_ms1");
    assert.equal(page2.json?.hasMore, false);
    assert.equal(page2.json?.nextCursor, null);
  } finally {
    await store.close();
  }
});
