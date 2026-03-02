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

test("CLI: agent work-order create --json posts expected payload", async () => {
  const observed = { method: null, url: null, headers: null, body: null };
  const api = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/work-orders") {
      observed.method = req.method;
      observed.url = req.url;
      observed.headers = req.headers;
      observed.body = await readRequestBody(req);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_cli_1",
            status: "created",
            revision: 0
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
      "work-order",
      "create",
      "--work-order-id",
      "workord_cli_1",
      "--principal-agent-id",
      "agt_principal_1",
      "--sub-agent-id",
      "agt_sub_1",
      "--required-capability",
      "travel.booking",
      "--amount-cents",
      "2400",
      "--currency",
      "usd",
      "--specification-json",
      '{"task":"book_flight"}',
      "--idempotency-key",
      "idem_work_create_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `work-order create failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.workOrder?.workOrderId, "workord_cli_1");

  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/work-orders");
  assert.equal(observed.headers?.["x-idempotency-key"], "idem_work_create_1");
  assert.equal(observed.body?.workOrderId, "workord_cli_1");
  assert.equal(observed.body?.pricing?.amountCents, 2400);
  assert.equal(observed.body?.pricing?.currency, "USD");
  assert.equal(observed.body?.specification?.task, "book_flight");
});

test("CLI: agent work-order list --json encodes query", async () => {
  let observedUrl = null;
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/work-orders?")) {
      observedUrl = String(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, workOrders: [{ workOrderId: "workord_cli_1" }], limit: 10, offset: 0 }));
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
      "work-order",
      "list",
      "--principal-agent-id",
      "agt_principal_1",
      "--status",
      "created",
      "--limit",
      "10",
      "--offset",
      "0",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `work-order list failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.workOrders?.length, 1);
  assert.equal(observedUrl, "/work-orders?principalAgentId=agt_principal_1&status=created&limit=10&offset=0");
});

test("CLI: agent work-order accept fails closed when idempotency key is missing", async () => {
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");
  const res = await runNode([cliPath, "work-order", "accept", "workord_cli_1"]);

  assert.equal(res.status, 1, "work-order accept should fail");
  assert.match(String(res.stderr), /idempotency-key is required/i);
});

test("CLI: agent work-order complete --json posts expected payload", async () => {
  const observed = { method: null, url: null, body: null };
  const api = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/work-orders/workord_cli_1/complete") {
      observed.method = req.method;
      observed.url = req.url;
      observed.body = await readRequestBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_cli_1",
            status: "completed",
            completionReceiptId: "rcpt_cli_1",
            revision: 2
          },
          completionReceipt: {
            schemaVersion: "SubAgentCompletionReceipt.v1",
            receiptId: "rcpt_cli_1",
            status: "success"
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
      "work-order",
      "complete",
      "workord_cli_1",
      "--receipt-id",
      "rcpt_cli_1",
      "--status",
      "success",
      "--outputs-json",
      '{"bookingId":"BKG-1"}',
      "--metrics-json",
      '{"latencyMs":1200}',
      "--idempotency-key",
      "idem_work_complete_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `work-order complete failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.completionReceipt?.receiptId, "rcpt_cli_1");
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/work-orders/workord_cli_1/complete");
  assert.equal(observed.body?.receiptId, "rcpt_cli_1");
  assert.equal(observed.body?.status, "success");
  assert.equal(observed.body?.outputs?.bookingId, "BKG-1");
});

test("CLI: agent session replay-pack --json encodes signing query", async () => {
  let observedUrl = null;
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/sessions/sess_cli_1/replay-pack")) {
      observedUrl = String(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          replayPack: {
            schemaVersion: "SessionReplayPack.v1",
            sessionId: "sess_cli_1",
            packHash: "a".repeat(64),
            eventCount: 1
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
      "session",
      "replay-pack",
      "sess_cli_1",
      "--sign",
      "--signer-key-id",
      "key_cli_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `session replay-pack failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.replayPack?.sessionId, "sess_cli_1");
  assert.equal(observedUrl, "/sessions/sess_cli_1/replay-pack?sign=true&signerKeyId=key_cli_1");
});

test("CLI: agent session stream --json reads SSE frames", async () => {
  const observed = { url: null, lastEventId: null };
  const api = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url).startsWith("/sessions/sess_cli_1/events/stream")) {
      observed.url = String(req.url);
      observed.lastEventId = req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : null;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("id: evt_ready\nevent: session.ready\ndata: {\"ok\":true}\n\n");
      res.write("id: evt_1\nevent: session.event\ndata: {\"id\":\"evt_1\",\"type\":\"TASK_COMPLETED\"}\n\n");
      res.end();
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
      "session",
      "stream",
      "sess_cli_1",
      "--event-type",
      "TASK_COMPLETED",
      "--last-event-id",
      "evt_prev_1",
      "--max-events",
      "2",
      "--timeout-ms",
      "1500",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );

  api.close();

  assert.equal(res.status, 0, `session stream failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  const parsed = JSON.parse(String(res.stdout).trim());
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.sessionId, "sess_cli_1");
  assert.equal(Array.isArray(parsed?.events), true);
  assert.equal(parsed?.events?.length, 2);
  assert.equal(observed.url, "/sessions/sess_cli_1/events/stream?eventType=TASK_COMPLETED");
  assert.equal(observed.lastEventId, "evt_prev_1");
});
