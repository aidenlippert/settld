import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runSettld(args, { env = null } = {}) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "settld.js"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
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

function runSettldAsync(args, { env = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin", "settld.js"), ...args], {
      cwd: REPO_ROOT,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        status: 124,
        stdout,
        stderr: `${stderr}\nError: command timed out after ${timeoutMs}ms\n`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      finish({ status: status ?? 1, stdout, stderr });
    });
  });
}

function runSettldWithInput(args, { input = "", env = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin", "settld.js"), ...args], {
      cwd: REPO_ROOT,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        status: 124,
        stdout,
        stderr: `${stderr}\nError: command timed out after ${timeoutMs}ms\n`
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      finish({ status: status ?? 1, stdout, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(String(input));
    child.stdin.end();
  });
}

function extractApplyFlags(helpText) {
  return [...new Set((helpText.match(/--[a-z0-9][a-z0-9-]*/gi) ?? []).map((flag) => flag.toLowerCase()))];
}

function pickFlag(flags, candidates) {
  for (const candidate of candidates) {
    if (flags.includes(candidate)) return candidate;
  }
  return null;
}

function pickKeywordFlag(flags, keyword) {
  return flags.find((flag) => flag.includes(keyword)) ?? null;
}

function buildRuntimeEnv({ baseUrl, tenantId, bearerToken, walletRef }) {
  return {
    SETTLD_RUNTIME_BASE_URL: baseUrl,
    SETTLD_RUNTIME_URL: baseUrl,
    SETTLD_BASE_URL: baseUrl,
    SETTLD_API_URL: baseUrl,
    SETTLD_RUNTIME_TENANT_ID: tenantId,
    SETTLD_TENANT_ID: tenantId,
    SETTLD_RUNTIME_BEARER_TOKEN: bearerToken,
    SETTLD_BEARER_TOKEN: bearerToken,
    SETTLD_API_KEY: bearerToken,
    SETTLD_TOKEN: bearerToken,
    SETTLD_RUNTIME_WALLET_REF: walletRef,
    SETTLD_WALLET_REF: walletRef,
    SETTLD_X402_WALLET_REF: walletRef
  };
}

function clearedRuntimeEnv() {
  const runtimeEnvKeys = Object.keys(
    buildRuntimeEnv({
      baseUrl: "http://127.0.0.1:0",
      tenantId: "tenant_unused",
      bearerToken: "token_unused",
      walletRef: "wallet_unused"
    })
  );
  return Object.fromEntries(runtimeEnvKeys.map((key) => [key, ""]));
}

function toOutputShape(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [toOutputShape(value[0])];
  }
  if (value === null) return null;
  if (typeof value !== "object") return typeof value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = toOutputShape(value[key]);
  }
  return out;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    assert.fail(`${label}: failed to parse json\n\nstdout:\n${text}\n\nerror:\n${err?.message ?? String(err)}`);
  }
}

async function listenLocal(server) {
  return await new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      server.off("error", onError);
    };
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => {
      cleanup();
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      resolve({ port });
    });
  });
}

async function createProfileFixture(t, fileName = "engineering.profile.json") {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-profile-cli-apply-"));
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  const profilePath = path.join(tmpDir, fileName);
  const initRun = runSettld(["profile", "init", "engineering-spend", "--out", profilePath, "--format", "json"]);
  assert.equal(initRun.status, 0, `stdout:\n${initRun.stdout}\n\nstderr:\n${initRun.stderr}`);
  return { profilePath };
}

