import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: sets x-request-id and echoes provided request IDs", async () => {
  const api = createApi();

  const first = await request(api, { method: "GET", path: "/jobs" });
  assert.equal(first.statusCode, 200);
  const rid1 = first.headers?.get?.("x-request-id") ?? null;
  assert.ok(typeof rid1 === "string" && rid1.trim() !== "");

  const provided = "req_test_123";
  const second = await request(api, { method: "GET", path: "/jobs", headers: { "x-request-id": provided } });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers?.get?.("x-request-id"), provided);
});

test("API e2e: /metrics exposes http_requests_total", async () => {
  const api = createApi();

  assert.equal((await request(api, { method: "GET", path: "/jobs" })).statusCode, 200);

  const metrics = await request(api, { method: "GET", path: "/metrics" });
  assert.equal(metrics.statusCode, 200);
  assert.ok(typeof metrics.body === "string");
  assert.ok(metrics.body.includes("http_requests_total"));
});

test("API e2e: /healthz is auth-exempt and returns signals", async () => {
  const api = createApi();

  const healthz = await request(api, { method: "GET", path: "/healthz", auth: "none" });
  assert.equal(healthz.statusCode, 200);
  assert.equal(healthz.json.ok, true);
  assert.equal(typeof healthz.json.dbOk, "boolean");
});

