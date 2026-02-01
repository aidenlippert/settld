import test from "node:test";
import assert from "node:assert/strict";

import { computeArtifactHash as computeServerArtifactHash } from "../src/core/artifacts.js";
import { verifyArtifactHash, verifyArtifactVersion, verifySettlementBalances } from "../packages/artifact-verify/src/index.js";

test("artifact-verify: verifies artifactHash and settlement balancing", () => {
  const core = {
    schemaVersion: "SettlementStatement.v1",
    artifactType: "SettlementStatement.v1",
    artifactId: "settlement_job_test_evt_1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    tenantId: "tenant_default",
    jobId: "job_test",
    jobVersion: 10,
    policyHash: "policy_hash_test",
    eventProof: { lastChainHash: "chain_test", eventCount: 10, signatures: { signedEventCount: 0, signerKeyIds: [] } },
    job: { templateId: "reset_lite", status: "SETTLED" },
    settlement: {
      currency: "USD",
      quoteAmountCents: 1000,
      operatorCostCents: 0,
      slaCreditsCents: 0,
      claimsPaidCents: 0,
      ledgerEntryIds: ["jnl_evt_1"],
      totalsByAccountId: {
        acct_customer_escrow: 1000,
        acct_platform_revenue: -200,
        acct_owner_payable: -800
      }
    }
  };

  const artifactHash = computeServerArtifactHash(core);
  const artifact = { ...core, artifactHash };

  assert.deepEqual(verifyArtifactVersion(artifact), { ok: true, artifactType: "SettlementStatement.v1" });
  assert.deepEqual(verifyArtifactHash(artifact), { ok: true, expected: artifactHash, actual: artifactHash });
  assert.deepEqual(verifySettlementBalances(artifact), { ok: true });

  const tampered = { ...artifact, settlement: { ...artifact.settlement, quoteAmountCents: 999 } };
  const bad = verifyArtifactHash(tampered);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "artifactHash mismatch");
});

test("artifact-verify: rejects unsupported artifactType", () => {
  const artifact = { schemaVersion: "WorkCertificate.v999", artifactType: "WorkCertificate.v999", artifactHash: "deadbeef" };
  const res = verifyArtifactVersion(artifact);
  assert.equal(res.ok, false);
  assert.equal(res.error, "unsupported artifactType");
});
