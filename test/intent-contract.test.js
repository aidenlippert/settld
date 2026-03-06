import test from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_CONTRACT_SCHEMA_VERSION,
  INTENT_CONTRACT_STATUS,
  acceptIntentContractV1,
  buildIntentContractV1,
  counterIntentContractV1,
  validateIntentContractV1
} from "../src/core/intent-contract.js";

function buildSeedIntent(intentId = "intent_test_1") {
  return buildIntentContractV1({
    intentId,
    tenantId: "tenant_default",
    proposerAgentId: "agt_requester_1",
    counterpartyAgentId: "agt_worker_1",
    objective: { summary: "Write deterministic parser" },
    constraints: { maxDurationSeconds: 600 },
    budgetEnvelope: { currency: "USD", maxAmountCents: 2500, hardCap: true },
    requiredApprovals: [{ approverRole: "finance", minApprovals: 1 }],
    successCriteria: { checks: ["tests-pass", "lint-pass"] },
    terminationPolicy: { timeoutSeconds: 3600 },
    proposedAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z"
  });
}

test("intent contract: deterministic hash for equivalent payloads", () => {
  const a = buildSeedIntent("intent_det_1");
  const b = buildSeedIntent("intent_det_1");
  assert.equal(a.schemaVersion, INTENT_CONTRACT_SCHEMA_VERSION);
  assert.equal(a.intentHash, b.intentHash);
  assert.equal(a.intentHash.length, 64);
});

test("intent contract: tampering payload fails closed", () => {
  const intent = buildSeedIntent("intent_tamper_1");
  const tampered = {
    ...intent,
    objective: { summary: "tampered objective" }
  };
  assert.throws(() => validateIntentContractV1(tampered), /intentHash mismatch/i);
});

test("intent contract: counter links parent intent hash deterministically", () => {
  const source = buildSeedIntent("intent_parent_1");
  const counter = counterIntentContractV1({
    sourceIntent: source,
    intentId: "intent_counter_1",
    proposerAgentId: "agt_worker_1",
    budgetEnvelope: { currency: "USD", maxAmountCents: 2200, hardCap: true },
    proposedAt: "2026-03-01T00:01:00.000Z"
  });

  assert.equal(counter.status, INTENT_CONTRACT_STATUS.COUNTERED);
  assert.equal(counter.counterOfIntentId, source.intentId);
  assert.equal(counter.parentIntentHash, source.intentHash);
  assert.equal(validateIntentContractV1(counter), true);
});

test("intent contract: accept transition requires participant and is hash-bound", () => {
  const proposed = buildSeedIntent("intent_accept_1");
  const accepted = acceptIntentContractV1({
    intentContract: proposed,
    acceptedByAgentId: "agt_worker_1",
    acceptedAt: "2026-03-01T00:02:00.000Z"
  });

  assert.equal(accepted.status, INTENT_CONTRACT_STATUS.ACCEPTED);
  assert.equal(accepted.acceptedByAgentId, "agt_worker_1");
  assert.equal(accepted.acceptedAt, "2026-03-01T00:02:00.000Z");
  assert.notEqual(accepted.intentHash, proposed.intentHash);
  assert.equal(validateIntentContractV1(accepted), true);
});

test("intent contract: accept fails closed for non-participant", () => {
  const proposed = buildSeedIntent("intent_accept_fail_1");
  assert.throws(
    () =>
      acceptIntentContractV1({
        intentContract: proposed,
        acceptedByAgentId: "agt_outsider_1",
        acceptedAt: "2026-03-01T00:02:00.000Z"
      }),
    /must be a participant/i
  );
});
