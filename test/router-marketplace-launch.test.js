import test from "node:test";
import assert from "node:assert/strict";

import { buildRouterMarketplaceLaunchV1 } from "../src/core/router-marketplace-launch.js";

test("router marketplace launch builder emits deterministic launch hash", () => {
  const input = {
    launchId: "rlaunch_demo_1",
    tenantId: "tenant_default",
    posterAgentId: "agt_poster_1",
    scope: "public",
    request: {
      text: "Implement the feature and make tests pass.",
      asOf: "2026-03-05T18:00:00.000Z"
    },
    planRef: {
      planId: "rplan_demo_1",
      planHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    tasks: [
      {
        taskId: "t_implement",
        title: "Implement changes",
        requiredCapability: "capability://code.generation",
        rfqId: "rfq_implement_1",
        dependsOnTaskIds: [],
        budgetCents: 5000,
        currency: "usd",
        deadlineAt: "2026-03-06T00:00:00.000Z",
        candidateCount: 2,
        candidateAgentIds: ["agt_worker_1", "agt_worker_2"]
      }
    ],
    metadata: {
      source: "ask-network"
    },
    createdAt: "2026-03-05T18:00:01.000Z"
  };

  const first = buildRouterMarketplaceLaunchV1(input);
  const second = buildRouterMarketplaceLaunchV1(input);

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, "RouterMarketplaceLaunch.v1");
  assert.equal(first.taskCount, 1);
  assert.equal(first.tasks[0].schemaVersion, "RouterMarketplaceLaunchTask.v1");
  assert.equal(first.tasks[0].currency, "USD");
  assert.match(first.launchHash, /^[0-9a-f]{64}$/);
});
