import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API: /openapi.json matches openapi/settld.openapi.json snapshot", async () => {
  const api = createApi();

  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-settld-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json?.openapi, "3.0.3");
  assert.ok(res.json?.paths?.["/jobs"]);
  assert.ok(res.json?.paths?.["/ops/party-statements"]);

  const snapshot = JSON.parse(fs.readFileSync("openapi/settld.openapi.json", "utf8"));
  assert.deepEqual(res.json, snapshot);
});

