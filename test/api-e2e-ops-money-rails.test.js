import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { sha256Hex } from "../src/core/crypto.js";
import { computeArtifactHash } from "../src/core/artifacts.js";
import { request } from "./api-test-harness.js";

function createMockFetchJsonResponse(status, payload, { headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    ok: Number(status) >= 200 && Number(status) < 300,
    status: Number(status),
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
      }
    },
    async text() {
      return JSON.stringify(payload ?? null);
    }
  };
}

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

test("API e2e: money rail operations persist across API recreation with shared store", async () => {
  const store = createStore();
  const apiA = createApi({
    store,
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_ops_restart_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(apiA, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await apiA.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 1800
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
  await apiA.store.putArtifact({ tenantId, artifact });
  await apiA.store.putPartyStatement({
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

  const enqueue = await request(apiA, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_restart_enqueue_1"
    },
    body: {
      counterpartyRef: "bank:acct_restart_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  const providerId = String(enqueue.json?.moneyRailOperation?.providerId ?? "");
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.equal(providerId, "stub_default");
  assert.ok(operationId);

  const apiB = createApi({
    store,
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });
  const status = await request(apiB, {
    method: "GET",
    path: `/ops/money-rails/${providerId}/operations/${operationId}`,
    headers: financeReadHeaders
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json?.operation?.operationId, operationId);
  assert.equal(status.json?.operation?.state, "initiated");
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

  const blockedByRealMoneyFlag = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_prod_enqueue_flag_blocked"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_prod_1"
    }
  });
  assert.equal(blockedByRealMoneyFlag.statusCode, 409);
  assert.equal(blockedByRealMoneyFlag.json?.code, "REAL_MONEY_DISABLED");

  const enableRealMoney = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"]
      }
    }
  });
  assert.equal(enableRealMoney.statusCode, 200);
  assert.equal(enableRealMoney.json?.billing?.moneyRails?.realMoneyEnabled, true);

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
      payload: {
        id: "evt_prod_paid_1",
        type: "transfer.paid",
        created: 1770422520,
        data: {
          object: {
            id: "tr_prod_paid_1",
            status: "paid",
            metadata: {
              settld_operation_id: operationId
            }
          }
        }
      }
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

  const audits = await api.store.listOpsAudit({ tenantId, limit: 200, offset: 0 });
  const ingestAudits = audits.filter((row) => row?.action === "MONEY_RAIL_PROVIDER_EVENT_INGEST");
  assert.ok(ingestAudits.length >= 2);
  const webhookAudit = ingestAudits.find((row) => row?.details?.eventId === "evt_prod_paid_1");
  assert.equal(webhookAudit?.details?.source, "stripe_webhook");
  assert.equal(webhookAudit?.details?.operationId, operationId);

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

test("API e2e: production payout controls enforce kill switch, single-payout cap, and daily cap", async () => {
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

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const tenantId = "tenant_default";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const seedStatement = async ({ partyId, payoutCents }) => {
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
  };

  await seedStatement({ partyId: "pty_money_guard_1", payoutCents: 2400 });
  await seedStatement({ partyId: "pty_money_guard_2", payoutCents: 900 });

  const setKillSwitch = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        payoutKillSwitch: true,
        allowedProviderIds: ["stripe_prod_us"]
      }
    }
  });
  assert.equal(setKillSwitch.statusCode, 200);

  const blockedKillSwitch = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent("pty_money_guard_1")}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_guard_killswitch_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_guard_1"
    }
  });
  assert.equal(blockedKillSwitch.statusCode, 409);
  assert.equal(blockedKillSwitch.json?.code, "PAYOUT_KILL_SWITCH_ACTIVE");

  const setSingleLimit = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        payoutKillSwitch: false,
        maxPayoutAmountCents: 1000,
        allowedProviderIds: ["stripe_prod_us"]
      }
    }
  });
  assert.equal(setSingleLimit.statusCode, 200);

  const blockedSingleCap = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent("pty_money_guard_1")}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_guard_singlecap_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_guard_1"
    }
  });
  assert.equal(blockedSingleCap.statusCode, 409);
  assert.equal(blockedSingleCap.json?.code, "PAYOUT_AMOUNT_LIMIT_EXCEEDED");

  const setDailyLimit = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        payoutKillSwitch: false,
        maxPayoutAmountCents: 5000,
        dailyPayoutLimitCents: 3000,
        allowedProviderIds: ["stripe_prod_us"]
      }
    }
  });
  assert.equal(setDailyLimit.statusCode, 200);

  const firstAllowed = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent("pty_money_guard_1")}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_guard_daily_first"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_guard_1"
    }
  });
  assert.equal(firstAllowed.statusCode, 201);
  assert.equal(firstAllowed.json?.moneyRailOperation?.state, "initiated");

  const secondBlockedDaily = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent("pty_money_guard_2")}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_guard_daily_second"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_guard_2"
    }
  });
  assert.equal(secondBlockedDaily.statusCode, 409);
  assert.equal(secondBlockedDaily.json?.code, "PAYOUT_DAILY_LIMIT_EXCEEDED");
});

