import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runSettld(args) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "settld.js"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000
  });
  const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : "";
  const mergedStderr = `${String(result.stderr ?? "")}${spawnError ? `\n${spawnError}\n` : ""}`;
  return {
    status: result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1),
    stdout: String(result.stdout ?? ""),
    stderr: mergedStderr
  };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    assert.fail(`${label}: failed to parse json\n\nstdout:\n${text}\n\nerror:\n${err?.message ?? String(err)}`);
  }
}

async function createPolicyFixture(t, { packId = "engineering-spend" } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-policy-cli-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const packPath = path.join(tmpDir, `${packId}.policy-pack.json`);
  const initRun = runSettld(["policy", "init", packId, "--out", packPath, "--format", "json"]);
  assert.equal(initRun.status, 0, `stdout:\n${initRun.stdout}\n\nstderr:\n${initRun.stderr}`);
  return { tmpDir, packPath };
}

test("CLI: settld --help includes policy commands", () => {
  const run = runSettld(["--help"]);
  assert.equal(run.status, 0, `stdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /settld policy init <pack-id>/);
  assert.match(run.stderr, /settld policy simulate <policy-pack\.json\|->/);
  assert.match(run.stderr, /settld policy publish <policy-pack\.json\|->/);
});

test("CLI: settld policy init writes starter pack with json/json-out modes", async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-policy-cli-init-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const outPath = path.join(tmpDir, "engineering.policy-pack.json");
  const jsonOutPath = path.join(tmpDir, "init.report.json");

  const run = runSettld(["policy", "init", "engineering-spend", "--out", outPath, "--format", "json", "--json-out", jsonOutPath]);
  assert.equal(run.status, 0, `stdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);

  const stdoutBody = parseJson(run.stdout, "policy init stdout");
  const fileBody = parseJson(await fs.readFile(jsonOutPath, "utf8"), "policy init json-out");
  assert.deepEqual(stdoutBody, fileBody);
  assert.equal(stdoutBody.ok, true);
  assert.equal(stdoutBody.command, "init");
  assert.equal(stdoutBody.packId, "engineering-spend");
  assert.equal(stdoutBody.outPath, outPath);

  const policyPack = parseJson(await fs.readFile(outPath, "utf8"), "policy pack file");
  assert.equal(policyPack.schemaVersion, "SettldPolicyPack.v1");
  assert.equal(policyPack.packId, "engineering-spend");
  assert.equal(policyPack.metadata.vertical, "engineering");
  assert.equal(Array.isArray(policyPack.policy.approvals), true);
});

test("CLI: settld policy simulate reports deterministic deny reasons", async (t) => {
  const { packPath } = await createPolicyFixture(t);
  const scenario = JSON.stringify({
    providerId: "provider_unknown",
    toolId: "tool.unknown",
    amountUsdCents: 999_999_999,
    monthToDateSpendUsdCents: 10_000,
    approvalsProvided: 0,
    receiptSigned: false,
    toolManifestHashPresent: false,
    toolVersionKnown: false
  });

  const run = runSettld(["policy", "simulate", packPath, "--scenario-json", scenario, "--format", "json"]);
  assert.equal(run.status, 0, `stdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
  const body = parseJson(run.stdout, "policy simulate stdout");
  assert.equal(body.schemaVersion, "SettldPolicySimulationReport.v1");
  assert.equal(body.ok, true);
  assert.equal(body.packId, "engineering-spend");
  assert.equal(body.decision, "deny");
  assert.equal(Array.isArray(body.reasons), true);
  assert.equal(body.reasons.includes("provider_allowlisted"), true);
  assert.equal(body.reasons.includes("tool_allowlisted"), true);
  assert.equal(body.reasons.includes("per_request_limit"), true);
  assert.equal(body.reasons.includes("monthly_limit"), true);
  assert.equal(body.reasons.includes("receipt_signature"), true);
  assert.equal(body.reasons.includes("tool_manifest_hash"), true);
  assert.equal(body.reasons.includes("tool_version_known"), true);
});

test("CLI: settld policy publish writes deterministic local publication report", async (t) => {
  const { tmpDir, packPath } = await createPolicyFixture(t);
  const outPath = path.join(tmpDir, "engineering-spend.publish.local.json");

  const firstRun = runSettld(["policy", "publish", packPath, "--out", outPath, "--format", "json"]);
  assert.equal(firstRun.status, 0, `stdout:\n${firstRun.stdout}\n\nstderr:\n${firstRun.stderr}`);
  const firstReport = parseJson(firstRun.stdout, "policy publish stdout#1");
  assert.equal(firstReport.schemaVersion, "SettldPolicyPublishReport.v1");
  assert.equal(firstReport.ok, true);
  assert.equal(firstReport.channel, "local");
  assert.equal(firstReport.owner, "local-operator");
  assert.match(String(firstReport.policyFingerprint ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(firstReport.artifactSha256 ?? ""), /^[0-9a-f]{64}$/);

  const firstArtifactRaw = await fs.readFile(firstReport.artifactPath, "utf8");
  const firstArtifact = parseJson(firstArtifactRaw, "policy publish artifact#1");
  assert.equal(firstArtifact.schemaVersion, "SettldPolicyPublication.v1");
  assert.equal(firstArtifact.packId, "engineering-spend");
  assert.equal(firstArtifact.policyFingerprint, firstReport.policyFingerprint);
  assert.equal(firstArtifact.publicationRef, firstReport.publicationRef);
  assert.equal(firstArtifact.checksums.policyPackCanonicalSha256, firstReport.policyFingerprint);

  const secondRun = runSettld(["policy", "publish", packPath, "--out", firstReport.artifactPath, "--force", "--format", "json"]);
  assert.equal(secondRun.status, 0, `stdout:\n${secondRun.stdout}\n\nstderr:\n${secondRun.stderr}`);
  const secondReport = parseJson(secondRun.stdout, "policy publish stdout#2");
  assert.deepEqual(secondReport, firstReport);

  const secondArtifactRaw = await fs.readFile(secondReport.artifactPath, "utf8");
  assert.equal(secondArtifactRaw, firstArtifactRaw);
});

test("CLI: settld policy init unknown pack returns actionable error", () => {
  const run = runSettld(["policy", "init", "missing-pack-id"]);
  assert.equal(run.status, 1, `stdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /unknown policy pack: missing-pack-id/);
  assert.match(run.stderr, /known:/);
});
