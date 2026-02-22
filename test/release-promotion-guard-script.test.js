import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEd25519Keypair, keyIdFromPublicKeyPem, signHashHexEd25519 } from "../src/core/crypto.js";
import { evaluatePromotionVerdict, parseArgs, runReleasePromotionGuard } from "../scripts/ci/run-release-promotion-guard.mjs";

async function writeJson(root, relPath, value) {
  const fp = path.join(root, relPath);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeRequiredArtifacts(root, { productionGateOk = true } = {}) {
  await writeJson(root, "artifacts/gates/kernel-v0-ship-gate.json", {
    schemaVersion: "KernelV0ShipGateReport.v1",
    verdict: { ok: true, requiredChecks: 1, passedChecks: 1 }
  });
  await writeJson(root, "artifacts/gates/production-cutover-gate.json", {
    schemaVersion: "ProductionCutoverGateReport.v1",
    verdict: { ok: productionGateOk, requiredChecks: 1, passedChecks: productionGateOk ? 1 : 0 }
  });
  await writeJson(root, "artifacts/gates/offline-verification-parity-gate.json", {
    schemaVersion: "OfflineVerificationParityGateReport.v1",
    verdict: { ok: true, requiredChecks: 1, passedChecks: 1 }
  });
  await writeJson(root, "artifacts/gates/onboarding-host-success-gate.json", {
    schemaVersion: "OnboardingHostSuccessGateReport.v1",
    verdict: { ok: true, requiredHosts: 4, passedHosts: 4 }
  });
  await writeJson(root, "artifacts/gates/s13-go-live-gate.json", {
    schemaVersion: "GoLiveGateReport.v1",
    verdict: { ok: true, requiredChecks: 1, passedChecks: 1 }
  });
  await writeJson(root, "artifacts/gates/s13-launch-cutover-packet.json", {
    schemaVersion: "LaunchCutoverPacket.v1",
    verdict: { ok: true, requiredChecks: 1, passedChecks: 1 }
  });
  await writeJson(root, "artifacts/ops/hosted-baseline-evidence-production.json", {
    type: "HostedBaselineEvidence.v1",
    v: 1,
    status: "pass",
    failures: []
  });
}

test("release promotion guard parser: uses env defaults and explicit overrides", () => {
  const cwd = "/tmp/settld";
  const args = parseArgs(
    [
      "--report",
      "artifacts/custom/release-promotion-guard.json",
      "--override",
      "artifacts/gates/override.json",
      "--offline-parity-gate",
      "artifacts/custom/offline-parity.json",
      "--onboarding-host-success-gate",
      "artifacts/custom/onboarding-host-success.json",
      "--promotion-ref",
      "abc123"
    ],
    {
      KERNEL_V0_SHIP_GATE_REPORT_PATH: "artifacts/custom/kernel-gate.json",
      RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z"
    },
    cwd
  );

  assert.equal(args.reportPath, path.resolve(cwd, "artifacts/custom/release-promotion-guard.json"));
  assert.equal(args.kernelV0ShipGatePath, path.resolve(cwd, "artifacts/custom/kernel-gate.json"));
  assert.equal(args.offlineVerificationParityGatePath, path.resolve(cwd, "artifacts/custom/offline-parity.json"));
  assert.equal(args.onboardingHostSuccessGatePath, path.resolve(cwd, "artifacts/custom/onboarding-host-success.json"));
  assert.equal(args.overridePath, path.resolve(cwd, "artifacts/gates/override.json"));
  assert.equal(args.promotionRef, "abc123");
  assert.equal(args.nowIso, "2026-02-21T18:00:00.000Z");
});

test("release promotion guard: fails closed when required artifacts are missing", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-missing-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const args = parseArgs([], { RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z" }, tmpRoot);
  const { report } = await runReleasePromotionGuard(args, { RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z" }, tmpRoot);

  assert.equal(report.schemaVersion, "ReleasePromotionGuardReport.v1");
  assert.equal(report.verdict.ok, false);
  assert.equal(report.verdict.status, "fail");
  assert.equal(report.artifacts.every((row) => row.status === "failed"), true);
  assert.equal(report.artifacts.every((row) => row.failureCodes.includes("file_missing")), true);
});

test("release promotion guard: emits deterministic report for identical inputs", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-deterministic-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await writeRequiredArtifacts(tmpRoot, { productionGateOk: true });
  const env = {
    RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z",
    RELEASE_PROMOTION_REF: "commit_deadbeef"
  };

  const args = parseArgs([], env, tmpRoot);
  const first = await runReleasePromotionGuard(args, env, tmpRoot);
  const second = await runReleasePromotionGuard(args, env, tmpRoot);

  assert.deepEqual(first.report, second.report);
  assert.equal(first.report.verdict.ok, true);
  assert.equal(first.report.verdict.status, "pass");
});

test("release promotion guard verdict aggregation: fails closed on missing required artifact rows", () => {
  const verdict = evaluatePromotionVerdict({
    artifacts: [
      { id: "kernel_v0_ship_gate", status: "passed" },
      { id: "production_cutover_gate", status: "passed" },
      { id: "offline_verification_parity_gate", status: "passed" },
      { id: "onboarding_host_success_gate", status: "passed" },
      { id: "go_live_gate", status: "passed" },
      { id: "launch_cutover_packet", status: "passed" }
    ],
    override: { provided: false, accepted: false }
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "fail");
  assert.equal(verdict.requiredArtifacts, 7);
  assert.equal(verdict.passedArtifacts, 6);
  assert.equal(verdict.failedArtifacts, 1);
  assert.deepEqual(verdict.blockingArtifactIds, ["hosted_baseline_evidence"]);
});

test("release promotion guard: fails closed when offline parity gate report schema drifts", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-parity-schema-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await writeRequiredArtifacts(tmpRoot, { productionGateOk: true });
  await writeJson(tmpRoot, "artifacts/gates/offline-verification-parity-gate.json", {
    schemaVersion: "OfflineVerificationParityGateReport.v0",
    verdict: { ok: true, requiredChecks: 1, passedChecks: 1 }
  });

  const env = {
    RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z"
  };

  const { report } = await runReleasePromotionGuard(parseArgs([], env, tmpRoot), env, tmpRoot);
  assert.equal(report.verdict.ok, false);
  assert.equal(report.verdict.status, "fail");
  const parityArtifact = report.artifacts.find((row) => row.id === "offline_verification_parity_gate");
  assert.ok(parityArtifact);
  assert.equal(parityArtifact.status, "failed");
  assert.equal(parityArtifact.failureCodes.includes("schema_mismatch"), true);
});

test("release promotion guard: accepts valid Ed25519 signed override for blocking artifacts", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-override-pass-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await writeRequiredArtifacts(tmpRoot, { productionGateOk: false });
  const env = {
    RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z",
    RELEASE_PROMOTION_REF: "commit_feedface"
  };

  const first = await runReleasePromotionGuard(parseArgs([], env, tmpRoot), env, tmpRoot);
  assert.equal(first.report.verdict.ok, false);
  assert.equal(first.report.verdict.status, "fail");

  const keypair = createEd25519Keypair();
  const keyId = keyIdFromPublicKeyPem(keypair.publicKeyPem);
  const overridePath = path.join(tmpRoot, "artifacts/gates/promotion-override.json");
  const overridePayload = {
    schemaVersion: "ReleasePromotionOverride.v1",
    allowPromotion: true,
    algorithm: "ED25519-SHA256",
    keyId,
    publicKeyPem: keypair.publicKeyPem,
    reason: "incident reviewed and accepted for one-time promotion",
    ticketId: "INC-2026-021",
    approvedBy: "release-oncall",
    issuedAt: "2026-02-21T17:45:00.000Z",
    expiresAt: "2026-02-21T20:00:00.000Z",
    promotionContextSha256: first.report.promotionContext.sha256,
    signatureBase64: signHashHexEd25519(first.report.promotionContext.sha256, keypair.privateKeyPem)
  };
  await writeJson(tmpRoot, "artifacts/gates/promotion-override.json", overridePayload);

  const secondArgs = parseArgs(["--override", path.relative(tmpRoot, overridePath)], env, tmpRoot);
  const second = await runReleasePromotionGuard(secondArgs, env, tmpRoot);

  assert.equal(second.report.verdict.ok, true);
  assert.equal(second.report.verdict.status, "override_pass");
  assert.equal(second.report.verdict.overrideUsed, true);
  assert.equal(second.report.override.accepted, true);
  assert.equal(second.report.override.keyId, keyId);
  assert.equal(second.report.override.algorithm, "ed25519-sha256");
});

test("release promotion guard: rejects invalid override signature and stays fail-closed", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-override-fail-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await writeRequiredArtifacts(tmpRoot, { productionGateOk: false });
  const env = {
    RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z"
  };

  const first = await runReleasePromotionGuard(parseArgs([], env, tmpRoot), env, tmpRoot);
  assert.equal(first.report.verdict.ok, false);

  const keypair = createEd25519Keypair();
  const keyId = keyIdFromPublicKeyPem(keypair.publicKeyPem);
  await writeJson(tmpRoot, "artifacts/gates/promotion-override.json", {
    schemaVersion: "ReleasePromotionOverride.v1",
    allowPromotion: true,
    algorithm: "ed25519-sha256",
    keyId,
    publicKeyPem: keypair.publicKeyPem,
    issuedAt: "2026-02-21T17:45:00.000Z",
    expiresAt: "2026-02-21T20:00:00.000Z",
    promotionContextSha256: "0".repeat(64),
    signatureBase64: signHashHexEd25519(first.report.promotionContext.sha256, keypair.privateKeyPem)
  });

  const second = await runReleasePromotionGuard(parseArgs(["--override", "artifacts/gates/promotion-override.json"], env, tmpRoot), env, tmpRoot);
  assert.equal(second.report.verdict.ok, false);
  assert.equal(second.report.verdict.status, "fail");
  assert.equal(second.report.override.accepted, false);
  assert.equal(second.report.override.errorCodes.includes("override_context_hash_mismatch"), true);
});

test("release promotion guard: rejects override missing required metadata and remains fail-closed", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-release-promotion-guard-override-metadata-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  await writeRequiredArtifacts(tmpRoot, { productionGateOk: false });
  const env = {
    RELEASE_PROMOTION_GUARD_NOW: "2026-02-21T18:00:00.000Z"
  };

  const first = await runReleasePromotionGuard(parseArgs([], env, tmpRoot), env, tmpRoot);
  const keypair = createEd25519Keypair();
  await writeJson(tmpRoot, "artifacts/gates/promotion-override.json", {
    schemaVersion: "ReleasePromotionOverride.v1",
    allowPromotion: true,
    algorithm: "ed25519-sha256",
    publicKeyPem: keypair.publicKeyPem,
    promotionContextSha256: first.report.promotionContext.sha256,
    signatureBase64: signHashHexEd25519(first.report.promotionContext.sha256, keypair.privateKeyPem)
  });

  const second = await runReleasePromotionGuard(parseArgs(["--override", "artifacts/gates/promotion-override.json"], env, tmpRoot), env, tmpRoot);
  assert.equal(second.report.verdict.ok, false);
  assert.equal(second.report.verdict.status, "fail");
  assert.equal(second.report.override.accepted, false);
  assert.equal(second.report.override.errorCodes.includes("override_key_id_missing"), true);
  assert.equal(second.report.override.errorCodes.includes("override_issued_at_missing"), true);
  assert.equal(second.report.override.errorCodes.includes("override_expires_at_missing"), true);
});