const APPLY_HELP_RUN = runSettld(["profile", "apply", "--help"]);
const APPLY_HELP_TEXT = `${APPLY_HELP_RUN.stdout}\n${APPLY_HELP_RUN.stderr}`;
const PROFILE_APPLY_SUPPORTED = !/unsupported command:\s*apply/i.test(APPLY_HELP_TEXT);
const APPLY_FLAGS = extractApplyFlags(APPLY_HELP_TEXT);
const APPLY_FORMAT_FLAG = pickFlag(APPLY_FLAGS, ["--format"]);
const APPLY_DRY_RUN_FLAG = pickFlag(APPLY_FLAGS, ["--dry-run"]) ?? pickKeywordFlag(APPLY_FLAGS, "dry-run");
const APPLY_LIVE_FLAG = pickFlag(APPLY_FLAGS, ["--live", "--no-dry-run"]) ?? pickKeywordFlag(APPLY_FLAGS, "no-dry");
const APPLY_BASE_URL_FLAG =
  pickFlag(APPLY_FLAGS, ["--runtime-base-url", "--runtime-url", "--api-url", "--base-url", "--url"]) ??
  pickKeywordFlag(APPLY_FLAGS, "base-url") ??
  pickKeywordFlag(APPLY_FLAGS, "api-url");
const APPLY_TENANT_FLAG =
  pickFlag(APPLY_FLAGS, ["--runtime-tenant-id", "--tenant-id", "--tenant"]) ??
  pickKeywordFlag(APPLY_FLAGS, "tenant-id");
const APPLY_BEARER_FLAG =
  pickFlag(APPLY_FLAGS, ["--runtime-bearer-token", "--bearer-token", "--api-key", "--token"]) ??
  pickKeywordFlag(APPLY_FLAGS, "bearer") ??
  pickKeywordFlag(APPLY_FLAGS, "api-key");
const APPLY_WALLET_FLAG =
  pickFlag(APPLY_FLAGS, ["--runtime-wallet-ref", "--wallet-ref", "--x402-wallet-ref", "--sponsor-wallet-ref"]) ??
  pickKeywordFlag(APPLY_FLAGS, "wallet-ref");

function buildApplyArgs({ profilePath, mode, runtime = null }) {
  const args = ["profile", "apply", profilePath];
  if (APPLY_FORMAT_FLAG) args.push(APPLY_FORMAT_FLAG, "json");
  if (mode === "dry-run" && APPLY_DRY_RUN_FLAG) args.push(APPLY_DRY_RUN_FLAG);
  if (mode === "live" && APPLY_LIVE_FLAG) args.push(APPLY_LIVE_FLAG);
  if (runtime) {
    if (APPLY_BASE_URL_FLAG) args.push(APPLY_BASE_URL_FLAG, runtime.baseUrl);
    if (APPLY_TENANT_FLAG) args.push(APPLY_TENANT_FLAG, runtime.tenantId);
    if (APPLY_BEARER_FLAG) args.push(APPLY_BEARER_FLAG, runtime.bearerToken);
    if (APPLY_WALLET_FLAG) args.push(APPLY_WALLET_FLAG, runtime.walletRef);
  }
  return args;
}

