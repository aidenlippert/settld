import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeOnboardingHostSuccessArtifactHash,
  evaluateHostSuccessVerdict,
  parseArgs,
  runOnboardingHostSuccessGate
} from "../scripts/ci/run-onboarding-host-success-gate.mjs";

test("onboarding host success gate parser: uses env defaults and supports overrides", () => {
  const cwd = "/tmp/settld";
  const args = parseArgs(
    ["--report", "artifacts/custom/host-success.json", "--hosts", "Codex,claude,codex"],
    {
      ONBOARDING_HOST_SUCCESS_GATE_REPORT_PATH: "artifacts/gates/default.json",
      ONBOARDING_HOST_SUCCESS_METRICS_DIR: "artifacts/ops/host-success",
      ONBOARDING_HOST_SUCCESS_ATTEMPTS: "3",
      ONBOARDING_HOST_SUCCESS_RATE_MIN_PCT: "95",
      ONBOARDING_HOST_SUCCESS_TIMEOUT_MS: "45000",
      SETTLD_BASE_URL: "https://api.settld.local/",
      SETTLD_TENANT_ID: "tenant_default",
      SETTLD_API_KEY: "sk_test",
      ONBOARDING_PROFILE_ID: "ops-critical"
    },
    cwd
  );

  assert.equal(args.reportPath, path.resolve(cwd, "artifacts/custom/host-success.json"));
  assert.equal(args.metricsDir, path.resolve(cwd, "artifacts/ops/host-success"));
  assert.deepEqual(args.hosts, ["codex", "claude"]);
  assert.equal(args.attemptsPerHost, 3);
  assert.equal(args.minSuccessRatePct, 95);
  assert.equal(args.timeoutMs, 45000);
  assert.equal(args.baseUrl, "https://api.settld.local");
  assert.equal(args.tenantId, "tenant_default");
  assert.equal(args.apiKey, "sk_test");
  assert.equal(args.profileId, "ops-critical");
});

test("onboarding host success gate parser: rejects unsupported host and missing auth args", () => {
  assert.throws(
    () =>
      parseArgs(
        ["--hosts", "codex,unknown"],
        {
          SETTLD_BASE_URL: "https://api.settld.local",
          SETTLD_TENANT_ID: "tenant_default",
          SETTLD_API_KEY: "sk_test"
        },
        "/tmp/settld"
      ),
    /unsupported host/i
  );

  assert.throws(
    () => parseArgs([], { SETTLD_BASE_URL: "https://api.settld.local", SETTLD_API_KEY: "sk_test" }, "/tmp/settld"),
    /--tenant-id is required/
  );
});

test("onboarding host success verdict: computes pass/fail counts from host rows", () => {
  const verdict = evaluateHostSuccessVerdict(
    [
      { host: "codex", status: "passed" },
      { host: "claude", status: "failed" },
      { host: "cursor", status: "passed" }
    ],
    { minSuccessRatePct: 90 }
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, "fail");
  assert.equal(verdict.requiredHosts, 3);
  assert.equal(verdict.passedHosts, 2);
  assert.equal(verdict.failedHosts, 1);
  assert.equal(verdict.minSuccessRatePct, 90);
});

test("onboarding host success gate runner: emits per-host metrics and fails closed under threshold", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-onboarding-host-success-gate-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const reportPath = path.join(tmpRoot, "out", "gate.json");
  const metricsDir = path.join(tmpRoot, "metrics");
  const calls = [];

  const runAttempt = async ({ host, attempt }) => {
    calls.push({ host, attempt });
    if (host === "codex") {
      return { ok: true, detail: "ok", durationMs: 11 + attempt };
    }
    if (host === "claude" && attempt === 1) {
      return { ok: false, detail: "tenant auth failed", durationMs: 21 };
    }
    return { ok: true, detail: "retry ok", durationMs: 22 };
  };

  const { report } = await runOnboardingHostSuccessGate(
    {
      help: false,
      reportPath,
      metricsDir,
      hosts: ["claude", "codex"],
      attemptsPerHost: 2,
      minSuccessRatePct: 90,
      timeoutMs: 5000,
      baseUrl: "https://api.settld.local",
      tenantId: "tenant_default",
      apiKey: "sk_test",
      profileId: "engineering-spend",
      cleanHomeRoot: null
    },
    process.env,
    process.cwd(),
    { runAttempt }
  );

  assert.equal(report.schemaVersion, "OnboardingHostSuccessGateReport.v1");
  assert.equal(report.hosts.length, 2);
  assert.deepEqual(
    report.hosts.map((row) => row.host),
    ["claude", "codex"]
  );
  assert.equal(report.hosts.find((row) => row.host === "codex")?.status, "passed");
  assert.equal(report.hosts.find((row) => row.host === "claude")?.status, "failed");
  assert.equal(report.blockingIssues.some((issue) => issue.host === "claude"), true);
  assert.equal(report.verdict.ok, false);
  assert.equal(report.verdict.failedHosts, 1);
  assert.equal(report.artifactHash, computeOnboardingHostSuccessArtifactHash(report));
  assert.equal(calls.length, 4);

  const claudeMetrics = await fs.readFile(path.join(metricsDir, "claude.prom"), "utf8");
  const codexMetrics = await fs.readFile(path.join(metricsDir, "codex.prom"), "utf8");
  assert.match(claudeMetrics, /onboarding_host_setup_attempts_total_gauge/);
  assert.match(claudeMetrics, /onboarding_host_setup_success_rate_pct_gauge/);
  assert.match(codexMetrics, /host="codex"/);
});

test("onboarding host success artifact hash: stable across volatile report fields", async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-onboarding-host-success-hash-"));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const reportPath = path.join(tmpRoot, "out", "gate.json");
  const metricsDir = path.join(tmpRoot, "metrics");

  const { report } = await runOnboardingHostSuccessGate(
    {
      help: false,
      reportPath,
      metricsDir,
      hosts: ["codex"],
      attemptsPerHost: 1,
      minSuccessRatePct: 100,
      timeoutMs: 5000,
      baseUrl: "https://api.settld.local",
      tenantId: "tenant_default",
      apiKey: "sk_test",
      profileId: "engineering-spend",
      cleanHomeRoot: null
    },
    process.env,
    process.cwd(),
    {
      runAttempt: async () => ({ ok: true, detail: "ok", durationMs: 10 })
    }
  );

  const mutated = {
    ...report,
    generatedAt: "2099-01-01T00:00:00.000Z",
    context: {
      ...report.context,
      baseUrl: "https://another-host.example",
      tenantId: "tenant_other"
    },
    blockingIssues: [{ host: "codex", code: "noop", detail: "not in deterministic core" }]
  };

  assert.equal(computeOnboardingHostSuccessArtifactHash(mutated), report.artifactHash);
});
