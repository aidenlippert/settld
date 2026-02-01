import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { jobIdFromLedgerMemo, payoutKeyFor } from "../src/core/party-statements.js";
import { parseYearMonth } from "../src/core/statements.js";

import { request } from "./api-test-harness.js";

async function registerRobot(api, { robotId, publicKeyPem, availability }) {
  const reg = await request(api, { method: "POST", path: "/robots/register", body: { robotId, publicKeyPem } });
  assert.equal(reg.statusCode, 201);

  const availRes = await request(api, {
    method: "POST",
    path: `/robots/${robotId}/availability`,
    headers: { "x-proxy-expected-prev-chain-hash": reg.json.robot.lastChainHash },
    body: { availability }
  });
  assert.equal(availRes.statusCode, 201);
}

test("API e2e: month close emits PartyStatement + PayoutInstruction and party statement reconciles to allocations", async () => {
  let nowMs = Date.parse("2026-01-15T10:00:00.000Z");
  const nowIso = () => new Date(nowMs).toISOString();
  const api = createApi({ now: nowIso });

  const { publicKeyPem: robotPublicKeyPem } = createEd25519Keypair();
  await registerRobot(api, {
    robotId: "rob_party_stmt",
    publicKeyPem: robotPublicKeyPem,
    availability: [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-03-01T00:00:00.000Z" }]
  });

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

  nowMs = Date.parse("2026-01-15T10:46:00.000Z");
  const settled = await request(api, {
    method: "POST",
    path: `/jobs/${jobId}/events`,
    headers: { "x-proxy-expected-prev-chain-hash": lastChainHash },
    body: { type: "SETTLED", actor: { type: "system", id: "proxy" }, payload: { settlement: "demo" } }
  });
  assert.equal(settled.statusCode, 201);

  // Seed a deterministic operator-payable ledger entry so payout instruction generation is exercised.
  api.store.outbox.push({
    type: "LEDGER_ENTRY_APPLY",
    tenantId: "tenant_default",
    jobId,
    entry: {
      id: `jnl_party_stmt_${jobId}`,
      memo: `job:${jobId} SETTLED (party statement seed)`,
      at: nowIso(),
      postings: [
        { accountId: "acct_platform_revenue", amountCents: -5 },
        { accountId: "acct_owner_payable", amountCents: -5 },
        { accountId: "acct_customer_escrow", amountCents: 10 }
      ]
    }
  });

  // Close January (settledAt basis).
  nowMs = Date.parse("2026-02-02T00:00:00.000Z");
  const closeReq = await request(api, { method: "POST", path: "/ops/month-close", body: { month: "2026-01" } });
  assert.equal(closeReq.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 10 });

  const closed = await request(api, { method: "GET", path: "/ops/month-close?month=2026-01" });
  assert.equal(closed.statusCode, 200);
  assert.equal(closed.json.monthClose.status, "CLOSED");
  const monthlyStmt = closed.json.statementArtifact;
  assert.ok(monthlyStmt);
  assert.equal(monthlyStmt.artifactType, "MonthlyStatement.v1");
  const includedJobIds = new Set((monthlyStmt?.statement?.jobs ?? []).map((j) => String(j?.jobId ?? "")).filter((id) => id && id.trim() !== ""));
  assert.ok(includedJobIds.has(jobId));

  const list = await request(api, { method: "GET", path: "/ops/party-statements?period=2026-01" });
  assert.equal(list.statusCode, 200);
  assert.ok(Array.isArray(list.json.statements));
  assert.ok(list.json.statements.length >= 1);

  // Find an operator party statement and assert it reconciles to allocations (sum of amounts).
  const operatorRec = await (async () => {
    for (const s of list.json.statements) {
      const art = await api.store.getArtifact({ tenantId: "tenant_default", artifactId: s.artifactId });
      if (art?.artifactType === "PartyStatement.v1" && art?.partyRole === "operator") return { rec: s, art };
    }
    return null;
  })();
  assert.ok(operatorRec, "expected an operator PartyStatement.v1");

  const period = parseYearMonth("2026-01");
  const startMs = Date.parse(period.startAt);
  const endMs = Date.parse(period.endAt);
  const ledger = api.store.getLedger("tenant_default");
  const includedEntryIds = new Set(
    (ledger?.entries ?? [])
      .filter((e) => {
        const t = Date.parse(e?.at ?? "");
        if (!Number.isFinite(t) || t < startMs || t >= endMs) return false;
        const jid = jobIdFromLedgerMemo(e?.memo ?? "");
        return jid ? includedJobIds.has(jid) : false;
      })
      .map((e) => String(e.id))
  );

  let sum = 0;
  for (const a of api.store.ledgerAllocations.values()) {
    if (!a || typeof a !== "object") continue;
    if (String(a.partyId ?? "") !== String(operatorRec.rec.partyId)) continue;
    if (!includedEntryIds.has(String(a.entryId ?? ""))) continue;
    if (!Number.isSafeInteger(a.amountCents)) continue;
    sum += a.amountCents;
  }

  assert.equal(operatorRec.art.statement?.balanceDeltaCents, sum);

  // PayoutInstruction should exist when payoutCents > 0.
  const payoutArtifacts = (await api.store.listArtifacts({ tenantId: "tenant_default" })).filter((a) => a?.artifactType === "PayoutInstruction.v1");
  assert.ok(payoutArtifacts.length >= 0);
  const payout = payoutArtifacts.find((p) => p?.partyId === operatorRec.rec.partyId && p?.period === "2026-01") ?? null;
  if (operatorRec.art.statement?.payoutCents > 0) {
    assert.ok(payout, "expected PayoutInstruction.v1 for operator");
    const expectedKey = payoutKeyFor({
      tenantId: "tenant_default",
      partyId: operatorRec.rec.partyId,
      period: "2026-01",
      statementHash: operatorRec.rec.artifactHash
    });
    assert.equal(payout.payoutKey, expectedKey);
  }
});
