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

test("CLI smoke: intent -> work-order -> session replay/stream flow", async (t) => {
  const seen = [];
  let acceptedIntentHash = "";

  const api = http.createServer(async (req, res) => {
    const pathOnly = String(req.url || "");
    const method = String(req.method || "").toUpperCase();

    if (method === "POST" && pathOnly === "/intents/propose") {
      const body = await readRequestBody(req);
      seen.push(`${method} ${pathOnly}`);
      acceptedIntentHash = "c".repeat(64);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          intentContract: {
            schemaVersion: "IntentContract.v1",
            intentId: "intent_smoke_1",
            status: "proposed",
            revision: 0,
            proposerAgentId: body?.proposerAgentId ?? "agt_manager_1",
            counterpartyAgentId: body?.counterpartyAgentId ?? "agt_worker_1",
            intentHash: acceptedIntentHash
          }
        })
      );
      return;
    }

    if (method === "POST" && pathOnly === "/intents/intent_smoke_1/accept") {
      seen.push(`${method} ${pathOnly}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          intentContract: {
            schemaVersion: "IntentContract.v1",
            intentId: "intent_smoke_1",
            status: "accepted",
            revision: 1,
            acceptedByAgentId: "agt_manager_1",
            intentHash: acceptedIntentHash
          }
        })
      );
      return;
    }

    if (method === "POST" && pathOnly === "/work-orders") {
      const body = await readRequestBody(req);
      seen.push(`${method} ${pathOnly}`);
      assert.equal(body?.intentBinding?.intentId, "intent_smoke_1");
      assert.equal(body?.intentBinding?.intentHash, acceptedIntentHash);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_smoke_1",
            status: "created",
            revision: 0,
            intentBinding: {
              schemaVersion: "IntentBinding.v1",
              intentId: "intent_smoke_1",
              intentHash: acceptedIntentHash,
              boundAt: "2026-01-01T00:00:00.000Z"
            }
          }
        })
      );
      return;
    }

    if (method === "POST" && pathOnly === "/work-orders/workord_smoke_1/accept") {
      seen.push(`${method} ${pathOnly}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_smoke_1",
            status: "accepted",
            revision: 1
          }
        })
      );
      return;
    }

    if (method === "POST" && pathOnly === "/work-orders/workord_smoke_1/complete") {
      const body = await readRequestBody(req);
      seen.push(`${method} ${pathOnly}`);
      assert.equal(body?.receiptId, "rcpt_smoke_1");
      assert.equal(body?.status, "success");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          workOrder: {
            schemaVersion: "SubAgentWorkOrder.v1",
            workOrderId: "workord_smoke_1",
            status: "completed",
            completionReceiptId: "rcpt_smoke_1",
            revision: 2
          },
          completionReceipt: {
            schemaVersion: "SubAgentCompletionReceipt.v1",
            receiptId: "rcpt_smoke_1",
            workOrderId: "workord_smoke_1",
            status: "success"
          }
        })
      );
      return;
    }

    if (method === "GET" && pathOnly === "/sessions/sess_smoke_1/replay-pack") {
      seen.push(`${method} ${pathOnly}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          replayPack: {
            schemaVersion: "SessionReplayPack.v1",
            sessionId: "sess_smoke_1",
            packHash: "d".repeat(64),
            eventCount: 2
          }
        })
      );
      return;
    }

    if (method === "GET" && pathOnly === "/sessions/sess_smoke_1/events/stream?eventType=TASK_COMPLETED") {
      seen.push(`${method} /sessions/sess_smoke_1/events/stream`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("id: evt_ready\nevent: session.ready\ndata: {\"ok\":true,\"sessionId\":\"sess_smoke_1\"}\n\n");
      res.write("id: evt_done_1\nevent: session.event\ndata: {\"id\":\"evt_done_1\",\"type\":\"TASK_COMPLETED\"}\n\n");
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  const addr = await listen(api);
  t.after(() => {
    api.close();
  });
  const baseUrl = `http://${addr.address}:${addr.port}`;
  const cliPath = path.resolve(process.cwd(), "scripts/agent/cli.mjs");

  const propose = await runNode(
    [
      cliPath,
      "intent",
      "propose",
      "--intent-id",
      "intent_smoke_1",
      "--proposer-agent-id",
      "agt_manager_1",
      "--counterparty-agent-id",
      "agt_worker_1",
      "--objective-json",
      '{"type":"delegation","summary":"book trip"}',
      "--budget-envelope-json",
      '{"currency":"USD","maxAmountCents":3000,"hardCap":true}',
      "--idempotency-key",
      "idem_smoke_intent_propose_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );
  assert.equal(propose.status, 0, propose.stderr);
  assert.equal(JSON.parse(String(propose.stdout).trim())?.intentContract?.status, "proposed");

  const acceptIntent = await runNode(
    [
      cliPath,
      "intent",
      "accept",
      "intent_smoke_1",
      "--accepted-by-agent-id",
      "agt_manager_1",
      "--idempotency-key",
      "idem_smoke_intent_accept_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );
  assert.equal(acceptIntent.status, 0, acceptIntent.stderr);
  assert.equal(JSON.parse(String(acceptIntent.stdout).trim())?.intentContract?.status, "accepted");

  const createWorkOrder = await runNode(
    [
      cliPath,
      "work-order",
      "create",
      "--work-order-id",
      "workord_smoke_1",
      "--principal-agent-id",
      "agt_manager_1",
      "--sub-agent-id",
      "agt_worker_1",
      "--required-capability",
      "travel.booking",
      "--amount-cents",
      "3000",
      "--currency",
      "USD",
      "--intent-binding-json",
      `{"intentId":"intent_smoke_1","intentHash":"${"c".repeat(64)}"}`,
      "--idempotency-key",
      "idem_smoke_work_create_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );
  assert.equal(createWorkOrder.status, 0, createWorkOrder.stderr);
  assert.equal(JSON.parse(String(createWorkOrder.stdout).trim())?.workOrder?.status, "created");

  const acceptWorkOrder = await runNode(
    [
      cliPath,
      "work-order",
      "accept",
      "workord_smoke_1",
      "--accepted-by-agent-id",
      "agt_worker_1",
      "--idempotency-key",
      "idem_smoke_work_accept_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );
  assert.equal(acceptWorkOrder.status, 0, acceptWorkOrder.stderr);
  assert.equal(JSON.parse(String(acceptWorkOrder.stdout).trim())?.workOrder?.status, "accepted");

  const completeWorkOrder = await runNode(
    [
      cliPath,
      "work-order",
      "complete",
      "workord_smoke_1",
      "--receipt-id",
      "rcpt_smoke_1",
      "--status",
      "success",
      "--outputs-json",
      '{"confirmationId":"CONFIRM-1"}',
      "--idempotency-key",
      "idem_smoke_work_complete_1",
      "--json",
      "--base-url",
      baseUrl
    ],
    { cwd: process.cwd() }
  );
  assert.equal(completeWorkOrder.status, 0, completeWorkOrder.stderr);
  assert.equal(JSON.parse(String(completeWorkOrder.stdout).trim())?.completionReceipt?.receiptId, "rcpt_smoke_1");

  const replayPack = await runNode([cliPath, "session", "replay-pack", "sess_smoke_1", "--json", "--base-url", baseUrl], {
    cwd: process.cwd()
  });
  assert.equal(replayPack.status, 0, replayPack.stderr);
  assert.equal(JSON.parse(String(replayPack.stdout).trim())?.replayPack?.packHash, "d".repeat(64));

  const stream = await runNode(
    [
      cliPath,
      "session",
      "stream",
      "sess_smoke_1",
      "--event-type",
      "TASK_COMPLETED",
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
  assert.equal(stream.status, 0, stream.stderr);
  const streamJson = JSON.parse(String(stream.stdout).trim());
  assert.equal(streamJson?.sessionId, "sess_smoke_1");
  assert.equal(streamJson?.events?.length, 2);
  assert.equal(streamJson?.events?.[1]?.data?.type, "TASK_COMPLETED");

  assert.deepEqual(seen, [
    "POST /intents/propose",
    "POST /intents/intent_smoke_1/accept",
    "POST /work-orders",
    "POST /work-orders/workord_smoke_1/accept",
    "POST /work-orders/workord_smoke_1/complete",
    "GET /sessions/sess_smoke_1/replay-pack",
    "GET /sessions/sess_smoke_1/events/stream"
  ]);
});
