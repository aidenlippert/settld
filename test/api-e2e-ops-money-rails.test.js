import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { sha256Hex } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

test("API e2e: payout enqueue creates money rail operation and cancel is idempotent", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);

  await api.tickMonthClose({ maxMessages: 50 });

  const monthClose = await request(api, {
    method: "GET",
    path: `/ops/month-close?month=${encodeURIComponent(month)}`,
    headers: financeReadHeaders
  });
  assert.equal(monthClose.statusCode, 200);
  assert.equal(monthClose.json?.monthClose?.status, "CLOSED");

  const tenantId = "tenant_default";
  const partyId = "pty_money_ops_1";
  const partyRole = "operator";
  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 2400
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

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_enqueue_1"
    },
    body: {
      counterpartyRef: "bank:acct_demo_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  assert.equal(enqueue.json?.ok, true);
  assert.ok(enqueue.json?.moneyRailOperation?.operationId);
  assert.equal(enqueue.json?.moneyRailOperation?.state, "initiated");

  const providerId = String(enqueue.json?.moneyRailOperation?.providerId ?? "");
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.equal(providerId, "stub_default");

  const status = await request(api, {
    method: "GET",
    path: `/ops/money-rails/${providerId}/operations/${operationId}`,
    headers: financeReadHeaders
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json?.operation?.operationId, operationId);
  assert.equal(status.json?.operation?.state, "initiated");

  const cancel = await request(api, {
    method: "POST",
    path: `/ops/money-rails/${providerId}/operations/${operationId}/cancel`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_cancel_1"
    },
    body: { reasonCode: "ops_cancelled" }
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.json?.applied, true);
  assert.equal(cancel.json?.operation?.state, "cancelled");

  const cancelReplay = await request(api, {
    method: "POST",
    path: `/ops/money-rails/${providerId}/operations/${operationId}/cancel`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_cancel_1"
    },
    body: { reasonCode: "ops_cancelled" }
  });
  assert.equal(cancelReplay.statusCode, 200);
  assert.deepEqual(cancelReplay.json, cancel.json);

  const cancelAgain = await request(api, {
    method: "POST",
    path: `/ops/money-rails/${providerId}/operations/${operationId}/cancel`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_cancel_2"
    },
    body: { reasonCode: "ops_cancelled_again" }
  });
  assert.equal(cancelAgain.statusCode, 200);
  assert.equal(cancelAgain.json?.applied, false);
  assert.equal(cancelAgain.json?.operation?.state, "cancelled");
});

test("API create: production money rail mode requires configured providers", () => {
  assert.throws(
    () =>
      createApi({
        moneyRailMode: "production"
      }),
    /requires configured providers/i
  );
});

test("API e2e: production provider event mapping ingests statuses deterministically", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";"),
    moneyRailMode: "production",
    moneyRailDefaultProviderId: "stripe_prod_us",
    moneyRailProviderConfigs: [
      {
        providerId: "stripe_prod_us",
        mode: "production",
        allowPayout: true,
        allowCollection: true,
        providerStatusMap: {
          pending_submission: "submitted",
          paid_out: "confirmed",
          terminal_failed: "failed",
          voided: "cancelled"
        }
      }
    ]
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);

  await api.tickMonthClose({ maxMessages: 50 });

  const tenantId = "tenant_default";
  const partyId = "pty_money_ops_prod_1";
  const partyRole = "operator";
  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 3600
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

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_enqueue_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_prod_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.ok(operationId);
  assert.equal(enqueue.json?.moneyRailOperation?.providerId, "stripe_prod_us");
  assert.equal(enqueue.json?.moneyRailOperation?.state, "initiated");

  const submitted = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_ingest_1"
    },
    body: {
      operationId,
      providerStatus: "pending_submission",
      eventId: "evt_prod_submit_1",
      providerRef: "prov_ref_001",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json?.eventType, "submitted");
  assert.equal(submitted.json?.applied, true);
  assert.equal(submitted.json?.operation?.state, "submitted");

  const submitReplay = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_ingest_1"
    },
    body: {
      operationId,
      providerStatus: "pending_submission",
      eventId: "evt_prod_submit_1",
      providerRef: "prov_ref_001",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(submitReplay.statusCode, 200);
  assert.deepEqual(submitReplay.json, submitted.json);

  const confirmed = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_ingest_2"
    },
    body: {
      operationId,
      providerStatus: "paid_out",
      eventId: "evt_prod_paid_1",
      at: "2026-02-07T00:02:00.000Z"
    }
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json?.eventType, "confirmed");
  assert.equal(confirmed.json?.operation?.state, "confirmed");
  assert.equal(confirmed.json?.operation?.confirmedAt, "2026-02-07T00:02:00.000Z");

  const status = await request(api, {
    method: "GET",
    path: `/ops/money-rails/stripe_prod_us/operations/${operationId}`,
    headers: financeReadHeaders
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json?.operation?.state, "confirmed");

  const mismatch = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_ingest_3"
    },
    body: {
      operationId,
      eventType: "failed",
      providerStatus: "paid_out",
      eventId: "evt_prod_invalid_1",
      at: "2026-02-07T00:03:00.000Z"
    }
  });
  assert.equal(mismatch.statusCode, 400);
  assert.match(String(mismatch.json?.error ?? ""), /invalid provider event/i);
});
