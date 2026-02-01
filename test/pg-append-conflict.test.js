import test from "node:test";
import assert from "node:assert/strict";

import { createPgStore } from "../src/db/store-pg.js";
import { createChainedEvent, appendChainedEvent } from "../src/core/event-chain.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: JOB_EVENTS_APPENDED rejects stale prevChainHash (optimistic concurrency)", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = "tenant_default";
  const jobId = `job_${schema}`;

  const storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });
  const storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });

  try {
    const signer = { keyId: storeA.serverSigner.keyId, privateKeyPem: storeA.serverSigner.privateKeyPem };

    const createdAt = new Date().toISOString();
    const createdDraft = createChainedEvent({
      streamId: jobId,
      type: "JOB_CREATED",
      actor: { type: "system", id: "pg_test" },
      payload: { tenantId, templateId: "reset_lite", constraints: {} },
      at: createdAt
    });
    const createdEvents = appendChainedEvent({ events: [], event: createdDraft, signer });
    const createdEvent = createdEvents[createdEvents.length - 1];
    await storeA.commitTx({ at: createdAt, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [createdEvent] }] });

    const base = await storeA.listAggregateEvents({ tenantId, aggregateType: "job", aggregateId: jobId });
    assert.equal(base.length, 1);
    const baseHead = base[base.length - 1].chainHash;

    const makeAppend = (store, suffix) => {
      const draft = createChainedEvent({
        streamId: jobId,
        type: "QUOTE_PROPOSED",
        actor: { type: "pricing", id: "pg_test" },
        payload: { note: `append_${suffix}` },
        at: new Date().toISOString()
      });
      const next = appendChainedEvent({ events: base, event: draft, signer: { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } });
      const ev = next[next.length - 1];
      return store.commitTx({ at: ev.at, ops: [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [ev] }] });
    };

    const [a, b] = await Promise.allSettled([makeAppend(storeA, "a"), makeAppend(storeB, "b")]);
    const rejected = [a, b].filter((r) => r.status === "rejected");
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, "PREV_CHAIN_HASH_MISMATCH");

    const after = await storeA.listAggregateEvents({ tenantId, aggregateType: "job", aggregateId: jobId });
    assert.equal(after.length, 2);
    assert.notEqual(after[after.length - 1].chainHash, baseHead);
  } finally {
    await storeB.close();
    await storeA.close();
  }
});

