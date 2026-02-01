import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

function makeCursorV1({ createdAt, artifactId }) {
  const payload = { v: 1, order: "created_at_desc_artifact_id_desc", createdAt, artifactId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

test("API: /jobs/:jobId/artifacts cursor pagination is unsupported in memory store", async () => {
  const api = createApi();
  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;

  const cursor = makeCursorV1({ createdAt: "2026-01-01T00:00:00.000000Z", artifactId: "a1" });
  const res = await request(api, { method: "GET", path: `/jobs/${jobId}/artifacts?cursor=${cursor}` });
  assert.equal(res.statusCode, 501);
  assert.equal(res.json?.code, "CURSOR_PAGINATION_UNSUPPORTED");
});

test("API: /jobs/:jobId/artifacts rejects cursor+offset", async () => {
  const api = createApi();
  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;

  const cursor = makeCursorV1({ createdAt: "2026-01-01T00:00:00.000000Z", artifactId: "a1" });
  const res = await request(api, {
    method: "GET",
    path: `/jobs/${jobId}/artifacts?cursor=${cursor}&offset=0`
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.code, "INVALID_PAGINATION");
});