test("API e2e: production provider ingest can require signed payloads", async () => {
  const webhookSecret = "whsec_money_rails_test";
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
        requireSignedIngest: true,
        webhookSecret,
        providerStatusMap: {
          pending_submission: "submitted"
        }
      }
    ]
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_sig_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 1300
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

  const enableRealMoney = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"]
      }
    }
  });
  assert.equal(enableRealMoney.statusCode, 200);

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_sig_enqueue_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_sig_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.ok(operationId);

  const unsignedIngest = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_sig_ingest_1"
    },
    body: {
      operationId,
      providerStatus: "pending_submission",
      eventId: "evt_sig_1",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(unsignedIngest.statusCode, 400);
  assert.equal(unsignedIngest.json?.error, "invalid provider signature");

  const signedPayload = {
    operationId,
    providerStatus: "pending_submission",
    eventId: "evt_sig_1",
    at: "2026-02-07T00:01:00.000Z"
  };
  const ts = Math.floor(Date.now() / 1000);
  const payloadText = JSON.stringify(signedPayload);
  const digest = crypto.createHmac("sha256", webhookSecret).update(`${ts}.${payloadText}`, "utf8").digest("hex");
  const sigHeader = `t=${ts},v1=${digest}`;

  const signedIngest = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stripe_prod_us/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_sig_ingest_2",
      "x-proxy-provider-signature": sigHeader
    },
    body: signedPayload
  });
  assert.equal(signedIngest.statusCode, 200);
  assert.equal(signedIngest.json?.eventType, "submitted");
  assert.equal(signedIngest.json?.operation?.state, "submitted");
});

test("API e2e: Stripe Connect account onboarding gates production payouts and resolves counterparty refs", async () => {
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

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_connect_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 1900
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

  const enableMoneyRails = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"],
        connect: {
          enabled: true
        }
      }
    }
  });
  assert.equal(enableMoneyRails.statusCode, 200);

  const blockedWithoutAccount = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_connect_blocked_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });
  assert.equal(blockedWithoutAccount.statusCode, 409);
  assert.equal(blockedWithoutAccount.json?.code, "STRIPE_CONNECT_ACCOUNT_REQUIRED");

  const upsertConnectAccount = await request(api, {
    method: "PUT",
    path: `/ops/finance/money-rails/stripe-connect/accounts/${encodeURIComponent("acct_connect_demo_1")}`,
    headers: financeWriteHeaders,
    body: {
      partyId,
      status: "active",
      payoutsEnabled: true,
      setDefault: true,
      enableConnect: true
    }
  });
  assert.equal(upsertConnectAccount.statusCode, 200);
  assert.equal(upsertConnectAccount.json?.account?.accountId, "acct_connect_demo_1");
  assert.equal(upsertConnectAccount.json?.connect?.defaultAccountId, "acct_connect_demo_1");

  const listConnectAccounts = await request(api, {
    method: "GET",
    path: "/ops/finance/money-rails/stripe-connect/accounts",
    headers: financeReadHeaders
  });
  assert.equal(listConnectAccounts.statusCode, 200);
  assert.equal(listConnectAccounts.json?.summary?.activeCount, 1);
  assert.equal(listConnectAccounts.json?.summary?.payoutsEnabledCount, 1);

  const mismatchCounterpartyRef = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_connect_mismatch_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us",
      counterpartyRef: "bank:acct_wrong"
    }
  });
  assert.equal(mismatchCounterpartyRef.statusCode, 409);
  assert.equal(mismatchCounterpartyRef.json?.code, "STRIPE_CONNECT_COUNTERPARTY_MISMATCH");

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_connect_enqueue_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  assert.equal(enqueue.json?.moneyRailOperation?.counterpartyRef, "stripe_connect:acct_connect_demo_1");
  assert.equal(enqueue.json?.moneyRailOperation?.metadata?.stripeConnectAccountId, "acct_connect_demo_1");
});

