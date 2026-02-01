import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("governance RBAC: global writes require ops_write (not finance_write)", async () => {
  const api = createApi({ opsTokens: "tok_fin:finance_write;tok_ops:ops_write" });
  const tenantId = "tenant_test_gov";

  // Tenant policy update with finance_write is allowed.
  const tenantRes = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_fin",
      "x-proxy-expected-prev-chain-hash": "null",
      "x-idempotency-key": "idem_tenant_policy_1"
    },
    body: {
      type: "TENANT_POLICY_UPDATED",
      scope: "tenant",
      payload: { effectiveFrom: "2026-01-01T00:00:00.000Z", policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } } }
    }
  });
  assert.equal(tenantRes.statusCode, 201);

  // Global key revocation with finance_write is forbidden.
  const globalForbidden = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: { "x-proxy-ops-token": "tok_fin", "x-proxy-expected-prev-chain-hash": "null", "x-idempotency-key": "idem_global_key_1" },
    body: {
      type: "SERVER_SIGNER_KEY_REVOKED",
      scope: "global",
      payload: { keyId: "key_deadbeef", revokedAt: "2026-01-01T00:00:00.000Z", reason: "compromised" }
    }
  });
  assert.equal(globalForbidden.statusCode, 403);
});

test("governance uniqueness: TENANT_POLICY_UPDATED effectiveFrom is unique", async () => {
  const api = createApi({ opsTokens: "tok_fin:finance_write" });
  const tenantId = "tenant_test_gov";

  const first = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_fin",
      "x-proxy-expected-prev-chain-hash": "null",
      "x-idempotency-key": "idem_policy_first"
    },
    body: {
      type: "TENANT_POLICY_UPDATED",
      scope: "tenant",
      payload: { effectiveFrom: "2026-01-01T00:00:00.000Z", policy: { finance: { monthCloseHoldPolicy: "ALLOW_WITH_DISCLOSURE" } } }
    }
  });
  assert.equal(first.statusCode, 201);

  const second = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_fin",
      "x-proxy-expected-prev-chain-hash": first.json.event.chainHash,
      "x-idempotency-key": "idem_policy_second"
    },
    body: {
      type: "TENANT_POLICY_UPDATED",
      scope: "tenant",
      payload: { effectiveFrom: "2026-01-01T00:00:00.000Z", policy: { finance: { monthCloseHoldPolicy: "BLOCK_ANY_OPEN_HOLDS" } } }
    }
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.code, "GOVERNANCE_EFFECTIVE_FROM_CONFLICT");
});

test("governance scope guard: SERVER_SIGNER_KEY_* requires global scope", async () => {
  const api = createApi({ opsTokens: "tok_fin:finance_write" });
  const tenantId = "tenant_test_gov";

  const bad = await request(api, {
    method: "POST",
    path: "/ops/governance/events",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_fin",
      "x-proxy-expected-prev-chain-hash": "null",
      "x-idempotency-key": "idem_bad_scope_1"
    },
    body: { type: "SERVER_SIGNER_KEY_REVOKED", scope: "tenant", payload: { keyId: "key_deadbeef", revokedAt: "2026-01-01T00:00:00.000Z" } }
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json.code, "GOVERNANCE_SCOPE_REQUIRED_GLOBAL");
});
