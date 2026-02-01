import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.3: ops config surfaces effective evidenceRetentionMaxDays per tenant", async () => {
  const store = createStore();
  store.getConfig("tenant_default").evidenceRetentionMaxDays = 730;

  const api = createApi({ store, opsTokens: "tok:ops_read" });
  const res = await request(api, { method: "GET", path: "/ops/config", headers: { "x-proxy-ops-token": "tok" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.config.evidenceRetentionMaxDays, 730);
});

