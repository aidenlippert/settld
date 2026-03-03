import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { request } from "./api-test-harness.js";

function createApiWithPgMethodMissing(methodName) {
  const api = createApi();
  api.store.kind = "pg";
  api.store.pg = api.store.pg ?? { pool: {} };
  api.store[methodName] = undefined;
  return api;
}

test("API startup: pg store fails closed when required marketplace method is missing", () => {
  const store = createStore();
  store.kind = "pg";
  store.pg = store.pg ?? { pool: {} };
  store.putMarketplaceCapabilityListing = undefined;
  assert.throws(
    () => createApi({ store }),
    /pg store missing required marketplace methods: .*putMarketplaceCapabilityListing/i
  );
});

test("API e2e: marketplace provider read routes fail closed in pg mode when list method is missing", async () => {
  const api = createApiWithPgMethodMissing("listMarketplaceProviderPublications");

  const providerList = await request(api, {
    method: "GET",
    path: "/marketplace/providers?status=all"
  });
  assert.equal(providerList.statusCode, 501, providerList.body);
  assert.match(providerList.body, /not supported/i);

  const toolList = await request(api, {
    method: "GET",
    path: "/marketplace/tools?status=all"
  });
  assert.equal(toolList.statusCode, 501, toolList.body);
  assert.match(toolList.body, /not supported/i);
});

test("API e2e: marketplace publish route fails closed in pg mode when persistence method is missing", async () => {
  const api = createApiWithPgMethodMissing("putMarketplaceProviderPublication");

  const published = await request(api, {
    method: "POST",
    path: "/marketplace/providers/publish",
    body: {}
  });
  assert.equal(published.statusCode, 501, published.body);
  assert.match(published.body, /not supported/i);
});

test("API e2e: marketplace capability routes fail closed in pg mode when methods are missing", async () => {
  const apiList = createApiWithPgMethodMissing("listMarketplaceCapabilityListings");
  const listed = await request(apiList, {
    method: "GET",
    path: "/marketplace/capability-listings?status=all"
  });
  assert.equal(listed.statusCode, 501, listed.body);
  assert.match(listed.body, /not supported/i);

  const apiUpsert = createApiWithPgMethodMissing("putMarketplaceCapabilityListing");
  const upserted = await request(apiUpsert, {
    method: "POST",
    path: "/marketplace/capability-listings",
    body: {}
  });
  assert.equal(upserted.statusCode, 501, upserted.body);
  assert.match(upserted.body, /not supported/i);

  const apiDelete = createApiWithPgMethodMissing("deleteMarketplaceCapabilityListing");
  const deleted = await request(apiDelete, {
    method: "DELETE",
    path: "/marketplace/capability-listings/cap_missing"
  });
  assert.equal(deleted.statusCode, 501, deleted.body);
  assert.match(deleted.body, /not supported/i);
});
