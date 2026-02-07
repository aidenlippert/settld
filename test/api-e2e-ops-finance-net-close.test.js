import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { computeArtifactHash } from "../src/core/artifacts.js";
import { request } from "./api-test-harness.js";

test("API e2e: /ops/finance/net-close is deterministic and detects held-rollforward drift", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const period = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month: period }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const first = await request(api, {
    method: "GET",
    path: `/ops/finance/net-close?period=${encodeURIComponent(period)}`,
    headers: financeReadHeaders
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json?.ok, true);
  assert.equal(first.json?.status, "pass");
  assert.deepEqual(first.json?.mismatchCodes, []);

  const replay = await request(api, {
    method: "GET",
    path: `/ops/finance/net-close?period=${encodeURIComponent(period)}`,
    headers: financeReadHeaders
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json, first.json);

  const persisted = await request(api, {
    method: "GET",
    path: `/ops/finance/net-close?period=${encodeURIComponent(period)}&persist=true`,
    headers: financeWriteHeaders
  });
  assert.equal(persisted.statusCode, 200);
  assert.equal(typeof persisted.json?.artifact?.artifactId, "string");
  assert.equal(typeof persisted.json?.artifact?.artifactHash, "string");

  const tamperedHeldRollforwardCore = {
    schemaVersion: "HeldExposureRollforward.v1",
    artifactType: "HeldExposureRollforward.v1",
    artifactId: `held_roll_manual_mismatch_${period}`,
    generatedAt: "2026-03-01T00:00:00.000Z",
    tenantId,
    period,
    basis: "settledAt",
    eventProof: {
      lastChainHash: "hash_manual_mismatch",
      eventCount: 1,
      signatures: {
        signedEventCount: 0,
        signerKeyIds: []
      }
    },
    rollforward: {
      schemaVersion: "HeldExposureRollforwardReport.v1",
      period,
      basis: "settledAt",
      buckets: {
        opening: {
          holdCount: 1,
          byCurrency: { USD: { holdCount: 1, amountGrossCents: 500, amountNetCents: 500, coverageFeeCents: 0 } }
        },
        newHolds: { holdCount: 0, byCurrency: {} },
        released: { holdCount: 0, byCurrency: {} },
        forfeited: { holdCount: 0, byCurrency: {} },
        ending: {
          holdCount: 1,
          byCurrency: { USD: { holdCount: 1, amountGrossCents: 500, amountNetCents: 500, coverageFeeCents: 0 } }
        }
      }
    },
    holds: []
  };
  await api.store.putArtifact({
    tenantId,
    artifact: {
      ...tamperedHeldRollforwardCore,
      artifactHash: computeArtifactHash(tamperedHeldRollforwardCore)
    }
  });

  const drift = await request(api, {
    method: "GET",
    path: `/ops/finance/net-close?period=${encodeURIComponent(period)}`,
    headers: financeReadHeaders
  });
  assert.equal(drift.statusCode, 200);
  assert.equal(drift.json?.status, "fail");
  assert.ok(Array.isArray(drift.json?.mismatchCodes));
  assert.ok(drift.json.mismatchCodes.includes("HELD_ROLLFORWARD_LEDGER_MISMATCH"));

  const driftReplay = await request(api, {
    method: "GET",
    path: `/ops/finance/net-close?period=${encodeURIComponent(period)}`,
    headers: financeReadHeaders
  });
  assert.equal(driftReplay.statusCode, 200);
  assert.deepEqual(driftReplay.json, drift.json);
});

