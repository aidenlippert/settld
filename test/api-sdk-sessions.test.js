import test from "node:test";
import assert from "node:assert/strict";

import { NooterraClient } from "../packages/api-sdk/src/index.js";

function makeJsonResponse(body, { status = 200, requestId = "req_test_sdk_sessions_1" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  });
}

function makeSseResponse(chunks, { status = 200, requestId = "req_test_sdk_sessions_stream_1" } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    {
      status,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": requestId
      }
    }
  );
}

test("api-sdk: session methods call expected endpoints", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/sessions") && String(init?.method) === "POST") {
      return makeJsonResponse({ session: { sessionId: "sess_sdk_1" } }, { status: 201 });
    }
    if (String(url).includes("/sessions?") && String(init?.method) === "GET") {
      return makeJsonResponse({ sessions: [{ sessionId: "sess_sdk_1" }], total: 1, limit: 20, offset: 0 });
    }
    if (String(url).endsWith("/sessions/sess_sdk_1") && String(init?.method) === "GET") {
      return makeJsonResponse({ session: { sessionId: "sess_sdk_1" } });
    }
    if (String(url).includes("/sessions/sess_sdk_1/events?") && String(init?.method) === "GET") {
      return makeJsonResponse({
        sessionId: "sess_sdk_1",
        events: [{ id: "evt_sdk_1", type: "TASK_REQUESTED" }],
        limit: 20,
        offset: 0
      });
    }
    if (String(url).includes("/sessions/sess_sdk_1/events/checkpoint?") && String(init?.method) === "GET") {
      return makeJsonResponse({
        checkpoint: {
          schemaVersion: "SessionEventInboxRelayCheckpoint.v1",
          sessionId: "sess_sdk_1",
          consumerId: "relay_sdk_1",
          sinceEventId: "evt_sdk_1"
        }
      });
    }
    if (String(url).endsWith("/sessions/sess_sdk_1/events/checkpoint") && String(init?.method) === "POST") {
      return makeJsonResponse({
        checkpoint: {
          schemaVersion: "SessionEventInboxRelayCheckpoint.v1",
          sessionId: "sess_sdk_1",
          consumerId: "relay_sdk_1",
          sinceEventId: "evt_sdk_1"
        }
      });
    }
    if (String(url).endsWith("/sessions/sess_sdk_1/events/checkpoint/requeue") && String(init?.method) === "POST") {
      return makeJsonResponse({
        checkpoint: {
          schemaVersion: "SessionEventInboxRelayCheckpoint.v1",
          sessionId: "sess_sdk_1",
          consumerId: "relay_sdk_1",
          sinceEventId: null
        }
      });
    }
    if (String(url).endsWith("/sessions/sess_sdk_1/events") && String(init?.method) === "POST") {
      return makeJsonResponse({ sessionId: "sess_sdk_1", event: { id: "evt_sdk_2" }, currentPrevChainHash: "a".repeat(64) }, { status: 201 });
    }
    if (String(url).includes("/sessions/sess_sdk_1/replay-pack") && String(init?.method) === "GET") {
      return makeJsonResponse({ replayPack: { sessionId: "sess_sdk_1", schemaVersion: "SessionReplayPack.v1" } });
    }
    if (String(url).includes("/sessions/sess_sdk_1/transcript") && String(init?.method) === "GET") {
      return makeJsonResponse({ transcript: { sessionId: "sess_sdk_1", schemaVersion: "SessionTranscript.v1" } });
    }
    if (String(url).includes("/sessions/sess_sdk_1/events/stream?") && String(init?.method) === "GET") {
      return makeSseResponse([
        "id: evt_ready\nevent: session.ready\ndata: {\"ok\":true,\"sessionId\":\"sess_sdk_1\"}\n\n",
        ": keepalive\n\n",
        "id: evt_sdk_3\nevent: session.event\ndata: {\"id\":\"evt_sdk_3\",\"type\":\"TASK_REQUESTED\"}\n\n"
      ]);
    }
    return makeJsonResponse({}, { status: 404 });
  };

  const client = new NooterraClient({
    baseUrl: "https://api.nooterra.local",
    tenantId: "tenant_sdk",
    fetch: fetchStub
  });

  await client.createSession({
    sessionId: "sess_sdk_1",
    participants: [{ agentId: "agt_manager" }, { agentId: "agt_worker" }],
    visibility: "tenant"
  });
  assert.equal(calls[0].url, "https://api.nooterra.local/sessions");
  assert.equal(calls[0].init?.method, "POST");

  await client.listSessions({
    participantAgentId: "agt_manager",
    status: "open",
    limit: 20,
    offset: 0
  });
  assert.equal(calls[1].url, "https://api.nooterra.local/sessions?participantAgentId=agt_manager&status=open&limit=20&offset=0");
  assert.equal(calls[1].init?.method, "GET");

  await client.getSession("sess_sdk_1");
  assert.equal(calls[2].url, "https://api.nooterra.local/sessions/sess_sdk_1");
  assert.equal(calls[2].init?.method, "GET");

  await client.listSessionEvents("sess_sdk_1", {
    eventType: "TASK_REQUESTED",
    sinceEventId: "evt_prev_1",
    checkpointConsumerId: "relay_sdk_1",
    limit: 20,
    offset: 0
  });
  assert.equal(
    calls[3].url,
    "https://api.nooterra.local/sessions/sess_sdk_1/events?eventType=TASK_REQUESTED&sinceEventId=evt_prev_1&checkpointConsumerId=relay_sdk_1&limit=20&offset=0"
  );
  assert.equal(calls[3].init?.method, "GET");

  await client.getSessionEventCheckpoint("sess_sdk_1", "relay_sdk_1");
  assert.equal(calls[4].url, "https://api.nooterra.local/sessions/sess_sdk_1/events/checkpoint?checkpointConsumerId=relay_sdk_1");
  assert.equal(calls[4].init?.method, "GET");

  await client.ackSessionEventCheckpoint("sess_sdk_1", {
    checkpointConsumerId: "relay_sdk_1",
    sinceEventId: "evt_sdk_1"
  });
  assert.equal(calls[5].url, "https://api.nooterra.local/sessions/sess_sdk_1/events/checkpoint");
  assert.equal(calls[5].init?.method, "POST");

  await client.requeueSessionEventCheckpoint("sess_sdk_1", {
    checkpointConsumerId: "relay_sdk_1",
    sinceEventId: null
  });
  assert.equal(calls[6].url, "https://api.nooterra.local/sessions/sess_sdk_1/events/checkpoint/requeue");
  assert.equal(calls[6].init?.method, "POST");

  await client.appendSessionEvent(
    "sess_sdk_1",
    {
      type: "TASK_REQUESTED",
      payload: { task: "plan trip" }
    },
    {
      expectedPrevChainHash: "a".repeat(64)
    }
  );
  assert.equal(calls[7].url, "https://api.nooterra.local/sessions/sess_sdk_1/events");
  assert.equal(calls[7].init?.method, "POST");

  await client.getSessionReplayPack("sess_sdk_1", {
    sign: true,
    signerKeyId: "key_session_signer_1"
  });
  assert.equal(
    calls[8].url,
    "https://api.nooterra.local/sessions/sess_sdk_1/replay-pack?sign=true&signerKeyId=key_session_signer_1"
  );
  assert.equal(calls[8].init?.method, "GET");

  await client.getSessionTranscript("sess_sdk_1", { sign: true });
  assert.equal(calls[9].url, "https://api.nooterra.local/sessions/sess_sdk_1/transcript?sign=true");
  assert.equal(calls[9].init?.method, "GET");

  const streamEvents = [];
  for await (const event of client.streamSessionEvents(
    "sess_sdk_1",
    {
      eventType: "TASK_REQUESTED",
      sinceEventId: "evt_prev_1",
      checkpointConsumerId: "relay_sdk_1"
    },
    {
      lastEventId: "evt_resume_1"
    }
  )) {
    streamEvents.push(event);
  }
  assert.equal(
    calls[10].url,
    "https://api.nooterra.local/sessions/sess_sdk_1/events/stream?eventType=TASK_REQUESTED&sinceEventId=evt_prev_1&checkpointConsumerId=relay_sdk_1"
  );
  assert.equal(calls[10].init?.method, "GET");
  assert.equal(calls[10].init?.headers?.["last-event-id"], "evt_resume_1");
  assert.equal(calls[10].init?.headers?.accept, "text/event-stream");
  assert.equal(streamEvents.length, 2);
  assert.equal(streamEvents[0].event, "session.ready");
  assert.equal(streamEvents[0].id, "evt_ready");
  assert.equal(streamEvents[1].event, "session.event");
  assert.equal(streamEvents[1].id, "evt_sdk_3");
});
