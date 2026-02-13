import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTLEMENT_VERIFICATION_STATUS,
  SETTLEMENT_VERIFIER_SOURCE,
  evaluateSettlementVerifierExecution,
  resolveSettlementVerifierRef
} from "../src/core/settlement-verifier.js";

test("resolveSettlementVerifierRef defaults to policy engine for unknown verifier source", () => {
  const out = resolveSettlementVerifierRef({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: "verifier://unknown/example"
    }
  });
  assert.equal(out.verifierId, "settld.policy-engine");
  assert.equal(out.verifierVersion, "v1");
  assert.equal(out.verifierHash, null);
  assert.equal(out.modality, "deterministic");
});

test("resolveSettlementVerifierRef resolves deterministic latency plugin", () => {
  const out = resolveSettlementVerifierRef({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_LATENCY_THRESHOLD_V1
    }
  });
  assert.equal(out.verifierId, "settld.deterministic.latency-threshold");
  assert.equal(out.verifierVersion, "v1");
  assert.match(String(out.verifierHash), /^[0-9a-f]{64}$/);
  assert.equal(out.modality, "deterministic");
});

test("evaluateSettlementVerifierExecution applies deterministic latency thresholds", () => {
  const green = evaluateSettlementVerifierExecution({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_LATENCY_THRESHOLD_V1
    },
    run: { status: "completed", metrics: { latencyMs: 200 } },
    verification: { verificationStatus: "amber" }
  });
  assert.equal(green.verificationStatus, SETTLEMENT_VERIFICATION_STATUS.GREEN);

  const red = evaluateSettlementVerifierExecution({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_LATENCY_THRESHOLD_V1
    },
    run: { status: "completed", metrics: { latencyMs: 5000 } },
    verification: { verificationStatus: "green" }
  });
  assert.equal(red.verificationStatus, SETTLEMENT_VERIFICATION_STATUS.RED);
});

test("resolveSettlementVerifierRef resolves deterministic schema-check plugin", () => {
  const out = resolveSettlementVerifierRef({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: `${SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_SCHEMA_CHECK_V1}?latencyMaxMs=300`
    }
  });
  assert.equal(out.verifierId, "settld.deterministic.schema-check");
  assert.equal(out.verifierVersion, "v1");
  assert.match(String(out.verifierHash), /^[0-9a-f]{64}$/);
  assert.equal(out.modality, "deterministic");
});

test("evaluateSettlementVerifierExecution applies deterministic schema-check plugin checks", () => {
  const pass = evaluateSettlementVerifierExecution({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: `${SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_SCHEMA_CHECK_V1}?latencyMaxMs=300`
    },
    run: { status: "completed", metrics: { latencyMs: 250, settlementReleaseRatePct: 100 } },
    verification: { verificationStatus: "amber" }
  });
  assert.equal(pass.verificationStatus, SETTLEMENT_VERIFICATION_STATUS.GREEN);

  const fail = evaluateSettlementVerifierExecution({
    verificationMethod: {
      schemaVersion: "VerificationMethod.v1",
      mode: "deterministic",
      source: `${SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_SCHEMA_CHECK_V1}?latencyMaxMs=300&requireSettlementReleaseRatePct=1`
    },
    run: { status: "completed", metrics: { latencyMs: 1200 } },
    verification: { verificationStatus: "green" }
  });
  assert.equal(fail.verificationStatus, SETTLEMENT_VERIFICATION_STATUS.RED);
  assert.deepEqual(fail.evaluation.reasonCodes, ["verifier_plugin_schema_check_failed"]);
});
