import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function registerAgent(api, agentId) {
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `register_${agentId}` },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId: "svc_marketplace_pg_test" },
      publicKeyPem: createEd25519Keypair().publicKeyPem,
      capabilities: ["translate", "summarize"]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
}

(databaseUrl ? test : test.skip)("pg api e2e: marketplace capability listings survive refresh and delete", async () => {
  const schema = makeSchema();
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

  try {
    const api = createApi({ store });
    await registerAgent(api, "agt_listing_seller_pg");

    const created = await request(api, {
      method: "POST",
      path: "/marketplace/capability-listings",
      headers: { "x-idempotency-key": "pg_capability_listing_create_1" },
      body: {
        listingId: "cap_translate_pg_1",
        capability: "translate",
        title: "Translation PG",
        sellerAgentId: "agt_listing_seller_pg",
        status: "active",
        tags: ["translation", "pg"],
        priceModel: {
          mode: "fixed",
          amountCents: 2500,
          currency: "USD"
        }
      }
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json?.listing?.listingId, "cap_translate_pg_1");

    await store.refreshFromDb();

    const fetched = await request(api, {
      method: "GET",
      path: "/marketplace/capability-listings/cap_translate_pg_1"
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json?.listing?.listingId, "cap_translate_pg_1");

    const listed = await request(api, {
      method: "GET",
      path: "/marketplace/capability-listings?status=active&limit=20&offset=0"
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json?.total, 1);
    assert.equal(listed.json?.listings?.[0]?.listingId, "cap_translate_pg_1");

    const deleted = await request(api, {
      method: "DELETE",
      path: "/marketplace/capability-listings/cap_translate_pg_1",
      headers: { "x-idempotency-key": "pg_capability_listing_delete_1" }
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json?.deleted, true);

    await store.refreshFromDb();

    const fetchedAfterDelete = await request(api, {
      method: "GET",
      path: "/marketplace/capability-listings/cap_translate_pg_1"
    });
    assert.equal(fetchedAfterDelete.statusCode, 404, fetchedAfterDelete.body);

    const count = await store.pg.pool.query(
      "SELECT COUNT(*)::int AS c FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'marketplace_capability_listing'",
      ["tenant_default"]
    );
    assert.equal(Number(count.rows[0]?.c ?? 0), 0);
  } finally {
    await store.close();
  }
});
