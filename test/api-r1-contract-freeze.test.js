import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenApiSpec } from "../src/api/openapi.js";

function assertOperation(spec, path, method, { scopes = null } = {}) {
  const op = spec?.paths?.[path]?.[method] ?? null;
  assert.ok(op, `missing operation ${method.toUpperCase()} ${path}`);
  if (scopes) {
    const gotScopes = op["x-settld-scopes"] ?? [];
    assert.deepEqual(gotScopes, scopes, `scope mismatch for ${method.toUpperCase()} ${path}`);
  }
}

function assertObjectSchema(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object schema`);
}

test("R1 API contract freeze: required operations remain published", () => {
  const spec = buildOpenApiSpec();
  assert.equal(spec?.openapi, "3.0.3");

  assertOperation(spec, "/agents/register", "post");
  assertOperation(spec, "/agents/{agentId}/wallet/credit", "post");
  assertOperation(spec, "/agents/{agentId}/runs", "post");
  assertOperation(spec, "/agents/{agentId}/runs/{runId}/events", "post");

  assertOperation(spec, "/marketplace/rfqs", "post");
  assertOperation(spec, "/marketplace/rfqs", "get");
  assertOperation(spec, "/marketplace/rfqs/{rfqId}/bids", "post");
  assertOperation(spec, "/marketplace/rfqs/{rfqId}/accept", "post");

  assertOperation(spec, "/runs/{runId}/settlement", "get");
  assertOperation(spec, "/runs/{runId}/settlement/policy-replay", "get");
  assertOperation(spec, "/runs/{runId}/settlement/resolve", "post");
  assertOperation(spec, "/runs/{runId}/dispute/open", "post");
  assertOperation(spec, "/runs/{runId}/dispute/close", "post");
  assertOperation(spec, "/runs/{runId}/dispute/evidence", "post");
  assertOperation(spec, "/runs/{runId}/dispute/escalate", "post");
  assertOperation(spec, "/ops/tool-calls/replay-evaluate", "get", { scopes: ["ops_read"] });

  assertOperation(spec, "/ops/payouts/{partyId}/{period}/enqueue", "post", { scopes: ["finance_write"] });
  assertOperation(spec, "/ops/money-rails/{providerId}/operations/{operationId}", "get", { scopes: ["finance_read"] });
  assertOperation(spec, "/ops/money-rails/{providerId}/operations/{operationId}/cancel", "post", { scopes: ["finance_write"] });
});

test("R1 API contract freeze: dispute lifecycle semantics remain encoded", () => {
  const spec = buildOpenApiSpec();

  const acceptRequest =
    spec?.paths?.["/marketplace/rfqs/{rfqId}/accept"]?.post?.requestBody?.content?.["application/json"]?.schema ?? null;
  assertObjectSchema(acceptRequest, "accept request");
  assert.ok(
    Object.prototype.hasOwnProperty.call(acceptRequest.properties ?? {}, "disputeWindowDays"),
    "accept request must expose disputeWindowDays"
  );

  const disputeOpen = spec?.paths?.["/runs/{runId}/dispute/open"]?.post ?? null;
  assertObjectSchema(disputeOpen, "dispute open operation");
  assert.match(
    String(disputeOpen.summary ?? ""),
    /within dispute window/i,
    "dispute open summary must document dispute-window gating"
  );
  assert.ok(disputeOpen.responses?.["409"], "dispute open must publish 409 conflict response");

  const disputeOpenResponse =
    disputeOpen?.responses?.["200"]?.content?.["application/json"]?.schema?.properties?.settlement ?? null;
  assertObjectSchema(disputeOpenResponse, "dispute open settlement schema");
  const settlementProperties = disputeOpenResponse.properties ?? {};
  assert.ok(
    Object.prototype.hasOwnProperty.call(settlementProperties, "disputeWindowDays"),
    "settlement schema must include disputeWindowDays"
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(settlementProperties, "disputeWindowEndsAt"),
    "settlement schema must include disputeWindowEndsAt"
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(settlementProperties, "disputeStatus"),
    "settlement schema must include disputeStatus"
  );
  assert.ok(
    Array.isArray(settlementProperties.decisionStatus?.enum) &&
      settlementProperties.decisionStatus.enum.includes("manual_review_required") &&
      settlementProperties.decisionStatus.enum.includes("manual_resolved"),
    "settlement decisionStatus enum must include manual review lifecycle states"
  );

  const disputeCloseRequest =
    spec?.paths?.["/runs/{runId}/dispute/close"]?.post?.requestBody?.content?.["application/json"]?.schema ?? null;
  assertObjectSchema(disputeCloseRequest, "dispute close request");
  assert.ok(
    Object.prototype.hasOwnProperty.call(disputeCloseRequest.properties ?? {}, "resolution"),
    "dispute close request must support structured resolution payloads"
  );
});
