import test from "node:test";
import assert from "node:assert/strict";

import { createAckWorker } from "../services/receiver/src/ack-worker.js";
import { SETTLD_PROTOCOL_CURRENT } from "../src/core/protocol.js";

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test("receiver: ACK includes x-settld-protocol", async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 204,
      headers: { get: (k) => (String(k).toLowerCase() === "x-settld-protocol" ? SETTLD_PROTOCOL_CURRENT : null) },
      text: async () => ""
    };
  };

  let acked = false;
  const dedupeStore = {
    listPendingAcks() {
      if (acked) return [];
      return [{ dedupeKey: "dedupe_1", artifactHash: "hash_1", deliveryId: "deliv_1", ackAttempts: 0 }];
    },
    async markAckResult({ ok }) {
      if (ok) acked = true;
    }
  };

  const worker = createAckWorker({
    cfg: {
      ackUrl: "http://127.0.0.1:9999/exports/ack",
      tenantId: "tenant_default",
      destinationId: "dst_test",
      hmacSecret: "secret_test",
      ack: { timeoutMs: 0, maxInflight: 1, retryMax: 1 }
    },
    dedupeStore,
    fetchFn
  });

  worker.start();
  const ok = await waitFor(() => calls.length >= 1);
  worker.stop();

  assert.equal(ok, true, "expected fetch to be called");
  const hdrs = calls[0]?.options?.headers ?? {};
  assert.equal(hdrs["x-settld-protocol"], SETTLD_PROTOCOL_CURRENT);
});
