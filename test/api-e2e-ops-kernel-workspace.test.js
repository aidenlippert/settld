import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: ops kernel workspace renders receipt explorer controls", async () => {
  const api = createApi({
    opsTokens: ["tok_opsr:ops_read", "tok_opsw:ops_write", "tok_aud:audit_read"].join(";")
  });

  const workspace = await request(api, {
    method: "GET",
    path: "/ops/kernel/workspace",
    headers: {
      "x-proxy-tenant-id": "tenant_kernel_workspace",
      "x-proxy-ops-token": "tok_opsr"
    },
    auth: "none"
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  assert.ok(String(workspace.headers?.get("content-type") ?? "").includes("text/html"));
  assert.match(workspace.body, /Kernel Explorer/);
  assert.match(workspace.body, /id="runIdInput"/);
  assert.match(workspace.body, /id="agreementIdInput"/);
  assert.match(workspace.body, /id="receiptIdInput"/);
  assert.match(workspace.body, /id="loadReceiptBtn"/);
  assert.match(workspace.body, /id="receiptDecisionRecord"/);
  assert.match(workspace.body, /id="receiptSettlementReceipt"/);
  assert.match(workspace.body, /id="receiptLinks"/);
  assert.match(workspace.body, /\/x402\/receipts\/\$\{encodeURIComponent\(receiptId\)\}/);
  assert.match(workspace.body, /\/x402\/receipts\?/);
  assert.match(workspace.body, /x-nooterra-protocol/);

  const workspaceWithQueryAuth = await request(api, {
    method: "GET",
    path: "/ops/kernel/workspace?tenantId=tenant_kernel_workspace&opsToken=tok_opsr",
    headers: {},
    auth: "none"
  });
  assert.equal(workspaceWithQueryAuth.statusCode, 403, workspaceWithQueryAuth.body);

  const forbidden = await request(api, {
    method: "GET",
    path: "/ops/kernel/workspace?tenantId=tenant_kernel_workspace&opsToken=tok_aud",
    headers: {},
    auth: "none"
  });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});
