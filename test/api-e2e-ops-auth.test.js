import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

test("API e2e v1.2: scoped ops auth gates ops/audit/finance endpoints", async () => {
  const api = createApi({
    opsTokens: [
      "tok_read:ops_read",
      "tok_write:ops_write,finance_read,audit_read",
      "tok_fin:finance_read",
      "tok_finw:finance_write",
      "tok_audit:audit_read"
    ].join(";")
  });

  // No token -> forbidden.
  assert.equal((await request(api, { method: "GET", path: "/ops", auth: "none" })).statusCode, 403);

  // ops_read can view ops lists.
  assert.equal((await request(api, { method: "GET", path: "/ops/jobs", headers: { "x-proxy-ops-token": "tok_read" } })).statusCode, 200);
  // but cannot write.
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/contracts",
        headers: { "x-proxy-ops-token": "tok_read" },
        body: { contractId: "c1", name: "c1", policies: { slaOverridesByEnvironmentTier: {}, creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" }, evidencePolicy: { retentionDays: 0 } } }
      })
    ).statusCode,
    403
  );

  // ops_write can write.
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/contracts",
        headers: { "x-proxy-ops-token": "tok_write" },
        body: { contractId: "c1", name: "c1", policies: { slaOverridesByEnvironmentTier: {}, creditPolicy: { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" }, evidencePolicy: { retentionDays: 0 } } }
      })
    ).statusCode,
    201
  );

  // finance_read can fetch statements but not ops lists.
  assert.equal(
    (await request(api, { method: "GET", path: "/ops/statements?month=2026-01", headers: { "x-proxy-ops-token": "tok_fin" } })).statusCode,
    200
  );
  // finance_write implies finance_read.
  assert.equal(
    (await request(api, { method: "GET", path: "/ops/statements?month=2026-01", headers: { "x-proxy-ops-token": "tok_finw" } })).statusCode,
    200
  );
  // ops_read can also fetch statements (ops needs finance-ish visibility).
  assert.equal(
    (await request(api, { method: "GET", path: "/ops/statements?month=2026-01", headers: { "x-proxy-ops-token": "tok_read" } })).statusCode,
    200
  );
  assert.equal((await request(api, { method: "GET", path: "/ops/jobs", headers: { "x-proxy-ops-token": "tok_fin" } })).statusCode, 403);

  // audit_read can access per-job audit export and discover jobs via read-only listing.
  const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
  assert.equal(created.statusCode, 201);
  const jobId = created.json.job.id;

  assert.equal((await request(api, { method: "GET", path: `/jobs/${jobId}/audit`, headers: { "x-proxy-ops-token": "tok_audit" } })).statusCode, 200);
  assert.equal((await request(api, { method: "GET", path: "/ops/jobs", headers: { "x-proxy-ops-token": "tok_audit" } })).statusCode, 200);

  // finance_read can access ledger views (timeline).
  assert.equal((await request(api, { method: "GET", path: `/ops/jobs/${jobId}/timeline`, headers: { "x-proxy-ops-token": "tok_fin" } })).statusCode, 200);

  // Month close: finance_write required for mutations; finance_read can view.
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/month-close",
        headers: { "x-proxy-ops-token": "tok_fin" },
        body: { month: "2026-01" }
      })
    ).statusCode,
    403
  );
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/month-close",
        headers: { "x-proxy-ops-token": "tok_write" },
        body: { month: "2026-01" }
      })
    ).statusCode,
    403
  );

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: { "x-proxy-ops-token": "tok_finw" },
    body: { month: "2026-01" }
  });
  assert.equal(monthCloseRequested.statusCode, 202);

  const monthCloseGet = await request(api, {
    method: "GET",
    path: "/ops/month-close?month=2026-01",
    headers: { "x-proxy-ops-token": "tok_fin" }
  });
  assert.equal(monthCloseGet.statusCode, 200);
  assert.equal(monthCloseGet.json.monthClose.status, "OPEN");

  // Reopen requires finance_write, but should not be forbidden for finance_write.
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/month-close/reopen",
        headers: { "x-proxy-ops-token": "tok_fin" },
        body: { month: "2026-01", reason: "test" }
      })
    ).statusCode,
    403
  );
  assert.equal(
    (
      await request(api, {
        method: "POST",
        path: "/ops/month-close/reopen",
        headers: { "x-proxy-ops-token": "tok_finw" },
        body: { month: "2026-01", reason: "test" }
      })
    ).statusCode,
    409
  );
});
