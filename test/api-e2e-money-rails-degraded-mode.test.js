import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { sha256Hex } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function closeMonth(api, { month, financeWriteHeaders }) {
  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202, monthCloseRequested.body);
  await api.tickMonthClose({ maxMessages: 50 });
}

async function seedClosedPartyStatement(api, { tenantId, partyId, partyRole = "operator", month, payoutCents }) {
  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents
  };
  const statementHash = sha256Hex(JSON.stringify(statement));
  const artifact = {
    artifactId: `pstmt_${tenantId}_${partyId}_${month}_${statementHash}`,
    artifactType: "PartyStatement.v1",
    partyId,
    partyRole,
    period: month,
    statement,
    artifactHash: statementHash
  };
  await api.store.putArtifact({ tenantId, artifact });
  await api.store.putPartyStatement({
    tenantId,
    statement: {
      partyId,
      period: month,
      basis: "settledAt",
      status: "CLOSED",
      statementHash,
      artifactId: artifact.artifactId,
      artifactHash: artifact.artifactHash,
      closedAt: new Date("2026-02-01T00:00:00.000Z").toISOString()
    }
  });
}

test("API e2e: degraded money-rail mode denies payout enqueue with deterministic outage reason code", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";"),
    moneyRailMode: "production",
    moneyRailDefaultProviderId: "stripe_prod_us",
    moneyRailProviderConfigs: [
      {
        providerId: "stripe_prod_us",
        mode: "production",
        allowPayout: true,
        allowCollection: true
      }
    ]
  });

  const tenantId = "tenant_default";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const month = "2026-01";
  const partyId = "pty_degraded_block_1";

  await closeMonth(api, { month, financeWriteHeaders });
  await seedClosedPartyStatement(api, { tenantId, partyId, month, payoutCents: 1700 });

  const billing = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"],
        degradedMode: {
          enabled: true,
          providerIds: ["stripe_prod_us"],
          denyEnqueuePayouts: true,
          denySubmitPayouts: true,
          reasonCode: "RAIL_OUTAGE_PARTIAL"
        }
      }
    }
  });
  assert.equal(billing.statusCode, 200, billing.body);
  assert.equal(billing.json?.billing?.moneyRails?.degradedMode?.reasonCode, "RAIL_OUTAGE_PARTIAL");

  const enqueueBlocked = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_degraded_enqueue_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });

  assert.equal(enqueueBlocked.statusCode, 409, enqueueBlocked.body);
  assert.equal(enqueueBlocked.json?.code, "MONEY_RAIL_DEGRADED_ENQUEUE_DENIED");
  assert.equal(enqueueBlocked.json?.details?.outageAction, "enqueue_payout");
  assert.equal(enqueueBlocked.json?.details?.outageReasonCode, "RAIL_OUTAGE_PARTIAL");

  const operations = await api.store.listMoneyRailOperations({
    tenantId,
    providerId: "stripe_prod_us",
    limit: 200,
    offset: 0
  });
  assert.equal(Array.isArray(operations) ? operations.length : 0, 0);
});

test("API e2e: degraded money-rail mode blocks submit while provider event ingest can still settle operation state", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const tenantId = "tenant_default";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const month = "2026-01";
  const partyId = "pty_degraded_submit_1";

  await closeMonth(api, { month, financeWriteHeaders });
  await seedClosedPartyStatement(api, { tenantId, partyId, month, payoutCents: 1900 });

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_degraded_submit_enqueue_1"
    },
    body: {
      counterpartyRef: "bank:acct_degraded_1"
    }
  });
  assert.equal(enqueue.statusCode, 201, enqueue.body);
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.ok(operationId);

  const enableDegraded = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        degradedMode: {
          enabled: true,
          providerIds: ["stub_default"],
          denyEnqueuePayouts: false,
          denySubmitPayouts: true,
          reasonCode: "RAIL_OUTAGE_PARTIAL"
        }
      }
    }
  });
  assert.equal(enableDegraded.statusCode, 200, enableDegraded.body);

  const submitBlocked = await request(api, {
    method: "POST",
    path: `/ops/money-rails/stub_default/operations/${encodeURIComponent(operationId)}/submit`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_degraded_submit_block_1"
    },
    body: {}
  });
  assert.equal(submitBlocked.statusCode, 409, submitBlocked.body);
  assert.equal(submitBlocked.json?.code, "MONEY_RAIL_DEGRADED_SUBMIT_DENIED");
  assert.equal(submitBlocked.json?.details?.outageAction, "submit_payout");
  assert.equal(submitBlocked.json?.details?.outageReasonCode, "RAIL_OUTAGE_PARTIAL");

  const statusAfterDeniedSubmit = await request(api, {
    method: "GET",
    path: `/ops/money-rails/stub_default/operations/${encodeURIComponent(operationId)}`,
    headers: financeReadHeaders
  });
  assert.equal(statusAfterDeniedSubmit.statusCode, 200, statusAfterDeniedSubmit.body);
  assert.equal(statusAfterDeniedSubmit.json?.operation?.state, "initiated");

  const ingestFailed = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stub_default/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_degraded_ingest_failed_1"
    },
    body: {
      operationId,
      eventType: "failed",
      reasonCode: "provider_outage",
      eventId: "evt_money_rail_degraded_failed_1",
      at: "2026-02-07T00:03:00.000Z"
    }
  });
  assert.equal(ingestFailed.statusCode, 200, ingestFailed.body);
  assert.equal(ingestFailed.json?.applied, true);
  assert.equal(ingestFailed.json?.operation?.state, "failed");
});
