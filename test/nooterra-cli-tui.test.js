import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected server address"));
      resolve(addr);
    });
  });
}

async function runNode(args, { cwd = process.cwd(), env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

test("CLI: nooterra tui routes to scripts/tui/cli.mjs", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-tui-route-"));
  const binDir = path.join(tmpRoot, "bin");
  const tuiDir = path.join(tmpRoot, "scripts", "tui");
  const logPath = path.join(tmpRoot, "tui-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(tuiDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "nooterra.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "nooterra.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "NOOTERRA_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(tuiDir, "cli.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.NOOTERRA_TUI_ROUTE_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  const res = spawnSync(
    process.execPath,
    [path.join(binDir, "nooterra.js"), "tui", "--json", "--base-url", "http://127.0.0.1:3000", "--agent-ref", "agent://agt_1"],
    {
      cwd: tmpRoot,
      env: { ...process.env, NOOTERRA_TUI_ROUTE_LOG: logPath },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  assert.equal(res.status, 0, `tui route failed\nstdout:\n${String(res.stdout)}\nstderr:\n${String(res.stderr)}`);

  const argv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(argv, ["--json", "--base-url", "http://127.0.0.1:3000", "--agent-ref", "agent://agt_1"]);
});

test("CLI: nooterra tui --json emits deterministic snapshot", async () => {
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/public/agents/resolve?agent=agent%3A%2F%2Fagt_tui_1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          locator: {
            schemaVersion: "AgentLocator.v1",
            agentRef: "agent://agt_tui_1",
            status: "resolved",
            reasonCode: null,
            matchCount: 1,
            resolved: { tenantId: "tenant_default", agentId: "agt_tui_1", displayName: "TUI Agent" },
            candidates: []
          }
        })
      );
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/sess_tui_1/events?limit=20") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          sessionId: "sess_tui_1",
          events: [{ id: "evt_tui_1", type: "TASK_REQUESTED" }],
          inbox: { ordering: "SESSION_SEQ_ASC", deliveryMode: "resume_then_tail", nextSinceEventId: "evt_tui_1" }
        })
      );
      return;
    }
    if (req.method === "GET" && req.url === "/work-orders/workord_tui_1") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_tui_1",
            tenantId: "tenant_default",
            principalAgentId: "agt_principal",
            subAgentId: "agt_worker",
            requiredCapability: "analysis.generic",
            status: "created",
            pricing: { model: "fixed", amountCents: 100, currency: "USD" },
            specification: {},
            progressEvents: [],
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
            revision: 0
          }
        })
      );
      return;
    }
    if (req.method === "GET" && req.url === "/ops/emergency/controls?limit=20") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND", error: "not found" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND", error: "not found" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const args = [
    path.resolve(process.cwd(), "scripts/tui/cli.mjs"),
    "--json",
    "--base-url",
    baseUrl,
    "--tenant-id",
    "tenant_default",
    "--agent-ref",
    "agent://agt_tui_1",
    "--session-id",
    "sess_tui_1",
    "--work-order-id",
    "workord_tui_1"
  ];

  const first = await runNode(args);
  const second = await runNode(args);
  api.close();

  assert.equal(first.status, 0, `tui json first failed\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
  assert.equal(second.status, 0, `tui json second failed\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`);

  const parsedA = JSON.parse(first.stdout);
  const parsedB = JSON.parse(second.stdout);
  assert.equal(parsedA.schemaVersion, "NooterraTuiState.v1");
  assert.equal(parsedA.ok, true);
  assert.equal(parsedA.panels?.identity?.ok, true);
  assert.equal(parsedA.panels?.session?.ok, true);
  assert.equal(parsedA.panels?.workOrder?.ok, true);
  assert.equal(parsedA.panels?.incidentControls?.ok, false);
  assert.equal(parsedA.panels?.incidentControls?.reasonCode, "NOT_FOUND");
  assert.deepEqual(parsedA, parsedB);
});

test("CLI: nooterra tui fails closed in non-TTY mode unless --json/--non-interactive is provided", async () => {
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/public/agents/resolve?agent=agent%3A%2F%2Fagt_tui_2") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          locator: {
            schemaVersion: "AgentLocator.v1",
            agentRef: "agent://agt_tui_2",
            status: "resolved",
            reasonCode: null,
            matchCount: 1,
            resolved: { tenantId: "tenant_default", agentId: "agt_tui_2", displayName: "TUI Agent 2" },
            candidates: []
          }
        })
      );
      return;
    }
    if (req.method === "GET" && req.url === "/ops/emergency/controls?limit=20") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, controls: [], total: 0 }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "NOT_FOUND", error: "not found" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;

  const interactiveAttempt = await runNode([
    path.resolve(process.cwd(), "scripts/tui/cli.mjs"),
    "--base-url",
    baseUrl,
    "--agent-ref",
    "agent://agt_tui_2"
  ]);
  assert.equal(interactiveAttempt.status, 1, interactiveAttempt.stdout);
  assert.match(interactiveAttempt.stderr, /TUI_REQUIRES_TTY/);

  const nonInteractive = await runNode([
    path.resolve(process.cwd(), "scripts/tui/cli.mjs"),
    "--non-interactive",
    "--base-url",
    baseUrl,
    "--agent-ref",
    "agent://agt_tui_2"
  ]);
  api.close();

  assert.equal(nonInteractive.status, 0, nonInteractive.stderr);
  assert.match(nonInteractive.stdout, /Nooterra TUI v1/);
});
