import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";

import { request } from "./api-test-harness.js";

test("API e2e: month close emits FinancePackBundle.v1 pointer and stores zip in evidence store (memory evidence)", async () => {
  const prevEvidenceStore = process.env.PROXY_EVIDENCE_STORE;
  process.env.PROXY_EVIDENCE_STORE = "memory";

  let nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();

  try {
    const api = createApi({ now: nowIso });

    // Preconfigure a finance account map so JournalCsv.v1 exists at month close time.
    const mapRes = await request(api, {
      method: "PUT",
      path: "/ops/finance/account-map",
      body: {
        mapping: {
          schemaVersion: "FinanceAccountMap.v1",
          accounts: {
            acct_cash: "ext_cash",
            acct_customer_escrow: "ext_customer_escrow",
            acct_platform_revenue: "ext_platform_revenue",
            acct_operator_payable: "ext_operator_payable"
          }
        }
      }
    });
    assert.equal(mapRes.statusCode, 200);

    const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
    const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId: "rob_fin_pack", publicKeyPem: robotPublicKeyPem } });
    assert.equal(reg.statusCode, 201);
    const avail = await request(api, {
      method: "POST",
      path: "/robots/rob_fin_pack/availability",
      headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
      body: { availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }] }
    });
    assert.equal(avail.statusCode, 201);

    const created = await request(api, { method: "POST", path: "/jobs", body: { templateId: "reset_lite", constraints: {} } });
    assert.equal(created.statusCode, 201);
    const jobId = created.json.job.id;
    let lastChainHash = created.json.job.lastChainHash;

    const bookingStartAt = "2026-01-15T10:30:00.000Z";
    const bookingEndAt = "2026-01-15T11:00:00.000Z";

    const quote = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/quote`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { startAt: bookingStartAt, endAt: bookingEndAt, environmentTier: "ENV_MANAGED_BUILDING", requiresOperatorCoverage: false }
    });
    assert.equal(quote.statusCode, 201);
    lastChainHash = quote.json.job.lastChainHash;

    const book = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/book`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: {
        paymentHoldId: `hold_${jobId}`,
        startAt: bookingStartAt,
        endAt: bookingEndAt,
        environmentTier: "ENV_MANAGED_BUILDING",
        requiresOperatorCoverage: false
      }
    });
    assert.equal(book.statusCode, 201);
    lastChainHash = book.json.job.lastChainHash;

    const matched = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type: "MATCHED", actor: { type: "system", id: "proxy" }, payload: { robotId: "rob_fin_pack", operatorPartyId: "pty_operator_demo" } }
    });
    assert.equal(matched.statusCode, 201);
    lastChainHash = matched.json.job.lastChainHash;

    // Move into January, cancel, then settle (so month close can include the job deterministically).
    nowMs = Date.parse("2026-01-15T10:45:00.000Z");
    const cancelledAt = nowIso();
    const cancelled = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: {
        type: "JOB_CANCELLED",
        actor: { type: "system", id: "proxy" },
        payload: { jobId, cancelledAt, reason: "OPS", requestedBy: "ops" }
      }
    });
    assert.equal(cancelled.statusCode, 201);
    lastChainHash = cancelled.json.job.lastChainHash;

    // Settle, then seed a deterministic ledger entry so allocations exist.
    nowMs = Date.parse("2026-01-15T10:46:00.000Z");
    const settled = await request(api, {
      method: "POST",
      path: `/jobs/${jobId}/events`,
      headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
      body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
    });
    assert.equal(settled.statusCode, 201);

    api.store.outbox.push({
      type: "LEDGER_ENTRY_APPLY",
      tenantId: "tenant_default",
      jobId,
      entry: {
        id: `jnl_fin_pack_${jobId}`,
        memo: `job:${jobId} SETTLED (finance pack seed)`,
        at: nowIso(),
        postings: [
          { accountId: "acct_customer_escrow", amountCents: 10001 },
          { accountId: "acct_platform_revenue", amountCents: -1500 },
          { accountId: "acct_operator_payable", amountCents: -8501 }
        ]
      }
    });
    api.store.processOutbox({ maxMessages: 50 });

    // Close the period.
    nowMs = Date.parse("2026-02-02T00:00:00.000Z");
    const closeReq = await request(api, { method: "POST", path: "/ops/month-close", body: { month: "2026-01" } });
    assert.equal(closeReq.statusCode, 202);
    await api.tickMonthClose({ maxMessages: 50 });

    const all = await api.store.listArtifacts({ tenantId: "tenant_default" });
    const pointers = all.filter((a) => a?.artifactType === "FinancePackBundle.v1" && String(a?.period ?? "") === "2026-01");
    assert.equal(pointers.length, 1);
    const pointer = pointers[0];
    assert.equal(pointer.bundleHash.length, 64);
    assert.ok(pointer.evidenceRef.startsWith("obj://finance-pack/2026-01/"));
    assert.equal(pointer.objectStore?.kind, "memory");

    const zip = await api.store.evidenceStore.readEvidence({ tenantId: "tenant_default", evidenceRef: pointer.evidenceRef });
    const zipHash = sha256Hex(zip.data);
    assert.equal(zipHash, pointer.bundleHash);
  } finally {
    if (prevEvidenceStore === undefined) delete process.env.PROXY_EVIDENCE_STORE;
    else process.env.PROXY_EVIDENCE_STORE = prevEvidenceStore;
  }
});
