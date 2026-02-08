import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { request } from "./api-test-harness.js";

function makeStripeSubscriptionUpdatedEvent({
  eventId,
  subscriptionId,
  customerId,
  priceId,
  status = "active",
  created = 1770422400
}) {
  return {
    id: eventId,
    type: "customer.subscription.updated",
    created,
    data: {
      object: {
        id: subscriptionId,
        customer: customerId,
        status,
        current_period_start: created,
        current_period_end: created + 2_419_200,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              price: {
                id: priceId,
                metadata: {
                  settldPlan: "growth"
                }
              }
            }
          ]
        },
        metadata: {}
      }
    }
  };
}

test("API e2e: billing stripe sync worker replays eligible dead-letter events", async () => {
  let nowValue = "2026-02-08T00:00:00.000Z";
  const api = createApi({
    now: () => nowValue,
    opsTokens: "tok_opsr:ops_read;tok_finr:finance_read",
    billingStripeSyncIntervalSeconds: 0,
    billingStripeSyncBatchSize: 10
  });

  const tenantId = "tenant_billing_sync_worker_replay";
  const replayEvent = makeStripeSubscriptionUpdatedEvent({
    eventId: "evt_sync_replay_001",
    subscriptionId: "sub_sync_replay_001",
    customerId: "cus_sync_replay_001",
    priceId: "price_growth_sync_replay_001"
  });

  await api.store.appendOpsAudit({
    tenantId,
    audit: {
      action: "BILLING_PROVIDER_EVENT_REJECTED",
      targetType: "billing_provider_event",
      targetId: replayEvent.id,
      at: nowValue,
      details: {
        provider: "stripe",
        eventId: replayEvent.id,
        eventType: replayEvent.type,
        reason: "apply_failed",
        source: "webhook",
        replayable: true,
        event: replayEvent
      }
    }
  });

  const run = await api.tickBillingStripeSync({
    tenantId,
    force: true,
    maxRows: 10
  });
  assert.equal(run.ok, true);
  assert.equal(run.summary.applied, 1);
  assert.equal(run.summary.failed, 0);

  const plan = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(plan.statusCode, 200);
  assert.equal(plan.json?.billing?.plan, "growth");

  const status = await request(api, {
    method: "GET",
    path: "/ops/status",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_opsr"
    }
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json?.maintenance?.billingStripeSync?.enabled, true);
  assert.equal(typeof status.json?.maintenance?.billingStripeSync?.lastRunAt, "string");
});

test("API e2e: billing stripe sync worker enforces replay backoff and max attempts", async () => {
  let currentMs = Date.parse("2026-02-08T01:00:00.000Z");
  const api = createApi({
    now: () => new Date(currentMs).toISOString(),
    opsTokens: "tok_opsr:ops_read",
    billingStripeSyncIntervalSeconds: 0,
    billingStripeSyncBatchSize: 10,
    billingStripeSyncMaxReplayAttempts: 2,
    billingStripeSyncMinRetrySeconds: 60,
    billingStripeSyncMaxRetrySeconds: 60
  });

  const tenantId = "tenant_billing_sync_worker_backoff";
  const invalidReplayEvent = {
    id: "evt_sync_bad_001",
    type: "customer.subscription.updated",
    created: 1770422400,
    data: {}
  };

  await api.store.appendOpsAudit({
    tenantId,
    audit: {
      action: "BILLING_PROVIDER_EVENT_REJECTED",
      targetType: "billing_provider_event",
      targetId: invalidReplayEvent.id,
      at: new Date(currentMs).toISOString(),
      details: {
        provider: "stripe",
        eventId: invalidReplayEvent.id,
        eventType: invalidReplayEvent.type,
        reason: "apply_failed",
        source: "webhook",
        replayable: true,
        event: invalidReplayEvent
      }
    }
  });

  const first = await api.tickBillingStripeSync({
    tenantId,
    force: true,
    maxRows: 10
  });
  assert.equal(first.ok, true);
  assert.equal(first.summary.failed, 1);

  const second = await api.tickBillingStripeSync({
    tenantId,
    force: true,
    maxRows: 10
  });
  assert.equal(second.ok, true);
  assert.equal(second.summary.selected, 0);
  assert.equal(second.summary.skippedBackoff, 1);

  currentMs += 61_000;
  const third = await api.tickBillingStripeSync({
    tenantId,
    force: true,
    maxRows: 10
  });
  assert.equal(third.ok, true);
  assert.equal(third.summary.failed, 1);

  currentMs += 61_000;
  const fourth = await api.tickBillingStripeSync({
    tenantId,
    force: true,
    maxRows: 10
  });
  assert.equal(fourth.ok, true);
  assert.equal(fourth.summary.selected, 0);
  assert.equal(fourth.summary.skippedMaxAttempts, 1);
});
