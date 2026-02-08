import crypto from "node:crypto";
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

function makeStripeSignatureHeader({ rawBody, secret, timestamp }) {
  const digest = crypto.createHmac("sha256", secret).update(`${String(timestamp)}.${rawBody}`, "utf8").digest("hex");
  return `t=${String(timestamp)},v1=${digest}`;
}

test("API e2e: billing subscription endpoint upserts provider state and plan", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
  });

  const tenantId = "tenant_billing_subscription_manual";

  const upsert = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/subscription",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: {
      plan: "builder",
      subscription: {
        provider: "stripe",
        customerId: "cus_manual_001",
        subscriptionId: "sub_manual_001",
        status: "active",
        currentPeriodStart: "2026-02-01T00:00:00.000Z",
        currentPeriodEnd: "2026-03-01T00:00:00.000Z"
      }
    }
  });
  assert.equal(upsert.statusCode, 200);
  assert.equal(upsert.json?.subscription?.provider, "stripe");
  assert.equal(upsert.json?.subscription?.subscriptionId, "sub_manual_001");
  assert.equal(upsert.json?.resolvedPlan?.planId, "builder");

  const getPlan = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getPlan.statusCode, 200);
  assert.equal(getPlan.json?.billing?.plan, "builder");

  const getSubscription = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/subscription",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getSubscription.statusCode, 200);
  assert.equal(getSubscription.json?.subscription?.customerId, "cus_manual_001");
  assert.equal(getSubscription.json?.subscription?.status, "active");
});

test("API e2e: resolved billing plan follows active subscription plan even if stored plan is stale", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
  });

  const tenantId = "tenant_billing_subscription_resolved_from_active_sub";

  const upsert = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/subscription",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: {
      // Simulate stale/manual top-level billing plan while provider subscription is active on a paid tier.
      plan: "free",
      subscription: {
        provider: "stripe",
        customerId: "cus_stale_plan_001",
        subscriptionId: "sub_stale_plan_001",
        status: "active",
        plan: "builder",
        currentPeriodStart: "2026-02-01T00:00:00.000Z",
        currentPeriodEnd: "2026-03-01T00:00:00.000Z"
      }
    }
  });
  assert.equal(upsert.statusCode, 200);
  assert.equal(upsert.json?.resolvedPlan?.planId, "builder");

  const getPlan = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getPlan.statusCode, 200);
  assert.equal(getPlan.json?.billing?.plan, "free");
  assert.equal(getPlan.json?.resolvedPlan?.planId, "builder");

  const getSummary = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/summary",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getSummary.statusCode, 200);
  assert.equal(getSummary.json?.plan?.planId, "builder");
});

test("API e2e: stripe billing webhook is idempotent and syncs growth plan", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
  });

  const tenantId = "tenant_billing_webhook_stripe";
  const payload = makeStripeSubscriptionUpdatedEvent({
    eventId: "evt_sub_updated_001",
    subscriptionId: "sub_stripe_001",
    customerId: "cus_stripe_001",
    priceId: "price_growth_monthly"
  });

  const first = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: payload
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json?.duplicate, false);
  assert.equal(first.json?.applied?.planChanged, true);
  assert.equal(first.json?.applied?.nextPlan, "growth");
  assert.equal(first.json?.subscription?.priceId, "price_growth_monthly");

  const duplicate = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: payload
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json?.duplicate, true);

  const getPlan = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getPlan.statusCode, 200);
  assert.equal(getPlan.json?.billing?.plan, "growth");

  const getSubscription = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/subscription",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getSubscription.statusCode, 200);
  assert.equal(getSubscription.json?.subscription?.provider, "stripe");
  assert.equal(getSubscription.json?.subscription?.subscriptionId, "sub_stripe_001");
  assert.equal(getSubscription.json?.subscription?.status, "active");
});

