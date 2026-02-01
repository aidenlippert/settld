import test from "node:test";
import assert from "node:assert/strict";

import { createDeliveryWorker } from "../src/api/workers/deliveries.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("worker: delivery concurrency cap is honored (by scopeKey)", async () => {
  try {
    process.env.PROXY_WORKER_CONCURRENCY_DELIVERIES = "2";
    process.env.PROXY_DELIVERY_HTTP_TIMEOUT_MS = "5000";

    let inFlight = 0;
    let maxInFlight = 0;

    const fetchFn = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(50);
      inFlight -= 1;
      return { status: 200 };
    };

    const store = {
      kind: "pg",
      metrics: { incCounter() {} },
      async getArtifact({ tenantId, artifactId }) {
        return { artifactType: "WorkCertificate.v1", artifactId, artifactHash: `hash_${tenantId}_${artifactId}` };
      },
      async claimDueDeliveries({ tenantId, maxMessages }) {
        const rows = [
          {
            id: 1,
            tenantId,
            destinationId: "dst",
            artifactType: "WorkCertificate.v1",
            artifactId: "a1",
            artifactHash: "h1",
            dedupeKey: "k1",
            scopeKey: "scope_a",
            orderSeq: 1,
            priority: 10,
            orderKey: "scope_a\n1\n10\n1",
            attempts: 1
          },
          {
            id: 2,
            tenantId,
            destinationId: "dst",
            artifactType: "WorkCertificate.v1",
            artifactId: "a2",
            artifactHash: "h2",
            dedupeKey: "k2",
            scopeKey: "scope_a",
            orderSeq: 2,
            priority: 10,
            orderKey: "scope_a\n2\n10\n2",
            attempts: 1
          },
          {
            id: 3,
            tenantId,
            destinationId: "dst",
            artifactType: "WorkCertificate.v1",
            artifactId: "b1",
            artifactHash: "h3",
            dedupeKey: "k3",
            scopeKey: "scope_b",
            orderSeq: 1,
            priority: 10,
            orderKey: "scope_b\n1\n10\n3",
            attempts: 1
          },
          {
            id: 4,
            tenantId,
            destinationId: "dst",
            artifactType: "WorkCertificate.v1",
            artifactId: "b2",
            artifactHash: "h4",
            dedupeKey: "k4",
            scopeKey: "scope_b",
            orderSeq: 2,
            priority: 10,
            orderKey: "scope_b\n2\n10\n4",
            attempts: 1
          }
        ];
        return rows.slice(0, maxMessages);
      },
      async updateDeliveryAttempt() {}
    };

    const worker = createDeliveryWorker({
      store,
      nowIso: () => new Date().toISOString(),
      listDestinationsForTenant: () => [{ destinationId: "dst", kind: "webhook", url: "http://127.0.0.1:1", secret: "secret" }],
      maxAttempts: 3,
      backoffBaseMs: 10,
      backoffMaxMs: 10,
      random: () => 0.5,
      fetchFn
    });

    const res = await worker.tickDeliveries({ tenantId: "tenant_default", maxMessages: 10 });
    assert.equal(res.processed.length, 4);
    assert.equal(maxInFlight, 2);
  } finally {
    delete process.env.PROXY_WORKER_CONCURRENCY_DELIVERIES;
    delete process.env.PROXY_DELIVERY_HTTP_TIMEOUT_MS;
  }
});
