import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("memory store: commitTx rejects stale prevChainHash (prevents TOCTOU chain breaks)", async () => {
  const api = createApi({ now: () => "2026-01-20T00:00:00.000Z" });

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  const initialHead = created.json.job.lastChainHash;

  const appended = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": initialHead, "x-idempotency-key": `m_${jobId}` },
    // Use an event that is legal from CREATED without requiring robots/booking.
    body: { type: "QUOTE_PROPOSED", actor: { type: "pricing", id: "pricing_v0" }, payload: { note: "test" } }
  });
  assert.equal(appended.statusCode, 201);
  const newHead = appended.json.job.lastChainHash;
  assert.notEqual(newHead, initialHead);

  assert.throws(
    () => {
      api.store.commitTx({
        at: "2026-01-20T00:00:01.000Z",
        ops: [
          {
          kind: "JOB_EVENTS_APPENDED",
          tenantId: "tenant_default",
          jobId,
          events: [
            {
              v: 1,
              id: "evt_stale",
              at: "2026-01-20T00:00:01.000Z",
              streamId: jobId,
              type: "RESERVED",
              actor: { type: "system", id: "proxy" },
              payload: { robotId: "rob_x", startAt: "2026-01-20T00:00:00.000Z", endAt: "2026-01-20T01:00:00.000Z", reservationId: "rsv_x" },
              payloadHash: "fake",
              prevChainHash: initialHead, // stale
              chainHash: "fake2",
              signature: null,
              signerKeyId: null
            }
          ]
        }
      ]
    });
    },
    (err) => err?.code === "PREV_CHAIN_HASH_MISMATCH"
  );
});
