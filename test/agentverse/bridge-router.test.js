import test from "node:test";
import assert from "node:assert/strict";

import { createBridgeApis } from "../../src/agentverse/bridge/index.js";

test("router bridge routes plan, launch, and dispatch through the shared client", async () => {
  const calls = [];
  const apis = createBridgeApis({
    baseUrl: "http://127.0.0.1:3000",
    protocol: "1.0",
    tenantId: "tenant_default",
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method ?? "GET",
        headers: { ...(options.headers ?? {}) },
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        status: 200,
        async text() {
          return "{}";
        }
      };
    }
  });

  await apis.router.plan({ text: "Plan this" });
  await apis.router.launch({ text: "Launch this", posterAgentId: "agt_router_poster" }, { idempotencyKey: "idem_router_launch" });
  await apis.router.dispatch({ launchId: "rlaunch_demo_1", acceptedByAgentId: "agt_router_operator" }, { idempotencyKey: "idem_router_dispatch" });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/router\/plan$/);
  assert.deepEqual(calls[0].body, { text: "Plan this" });

  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /\/router\/launch$/);
  assert.equal(calls[1].headers["x-idempotency-key"], "idem_router_launch");
  assert.deepEqual(calls[1].body, { text: "Launch this", posterAgentId: "agt_router_poster" });

  assert.equal(calls[2].method, "POST");
  assert.match(calls[2].url, /\/router\/dispatch$/);
  assert.equal(calls[2].headers["x-idempotency-key"], "idem_router_dispatch");
  assert.deepEqual(calls[2].body, { launchId: "rlaunch_demo_1", acceptedByAgentId: "agt_router_operator" });
});
