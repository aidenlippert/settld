import test from "node:test";
import assert from "node:assert/strict";

import { allocateEntry } from "../src/core/allocations.js";

test("allocations: each posting is fully attributed (sum matches) and is deterministic", () => {
  const entry = {
    id: "jnl_test",
    at: "2026-01-01T00:00:00.000Z",
    memo: "test",
    postings: [
      { accountId: "acct_platform_revenue", amountCents: -1001 },
      { accountId: "acct_owner_payable", amountCents: -9000 },
      { accountId: "acct_customer_escrow", amountCents: 10001 }
    ]
  };

  const job = {
    id: "job_1",
    tenantId: "tenant_default",
    customerId: "cust_1",
    booking: { customerId: "cust_1", policySnapshot: { coveragePolicy: { insurerId: null } } },
    operatorCoverage: { operatorId: "op_1" }
  };

  const a1 = allocateEntry({ tenantId: "tenant_default", entry, job, operatorContractDoc: null, currency: "USD" });
  const a2 = allocateEntry({ tenantId: "tenant_default", entry, job, operatorContractDoc: null, currency: "USD" });

  // Deterministic order + values.
  assert.deepEqual(a1, a2);

  for (let i = 0; i < entry.postings.length; i += 1) {
    const postingId = `p${i}`;
    const posting = entry.postings[i];
    const sum = a1.filter((x) => x.postingId === postingId).reduce((acc, x) => acc + x.amountCents, 0);
    assert.equal(sum, posting.amountCents);
  }
});

