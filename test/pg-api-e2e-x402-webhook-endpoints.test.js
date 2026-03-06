import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

(databaseUrl ? test : test.skip)("pg api e2e: x402 webhook endpoint lifecycle is supported and durable", async () => {
  const schema = makeSchema();
  const store = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

  try {
    const api = createApi({ store, opsToken: "tok_ops" });

    const created = await request(api, {
      method: "POST",
      path: "/x402/webhooks/endpoints",
      headers: {
        "x-nooterra-protocol": "1.0",
        "x-idempotency-key": "pg_webhook_endpoint_create_1"
      },
      body: {
        url: "https://example.invalid/x402/pg-endpoint",
        events: ["x402.escalation.created", "x402.escalation.approved"],
        description: "pg endpoint"
      }
    });
    assert.equal(created.statusCode, 201, created.body);
    const endpointId = created.json?.endpoint?.endpointId;
    assert.ok(typeof endpointId === "string" && endpointId.length > 0);
    assert.equal(created.json?.endpoint?.status, "active");
    const firstSecret = created.json?.secret;
    assert.ok(typeof firstSecret === "string" && firstSecret.startsWith("whsec_"));

    const listed = await request(api, {
      method: "GET",
      path: "/x402/webhooks/endpoints?status=active&event=x402.escalation.created"
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(Array.isArray(listed.json?.endpoints), true);
    assert.equal(listed.json?.endpoints?.length, 1);
    assert.equal(listed.json?.endpoints?.[0]?.endpointId, endpointId);

    const fetched = await request(api, {
      method: "GET",
      path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}`
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json?.endpoint?.endpointId, endpointId);

    await store.refreshFromDb();

    const fetchedAfterRefresh = await request(api, {
      method: "GET",
      path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}`
    });
    assert.equal(fetchedAfterRefresh.statusCode, 200, fetchedAfterRefresh.body);
    assert.equal(fetchedAfterRefresh.json?.endpoint?.endpointId, endpointId);

    const rotated = await request(api, {
      method: "POST",
      path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
      headers: {
        "x-nooterra-protocol": "1.0",
        "x-idempotency-key": "pg_webhook_endpoint_rotate_1"
      },
      body: {
        gracePeriodSeconds: 1800
      }
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.equal(rotated.json?.endpoint?.endpointId, endpointId);
    assert.ok(typeof rotated.json?.secret === "string" && rotated.json.secret.startsWith("whsec_"));
    assert.notEqual(rotated.json?.secret, firstSecret);

    const revoked = await request(api, {
      method: "DELETE",
      path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}`,
      headers: {
        "x-nooterra-protocol": "1.0",
        "x-idempotency-key": "pg_webhook_endpoint_revoke_1"
      }
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json?.endpoint?.status, "revoked");

    const revokedList = await request(api, {
      method: "GET",
      path: "/x402/webhooks/endpoints?status=revoked"
    });
    assert.equal(revokedList.statusCode, 200, revokedList.body);
    assert.equal(revokedList.json?.endpoints?.[0]?.endpointId, endpointId);
    assert.equal(revokedList.json?.endpoints?.[0]?.status, "revoked");

    const rotateRevoked = await request(api, {
      method: "POST",
      path: `/x402/webhooks/endpoints/${encodeURIComponent(endpointId)}/rotate-secret`,
      headers: {
        "x-nooterra-protocol": "1.0",
        "x-idempotency-key": "pg_webhook_endpoint_rotate_revoked_1"
      },
      body: {
        gracePeriodSeconds: 60
      }
    });
    assert.equal(rotateRevoked.statusCode, 409, rotateRevoked.body);
    assert.equal(rotateRevoked.json?.code, "X402_WEBHOOK_ENDPOINT_REVOKED");
  } finally {
    await store.close();
  }
});
