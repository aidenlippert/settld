import test from "node:test";
import assert from "node:assert/strict";

import { selectActiveContractV2 } from "../src/core/contract-selection.js";

test("contract selection v2: deterministic precedence tuple", () => {
  const base = {
    tenantId: "tenant_default",
    status: "ACTIVE",
    policyHash: "p".repeat(64),
    compilerId: "contract_compiler.v1",
    doc: { type: "ContractDocument.v1", v: 1, contractId: "ctr", contractVersion: 1, name: "x", policies: {}, scope: {} }
  };

  const contracts = [
    // Less specific (template only).
    {
      ...base,
      contractId: "ctr_a",
      contractVersion: 3,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      contractHash: "01".repeat(32),
      scope: { templateId: "reset_lite" }
    },
    // More specific (customer + template) but lower version.
    {
      ...base,
      contractId: "ctr_b",
      contractVersion: 1,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      contractHash: "02".repeat(32),
      scope: { customerId: "cust_1", templateId: "reset_lite" }
    },
    // Same specificity + version, later effectiveFrom should win.
    {
      ...base,
      contractId: "ctr_c",
      contractVersion: 1,
      effectiveFrom: "2026-01-15T00:00:00.000Z",
      contractHash: "03".repeat(32),
      scope: { customerId: "cust_1", templateId: "reset_lite" }
    },
    // Same as ctr_c but earlier effectiveFrom; should lose.
    {
      ...base,
      contractId: "ctr_d",
      contractVersion: 1,
      effectiveFrom: "2026-01-10T00:00:00.000Z",
      contractHash: "ff".repeat(32),
      scope: { customerId: "cust_1", templateId: "reset_lite" }
    }
  ];

  const selected = selectActiveContractV2(contracts, {
    kind: "customer",
    scope: { customerId: "cust_1", templateId: "reset_lite" },
    at: "2026-01-20T00:00:00.000Z"
  });
  assert.ok(selected);
  assert.equal(selected.contractId, "ctr_c");

  // If effectiveFrom ties, contractHash lexicographic is final tie-breaker (higher wins here).
  const tied = [
    {
      ...base,
      contractId: "ctr_t1",
      contractVersion: 1,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      contractHash: "10".repeat(32),
      scope: { customerId: "cust_2" }
    },
    {
      ...base,
      contractId: "ctr_t2",
      contractVersion: 1,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      contractHash: "20".repeat(32),
      scope: { customerId: "cust_2" }
    }
  ];
  const selected2 = selectActiveContractV2(tied, { kind: "customer", scope: { customerId: "cust_2" }, at: "2026-01-02T00:00:00.000Z" });
  assert.ok(selected2);
  assert.equal(selected2.contractId, "ctr_t2");
});

