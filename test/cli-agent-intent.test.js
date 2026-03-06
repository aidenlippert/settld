import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("unexpected server address"));
      resolve(addr);
    });
  });
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text ? JSON.parse(text) : null);
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

test("CLI: agent intent propose --json posts expected payload", async () => {
  const observed = { method: null, url: null, headers: null, body: null };
  const api = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/intents/propose") {
      observed.method = req.method;
      observed.url = req.url;
      observed.headers = req.headers;
      observed.body = await readRequestBody(req);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          intentContract: {
            schemaVersion: "IntentContract.v1",
            intentId: "intent_cli_1",
            status: "proposed",
            revision: 0,
            intentHash: "a".repeat(64)
          }
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");
  const res = await runNode(
    [
      cliPath,
      "intent",
      "propose",
      "--proposer-agent-id",
      "agt_proposer_1",
      "--counterparty-agent-id",
      "agt_counterparty_1",
      "--objective-json",
      '{"type":"delegation","summary":"delegate task"}',
      "--budget-envelope-json",
      '{"currency":"USD","maxAmountCents":1500,"hardCap":true}',
      "--tenant-id",
      "tenant_cli",
      "--proxy-api-key",
      "proxy_key_1",
      "--idempotency-key",
      "idem_cli_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `intent propose failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.intentContract?.intentId, "intent_cli_1");

  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/intents/propose");
  assert.equal(observed.headers?.["x-proxy-tenant-id"], "tenant_cli");
  assert.equal(observed.headers?.["x-proxy-api-key"], "proxy_key_1");
  assert.equal(observed.headers?.["x-idempotency-key"], "idem_cli_1");
  assert.equal(observed.body?.proposerAgentId, "agt_proposer_1");
  assert.equal(observed.body?.counterpartyAgentId, "agt_counterparty_1");
  assert.equal(observed.body?.objective?.type, "delegation");
  assert.equal(observed.body?.budgetEnvelope?.maxAmountCents, 1500);
});

test("CLI: agent intent list --json encodes query filters", async () => {
  let observedUrl = null;
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/intents?")) {
      observedUrl = String(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          intents: [{ intentId: "intent_cli_1" }, { intentId: "intent_cli_2" }],
          limit: 2,
          offset: 1
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");

  const res = await runNode(
    [
      cliPath,
      "intent",
      "list",
      "--proposer-agent-id",
      "agt_proposer_1",
      "--status",
      "accepted",
      "--limit",
      "2",
      "--offset",
      "1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `intent list failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(Array.isArray(parsed?.intents), true);
  assert.equal(parsed?.intents?.length, 2);
  assert.equal(observedUrl, "/intents?proposerAgentId=agt_proposer_1&status=accepted&limit=2&offset=1");
});

test("CLI: agent intent counter --json posts counter request", async () => {
  const observed = { method: null, url: null, body: null };
  const api = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/intents/intent_src_1/counter") {
      observed.method = req.method;
      observed.url = req.url;
      observed.body = await readRequestBody(req);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          intentContract: {
            schemaVersion: "IntentContract.v1",
            intentId: "intent_dst_1",
            counterOfIntentId: "intent_src_1",
            status: "countered",
            revision: 0,
            intentHash: "b".repeat(64)
          }
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");

  const res = await runNode(
    [
      cliPath,
      "intent",
      "counter",
      "intent_src_1",
      "--proposer-agent-id",
      "agt_counterparty_1",
      "--new-intent-id",
      "intent_dst_1",
      "--objective",
      "counter proposal",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `intent counter failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.intentContract?.counterOfIntentId, "intent_src_1");
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/intents/intent_src_1/counter");
  assert.equal(observed.body?.proposerAgentId, "agt_counterparty_1");
  assert.equal(observed.body?.intentId, "intent_dst_1");
  assert.equal(observed.body?.objective, "counter proposal");
});

test("CLI: agent intent accept exits non-zero and emits JSON on API error", async () => {
  const api = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/intents/intent_cli_2/accept") {
      await readRequestBody(req);
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "intent hash mismatch", code: "INTENT_HASH_MISMATCH" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  const addr = await listen(api);
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");

  const res = await runNode(
    [
      cliPath,
      "intent",
      "accept",
      "intent_cli_2",
      "--accepted-by-agent-id",
      "agt_proposer_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 1, `intent accept should fail\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.code, "INTENT_HASH_MISMATCH");
  assert.equal(parsed?.statusCode, 409);
});

test("CLI: agent intent propose fails closed when objective is missing", async () => {
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");
  const res = await runNode([
    cliPath,
    "intent",
    "propose",
    "--proposer-agent-id",
    "agt_proposer_1",
    "--counterparty-agent-id",
    "agt_counterparty_1",
    "--budget-envelope-json",
    '{"currency":"USD","maxAmountCents":1000,"hardCap":true}'
  ]);

  assert.equal(res.status, 1, "intent propose should fail when objective is missing");
  assert.match(String(res.stderr), /objective is required/i);
});
