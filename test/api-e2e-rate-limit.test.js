import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: rate limiting returns 429 with Retry-After", async () => {
  const api = createApi({ rateLimitRpm: 1, rateLimitBurst: 2 });

  assert.equal((await request(api, { method: "GET", path: "/jobs" })).statusCode, 200);
  assert.equal((await request(api, { method: "GET", path: "/jobs" })).statusCode, 200);

  const limited = await request(api, { method: "GET", path: "/jobs" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json.error, "rate limit exceeded");
  assert.ok(limited.headers?.get?.("retry-after"));
});
