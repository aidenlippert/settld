import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { listenOnEphemeralLoopback } from "./lib/listen.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pythonAvailable() {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

test("api-sdk-python: stream_session_events parses SSE and sends Last-Event-ID", { skip: !pythonAvailable() }, async (t) => {
  const seen = {
    url: null,
    headers: null,
  };

  const server = http.createServer((req, res) => {
    seen.url = req.url ?? null;
    seen.headers = req.headers ?? {};

    if (
      req.method === "GET" &&
      req.url === "/sessions/sess_py_stream_1/events/stream?eventType=TASK_REQUESTED&sinceEventId=evt_prev_1&checkpointConsumerId=relay_py_1"
    ) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-request-id": "req_py_stream_1",
      });
      res.write('id: evt_ready\nevent: session.ready\ndata: {"ok":true,"sessionId":"sess_py_stream_1"}\n\n');
      res.write(": keepalive\n\n");
      res.write('id: evt_stream_1\nevent: session.event\ndata: {"id":"evt_stream_1","type":"TASK_REQUESTED"}\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "NOT_FOUND" }));
  });

  let port = null;
  try {
    ({ port } = await listenOnEphemeralLoopback(server, { hosts: ["127.0.0.1"] }));
  } catch (err) {
    const cause = err?.cause ?? err;
    if (cause?.code === "EPERM" || cause?.code === "EACCES") {
      t.skip(`loopback listen not permitted (${cause.code})`);
      return;
    }
    throw err;
  }

  try {
    const pythonScript = `
import json
import os
import pathlib
import sys

repo_root = pathlib.Path(os.environ["NOOTERRA_REPO_ROOT"])
sys.path.insert(0, str(repo_root / "packages" / "api-sdk-python"))

from nooterra_api_sdk import NooterraClient

client = NooterraClient(
    base_url=os.environ["NOOTERRA_BASE_URL"],
    tenant_id="tenant_py_stream",
    api_key="sk_test_py_stream",
    timeout_seconds=5,
)

events = []
for event in client.stream_session_events(
    "sess_py_stream_1",
    {"eventType": "TASK_REQUESTED", "sinceEventId": "evt_prev_1", "checkpointConsumerId": "relay_py_1"},
    last_event_id="evt_resume_1",
):
    events.append(event)
    if len(events) >= 2:
        break

print(json.dumps({"events": events}))
`;

    const run = await new Promise((resolve, reject) => {
      const child = spawn("python3", ["-c", pythonScript], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          NOOTERRA_REPO_ROOT: REPO_ROOT,
          NOOTERRA_BASE_URL: `http://127.0.0.1:${port}`,
        },
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
      child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });

    assert.equal(run.status, 0, `python stream_session_events failed\nstdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
    assert.equal(
      seen.url,
      "/sessions/sess_py_stream_1/events/stream?eventType=TASK_REQUESTED&sinceEventId=evt_prev_1&checkpointConsumerId=relay_py_1"
    );
    assert.equal(seen.headers?.accept, "text/event-stream");
    assert.equal(seen.headers?.["last-event-id"], "evt_resume_1");
    assert.equal(seen.headers?.authorization, "Bearer sk_test_py_stream");

    const parsed = JSON.parse(String(run.stdout ?? "{}"));
    assert.equal(Array.isArray(parsed.events), true);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0]?.event, "session.ready");
    assert.equal(parsed.events[0]?.id, "evt_ready");
    assert.equal(parsed.events[0]?.data?.ok, true);
    assert.equal(parsed.events[1]?.event, "session.event");
    assert.equal(parsed.events[1]?.id, "evt_stream_1");
    assert.equal(parsed.events[1]?.data?.type, "TASK_REQUESTED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("api-sdk-python: list_sessions includes status filter parity", { skip: !pythonAvailable() }, async (t) => {
  const seen = {
    url: null,
    method: null,
  };

  const server = http.createServer((req, res) => {
    seen.url = req.url ?? null;
    seen.method = req.method ?? null;
    res.writeHead(200, {
      "content-type": "application/json",
      "x-request-id": "req_py_list_sessions_1",
    });
    res.end(JSON.stringify({ ok: true, sessions: [] }));
  });

  let port = null;
  try {
    ({ port } = await listenOnEphemeralLoopback(server, { hosts: ["127.0.0.1"] }));
  } catch (err) {
    const cause = err?.cause ?? err;
    if (cause?.code === "EPERM" || cause?.code === "EACCES") {
      t.skip(`loopback listen not permitted (${cause.code})`);
      return;
    }
    throw err;
  }

  try {
    const pythonScript = `
import os
import pathlib
import sys

repo_root = pathlib.Path(os.environ["NOOTERRA_REPO_ROOT"])
sys.path.insert(0, str(repo_root / "packages" / "api-sdk-python"))

from nooterra_api_sdk import NooterraClient

client = NooterraClient(
    base_url=os.environ["NOOTERRA_BASE_URL"],
    tenant_id="tenant_py_sessions_list",
    api_key="sk_test_py_sessions_list",
)

client.list_sessions(
    {
        "sessionId": "sess_1",
        "participantAgentId": "agt_worker",
        "visibility": "tenant",
        "status": "open",
        "limit": 20,
        "offset": 0,
    },
)
`;
    const run = await new Promise((resolve, reject) => {
      const child = spawn("python3", ["-c", pythonScript], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          NOOTERRA_REPO_ROOT: REPO_ROOT,
          NOOTERRA_BASE_URL: `http://127.0.0.1:${port}`,
        },
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
      child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    });

    assert.equal(run.status, 0, `python list_sessions status parity failed\nstdout:\n${run.stdout}\n\nstderr:\n${run.stderr}`);
    assert.equal(seen.method, "GET");
    const parsedUrl = new URL(String(seen.url ?? "/"), "http://127.0.0.1");
    assert.equal(parsedUrl.pathname, "/sessions");
    assert.deepEqual(Object.fromEntries(parsedUrl.searchParams.entries()), {
      sessionId: "sess_1",
      participantAgentId: "agt_worker",
      visibility: "tenant",
      status: "open",
      limit: "20",
      offset: "0",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("api-sdk-python: append_session_event fails closed when chain hash or body.type are missing", { skip: !pythonAvailable() }, () => {
  const script = [
    "import json, pathlib, sys",
    "repo = pathlib.Path.cwd()",
    "sys.path.insert(0, str(repo / 'packages' / 'api-sdk-python'))",
    "from nooterra_api_sdk import NooterraClient",
    "calls = []",
    "def fake(method, path, **kwargs):",
    "    calls.append({'method': method, 'path': path, 'idempotencyKey': kwargs.get('idempotency_key')})",
    "    return {'ok': True, 'status': 201, 'requestId': 'req_py_append_session_1', 'body': {'ok': True}}",
    "client = NooterraClient(base_url='https://api.nooterra.local', tenant_id='tenant_py_append_session')",
    "client._request = fake",
    "errors = {}",
    "def capture(name, fn):",
    "    try:",
    "        fn()",
    "        errors[name] = None",
    "    except Exception as exc:",
    "        errors[name] = str(exc)",
    "capture('missingPrevChainHash', lambda: client.append_session_event('sess_1', {'type': 'TASK_REQUESTED', 'payload': {'text': 'hi'}}))",
    "capture('missingBodyType', lambda: client.append_session_event('sess_1', {'payload': {'text': 'hi'}}, expected_prev_chain_hash='0'*64))",
    "print(json.dumps({'errors': errors, 'calls': calls}))",
  ].join("\n");

  const run = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `python append_session_event fail-closed check failed\n\nstdout:\n${run.stdout ?? ""}\n\nstderr:\n${run.stderr ?? ""}`
  );

  const parsed = JSON.parse(String(run.stdout ?? "{}"));
  assert.deepEqual(parsed.calls, []);
  assert.match(String(parsed.errors?.missingPrevChainHash ?? ""), /expected_prev_chain_hash|expectedPrevChainHash/);
  assert.match(String(parsed.errors?.missingBodyType ?? ""), /body\.type|body.type/);
});
