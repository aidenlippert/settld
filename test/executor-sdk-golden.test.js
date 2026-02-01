import test from "node:test";
import assert from "node:assert/strict";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { finalizeChainedEvent as finalizeCore } from "../src/core/event-chain.js";
import { finalizeChainedEvent as finalizeSdk } from "../packages/executor-sdk/src/event-chain.js";

test("executor-sdk: golden transcript matches server hashing/signing", () => {
  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);

  const signer = { keyId, privateKeyPem };
  const event = {
    v: 1,
    id: "evt_test_1",
    at: "2026-01-01T00:00:00.000Z",
    streamId: "job_test_1",
    type: "JOB_HEARTBEAT",
    actor: { type: "robot", id: "rob_test_1" },
    payload: { jobId: "job_test_1", robotId: "rob_test_1", t: "2026-01-01T00:00:00.000Z", stage: "TASK", progress: 0.5 }
  };

  const prevChainHash = "chain_prev_test";

  const core = finalizeCore({ event: { ...event, payloadHash: null, prevChainHash: null, chainHash: null, signature: null, signerKeyId: null }, prevChainHash, signer });
  const sdk = finalizeSdk({ event: { ...event, payloadHash: null, prevChainHash: null, chainHash: null, signature: null, signerKeyId: null }, prevChainHash, signer });

  assert.equal(sdk.payloadHash, core.payloadHash);
  assert.equal(sdk.chainHash, core.chainHash);
  assert.equal(sdk.signature, core.signature);
  assert.equal(sdk.signerKeyId, core.signerKeyId);
});

