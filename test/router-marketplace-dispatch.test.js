import test from "node:test";
import assert from "node:assert/strict";

import { buildRouterMarketplaceDispatchV1 } from "../src/core/router-marketplace-dispatch.js";

test("router marketplace dispatch builder emits deterministic dispatch hash", () => {
  const input = {
    dispatchId: "rdispatch_demo_1",
    launchRef: {
      launchId: "rlaunch_demo_1",
      launchHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      planId: "rplan_demo_1",
      planHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requestTextSha256: "1111111111111111111111111111111111111111111111111111111111111111"
    },
    tenantId: "tenant_default",
    posterAgentId: "agt_router_poster",
    selectionStrategy: "lowest_amount_then_eta",
    allowOverBudget: false,
    tasks: [
      {
        taskId: "t_test",
        taskIndex: 2,
        rfqId: "rfq_test_1",
        dependsOnTaskIds: ["t_implement"],
        state: "blocked_dependencies_pending",
        reasonCode: "ROUTER_DISPATCH_DEPENDENCIES_PENDING",
        rfqStatus: "open",
        acceptedBidId: null,
        runId: null,
        decisionHash: null,
        blockingTaskIds: ["t_implement"]
      },
      {
        taskId: "t_implement",
        taskIndex: 1,
        rfqId: "rfq_implement_1",
        dependsOnTaskIds: [],
        state: "accepted",
        reasonCode: null,
        rfqStatus: "assigned",
        acceptedBidId: "bid_implement_1",
        runId: "run_rfq_implement_1_bid_implement_1",
        decisionHash: "2222222222222222222222222222222222222222222222222222222222222222",
        blockingTaskIds: []
      }
    ],
    metadata: {
      requestedTaskIds: ["t_test", "t_implement"]
    },
    dispatchedAt: "2026-03-05T19:00:00.000Z"
  };

  const first = buildRouterMarketplaceDispatchV1(input);
  const second = buildRouterMarketplaceDispatchV1(input);

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, "RouterMarketplaceDispatch.v1");
  assert.equal(first.acceptedCount, 1);
  assert.equal(first.blockedCount, 1);
  assert.equal(first.noopCount, 0);
  assert.equal(first.tasks[0].schemaVersion, "RouterMarketplaceDispatchTask.v1");
  assert.deepEqual(first.tasks[0].dependsOnTaskIds, ["t_implement"]);
  assert.match(first.dispatchHash, /^[0-9a-f]{64}$/);
});