test("API e2e: Stripe production submit executes transfer and transitions operation to submitted", async () => {
  const stripeCalls = [];
  const stripeFetchFn = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const formData = new URLSearchParams(String(init?.body ?? ""));
    stripeCalls.push({
      url: String(url),
      method: String(init?.method ?? "GET"),
      authorization:
        (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
          ? init.headers.authorization ?? init.headers.Authorization ?? null
          : null) ?? null,
      formData
    });
    if (parsedUrl.pathname === "/v1/transfers") {
      return createMockFetchJsonResponse(200, {
        id: "tr_test_submit_1",
        object: "transfer",
        amount: 2100,
        currency: "usd",
        destination: "acct_connect_submit_1",
        created: 1765238400
      });
    }
    return createMockFetchJsonResponse(404, { error: { message: "not found" } });
  };

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
    ],
    billingStripeApiBaseUrl: "https://stripe.mock.local",
    billingStripeSecretKey: "sk_test_money_rails_123",
    billingStripeFetchFn: stripeFetchFn
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_submit_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 2100
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

  const enableMoneyRails = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"],
        connect: {
          enabled: true
        }
      }
    }
  });
  assert.equal(enableMoneyRails.statusCode, 200);

  const upsertConnectAccount = await request(api, {
    method: "PUT",
    path: `/ops/finance/money-rails/stripe-connect/accounts/${encodeURIComponent("acct_connect_submit_1")}`,
    headers: financeWriteHeaders,
    body: {
      partyId,
      status: "active",
      payoutsEnabled: true,
      setDefault: true,
      enableConnect: true
    }
  });
  assert.equal(upsertConnectAccount.statusCode, 200);

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_submit_enqueue_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  assert.equal(enqueue.json?.moneyRailOperation?.counterpartyRef, "stripe_connect:acct_connect_submit_1");
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.ok(operationId);

  const submit = await request(api, {
    method: "POST",
    path: `/ops/money-rails/stripe_prod_us/operations/${operationId}/submit`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_submit_1"
    },
    body: {}
  });
  assert.equal(submit.statusCode, 200, submit.body);
  assert.equal(submit.json?.applied, true);
  assert.equal(submit.json?.operation?.state, "submitted");
  assert.equal(submit.json?.operation?.providerRef, "tr_test_submit_1");
  assert.equal(submit.json?.providerSubmission?.transferId, "tr_test_submit_1");
  assert.equal(submit.json?.providerSubmission?.destinationAccountId, "acct_connect_submit_1");

  assert.equal(stripeCalls.length, 1);
  const transferCall = stripeCalls[0];
  assert.equal(transferCall.method, "POST");
  assert.equal(transferCall.url, "https://stripe.mock.local/v1/transfers");
  assert.equal(transferCall.authorization, "Bearer sk_test_money_rails_123");
  assert.equal(transferCall.formData.get("amount"), "2100");
  assert.equal(transferCall.formData.get("currency"), "usd");
  assert.equal(transferCall.formData.get("destination"), "acct_connect_submit_1");
  assert.equal(transferCall.formData.get("metadata[settld_operation_id]"), operationId);

  const submitReplay = await request(api, {
    method: "POST",
    path: `/ops/money-rails/stripe_prod_us/operations/${operationId}/submit`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_submit_1"
    },
    body: {}
  });
  assert.equal(submitReplay.statusCode, 200);
  assert.deepEqual(submitReplay.json, submit.json);
  assert.equal(stripeCalls.length, 1);

  const submitAgain = await request(api, {
    method: "POST",
    path: `/ops/money-rails/stripe_prod_us/operations/${operationId}/submit`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_submit_2"
    },
    body: {}
  });
  assert.equal(submitAgain.statusCode, 200);
  assert.equal(submitAgain.json?.applied, false);
  assert.equal(submitAgain.json?.reason, "already_submitted");
  assert.equal(stripeCalls.length, 1);
});

