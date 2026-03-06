import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e: ops tenant bootstrap creates scoped API key + applies billing plan", async () => {
  const api = createApi({
    opsTokens: ["tok_opsw:ops_write", "tok_opsr:ops_read"].join(";")
  });

  const tenantId = "tenant_bootstrap_ops";
  const bootstrap = await request(api, {
    method: "POST",
    path: "/ops/tenants/bootstrap",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_opsw"
    },
    body: {
      billing: {
        plan: "builder",
        hardLimitEnforced: false
      },
      apiKey: {
        scopes: ["ops_read", "finance_read"],
        description: "bootstrap key"
      }
    }
  });
  assert.equal(bootstrap.statusCode, 201);
  assert.equal(bootstrap.json?.tenantId, tenantId);
  assert.equal(bootstrap.json?.bootstrap?.billing?.plan, "builder");
  assert.equal(bootstrap.json?.bootstrap?.billing?.hardLimitEnforced, false);
  assert.equal(bootstrap.json?.bootstrap?.apiKey?.description, "bootstrap key");
  assert.deepEqual(bootstrap.json?.bootstrap?.apiKey?.scopes, ["finance_read", "ops_read"]);
  assert.equal(bootstrap.json?.bootstrap?.env?.NOOTERRA_TENANT_ID, tenantId);
  assert.match(String(bootstrap.json?.bootstrap?.exportCommands ?? ""), /NOOTERRA_API_KEY=/);

  const token = String(bootstrap.json?.bootstrap?.apiKey?.token ?? "");
  assert.ok(token.includes("."));

  const byApiKey = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      authorization: `Bearer ${token}`
    }
  });
  assert.equal(byApiKey.statusCode, 200);
  assert.equal(byApiKey.json?.billing?.plan, "builder");
  assert.equal(byApiKey.json?.billing?.hardLimitEnforced, false);
});

test("API e2e: ops tenant bootstrap requires ops_write", async () => {
  const api = createApi({
    opsTokens: ["tok_opsr:ops_read"].join(";")
  });

  const denied = await request(api, {
    method: "POST",
    path: "/ops/tenants/bootstrap",
    headers: {
      "x-proxy-tenant-id": "tenant_bootstrap_forbidden",
      "x-proxy-ops-token": "tok_opsr"
    },
    body: {}
  });
  assert.equal(denied.statusCode, 403);
});

test("API e2e: ops tenant bootstrap validates scopes", async () => {
  const api = createApi({
    opsTokens: ["tok_opsw:ops_write"].join(";")
  });

  const invalid = await request(api, {
    method: "POST",
    path: "/ops/tenants/bootstrap",
    headers: {
      "x-proxy-tenant-id": "tenant_bootstrap_invalid_scope",
      "x-proxy-ops-token": "tok_opsw"
    },
    body: {
      apiKey: {
        scopes: ["not_a_real_scope"]
      }
    }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json?.code, "SCHEMA_INVALID");
});

test("API e2e: ops tenant bootstrap prefers configured public base URL", async () => {
  const api = createApi({
    opsTokens: ["tok_opsw:ops_write"].join(";"),
    publicBaseUrl: "https://api.nooterra.ai"
  });

  const tenantId = "tenant_bootstrap_public_base";
  const bootstrap = await request(api, {
    method: "POST",
    path: "/ops/tenants/bootstrap",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_opsw",
      host: "nooterra-api.railway.internal:3000",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "nooterra-api.railway.internal:3000"
    },
    body: {}
  });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  assert.equal(bootstrap.json?.bootstrap?.apiBaseUrl, "https://api.nooterra.ai");
  assert.equal(bootstrap.json?.bootstrap?.env?.NOOTERRA_BASE_URL, "https://api.nooterra.ai");
  assert.equal(bootstrap.json?.bootstrap?.next?.healthcheckCurl, "curl -sS https://api.nooterra.ai/healthz | jq");
});
