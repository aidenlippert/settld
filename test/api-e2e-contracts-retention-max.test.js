import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.2: contract evidence retentionDays is capped per-tenant (0 means retain forever)", async () => {
  const opsTokens = "tok:ops_write";
  const contractBody = (retentionDays) => ({
    contractId: "c_retention",
    name: "Retention Contract",
    policies: {
      slaOverridesByEnvironmentTier: {},
      creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
      evidencePolicy: { retentionDays }
    }
  });

  // Default cap is 365 days.
  {
    const api = createApi({ opsTokens });
    const res = await request(api, {
      method: "POST",
      path: "/ops/contracts",
      headers: { "x-proxy-ops-token": "tok" },
      body: contractBody(366)
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json?.details?.message ?? "", /retentionDays/);
  }

  // Tenant can be explicitly configured for longer retention.
  {
    const store = createStore();
    store.getConfig("tenant_default").evidenceRetentionMaxDays = 730;
    const api = createApi({ store, opsTokens });
    const res = await request(api, {
      method: "POST",
      path: "/ops/contracts",
      headers: { "x-proxy-ops-token": "tok" },
      body: contractBody(366)
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json.contract.policies.evidencePolicy.retentionDays, 366);
  }
});
