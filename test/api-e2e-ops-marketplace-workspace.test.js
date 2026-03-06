import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: ops marketplace workspace page renders listing/RFQ/bid controls", async () => {
  const api = createApi({
    opsTokens: ["tok_opsr:ops_read", "tok_opsw:ops_write", "tok_aud:audit_read"].join(";")
  });

  const workspace = await request(api, {
    method: "GET",
    path: "/ops/marketplace/workspace",
    headers: {
      "x-proxy-tenant-id": "tenant_market_workspace",
      "x-proxy-ops-token": "tok_opsr"
    },
    auth: "none"
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.ok(String(workspace.headers?.get("content-type") ?? "").includes("text/html"));
  assert.match(workspace.body, /Marketplace Operator Workspace/);
  assert.match(workspace.body, /id="marketplaceWorkspaceRoot"/);
  assert.match(workspace.body, /id="capabilityListingTable"/);
  assert.match(workspace.body, /id="marketplaceRfqTable"/);
  assert.match(workspace.body, /id="rfqStatusFilter"/);
  assert.doesNotMatch(workspace.body, /taskStatusFilter/);
  assert.match(workspace.body, /id="marketplaceBidTable"/);
  assert.match(workspace.body, /id="createCapabilityListingBtn"/);
  assert.match(workspace.body, /id="createRfqBtn"/);
  assert.match(workspace.body, /id="submitBidBtn"/);
  assert.match(workspace.body, /id="acceptBidBtn"/);
  assert.match(workspace.body, /\/marketplace\/capability-listings/);
  assert.match(workspace.body, /\/marketplace\/rfqs/);
  assert.match(workspace.body, /\/marketplace\/rfqs\/\$\{encodeURIComponent\(rfqId\)\}\/bids/);
  assert.match(workspace.body, /\/marketplace\/rfqs\/\$\{encodeURIComponent\(rfqId\)\}\/accept/);
  assert.match(workspace.body, /x-nooterra-protocol/);

  const workspaceWithQueryAuth = await request(api, {
    method: "GET",
    path: "/ops/marketplace/workspace?tenantId=tenant_market_workspace&opsToken=tok_opsr",
    headers: {},
    auth: "none"
  });
  assert.equal(workspaceWithQueryAuth.statusCode, 403, workspaceWithQueryAuth.body);

  const forbidden = await request(api, {
    method: "GET",
    path: "/ops/marketplace/workspace?tenantId=tenant_market_workspace&opsToken=tok_aud",
    headers: {},
    auth: "none"
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});
