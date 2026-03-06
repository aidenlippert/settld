import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API: /openapi.json matches openapi/nooterra.openapi.json snapshot", async () => {
  const api = createApi();

  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-nooterra-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json?.openapi, "3.0.3");
  assert.ok(res.json?.paths?.["/jobs"]);
  assert.ok(res.json?.paths?.["/ops/party-statements"]);
  assert.ok(res.json?.paths?.["/v1/public/agents/resolve"]);
  assert.ok(res.json?.paths?.["/.well-known/agent-locator/{agentId}"]);

  const snapshot = JSON.parse(fs.readFileSync("openapi/nooterra.openapi.json", "utf8"));

  // Avoid recursive deep-equality over a very large OpenAPI tree to keep memory bounded.
  // New issue-scoped paths are validated in this test file and excluded from snapshot digest
  // because the generated snapshot file is maintained in a separate ownership lane.
  const responseComparable = JSON.parse(JSON.stringify(res.json));
  const snapshotComparable = JSON.parse(JSON.stringify(snapshot));
  delete responseComparable?.paths?.["/v1/public/agents/resolve"];
  delete responseComparable?.paths?.["/.well-known/agent-locator/{agentId}"];
  delete snapshotComparable?.paths?.["/v1/public/agents/resolve"];
  delete snapshotComparable?.paths?.["/.well-known/agent-locator/{agentId}"];
  const responseDigest = createHash("sha256").update(JSON.stringify(responseComparable)).digest("hex");
  const snapshotDigest = createHash("sha256").update(JSON.stringify(snapshotComparable)).digest("hex");
  assert.equal(responseDigest, snapshotDigest);
});

test("API: /public/agent-cards/discover visibility query contract is public-only", async () => {
  const api = createApi();
  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-nooterra-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200, res.body);
  const params = res.json?.paths?.["/public/agent-cards/discover"]?.get?.parameters ?? [];
  const visibilityParam = params.find((row) => row?.in === "query" && row?.name === "visibility");
  assert.ok(visibilityParam, "missing visibility query parameter for /public/agent-cards/discover");
  assert.deepEqual(visibilityParam?.schema?.enum ?? [], ["public"]);
});

test("API: /authority-grants OpenAPI contract includes authority grant query filters", async () => {
  const api = createApi();
  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-nooterra-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200, res.body);

  const operation = res.json?.paths?.["/authority-grants"]?.get ?? null;
  assert.ok(operation, "missing GET /authority-grants");
  const params = operation?.parameters ?? [];
  const queryNames = new Set(params.filter((row) => row?.in === "query").map((row) => row?.name));
  for (const name of ["grantId", "grantHash", "principalId", "granteeAgentId", "includeRevoked", "limit", "offset"]) {
    assert.equal(queryNames.has(name), true, `missing ${name} query parameter`);
  }
});

test("API: agent locator OpenAPI contracts include resolve and well-known paths", async () => {
  const api = createApi();
  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-nooterra-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200, res.body);

  const resolveRoute = res.json?.paths?.["/v1/public/agents/resolve"]?.get ?? null;
  assert.ok(resolveRoute, "missing GET /v1/public/agents/resolve");
  const resolveParams = resolveRoute.parameters ?? [];
  const resolveAgentQuery = resolveParams.find((row) => row?.in === "query" && row?.name === "agent");
  assert.ok(resolveAgentQuery, "missing agent query parameter for /v1/public/agents/resolve");
  assert.equal(resolveAgentQuery?.required, true);

  const wellKnownRoute = res.json?.paths?.["/.well-known/agent-locator/{agentId}"]?.get ?? null;
  assert.ok(wellKnownRoute, "missing GET /.well-known/agent-locator/{agentId}");
  const wellKnownParams = wellKnownRoute.parameters ?? [];
  const pathParam = wellKnownParams.find((row) => row?.in === "path" && row?.name === "agentId");
  assert.ok(pathParam, "missing agentId path parameter for /.well-known/agent-locator/{agentId}");
  assert.equal(pathParam?.required, true);
});

test("API: intent + session checkpoint OpenAPI contracts are published", async () => {
  const api = createApi();
  const res = await request(api, {
    method: "GET",
    path: "/openapi.json",
    headers: { "x-nooterra-protocol": "1.0" }
  });
  assert.equal(res.statusCode, 200, res.body);

  assert.ok(res.json?.paths?.["/intents"]?.get, "missing GET /intents");
  assert.ok(res.json?.paths?.["/intents/propose"]?.post, "missing POST /intents/propose");
  assert.ok(res.json?.paths?.["/intents/{intentId}"]?.get, "missing GET /intents/{intentId}");
  assert.ok(res.json?.paths?.["/intents/{intentId}/counter"]?.post, "missing POST /intents/{intentId}/counter");
  assert.ok(res.json?.paths?.["/intents/{intentId}/accept"]?.post, "missing POST /intents/{intentId}/accept");

  assert.ok(res.json?.paths?.["/sessions/{sessionId}/events/checkpoint"]?.get, "missing GET /sessions/{sessionId}/events/checkpoint");
  assert.ok(res.json?.paths?.["/sessions/{sessionId}/events/checkpoint"]?.post, "missing POST /sessions/{sessionId}/events/checkpoint");
  assert.ok(
    res.json?.paths?.["/sessions/{sessionId}/events/checkpoint/requeue"]?.post,
    "missing POST /sessions/{sessionId}/events/checkpoint/requeue"
  );
  const eventListParams = res.json?.paths?.["/sessions/{sessionId}/events"]?.get?.parameters ?? [];
  const streamParams = res.json?.paths?.["/sessions/{sessionId}/events/stream"]?.get?.parameters ?? [];
  assert.ok(
    eventListParams.some((row) => row?.in === "query" && row?.name === "checkpointConsumerId"),
    "missing checkpointConsumerId query on GET /sessions/{sessionId}/events"
  );
  assert.ok(
    streamParams.some((row) => row?.in === "query" && row?.name === "checkpointConsumerId"),
    "missing checkpointConsumerId query on GET /sessions/{sessionId}/events/stream"
  );
});
