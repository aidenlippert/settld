import test from "node:test";
import assert from "node:assert/strict";

import { createChainedEvent, appendChainedEvent, verifyChainedEvents } from "../src/core/event-chain.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";

test("event chain: verifies hashes and signatures", () => {
  let events = [];

  events = appendChainedEvent({
    events,
    event: createChainedEvent({
      streamId: "job_test",
      type: "JOB_CREATED",
      actor: { type: "system", id: "proxy" },
      payload: { templateId: "reset_lite" },
      at: "2026-01-26T00:00:00.000Z"
    })
  });

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);

  events = appendChainedEvent({
    events,
    event: createChainedEvent({ streamId: "job_test", type: "EN_ROUTE", actor: { type: "robot", id: "rob_1" }, payload: { etaSeconds: 10 }, at: "2026-01-26T00:01:00.000Z" }),
    signer: { keyId, privateKeyPem }
  });

  const verify = verifyChainedEvents(events, { publicKeyByKeyId: new Map([[keyId, publicKeyPem]]) });
  assert.equal(verify.ok, true);
});

test("event chain: detects tampering", () => {
  let events = [];
  events = appendChainedEvent({
    events,
    event: createChainedEvent({
      streamId: "job_test",
      type: "JOB_CREATED",
      actor: { type: "system", id: "proxy" },
      payload: { templateId: "reset_lite" },
      at: "2026-01-26T00:00:00.000Z"
    })
  });
  events = appendChainedEvent({
    events,
    event: createChainedEvent({ streamId: "job_test", type: "TELEMETRY", actor: { type: "robot", id: "rob_1" }, payload: { batteryPct: 1 }, at: "2026-01-26T00:01:00.000Z" })
  });

  const tampered = events.map((e) => ({ ...e }));
  tampered[1].payload = { batteryPct: 0 };

  const verify = verifyChainedEvents(tampered);
  assert.equal(verify.ok, false);
  assert.match(verify.error, /payloadHash mismatch|chainHash mismatch/);
});
