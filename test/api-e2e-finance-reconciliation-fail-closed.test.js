import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { request } from "./api-test-harness.js";

function createApiWithPgMethodMissing(methodName) {
  const api = createApi({
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write"].join(";")
  });
  api.store.kind = "pg";
  api.store.pg = api.store.pg ?? { pool: {} };
  api.store[methodName] = undefined;
  return api;
}

test("API startup: pg store fails closed when required finance reconciliation method is missing", () => {
  const store = createStore();
  store.kind = "pg";
  store.pg = store.pg ?? { pool: {} };
  store.getMarketplaceProviderPublication = async () => null;
  store.listMarketplaceProviderPublications = async () => [];
  store.putMarketplaceProviderPublication = async () => null;
  store.getMarketplaceCapabilityListing = async () => null;
  store.listMarketplaceCapabilityListings = async () => [];
  store.putMarketplaceCapabilityListing = async () => null;
  store.deleteMarketplaceCapabilityListing = async () => null;
  store.listFinanceReconciliationTriages = undefined;
  assert.throws(
    () => createApi({ store }),
    /pg store missing required finance reconciliation methods: .*listFinanceReconciliationTriages/i
  );
});

test("API e2e: finance reconciliation triage routes fail closed in pg mode when methods are missing", async () => {
  const apiList = createApiWithPgMethodMissing("listFinanceReconciliationTriages");
  const listed = await request(apiList, {
    method: "GET",
    path: "/ops/finance/reconciliation/triage?period=2026-01",
    headers: { "x-proxy-ops-token": "tok_finr" },
    auth: "none"
  });
  assert.equal(listed.statusCode, 501, listed.body);
  assert.match(listed.body, /not supported/i);

  const apiWrite = createApiWithPgMethodMissing("putFinanceReconciliationTriage");
  const upserted = await request(apiWrite, {
    method: "POST",
    path: "/ops/finance/reconciliation/triage",
    headers: {
      "x-proxy-ops-token": "tok_finw",
      "x-nooterra-protocol": "1.0"
    },
    body: {
      sourceType: "money_rails_reconcile",
      period: "2026-01",
      mismatchType: "missing_operation",
      mismatchKey: "operation:missing_1",
      status: "open"
    },
    auth: "none"
  });
  assert.equal(upserted.statusCode, 501, upserted.body);
  assert.match(upserted.body, /not supported/i);
});

test("API e2e: money-rail reconcile route fails closed in pg mode when triage listing method is missing", async () => {
  const api = createApiWithPgMethodMissing("listFinanceReconciliationTriages");
  const reconcile = await request(api, {
    method: "GET",
    path: "/ops/finance/money-rails/reconcile?period=2026-01&providerId=stub_default",
    headers: { "x-proxy-ops-token": "tok_finr" },
    auth: "none"
  });
  assert.equal(reconcile.statusCode, 501, reconcile.body);
  assert.match(reconcile.body, /not supported/i);
});

test("API e2e: money-rail reconcile fails closed when payout instruction evidence is missing", async () => {
  const api = createApi({
    opsTokens: ["tok_finr:finance_read"].join(";")
  });

  const reconcile = await request(api, {
    method: "GET",
    path: "/ops/finance/money-rails/reconcile?period=2026-01&providerId=stub_default",
    headers: { "x-proxy-ops-token": "tok_finr" },
    auth: "none"
  });
  assert.equal(reconcile.statusCode, 409, reconcile.body);
  assert.equal(reconcile.json?.code, "MONEY_RAIL_RECONCILE_EVIDENCE_REQUIRED");
});
