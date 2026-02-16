import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { rm, readFile } from "node:fs/promises";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("unexpected server address"));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

test("demo:mcp-paid-exa script completes and writes PASS artifact bundle", async () => {
  const apiPort = await reservePort();
  const upstreamPort = await reservePort();
  const gatewayPort = await reservePort();
  const artifactDir = path.join(process.cwd(), "artifacts", "mcp-paid-exa", `test-${Date.now()}`);

  await rm(artifactDir, { recursive: true, force: true });

  const child = spawn(process.execPath, ["scripts/demo/mcp-paid-exa.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SETTLD_DEMO_API_PORT: String(apiPort),
      SETTLD_DEMO_UPSTREAM_PORT: String(upstreamPort),
      SETTLD_DEMO_GATEWAY_PORT: String(gatewayPort),
      SETTLD_DEMO_KEEP_ALIVE: "0",
      SETTLD_DEMO_QUERY: "dentist chicago",
      SETTLD_DEMO_NUM_RESULTS: "2",
      SETTLD_DEMO_ARTIFACT_DIR: artifactDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exit = await Promise.race([
    new Promise((resolve) => child.once("close", (code) => resolve({ code, timeout: false }))),
    sleep(90_000).then(() => ({ code: null, timeout: true }))
  ]);

  if (exit.timeout) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    assert.fail(`demo script timed out; stderr=${stderr}`);
  }

  assert.equal(exit.code, 0, `expected demo to pass; stdout=${stdout}\nstderr=${stderr}`);
  assert.match(stdout, /PASS artifactDir=/);

  const summaryRaw = await readFile(path.join(artifactDir, "summary.json"), "utf8");
  const summary = JSON.parse(summaryRaw);
  assert.equal(summary.ok, true, `summary failed: ${summaryRaw}`);
  assert.equal(summary.passChecks?.providerSignature, true);
  assert.equal(summary.passChecks?.tokenVerified, true);
  assert.equal(summary.passChecks?.reserveTracked, true);
  assert.equal(summary.circleMode, "stub");
  assert.equal(typeof summary.circleReserveId, "string");
  assert.ok(summary.circleReserveId.length > 0);

  const reserveStateRaw = await readFile(path.join(artifactDir, "reserve-state.json"), "utf8");
  const reserveState = JSON.parse(reserveStateRaw);
  assert.equal(reserveState.mode, "stub");
  assert.equal(typeof reserveState.circleReserveId, "string");
  assert.ok(Array.isArray(reserveState.transitions));
  assert.ok(reserveState.transitions.length >= 2);
  assert.equal(reserveState.payoutDestination?.type, "agent_wallet");
});
