import test from "node:test";
import assert from "node:assert/strict";

import { NooterraClient } from "../packages/api-sdk/src/index.js";

function makeJsonResponse(body, { status = 200, requestId = "req_test_sdk_intents_1" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId
    }
  });
}

test("api-sdk: intent methods call expected endpoints", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/intents/propose") && String(init?.method) === "POST") {
      return makeJsonResponse({ intentContract: { intentId: "intent_sdk_1" } }, { status: 201 });
    }
    if (String(url).includes("/intents?") && String(init?.method) === "GET") {
      return makeJsonResponse({ intents: [{ intentId: "intent_sdk_1" }], limit: 20, offset: 0 });
    }
    if (String(url).endsWith("/intents/intent_sdk_1") && String(init?.method) === "GET") {
      return makeJsonResponse({ intentContract: { intentId: "intent_sdk_1" } });
    }
    if (String(url).endsWith("/intents/intent_sdk_1/counter") && String(init?.method) === "POST") {
      return makeJsonResponse({ intentContract: { intentId: "intent_sdk_2", counterOfIntentId: "intent_sdk_1" } }, { status: 201 });
    }
    if (String(url).endsWith("/intents/intent_sdk_2/accept") && String(init?.method) === "POST") {
      return makeJsonResponse({ intentContract: { intentId: "intent_sdk_2", status: "accepted" } });
    }
    return makeJsonResponse({}, { status: 404 });
  };

  const client = new NooterraClient({
    baseUrl: "https://api.nooterra.local",
    tenantId: "tenant_sdk",
    fetch: fetchStub
  });

  await client.proposeIntentContract({
    intentId: "intent_sdk_1",
    proposerAgentId: "agt_proposer_1",
    counterpartyAgentId: "agt_counterparty_1",
    objective: { type: "delegation", summary: "delegate task" },
    budgetEnvelope: { currency: "USD", maxAmountCents: 1000, hardCap: true }
  });
  assert.equal(calls[0].url, "https://api.nooterra.local/intents/propose");
  assert.equal(calls[0].init?.method, "POST");

  await client.listIntentContracts({
    proposerAgentId: "agt_proposer_1",
    status: "accepted",
    limit: 20,
    offset: 0
  });
  assert.equal(calls[1].url, "https://api.nooterra.local/intents?proposerAgentId=agt_proposer_1&status=accepted&limit=20&offset=0");
  assert.equal(calls[1].init?.method, "GET");

  await client.getIntentContract("intent_sdk_1");
  assert.equal(calls[2].url, "https://api.nooterra.local/intents/intent_sdk_1");
  assert.equal(calls[2].init?.method, "GET");

  await client.counterIntentContract("intent_sdk_1", {
    proposerAgentId: "agt_counterparty_1",
    objective: { type: "delegation", summary: "counter proposal" }
  });
  assert.equal(calls[3].url, "https://api.nooterra.local/intents/intent_sdk_1/counter");
  assert.equal(calls[3].init?.method, "POST");

  await client.acceptIntentContract("intent_sdk_2", {
    acceptedByAgentId: "agt_proposer_1"
  });
  assert.equal(calls[4].url, "https://api.nooterra.local/intents/intent_sdk_2/accept");
  assert.equal(calls[4].init?.method, "POST");
});
