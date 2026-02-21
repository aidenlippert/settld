import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => {
        if (!Number.isInteger(port) || port <= 0) {
          reject(new Error("failed to allocate port"));
          return;
        }
        resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  if (lastErr) throw lastErr;
  throw new Error("timeout waiting for condition");
}

function startNodeProcess({ name, script, env }) {
  const logs = [];
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const pushLog = (line) => {
    if (!line) return;
    logs.push(line);
    if (logs.length > 200) logs.shift();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) pushLog(`[${name}:stdout] ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) pushLog(`[${name}:stderr] ${line}`);
  });
  return { child, logs };
}

async function stopProc(proc) {
  if (!proc || typeof proc.kill !== "function") return;
  if (proc.exitCode !== null && proc.exitCode !== undefined) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    new Promise((resolve) => proc.once("exit", () => resolve(true))),
    sleep(3000).then(() => false)
  ]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

async function httpJson({ baseUrl, method, route, headers = {}, body = undefined }) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

test("live contract: magic-link onboarding runtime flow stays green against real local API", async () => {
  const opsToken = `tok_ops_${crypto.randomBytes(6).toString("hex")}`;
  const apiPort = await pickPort();
  const magicPort = await pickPort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-ml-live-contract-"));

  const api = startNodeProcess({
    name: "api",
    script: "src/api/server.js",
    env: {
      PORT: String(apiPort),
      PROXY_BIND_HOST: "127.0.0.1",
      PROXY_OPS_TOKEN: opsToken,
      PROXY_AUTOTICK_INTERVAL_MS: "200"
    }
  });
  const magic = startNodeProcess({
    name: "magic-link",
    script: "services/magic-link/src/server.js",
    env: {
      MAGIC_LINK_HOST: "127.0.0.1",
      MAGIC_LINK_PORT: String(magicPort),
      MAGIC_LINK_DATA_DIR: dataDir,
      MAGIC_LINK_PUBLIC_SIGNUP_ENABLED: "1",
      MAGIC_LINK_ARCHIVE_EXPORT_ENABLED: "0",
      MAGIC_LINK_SETTLD_API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      MAGIC_LINK_SETTLD_OPS_TOKEN: opsToken
    }
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  const magicBase = `http://127.0.0.1:${magicPort}`;

  try {
    await waitFor(async () => {
      if (api.child.exitCode !== null) {
        throw new Error(`api exited early (${api.child.exitCode})`);
      }
      const res = await fetch(`${apiBase}/healthz`).catch(() => null);
      return Boolean(res && res.ok);
    }, { timeoutMs: 30_000, intervalMs: 250 });

    await waitFor(async () => {
      if (magic.child.exitCode !== null) {
        throw new Error(`magic-link exited early (${magic.child.exitCode})`);
      }
      const res = await fetch(`${magicBase}/health`).catch(() => null);
      return Boolean(res && res.ok);
    }, { timeoutMs: 30_000, intervalMs: 250 });

    const signup = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: "/v1/public/signup",
      body: {
        email: "founder@settld.work",
        company: "Settld",
        name: "Founding User"
      }
    });
    assert.equal(signup.status, 201, signup.text);
    assert.equal(signup.json?.ok, true, signup.text);
    const tenantId = String(signup.json?.tenantId ?? "");
    assert.ok(tenantId.length > 0, "tenantId must be returned");

    const bootstrap = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap`,
      body: {}
    });
    assert.equal(bootstrap.status, 201, bootstrap.text);
    assert.equal(bootstrap.json?.ok, true, bootstrap.text);
    const mcpEnv = bootstrap.json?.mcp?.env ?? null;
    assert.ok(mcpEnv && typeof mcpEnv === "object", "runtime bootstrap must return mcp.env");
    assert.equal(typeof mcpEnv.SETTLD_API_KEY, "string", "runtime bootstrap must return API key token");

    const smoke = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap/smoke-test`,
      body: { env: mcpEnv }
    });
    assert.equal(smoke.status, 200, smoke.text);
    assert.equal(smoke.json?.ok, true, smoke.text);
    assert.ok(Number.isInteger(smoke.json?.smoke?.toolsCount), "smoke test must include toolsCount");

    const firstPaidCall = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call`,
      body: {}
    });
    assert.equal(firstPaidCall.status, 200, firstPaidCall.text);
    assert.equal(firstPaidCall.json?.ok, true, firstPaidCall.text);
    assert.equal(firstPaidCall.json?.verificationStatus, "green", firstPaidCall.text);
    assert.equal(firstPaidCall.json?.settlementStatus, "released", firstPaidCall.text);
    const attemptId = String(firstPaidCall.json?.attemptId ?? "");
    assert.ok(attemptId.length > 0, "first-paid-call must return attemptId");

    const history = await httpJson({
      baseUrl: magicBase,
      method: "GET",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call/history`
    });
    assert.equal(history.status, 200, history.text);
    assert.equal(history.json?.ok, true, history.text);
    assert.ok(Array.isArray(history.json?.attempts), "history must include attempts[]");
    assert.ok(history.json.attempts.some((row) => row?.attemptId === attemptId), "history must include latest attempt");

    const idemKey = `idem_${crypto.randomBytes(6).toString("hex")}`;
    const conformance = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/conformance-matrix`,
      headers: { "x-idempotency-key": idemKey },
      body: { targets: ["codex", "claude", "cursor", "openclaw"] }
    });
    assert.equal(conformance.status, 200, conformance.text);
    assert.equal(conformance.json?.ok, true, conformance.text);
    assert.equal(conformance.json?.matrix?.ready, true, conformance.text);
    const checks = Array.isArray(conformance.json?.matrix?.checks) ? conformance.json.matrix.checks : [];
    const checkStatus = new Map(checks.map((row) => [row?.checkId, row?.status]));
    assert.equal(checkStatus.get("runtime_bootstrap"), "pass", conformance.text);
    assert.equal(checkStatus.get("mcp_smoke"), "pass", conformance.text);
    assert.equal(checkStatus.get("first_paid_call"), "pass", conformance.text);
    assert.equal(conformance.json?.idempotency?.reused, false, conformance.text);

    const conformanceReplay = await httpJson({
      baseUrl: magicBase,
      method: "POST",
      route: `/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/conformance-matrix`,
      headers: { "x-idempotency-key": idemKey },
      body: { targets: ["codex"] }
    });
    assert.equal(conformanceReplay.status, 200, conformanceReplay.text);
    assert.equal(conformanceReplay.json?.idempotency?.reused, true, conformanceReplay.text);
  } catch (err) {
    const apiLogs = api.logs.join("\n");
    const magicLogs = magic.logs.join("\n");
    err.message = `${err.message}\n--- api logs ---\n${apiLogs}\n--- magic-link logs ---\n${magicLogs}`;
    throw err;
  } finally {
    await stopProc(magic.child);
    await stopProc(api.child);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, { timeout: 120_000 });