test("CLI: settld profile wizard non-interactive writes profile valid for validate/simulate/apply pipeline", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-profile-cli-wizard-"));
  const profilePath = path.join(tmpDir, "custom.profile.json");
  const jsonOutPath = path.join(tmpDir, "wizard-output.json");

  try {
    const wizardRun = runSettld([
      "profile",
      "wizard",
      "--non-interactive",
      "--template",
      "engineering-spend",
      "--profile-id",
      "engineering-custom",
      "--name",
      "Engineering Custom Spend",
      "--vertical",
      "engineering",
      "--description",
      "Generated from wizard",
      "--per-request-usd-cents",
      "125000",
      "--monthly-usd-cents",
      "900000",
      "--providers",
      "openai,anthropic",
      "--tools",
      "llm.inference,ci.compute",
      "--out",
      profilePath,
      "--format",
      "json",
      "--json-out",
      jsonOutPath
    ]);
    assert.equal(wizardRun.status, 0, `stdout:\n${wizardRun.stdout}\n\nstderr:\n${wizardRun.stderr}`);
    const wizardBody = parseJson(await fs.readFile(jsonOutPath, "utf8"), "wizard json-out");
    assert.equal(wizardBody.ok, true);
    assert.equal(wizardBody.command, "wizard");
    assert.equal(wizardBody.mode, "non_interactive");
    assert.equal(wizardBody.profileId, "engineering-custom");

    const profileDoc = parseJson(await fs.readFile(profilePath, "utf8"), "wizard profile");
    assert.equal(profileDoc.profileId, "engineering-custom");
    assert.equal(profileDoc.metadata.name, "Engineering Custom Spend");
    assert.equal(profileDoc.policy.limits.perRequestUsdCents, 125000);
    assert.equal(profileDoc.policy.limits.monthlyUsdCents, 900000);
    assert.deepEqual(profileDoc.policy.allowlists.providers, ["openai", "anthropic"]);
    assert.deepEqual(profileDoc.policy.allowlists.tools, ["llm.inference", "ci.compute"]);

    const validateRun = runSettld(["profile", "validate", profilePath, "--format", "json"]);
    assert.equal(validateRun.status, 0, `stdout:\n${validateRun.stdout}\n\nstderr:\n${validateRun.stderr}`);
    const validateBody = parseJson(validateRun.stdout, "wizard validate output");
    assert.equal(validateBody.ok, true);

    const simulateRun = runSettld([
      "profile",
      "simulate",
      profilePath,
      "--scenario-json",
      JSON.stringify({
        providerId: "openai",
        toolId: "llm.inference",
        amountUsdCents: 50000,
        monthToDateSpendUsdCents: 0,
        approvalsProvided: 0,
        receiptSigned: true,
        toolManifestHashPresent: true
      }),
      "--format",
      "json"
    ]);
    assert.equal(simulateRun.status, 0, `stdout:\n${simulateRun.stdout}\n\nstderr:\n${simulateRun.stderr}`);
    const simulateBody = parseJson(simulateRun.stdout, "wizard simulate output");
    assert.equal(simulateBody.decision, "allow");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: settld profile wizard interactive prompts accept defaults", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-profile-cli-wizard-interactive-"));
  const profilePath = path.join(tmpDir, "interactive.profile.json");
  const jsonOutPath = path.join(tmpDir, "interactive-wizard-output.json");
  const promptAnswers = ["", "team-policy", "", "", "", "", "", "", "", ""].join("\n") + "\n";

  try {
    const wizardRun = await runSettldWithInput(
      ["profile", "wizard", "--out", profilePath, "--json-out", jsonOutPath, "--format", "json"],
      { input: promptAnswers }
    );
    assert.equal(wizardRun.status, 0, `stdout:\n${wizardRun.stdout}\n\nstderr:\n${wizardRun.stderr}`);

    const wizardBody = parseJson(await fs.readFile(jsonOutPath, "utf8"), "interactive wizard json-out");
    assert.equal(wizardBody.ok, true);
    assert.equal(wizardBody.command, "wizard");
    assert.equal(wizardBody.mode, "interactive");
    assert.equal(wizardBody.profileId, "team-policy");

    const profileDoc = parseJson(await fs.readFile(profilePath, "utf8"), "interactive wizard profile");
    assert.equal(profileDoc.profileId, "team-policy");
    assert.equal(profileDoc.metadata.name, "Engineering Spend");
    assert.equal(profileDoc.policy.currency, "USD");

    const validateRun = runSettld(["profile", "validate", profilePath, "--format", "json"]);
    assert.equal(validateRun.status, 0, `stdout:\n${validateRun.stdout}\n\nstderr:\n${validateRun.stderr}`);
    const validateBody = parseJson(validateRun.stdout, "interactive wizard validate output");
    assert.equal(validateBody.ok, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: settld profile init + validate + simulate", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-profile-cli-"));
  const profilePath = path.join(tmpDir, "engineering.profile.json");
  const scenarioPath = path.join(REPO_ROOT, "test", "fixtures", "profile", "scenario-allow.json");

  try {
    const initRun = runSettld(["profile", "init", "engineering-spend", "--out", profilePath, "--format", "json"]);
    assert.equal(initRun.status, 0, `stdout:\n${initRun.stdout}\n\nstderr:\n${initRun.stderr}`);
    const initBody = JSON.parse(initRun.stdout);
    assert.equal(initBody.ok, true);
    assert.equal(initBody.profileId, "engineering-spend");
    const profileDoc = JSON.parse(await fs.readFile(profilePath, "utf8"));
    assert.equal(profileDoc.schemaVersion, "SettldProfile.v1");
    assert.equal(profileDoc.profileId, "engineering-spend");

    const validateRun = runSettld(["profile", "validate", profilePath, "--format", "json"]);
    assert.equal(validateRun.status, 0, `stdout:\n${validateRun.stdout}\n\nstderr:\n${validateRun.stderr}`);
    const validateBody = JSON.parse(validateRun.stdout);
    assert.equal(validateBody.schemaVersion, "SettldProfileValidationReport.v1");
    assert.equal(validateBody.ok, true);
    assert.deepEqual(validateBody.errors, []);

    const simulateRunA = runSettld(["profile", "simulate", profilePath, "--scenario", scenarioPath, "--format", "json"]);
    assert.equal(simulateRunA.status, 0, `stdout:\n${simulateRunA.stdout}\n\nstderr:\n${simulateRunA.stderr}`);
    const simulateBodyA = JSON.parse(simulateRunA.stdout);
    assert.equal(simulateBodyA.schemaVersion, "SettldProfileSimulationReport.v1");
    assert.equal(simulateBodyA.ok, true);
    assert.equal(simulateBodyA.decision, "allow");
    assert.equal(simulateBodyA.requiredApprovers, 1);

    const simulateRunChallenge = runSettld([
      "profile",
      "simulate",
      profilePath,
      "--scenario-json",
      JSON.stringify({
        providerId: "openai",
        toolId: "llm.inference",
        amountUsdCents: 120000,
        monthToDateSpendUsdCents: 200000,
        approvalsProvided: 0,
        receiptSigned: true,
        toolManifestHashPresent: true
      }),
      "--format",
      "json"
    ]);
    assert.equal(simulateRunChallenge.status, 0, `stdout:\n${simulateRunChallenge.stdout}\n\nstderr:\n${simulateRunChallenge.stderr}`);
    const simulateBodyChallenge = JSON.parse(simulateRunChallenge.stdout);
    assert.equal(simulateBodyChallenge.decision, "challenge");
    assert.equal(simulateBodyChallenge.requiredApprovers, 1);

    const simulateRunB = runSettld(["profile", "simulate", profilePath, "--scenario", scenarioPath, "--format", "json"]);
    assert.equal(simulateRunB.status, 0, `stdout:\n${simulateRunB.stdout}\n\nstderr:\n${simulateRunB.stderr}`);
    assert.equal(simulateRunA.stdout, simulateRunB.stdout, "simulate output should be deterministic for identical inputs");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test(
  "CLI: settld profile apply dry-run emits deterministic JSON output shape",
  { skip: !PROFILE_APPLY_SUPPORTED },
  async (t) => {
    if (!APPLY_DRY_RUN_FLAG) {
      t.skip("profile apply does not expose a dry-run flag in --help output");
      return;
    }
    if (!APPLY_FORMAT_FLAG) {
      t.skip("profile apply does not expose --format json");
      return;
    }

    const { profilePath } = await createProfileFixture(t, "apply-dry-run.profile.json");
    const runtime = {
      baseUrl: "http://127.0.0.1:1",
      tenantId: "tenant_profile_apply_dry_run",
      bearerToken: "sk_profile_apply_dry_run",
      walletRef: "wallet_profile_apply_dry_run"
    };
    const args = buildApplyArgs({ profilePath, mode: "dry-run", runtime });
    const env = buildRuntimeEnv(runtime);

    const runA = runSettld(args, { env });
    const runB = runSettld(args, { env });

    assert.equal(runA.status, 0, `stdout:\n${runA.stdout}\n\nstderr:\n${runA.stderr}`);
    assert.equal(runB.status, 0, `stdout:\n${runB.stdout}\n\nstderr:\n${runB.stderr}`);

    const outA = parseJson(runA.stdout, "apply dry-run output A");
    const outB = parseJson(runB.stdout, "apply dry-run output B");
    assert.deepEqual(toOutputShape(outA), toOutputShape(outB), "dry-run output shape should remain deterministic");
  }
);

test(
  "CLI: settld profile apply fails when runtime env/args are missing",
  { skip: !PROFILE_APPLY_SUPPORTED },
  async (t) => {
    const { profilePath } = await createProfileFixture(t, "apply-missing-runtime.profile.json");
    const args = buildApplyArgs({ profilePath, mode: "live", runtime: null });
    const run = runSettld(args, { env: clearedRuntimeEnv() });

    assert.notEqual(run.status, 0, "apply without runtime config should fail");
    const combined = `${run.stdout}\n${run.stderr}`.toLowerCase();
    assert.match(combined, /(runtime|base-url|api-url|tenant|bearer|token|wallet|required|missing)/);
  }
);

test(
  "CLI: settld profile apply live calls wallet policy + settlement policy endpoints with tenant/bearer/idempotency headers",
  { skip: !PROFILE_APPLY_SUPPORTED },
  async (t) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      });
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          path: parsedUrl.pathname,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });

        const walletPathMatch = /^\/x402\/wallets\/([^/]+)\/policy$/.exec(parsedUrl.pathname);
        if ((req.method ?? "").toUpperCase() === "PUT" && walletPathMatch) {
          res.writeHead(200, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ ok: true, walletRef: decodeURIComponent(walletPathMatch[1]) }));
          return;
        }
        if ((req.method ?? "").toUpperCase() === "POST" && parsedUrl.pathname === "/marketplace/settlement-policies") {
          res.writeHead(201, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ ok: true, policyId: "policy_apply_test", policyVersion: 1 }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
      });
    });
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    let port = null;
    try {
      ({ port } = await listenLocal(server));
    } catch (err) {
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        t.skip(`loopback listen not permitted (${err.code})`);
        return;
      }
      throw err;
    }

    const { profilePath } = await createProfileFixture(t, "apply-live.profile.json");
    const runtime = {
      baseUrl: `http://127.0.0.1:${port}`,
      tenantId: "tenant_profile_apply_live",
      bearerToken: "sk_profile_apply_live",
      walletRef: "wallet_profile_apply_live"
    };
    const args = buildApplyArgs({ profilePath, mode: "live", runtime });
    const run = await runSettldAsync(args, { env: buildRuntimeEnv(runtime) });

    assert.equal(run.status, 0, `stdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
    assert.equal(requests.length, 2, `expected exactly 2 requests, received ${requests.length}`);

    assert.equal(requests[0].method.toUpperCase(), "PUT");
    const walletPathMatch = /^\/x402\/wallets\/([^/]+)\/policy$/.exec(requests[0].path);
    assert.ok(walletPathMatch, `unexpected wallet policy path: ${requests[0].path}`);
    assert.equal(decodeURIComponent(walletPathMatch[1]), runtime.walletRef);

    assert.equal(requests[1].method.toUpperCase(), "POST");
    assert.equal(requests[1].path, "/marketplace/settlement-policies");

    for (const request of requests) {
      const tenantHeader = String(request.headers["x-tenant-id"] ?? request.headers["x-proxy-tenant-id"] ?? "").trim();
      assert.equal(tenantHeader, runtime.tenantId);

      const authorization = String(request.headers.authorization ?? "").trim();
      assert.equal(authorization, `Bearer ${runtime.bearerToken}`);

      const idempotencyKey = String(request.headers["x-idempotency-key"] ?? "").trim();
      assert.ok(idempotencyKey.length > 0, "x-idempotency-key must be populated");
    }
  }
);
