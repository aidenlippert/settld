import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent, verifyChainedEvents } from "../src/core/event-chain.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.6: revoked signer key cannot append new events; old events remain verifiable", async () => {
  const api = createApi();

  const { publicKeyPem: robotPublicKeyPem, privateKeyPem: robotPrivateKeyPem } = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotPublicKeyPem);

  const regRobot = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_keys", publicKeyPem: robotPublicKeyPem } });
  assert.equal(regRobot.statusCode, 201);
  let lastChainHash = regRobot.json.robot.lastChainHash;

  const hb1Draft = createChainedEvent({
    streamId: "rob_keys",
    type: "ROBOT_HEARTBEAT",
    actor: { type: "robot", id: "rob_keys" },
    payload: { batteryPct: 0.5 },
    at: new Date().toISOString()
  });
  const hb1 = finalizeChainedEvent({ event: hb1Draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
  const hb1Res = await request(api, { method: "POST", path: "/robots/rob_keys/events", body: hb1 });
  assert.equal(hb1Res.statusCode, 201);
  lastChainHash = hb1Res.json.robot.lastChainHash;

  const revoke = await request(api, { method: "POST", path: `/ops/signer-keys/${robotKeyId}/revoke`, body: {} });
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.json.signerKey.status, "revoked");

  const hb2Draft = createChainedEvent({
    streamId: "rob_keys",
    type: "ROBOT_HEARTBEAT",
    actor: { type: "robot", id: "rob_keys" },
    payload: { batteryPct: 0.6 },
    at: new Date().toISOString()
  });
  const hb2 = finalizeChainedEvent({ event: hb2Draft, prevChainHash: lastChainHash, signer: { keyId: robotKeyId, privateKeyPem: robotPrivateKeyPem } });
  const hb2Res = await request(api, { method: "POST", path: "/robots/rob_keys/events", body: hb2 });
  assert.equal(hb2Res.statusCode, 400);

  // Previously accepted events remain verifiable.
  const eventsRes = await request(api, { method: "GET", path: "/robots/rob_keys/events" });
  assert.equal(eventsRes.statusCode, 200);
  const verify = verifyChainedEvents(eventsRes.json.events, { publicKeyByKeyId: api.store.publicKeyByKeyId });
  assert.equal(verify.ok, true);
});

