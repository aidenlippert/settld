import test from "node:test";
import assert from "node:assert/strict";

import { createChainedEvent, finalizeChainedEvent, verifyChainedEvents } from "../src/core/event-chain.js";

test("event chain: normalizes undefined object fields before hashing", () => {
  const draft = createChainedEvent({
    streamId: "job_norm",
    type: "QUOTE_PROPOSED",
    actor: { type: "system", id: "proxy", extra: undefined },
    payload: { a: 1, b: undefined, nested: { c: undefined, d: 2 } }
  });

  const finalized = finalizeChainedEvent({ event: draft, prevChainHash: null, signer: null });

  assert.deepEqual(finalized.actor, { id: "proxy", type: "system" });
  assert.deepEqual(finalized.payload, { a: 1, nested: { d: 2 } });

  const verify = verifyChainedEvents([finalized], { publicKeyByKeyId: new Map() });
  assert.equal(verify.ok, true);
});

test("event chain: rejects undefined in arrays (ambiguous JSON semantics)", () => {
  const draft = createChainedEvent({
    streamId: "job_norm_array",
    type: "QUOTE_PROPOSED",
    actor: { type: "system", id: "proxy" },
    payload: { list: [1, undefined, 3] }
  });

  assert.throws(() => finalizeChainedEvent({ event: draft, prevChainHash: null, signer: null }), /undefined/);
});

