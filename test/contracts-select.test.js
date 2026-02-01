import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultContract, selectBestContract } from "../src/core/contracts.js";

test("contracts: selectBestContract uses deterministic precedence (site > customer > tenant)", () => {
  const base = createDefaultContract({ tenantId: "tenant_default", nowIso: () => "2026-01-01T00:00:00.000Z" });

  const contracts = [
    base,
    { ...base, contractId: "c_site_tpl", isDefault: false, siteId: "site1", templateId: "reset_lite" },
    { ...base, contractId: "c_site_all", isDefault: false, siteId: "site1", templateId: null },
    { ...base, contractId: "c_cust_tpl", isDefault: false, customerId: "cust1", siteId: null, templateId: "reset_lite" },
    { ...base, contractId: "c_cust_all", isDefault: false, customerId: "cust1", siteId: null, templateId: null },
    { ...base, contractId: "c_tenant_tpl", isDefault: false, customerId: null, siteId: null, templateId: "reset_lite" }
  ];

  assert.equal(selectBestContract(contracts, { siteId: "site1", customerId: "cust1", templateId: "reset_lite" }).contractId, "c_site_tpl");
  assert.equal(selectBestContract(contracts, { siteId: "site1", customerId: "cust1", templateId: "other" }).contractId, "c_site_all");
  assert.equal(selectBestContract(contracts, { customerId: "cust1", templateId: "reset_lite" }).contractId, "c_cust_tpl");
  assert.equal(selectBestContract(contracts, { customerId: "cust1" }).contractId, "c_cust_all");
  assert.equal(selectBestContract(contracts, { templateId: "reset_lite" }).contractId, "c_tenant_tpl");
  assert.equal(selectBestContract(contracts, {}).contractId, "contract_default");

  assert.equal(selectBestContract(contracts, { contractId: "c_site_tpl" }).contractId, "c_site_tpl");
});