test("API e2e: Stripe Connect KYB sync updates payout eligibility from provider account state", async () => {
  let stripeAccountSnapshot = {
    id: "acct_connect_kyb_1",
    payouts_enabled: false,
    transfers_enabled: false,
    details_submitted: false,
    requirements: {
      currently_due: ["external_account"],
      pending_verification: [],
      disabled_reason: null
    }
  };
  let stripeAccountCalls = 0;
  const stripeFetchFn = async (url) => {
    const parsedUrl = new URL(String(url));
    if (parsedUrl.pathname === "/v1/accounts/acct_connect_kyb_1") {
      stripeAccountCalls += 1;
      return createMockFetchJsonResponse(200, stripeAccountSnapshot);
    }
    return createMockFetchJsonResponse(404, { error: { message: "not found" } });
  };

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
    ],
    billingStripeApiBaseUrl: "https://stripe.mock.local",
    billingStripeSecretKey: "sk_test_connect_kyb_123",
    billingStripeFetchFn: stripeFetchFn
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_kyb_sync_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 1300
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

  const enableMoneyRails = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        realMoneyEnabled: true,
        allowedProviderIds: ["stripe_prod_us"],
        connect: {
          enabled: true
        }
      }
    }
  });
  assert.equal(enableMoneyRails.statusCode, 200);

  const upsertConnectAccount = await request(api, {
    method: "PUT",
    path: `/ops/finance/money-rails/stripe-connect/accounts/${encodeURIComponent("acct_connect_kyb_1")}`,
    headers: financeWriteHeaders,
    body: {
      partyId,
      status: "active",
      payoutsEnabled: true,
      transfersEnabled: true,
      setDefault: true,
      enableConnect: true
    }
  });
  assert.equal(upsertConnectAccount.statusCode, 200);

  const syncPending = await request(api, {
    method: "POST",
    path: "/ops/finance/money-rails/stripe-connect/accounts/sync?providerId=stripe_prod_us",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_kyb_sync_pending_1"
    },
    body: {
      accountIds: ["acct_connect_kyb_1"]
    }
  });
  assert.equal(syncPending.statusCode, 200, syncPending.body);
  assert.equal(syncPending.json?.summary?.syncedCount, 1);
  assert.equal(syncPending.json?.results?.[0]?.kybStatus, "pending");
  assert.equal(syncPending.json?.results?.[0]?.payoutsEnabled, false);
  assert.equal(stripeAccountCalls, 1);

  const syncPendingReplay = await request(api, {
    method: "POST",
    path: "/ops/finance/money-rails/stripe-connect/accounts/sync?providerId=stripe_prod_us",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_kyb_sync_pending_1"
    },
    body: {
      accountIds: ["acct_connect_kyb_1"]
    }
  });
  assert.equal(syncPendingReplay.statusCode, 200);
  assert.deepEqual(syncPendingReplay.json, syncPending.json);
  assert.equal(stripeAccountCalls, 1);

  const listAfterPending = await request(api, {
    method: "GET",
    path: "/ops/finance/money-rails/stripe-connect/accounts",
    headers: financeReadHeaders
  });
  assert.equal(listAfterPending.statusCode, 200);
  assert.equal(listAfterPending.json?.summary?.pendingCount, 1);
  assert.equal(listAfterPending.json?.summary?.verifiedCount, 0);

  const blockedPending = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_kyb_blocked_pending_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });
  assert.equal(blockedPending.statusCode, 409);
  assert.equal(blockedPending.json?.code, "STRIPE_CONNECT_ACCOUNT_REQUIRED");

  stripeAccountSnapshot = {
    id: "acct_connect_kyb_1",
    payouts_enabled: true,
    transfers_enabled: true,
    details_submitted: true,
    requirements: {
      currently_due: [],
      pending_verification: [],
      disabled_reason: null
    }
  };

  const syncVerified = await request(api, {
    method: "POST",
    path: "/ops/finance/money-rails/stripe-connect/accounts/sync?providerId=stripe_prod_us",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_kyb_sync_verified_1"
    },
    body: {
      accountIds: ["acct_connect_kyb_1"]
    }
  });
  assert.equal(syncVerified.statusCode, 200, syncVerified.body);
  assert.equal(syncVerified.json?.summary?.syncedCount, 1);
  assert.equal(syncVerified.json?.results?.[0]?.kybStatus, "verified");
  assert.equal(syncVerified.json?.results?.[0]?.payoutsEnabled, true);
  assert.equal(stripeAccountCalls, 2);

  const listAfterVerified = await request(api, {
    method: "GET",
    path: "/ops/finance/money-rails/stripe-connect/accounts",
    headers: financeReadHeaders
  });
  assert.equal(listAfterVerified.statusCode, 200);
  assert.equal(listAfterVerified.json?.summary?.verifiedCount, 1);
  assert.equal(listAfterVerified.json?.summary?.pendingCount, 0);

  const enqueueAfterVerified = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_kyb_enqueue_verified_1"
    },
    body: {
      moneyRailProviderId: "stripe_prod_us"
    }
  });
  assert.equal(enqueueAfterVerified.statusCode, 201, enqueueAfterVerified.body);
  assert.equal(enqueueAfterVerified.json?.moneyRailOperation?.counterpartyRef, "stripe_connect:acct_connect_kyb_1");
});

