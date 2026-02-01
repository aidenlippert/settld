import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createDefaultContract } from "../src/core/contracts.js";
import { contractDocumentV1FromLegacyContract } from "../src/core/contract-document.js";
import { request } from "./api-test-harness.js";

test("ops/contracts routing compat: legacy v1 and contracts-v2 do not shadow each other", async () => {
  const api = createApi({ now: () => "2026-01-26T09:50:00.000Z" });

  // 1) Legacy payload must be accepted by /ops/contracts (v1).
  // Use a v1-only shape (top-level customerId/siteId/templateId/isDefault) to ensure it's not a valid v2 doc.
  const legacyBody = {
    contractId: "contract_routing_legacy",
    name: "Legacy Routing Contract",
    customerId: "cust_legacy",
    isDefault: true,
    policies: {
      creditPolicy: { enabled: true, defaultAmountCents: 100, maxAmountCents: 100, currency: "USD" },
      evidencePolicy: { retentionDays: 0 },
      claimPolicy: { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 },
      coveragePolicy: {
        required: false,
        coverageTierId: null,
        feeModel: "PER_JOB",
        feeCentsPerJob: 0,
        creditFundingModel: "PLATFORM_EXPENSE",
        reserveFundPercent: 100,
        insurerId: null,
        recoverablePercent: 100,
        recoverableTerms: null,
        responseSlaSeconds: 0,
        includedAssistSeconds: 0,
        overageRateCentsPerMinute: 0
      }
    }
  };
  const legacyUpsert = await request(api, { method: "POST", path: "/ops/contracts", body: legacyBody });
  assert.equal(legacyUpsert.statusCode, 201);
  assert.equal(legacyUpsert.json?.contract?.contractId, "contract_routing_legacy");

  // 2) The same legacy payload must *not* be accepted by /ops/contracts-v2 (it has v1-only fields).
  const v2RejectLegacy = await request(api, { method: "POST", path: "/ops/contracts-v2", body: legacyBody });
  assert.equal(v2RejectLegacy.statusCode, 400);
  assert.equal(v2RejectLegacy.json?.code, "SCHEMA_INVALID");

  // 3) A valid v2 doc must be accepted by /ops/contracts-v2.
  const legacy = createDefaultContract({ tenantId: "tenant_default", nowIso: () => "2026-01-26T09:50:00.000Z" });
  legacy.contractId = "ctr_v2_routing";
  legacy.contractVersion = 1;
  legacy.name = "V2 Routing Contract";
  legacy.customerId = "cust_v2";
  legacy.isDefault = false;
  const doc = contractDocumentV1FromLegacyContract(legacy);
  const v2Create = await request(api, { method: "POST", path: "/ops/contracts-v2", body: { doc } });
  assert.equal(v2Create.statusCode, 201);
  assert.equal(v2Create.json?.contract?.contractId, "ctr_v2_routing");
  const v2Publish = await request(api, { method: "POST", path: "/ops/contracts-v2/ctr_v2_routing/publish", body: { contractVersion: 1 } });
  assert.equal(v2Publish.statusCode, 200);
  assert.ok(v2Publish.json?.contract?.contractHash);

  // 4) V2 docs must be rejected by the legacy v1 endpoint (avoid accidental wrong-endpoint usage).
  const v1RejectV2 = await request(api, { method: "POST", path: "/ops/contracts", body: doc });
  assert.equal(v1RejectV2.statusCode, 400);
  assert.equal(v1RejectV2.json?.code, "SCHEMA_INVALID");
});
