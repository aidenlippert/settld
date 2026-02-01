import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";
import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg api: /jobs/:jobId/artifacts rejects unsupported cursor version", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const api = createApi({ store });
  try {
    const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;

    const cursor = Buffer.from(
      JSON.stringify({ v: 2, order: "created_at_desc_artifact_id_desc", createdAt: "2026-01-01T00:00:00.000000Z", artifactId: "a1" }),
      "utf8"
    ).toString("base64url");

    const res = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts?cursor=${cursor}&limit=5` });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.code, "INVALID_CURSOR");
  } finally {
    await store.close();
  }
});