test("API e2e: chargeback policy enforces negative-balance hold/net payout handling", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const monthInitial = "2026-01";
  const monthHold = "2026-02";
  const monthNet = "2026-03";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_chargeback_1";
  const partyRole = "operator";

  async function closeMonthAndPutStatement({ period, payoutCents, suffix }) {
    const monthCloseRequested = await request(api, {
      method: "POST",
      path: "/ops/month-close",
      headers: financeWriteHeaders,
      body: { month: period }
    });
    assert.equal(monthCloseRequested.statusCode, 202);
    await api.tickMonthClose({ maxMessages: 50 });

    const statement = {
      type: "PartyStatementBody.v1",
      v: 1,
      currency: "USD",
      tenantId,
      partyId,
      partyRole,
      period,
      basis: "settledAt",
      payoutCents
    };
    const statementHash = sha256Hex(JSON.stringify(statement));
    const artifact = {
      artifactId: `pstmt_${tenantId}_${partyId}_${period}_${suffix}_${statementHash}`,
      artifactType: "PartyStatement.v1",
      partyId,
      partyRole,
      period,
      statement,
      artifactHash: statementHash
    };
    await api.store.putArtifact({ tenantId, artifact });
    await api.store.putPartyStatement({
      tenantId,
      statement: {
        partyId,
        period,
        basis: "settledAt",
        status: "CLOSED",
        statementHash,
        artifactId: artifact.artifactId,
        artifactHash: artifact.artifactHash,
        closedAt: new Date("2026-02-01T00:00:00.000Z").toISOString()
      }
    });
  }

  await closeMonthAndPutStatement({ period: monthInitial, payoutCents: 2000, suffix: "first" });
  const firstPayout = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(monthInitial)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_first_enqueue"
    },
    body: {
      counterpartyRef: "bank:acct_chargeback_1"
    }
  });
  assert.equal(firstPayout.statusCode, 201, firstPayout.body);
  const operationId = String(firstPayout.json?.moneyRailOperation?.operationId ?? "");
  assert.ok(operationId);

  const submitted = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stub_default/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_submitted"
    },
    body: {
      operationId,
      eventType: "submitted",
      eventId: "evt_chargeback_submitted",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(submitted.statusCode, 200);
  const confirmed = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stub_default/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_confirmed"
    },
    body: {
      operationId,
      eventType: "confirmed",
      eventId: "evt_chargeback_confirmed",
      at: "2026-02-07T00:02:00.000Z"
    }
  });
  assert.equal(confirmed.statusCode, 200);
  const reversed = await request(api, {
    method: "POST",
    path: "/ops/money-rails/stub_default/events/ingest",
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_reversed"
    },
    body: {
      operationId,
      eventType: "reversed",
      eventId: "evt_chargeback_reversed",
      reasonCode: "chargeback",
      at: "2026-02-07T00:03:00.000Z"
    }
  });
  assert.equal(reversed.statusCode, 200);
  assert.equal(reversed.json?.operation?.state, "reversed");

  const exposuresBefore = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/chargebacks?providerId=stub_default&partyId=${encodeURIComponent(partyId)}`,
    headers: financeReadHeaders
  });
  assert.equal(exposuresBefore.statusCode, 200, exposuresBefore.body);
  assert.equal(exposuresBefore.json?.summary?.totalOutstandingCents, 2000);
  assert.equal(exposuresBefore.json?.parties?.[0]?.status, "negative_balance");

  const holdPolicy = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        chargebacks: {
          enabled: true,
          negativeBalanceMode: "hold"
        }
      }
    }
  });
  assert.equal(holdPolicy.statusCode, 200);

  await closeMonthAndPutStatement({ period: monthHold, payoutCents: 1500, suffix: "hold" });
  const holdBlocked = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(monthHold)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_hold_block"
    },
    body: {
      counterpartyRef: "bank:acct_chargeback_1"
    }
  });
  assert.equal(holdBlocked.statusCode, 409);
  assert.equal(holdBlocked.json?.code, "NEGATIVE_BALANCE_PAYOUT_HOLD");

  const netPolicy = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: financeWriteHeaders,
    body: {
      plan: "free",
      hardLimitEnforced: true,
      moneyRails: {
        chargebacks: {
          enabled: true,
          negativeBalanceMode: "net"
        }
      }
    }
  });
  assert.equal(netPolicy.statusCode, 200);

  await closeMonthAndPutStatement({ period: monthNet, payoutCents: 2500, suffix: "net" });
  const netEnqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(monthNet)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_chargeback_net_enqueue"
    },
    body: {
      counterpartyRef: "bank:acct_chargeback_1"
    }
  });
  assert.equal(netEnqueue.statusCode, 201, netEnqueue.body);
  assert.equal(netEnqueue.json?.chargeback?.outstandingBeforeCents, 2000);
  assert.equal(netEnqueue.json?.chargeback?.recoveryAppliedCents, 2000);
  assert.equal(netEnqueue.json?.chargeback?.outstandingAfterCents, 0);
  assert.equal(netEnqueue.json?.moneyRailOperation?.amountCents, 500);
  assert.equal(netEnqueue.json?.moneyRailOperation?.metadata?.chargebackRecoveryAppliedCents, 2000);
  assert.equal(netEnqueue.json?.moneyRailOperation?.metadata?.payoutAmountGrossCents, 2500);
  assert.equal(netEnqueue.json?.moneyRailOperation?.metadata?.payoutAmountNetCents, 500);

  const exposuresAfter = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/chargebacks?providerId=stub_default&partyId=${encodeURIComponent(partyId)}`,
    headers: financeReadHeaders
  });
  assert.equal(exposuresAfter.statusCode, 200, exposuresAfter.body);
  assert.equal(exposuresAfter.json?.summary?.totalOutstandingCents, 0);
  assert.equal(exposuresAfter.json?.summary?.totalRecoveredCents, 2000);
  assert.equal(exposuresAfter.json?.parties?.[0]?.status, "clear");
});

