import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("protocol: missing header rejected when required", async () => {
  const api = createApi({ protocol: { requireHeader: true } });
  const res = await request(api, { method: "POST", path: "/ingest/proxy", auth: "none" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.code, "PROTOCOL_VERSION_REQUIRED");
});

test("protocol: too old rejected with 426", async () => {
  const api = createApi({ protocol: { requireHeader: true, min: "1.0", max: "1.0" } });
  const res = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    auth: "none",
    headers: { "x-settld-protocol": "0.9" }
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json?.code, "PROTOCOL_TOO_OLD");
});

test("protocol: too new rejected", async () => {
  const api = createApi({ protocol: { requireHeader: true, min: "1.0", max: "1.0" } });
  const res = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    auth: "none",
    headers: { "x-settld-protocol": "2.0" }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.code, "PROTOCOL_TOO_NEW");
});

test("protocol: deprecated protocol rejected with 426", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-proto-"));
  const fp = path.join(dir, "deprecations.json");
  await fs.writeFile(fp, JSON.stringify({ "1.0": { cutoff: "2026-01-01T00:00:00.000Z" } }), "utf8");

  const api = createApi({
    now: () => "2026-02-01T00:00:00.000Z",
    protocol: { requireHeader: true, min: "1.0", max: "1.0", deprecationsPath: fp }
  });
  const res = await request(api, {
    method: "POST",
    path: "/ingest/proxy",
    auth: "none",
    headers: { "x-settld-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json?.code, "PROTOCOL_DEPRECATED");
});

test("capabilities: advertises supported versions and emits protocol headers", async () => {
  const api = createApi({ protocol: { requireHeader: true, min: "1.0", max: "1.0" } });
  const res = await request(api, { method: "GET", path: "/capabilities" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json?.ok, true);
  assert.equal(res.json?.protocol?.current, "1.0");
  assert.equal(res.headers?.get?.("x-settld-protocol"), "1.0");
  assert.ok(Array.isArray(res.json?.events?.schemaVersionsByType?.JOB_CREATED));
  assert.ok(Array.isArray(res.json?.artifacts?.supportedTypes));
});

test("append: missing protocol header rejected when required", async () => {
  const api = createApi({ protocol: { requireHeader: true } });
  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_proto_1" },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;

  const res = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    body: { type: "MATCHED", actor: { type: "system", id: "proxy" }, payload: { robotId: "rob_1" } }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.code, "PROTOCOL_VERSION_REQUIRED");
});

test("append: unsupported event schemaVersion rejected", async () => {
  const api = createApi({ protocol: { requireHeader: true } });
  const createJob = await request(api, {
    method: "POST",
    path: "/jobs",
    headers: { "x-idempotency-key": "job_proto_2" },
    body: { templateId: "reset_lite", constraints: {} }
  });
  assert.equal(createJob.statusCode, 201);
  const jobId = createJob.json.job.id;

  const res = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-settld-protocol": "1.0" },
    body: { schemaVersion: 2, type: "MATCHED", actor: { type: "system", id: "proxy" }, payload: { robotId: "rob_1" } }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json?.code, "UNSUPPORTED_EVENT_VERSION");
});