test("API e2e: stripe webhook maps configured price IDs to billing plan when metadata is absent", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finr:finance_read;tok_finw:finance_write",
    billingStripePriceIdBuilder: "price_builder_cfg_001",
    billingStripePriceIdGrowth: "price_growth_cfg_001",
    billingStripePriceIdEnterprise: "price_enterprise_cfg_001"
  });

  const tenantId = "tenant_billing_webhook_price_map";
  const payload = makeStripeSubscriptionUpdatedEvent({
    eventId: "evt_sub_price_map_001",
    subscriptionId: "sub_price_map_001",
    customerId: "cus_price_map_001",
    priceId: "price_builder_cfg_001"
  });
  // Simulate real Stripe subscription events that do not include settldPlan metadata.
  payload.data.object.items.data[0].price.metadata = {};

  const ingested = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: payload
  });
  assert.equal(ingested.statusCode, 200);
  assert.equal(ingested.json?.duplicate, false);
  assert.equal(ingested.json?.applied?.nextPlan, "builder");
  assert.equal(ingested.json?.subscription?.plan, "builder");

  const getPlan = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(getPlan.statusCode, 200);
  assert.equal(getPlan.json?.billing?.plan, "builder");
});

test("API e2e: stripe billing webhook enforces signature when secret is configured", async () => {
  const webhookSecret = "whsec_test_001";
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finw:finance_write",
    billingStripeWebhookSecret: webhookSecret,
    billingStripeWebhookToleranceSeconds: 300
  });

  const tenantId = "tenant_billing_webhook_sig";
  const payload = makeStripeSubscriptionUpdatedEvent({
    eventId: "evt_sub_sig_001",
    subscriptionId: "sub_sig_001",
    customerId: "cus_sig_001",
    priceId: "price_growth_sig",
    created: 1770422400
  });

  const missingSig = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: payload
  });
  assert.equal(missingSig.statusCode, 400);
  assert.equal(missingSig.json?.error, "invalid stripe signature");

  const reportAfterReject = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/providers/stripe/reconcile/report?limit=20",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    }
  });
  assert.equal(reportAfterReject.statusCode, 200);
  assert.ok(Number(reportAfterReject.json?.rejectedReasonCounts?.signature_verification_failed ?? 0) >= 1);

  const rawBody = JSON.stringify(payload);
  const signature = makeStripeSignatureHeader({
    rawBody,
    secret: webhookSecret,
    timestamp: 1770422400
  });
  const validSig = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw",
      "stripe-signature": signature
    },
    body: payload
  });
  assert.equal(validSig.statusCode, 200);
  assert.equal(validSig.json?.duplicate, false);
  assert.equal(validSig.json?.applied?.nextPlan, "growth");
});

test("API e2e: stripe billing reconcile replay returns summary and report", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: "tok_finr:finance_read;tok_finw:finance_write"
  });

  const tenantId = "tenant_billing_reconcile_report";
  const baseEvent = makeStripeSubscriptionUpdatedEvent({
    eventId: "evt_reconcile_001",
    subscriptionId: "sub_reconcile_001",
    customerId: "cus_reconcile_001",
    priceId: "price_growth_001"
  });

  const firstIngest = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/webhook",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: baseEvent
  });
  assert.equal(firstIngest.statusCode, 200);
  assert.equal(firstIngest.json?.duplicate, false);

  const replay = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/reconcile",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: {
      events: [
        baseEvent,
        makeStripeSubscriptionUpdatedEvent({
          eventId: "evt_reconcile_002",
          subscriptionId: "sub_reconcile_001",
          customerId: "cus_reconcile_001",
          priceId: "price_growth_002"
        }),
        {
          id: "evt_reconcile_003",
          type: "invoice.created",
          created: 1770422400,
          data: { object: { id: "in_001", customer: "cus_reconcile_001", metadata: {} } }
        },
        {
          id: "evt_reconcile_004",
          type: "customer.subscription.updated",
          created: 1770422400,
          data: {}
        }
      ]
    }
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json?.summary?.total, 4);
  assert.equal(replay.json?.summary?.duplicate, 1);
  assert.equal(replay.json?.summary?.applied, 1);
  assert.equal(replay.json?.summary?.ignored, 1);
  assert.equal(replay.json?.summary?.failed, 1);

  const report = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/providers/stripe/reconcile/report?limit=50",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(report.statusCode, 200);
  assert.equal(report.json?.provider, "stripe");
  assert.ok(Number(report.json?.counts?.ingested ?? 0) >= 2);
  assert.ok(Number(report.json?.rejectedReasonCounts?.reconcile_apply_failed ?? 0) >= 1);
  assert.equal(report.json?.subscription?.subscriptionId, "sub_reconcile_001");
});
