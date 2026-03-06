import test from "node:test";
import assert from "node:assert/strict";

import { buildRouterLaunchStatusV1 } from "../src/core/router-launch-status.js";

test("buildRouterLaunchStatusV1 is deterministic and summarizes task lifecycle", () => {
  const input = {
    launchRef: {
      launchId: "rlaunch_status_demo_1",
      launchHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      planId: "rplan_status_demo_1",
      planHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requestTextSha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
    },
    tenantId: "tenant_default",
    posterAgentId: "agt_status_poster",
    generatedAt: "2030-01-01T00:00:00.000Z",
    tasks: [
      {
        taskId: "t_implement",
        taskIndex: 1,
        rfqId: "rfq_status_implement",
        title: "Implement feature",
        requiredCapability: "capability://code.generation",
        dependsOnTaskIds: [],
        candidateAgentIds: ["agt_worker_a"],
        candidateCount: 1,
        state: "closed",
        blockedByTaskIds: [],
        rfqStatus: "closed",
        bidCount: 2,
        acceptedBidId: "bid_status_implement",
        runId: "run_status_implement",
        settlementStatus: "released",
        disputeStatus: null,
        rfq: { rfqId: "rfq_status_implement", status: "closed" },
        bids: [{ bidId: "bid_status_implement" }],
        acceptedBid: { bidId: "bid_status_implement" },
        run: { runId: "run_status_implement", status: "completed" },
        settlement: { status: "released" }
      },
      {
        taskId: "t_test",
        taskIndex: 2,
        rfqId: "rfq_status_test",
        title: "Run tests",
        requiredCapability: "capability://code.test.run",
        dependsOnTaskIds: ["t_implement"],
        candidateAgentIds: ["agt_worker_a"],
        candidateCount: 1,
        state: "open_ready",
        blockedByTaskIds: [],
        rfqStatus: "open",
        bidCount: 1,
        acceptedBidId: null,
        runId: null,
        settlementStatus: null,
        disputeStatus: null,
        rfq: { rfqId: "rfq_status_test", status: "open" },
        bids: [{ bidId: "bid_status_test" }],
        acceptedBid: null,
        run: null,
        settlement: null
      }
    ]
  };

  const first = buildRouterLaunchStatusV1(input);
  const second = buildRouterLaunchStatusV1(input);

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, "RouterLaunchStatus.v1");
  assert.equal(first.tasks[0].schemaVersion, "RouterLaunchStatusTask.v1");
  assert.equal(first.summary.closedCount, 1);
  assert.equal(first.summary.readyCount, 1);
  assert.equal(first.summary.openCount, 1);
  assert.equal(first.summary.settlementReleasedCount, 1);
  assert.match(first.statusHash, /^[0-9a-f]{64}$/);
});