test("API e2e: finance money rail reconciliation reports deterministic critical mismatches", async () => {
  const api = createApi({
    opsTokens: ["tok_finw:finance_write", "tok_fin:finance_read"].join(";")
  });

  const month = "2026-01";
  const financeWriteHeaders = { "x-proxy-ops-token": "tok_finw" };
  const financeReadHeaders = { "x-proxy-ops-token": "tok_fin" };
  const tenantId = "tenant_default";
  const partyId = "pty_money_ops_recon_1";
  const partyRole = "operator";

  const monthCloseRequested = await request(api, {
    method: "POST",
    path: "/ops/month-close",
    headers: financeWriteHeaders,
    body: { month }
  });
  assert.equal(monthCloseRequested.statusCode, 202);
  await api.tickMonthClose({ maxMessages: 50 });

  const statement = {
    type: "PartyStatementBody.v1",
    v: 1,
    currency: "USD",
    tenantId,
    partyId,
    partyRole,
    period: month,
    basis: "settledAt",
    payoutCents: 2750
  };
  const statementHash = sha256Hex(JSON.stringify(statement));
  const partyArtifact = {
    artifactId: `pstmt_${tenantId}_${partyId}_${month}_${statementHash}`,
    artifactType: "PartyStatement.v1",
    partyId,
    partyRole,
    period: month,
    statement,
    artifactHash: statementHash
  };
  await api.store.putArtifact({ tenantId, artifact: partyArtifact });
  await api.store.putPartyStatement({
    tenantId,
    statement: {
      partyId,
      period: month,
      basis: "settledAt",
      status: "CLOSED",
      statementHash,
      artifactId: partyArtifact.artifactId,
      artifactHash: partyArtifact.artifactHash,
      closedAt: new Date("2026-02-01T00:00:00.000Z").toISOString()
    }
  });

  const enqueue = await request(api, {
    method: "POST",
    path: `/ops/payouts/${encodeURIComponent(partyId)}/${encodeURIComponent(month)}/enqueue`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_recon_enqueue_1"
    },
    body: {
      counterpartyRef: "bank:acct_recon_1"
    }
  });
  assert.equal(enqueue.statusCode, 201);
  const providerId = String(enqueue.json?.moneyRailOperation?.providerId ?? "");
  const operationId = String(enqueue.json?.moneyRailOperation?.operationId ?? "");
  assert.equal(providerId, "stub_default");
  assert.ok(operationId);

  const firstRecon = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}`,
    headers: financeReadHeaders
  });
  assert.equal(firstRecon.statusCode, 200);
  assert.equal(firstRecon.json?.status, "pass");
  assert.equal(firstRecon.json?.summary?.expectedPayoutCount, 1);
  assert.equal(firstRecon.json?.summary?.operationCount, 1);
  assert.equal(firstRecon.json?.summary?.criticalMismatchCount, 0);

  const failed = await request(api, {
    method: "POST",
    path: `/ops/money-rails/${encodeURIComponent(providerId)}/events/ingest`,
    headers: {
      ...financeWriteHeaders,
      "x-idempotency-key": "ops_money_rail_recon_ingest_failed_1"
    },
    body: {
      operationId,
      eventType: "failed",
      eventId: "evt_recon_failed_1",
      reasonCode: "insufficient_liquidity",
      at: "2026-02-07T00:01:00.000Z"
    }
  });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json?.operation?.state, "failed");

  const missingPayoutKey = `${tenantId}:party:pty_missing:period:${month}:statement:sha_missing`;
  const missingArtifactCore = {
    schemaVersion: "PayoutInstruction.v1",
    artifactType: "PayoutInstruction.v1",
    artifactId: `payout_${tenantId}_pty_missing_${month}_sha_missing`,
    generatedAt: "2026-02-02T00:00:00.000Z",
    tenantId,
    partyId: "pty_missing",
    partyRole: "operator",
    period: month,
    statementHash: "sha_missing",
    payoutKey: missingPayoutKey,
    payout: {
      currency: "USD",
      amountCents: 900,
      destinationRef: null
    },
    eventProof: {
      lastChainHash: "hash_missing",
      eventCount: 0,
      signatures: { signedEventCount: 0, signerKeyIds: [] }
    }
  };
  await api.store.putArtifact({
    tenantId,
    artifact: { ...missingArtifactCore, artifactHash: computeArtifactHash(missingArtifactCore) }
  });

  const secondRecon = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}`,
    headers: financeReadHeaders
  });
  assert.equal(secondRecon.statusCode, 200);
  assert.equal(secondRecon.json?.status, "fail");
  assert.equal(secondRecon.json?.summary?.criticalMismatchCount, 2);
  assert.equal(secondRecon.json?.mismatches?.terminalFailures?.length, 1);
  assert.equal(secondRecon.json?.mismatches?.missingOperations?.length, 1);
  assert.equal(secondRecon.json?.mismatches?.missingOperations?.[0]?.operationId, `mop_${missingPayoutKey}`);

  const replayRecon = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}`,
    headers: financeReadHeaders
  });
  assert.equal(replayRecon.statusCode, 200);
  assert.deepEqual(replayRecon.json, secondRecon.json);

  const persistedRecon = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}&persist=true`,
    headers: financeReadHeaders
  });
  assert.equal(persistedRecon.statusCode, 200);
  assert.equal(persistedRecon.json?.status, "fail");
  assert.ok(typeof persistedRecon.json?.reportHash === "string" && persistedRecon.json.reportHash.length === 64);
  assert.equal(persistedRecon.json?.artifact?.artifactId?.startsWith("money_rail_reconcile_"), true);
  assert.ok(typeof persistedRecon.json?.artifact?.artifactHash === "string" && persistedRecon.json.artifact.artifactHash.length === 64);

  const persistedReplay = await request(api, {
    method: "GET",
    path: `/ops/finance/money-rails/reconcile?period=${encodeURIComponent(month)}&providerId=${encodeURIComponent(providerId)}&persist=true`,
    headers: financeReadHeaders
  });
  assert.equal(persistedReplay.statusCode, 200);
  assert.equal(persistedReplay.json?.artifact?.artifactId, persistedRecon.json?.artifact?.artifactId);
  assert.equal(persistedReplay.json?.artifact?.artifactHash, persistedRecon.json?.artifact?.artifactHash);

  const storedArtifact = await api.store.getArtifact({
    tenantId,
    artifactId: persistedRecon.json?.artifact?.artifactId
  });
  assert.equal(storedArtifact?.artifactType, "MoneyRailReconcileReport.v1");
  assert.equal(storedArtifact?.reportHash, persistedRecon.json?.reportHash);
});
