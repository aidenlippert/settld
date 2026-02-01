import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("jobs: operator policy pin is set on MATCHED and resets on reschedule", async () => {
  const api = createApi({ now: () => "2026-01-20T10:00:00.000Z" });

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_pins" } });
  assert.equal(regRobot.statusCode, 201);
  const avail = await request(api, {
    method: "POST",
    path: "/robots/rob_pins/availability",
    headers: { "x-proxy-expected-prev-chain-hash": regRobot.json.robot.lastChainHash },
    body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
  });
  assert.equal(avail.statusCode, 201);

  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;
  let lastChainHash = created.json.job.lastChainHash;

  const startAt = "2026-01-20T10:30:00.000Z";
  const endAt = "2026-01-20T11:00:00.000Z";

  const quote = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/quote`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(quote.statusCode, 201);
  lastChainHash = quote.json.job.lastChainHash;

  const book = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/book`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { paymentHoldId: `hold_${jobId}`, startAt, endAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
  });
  assert.equal(book.statusCode, 201);
  lastChainHash = book.json.job.lastChainHash;

  const customOperatorContractHash = "ab".repeat(32);
  const customOperatorPolicyHash = "cd".repeat(32);

  const matched = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `m_${jobId}` },
    body: {
      type: "MATCHED",
      actor: { type: "system", id: "proxy" },
      payload: {
        robotId: "rob_pins",
        operatorContractHash: customOperatorContractHash,
        operatorPolicyHash: customOperatorPolicyHash,
        operatorCompilerId: "contract_compiler.v1"
      }
    }
  });
  assert.equal(matched.statusCode, 201);
  lastChainHash = matched.json.job.lastChainHash;
  assert.equal(matched.json.job.operatorContractHash, customOperatorContractHash);
  assert.equal(matched.json.job.operatorPolicyHash, customOperatorPolicyHash);
  assert.equal(matched.json.job.operatorCompilerId, "contract_compiler.v1");

  const reschedule = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `rs_${jobId}` },
    body: {
      type: "JOB_RESCHEDULED",
      actor: { type: "system", id: "proxy" },
      payload: {
        jobId,
        oldWindow: { startAt, endAt },
        newWindow: { startAt, endAt },
        reason: "OPS",
        requestedBy: "system",
        requiresRequote: false
      }
    }
  });
  assert.equal(reschedule.statusCode, 201);
  lastChainHash = reschedule.json.job.lastChainHash;
  assert.equal(reschedule.json.job.operatorContractHash, null);
  assert.equal(reschedule.json.job.operatorPolicyHash, null);
  assert.equal(reschedule.json.job.operatorCompilerId, null);

  const rematch = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash, "x-idempotency-key": `m2_${jobId}` },
    body: {
      type: "MATCHED",
      actor: { type: "system", id: "proxy" },
      payload: {
        robotId: "rob_pins",
        operatorContractHash: "ef".repeat(32),
        operatorPolicyHash: "01".repeat(32),
        operatorCompilerId: "contract_compiler.v1"
      }
    }
  });
  assert.equal(rematch.statusCode, 201);
  assert.equal(rematch.json.job.operatorContractHash, "ef".repeat(32));
  assert.equal(rematch.json.job.operatorPolicyHash, "01".repeat(32));
});
