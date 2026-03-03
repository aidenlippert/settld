import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createPgStore } from "../src/db/store-pg.js";
import { request } from "./api-test-harness.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

function makeSchema() {
  return `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

(databaseUrl ? test : test.skip)("pg api e2e: marketplace reads are cross-instance consistent without refresh", async () => {
  const schema = makeSchema();
  let storeA = null;
  let storeB = null;

  try {
    storeA = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: false });
    storeB = await createPgStore({ databaseUrl, schema, dropSchemaOnClose: true });

    const apiB = createApi({ store: storeB });
    const tenantId = "tenant_default";

    const providerPublication = {
      schemaVersion: "MarketplaceProviderPublication.v1",
      publicationId: "pub_cross_instance_1",
      tenantId,
      providerId: "prov_cross_instance_1",
      providerRef: "prov_cross_instance_1",
      status: "certified",
      certified: true,
      baseUrl: "https://provider.example",
      description: "cross-instance provider",
      tags: ["cross", "instance"],
      manifestSchemaVersion: "PaidToolManifest.v2",
      manifestHash: "sha256:crossinstance",
      manifest: {
        schemaVersion: "PaidToolManifest.v2",
        providerId: "prov_cross_instance_1",
        tools: [
          {
            toolId: "tool.cross.echo",
            mcpToolName: "tool.cross.echo",
            description: "cross-instance tool",
            method: "GET",
            paidPath: "/tool/echo",
            upstreamPath: "/echo",
            pricing: {
              amountCents: 100,
              currency: "USD"
            },
            tags: ["cross", "echo"]
          }
        ]
      },
      conformanceReport: null,
      providerSigning: null,
      publishProof: null,
      publishedAt: "2026-03-03T00:00:00.000Z",
      certifiedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z"
    };
    await storeA.putMarketplaceProviderPublication({ tenantId, publication: providerPublication });

    const capabilityListing = {
      schemaVersion: "MarketplaceCapabilityListing.v1",
      listingId: "cap_cross_instance_1",
      tenantId,
      capability: "translate",
      title: "Cross Instance Listing",
      description: "read path should see this without refresh",
      category: "language",
      sellerAgentId: null,
      status: "active",
      tags: ["cross", "instance"],
      priceModel: {
        schemaVersion: "MarketplaceCapabilityPriceModel.v1",
        mode: "fixed",
        amountCents: 1500,
        minAmountCents: null,
        maxAmountCents: null,
        currency: "USD",
        unit: null
      },
      availability: null,
      metadata: null,
      createdAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z"
    };
    await storeA.putMarketplaceCapabilityListing({ tenantId, listing: capabilityListing });

    const providers = await request(apiB, {
      method: "GET",
      path: "/marketplace/providers?status=certified&limit=20&offset=0",
      headers: { "x-proxy-tenant-id": tenantId }
    });
    assert.equal(providers.statusCode, 200, providers.body);
    assert.equal(providers.json?.total, 1);
    assert.equal(providers.json?.publications?.[0]?.providerId, "prov_cross_instance_1");

    const provider = await request(apiB, {
      method: "GET",
      path: "/marketplace/providers/prov_cross_instance_1",
      headers: { "x-proxy-tenant-id": tenantId }
    });
    assert.equal(provider.statusCode, 200, provider.body);
    assert.equal(provider.json?.publication?.providerId, "prov_cross_instance_1");

    const tools = await request(apiB, {
      method: "GET",
      path: "/marketplace/tools?status=certified&limit=20&offset=0",
      headers: { "x-proxy-tenant-id": tenantId }
    });
    assert.equal(tools.statusCode, 200, tools.body);
    assert.equal(tools.json?.total, 1);
    assert.equal(tools.json?.tools?.[0]?.toolId, "tool.cross.echo");

    const listings = await request(apiB, {
      method: "GET",
      path: "/marketplace/capability-listings?status=active&limit=20&offset=0",
      headers: { "x-proxy-tenant-id": tenantId }
    });
    assert.equal(listings.statusCode, 200, listings.body);
    assert.equal(listings.json?.total, 1);
    assert.equal(listings.json?.listings?.[0]?.listingId, "cap_cross_instance_1");

    const listing = await request(apiB, {
      method: "GET",
      path: "/marketplace/capability-listings/cap_cross_instance_1",
      headers: { "x-proxy-tenant-id": tenantId }
    });
    assert.equal(listing.statusCode, 200, listing.body);
    assert.equal(listing.json?.listing?.listingId, "cap_cross_instance_1");
  } finally {
    try {
      await storeB?.close?.();
    } catch {}
    try {
      await storeA?.close?.();
    } catch {}
  }
});
