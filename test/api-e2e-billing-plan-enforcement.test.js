import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { tenantId, agentId, ownerId = "svc_billing_test" }) {
  const { publicKeyPem } = createEd25519Keypair();
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `register_${tenantId}_${agentId}`
    },
    body: {
      agentId,
      displayName: agentId,
      owner: { ownerType: "service", ownerId },
      publicKeyPem
    }
  });
  assert.equal(created.statusCode, 201);
}

async function createAndCompleteRun(api, { tenantId, payerAgentId, payeeAgentId, runId, amountCents, idempotencyPrefix }) {
  const createdRun = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_create`
    },
    body: {
      runId,
      taskType: "analysis",
      settlement: {
        payerAgentId,
        amountCents,
        currency: "USD",
        disputeWindowDays: 3
      }
    }
  });
  assert.equal(createdRun.statusCode, 201);
  const prevChainHash = createdRun.json?.run?.lastChainHash;
  assert.ok(prevChainHash);

  return request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": `${idempotencyPrefix}_complete`,
      "x-proxy-expected-prev-chain-hash": prevChainHash
    },
    body: {
      type: "RUN_COMPLETED",
      payload: { outputRef: `evidence://${runId}/output.json` }
    }
  });
}

test("API e2e: billing catalog + summary reflects billable event usage and estimated charges", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write"].join(";")
  });

  const tenantId = "tenant_billing_summary";
  const payerAgentId = "agt_billing_payer";
  const payeeAgentId = "agt_billing_payee";
  const arbiterAgentId = "agt_billing_arbiter";
  const runId = "run_billing_summary_1";

  const catalog = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/catalog",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json?.schemaVersion, "BillingPlanCatalog.v1");
  assert.ok(catalog.json?.plans?.builder);

  const setPlan = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: {
      plan: "builder",
      hardLimitEnforced: true
    }
  });
  assert.equal(setPlan.statusCode, 200);
  assert.equal(setPlan.json?.billing?.plan, "builder");

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });
  await registerAgent(api, { tenantId, agentId: arbiterAgentId });

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billing_summary_credit_1"
    },
    body: {
      amountCents: 5000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  const completed = await createAndCompleteRun(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    runId,
    amountCents: 1500,
    idempotencyPrefix: "billing_summary_run_1"
  });
  assert.equal(completed.statusCode, 201);
  assert.equal(completed.json?.settlement?.status, "released");

  const openedDispute = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/dispute/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billing_summary_dispute_open_1"
    },
    body: {
      disputeId: "dispute_billing_summary_1",
      reason: "need arbitration",
      openedByAgentId: payerAgentId
    }
  });
  assert.equal(openedDispute.statusCode, 200);

  const openArbitration = await request(api, {
    method: "POST",
    path: `/runs/${encodeURIComponent(runId)}/arbitration/open`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billing_summary_arb_open_1"
    },
    body: {
      caseId: "arb_case_billing_summary_1",
      disputeId: "dispute_billing_summary_1",
      arbiterAgentId
    }
  });
  assert.equal(openArbitration.statusCode, 201);

  const summary = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/summary?period=2026-02",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json?.plan?.planId, "builder");
  assert.equal(summary.json?.usage?.verifiedRuns, 1);
  assert.equal(summary.json?.usage?.settledVolumeCents, 1500);
  assert.equal(summary.json?.usage?.arbitrationCases, 1);
  assert.equal(summary.json?.estimate?.subscriptionCents, 9900);
  assert.equal(summary.json?.estimate?.settledVolumeFeeCents, 11);
  assert.equal(summary.json?.estimate?.arbitrationFeeCents, 200);
  assert.equal(summary.json?.estimate?.totalEstimatedCents, 10111);
});

test("API e2e: billing stripe provider session endpoints + period-close artifact export", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: ["tok_finr:finance_read", "tok_finw:finance_write"].join(";"),
    billingStripeCheckoutBaseUrl: "https://billing.stripe.test/checkout",
    billingStripePortalBaseUrl: "https://billing.stripe.test/portal"
  });

  const tenantId = "tenant_billing_period_close";
  const payerAgentId = "agt_billing_close_payer";
  const payeeAgentId = "agt_billing_close_payee";

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billing_close_credit_1"
    },
    body: {
      amountCents: 5000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  const checkout = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/checkout",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw",
      "x-idempotency-key": "billing_close_checkout_1"
    },
    body: {
      plan: "growth",
      customerId: "cus_test_period_close_1",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel"
    }
  });
  assert.equal(checkout.statusCode, 201);
  assert.equal(checkout.json?.checkoutSession?.schemaVersion, "BillingStripeCheckoutSession.v1");
  assert.equal(checkout.json?.checkoutSession?.provider, "stripe");
  assert.equal(checkout.json?.checkoutSession?.plan, "growth");
  assert.match(String(checkout.json?.checkoutSession?.sessionUrl ?? ""), /^https:\/\/billing\.stripe\.test\/checkout\?/);
  const checkoutUrl = new URL(String(checkout.json?.checkoutSession?.sessionUrl ?? ""));
  assert.equal(checkoutUrl.searchParams.get("tenant"), tenantId);
  assert.equal(checkoutUrl.searchParams.get("plan"), "growth");

  const portal = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/providers/stripe/portal",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw",
      "x-idempotency-key": "billing_close_portal_1"
    },
    body: {
      customerId: "cus_test_period_close_1",
      returnUrl: "https://example.test/billing"
    }
  });
  assert.equal(portal.statusCode, 201);
  assert.equal(portal.json?.portalSession?.schemaVersion, "BillingStripePortalSession.v1");
  assert.equal(portal.json?.portalSession?.provider, "stripe");
  assert.match(String(portal.json?.portalSession?.sessionUrl ?? ""), /^https:\/\/billing\.stripe\.test\/portal\?/);

  const completed = await createAndCompleteRun(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    runId: "run_billing_period_close_1",
    amountCents: 1250,
    idempotencyPrefix: "billing_close_run_1"
  });
  assert.equal(completed.statusCode, 201);

  const periodClose = await request(api, {
    method: "POST",
    path: "/ops/finance/billing/period-close",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw",
      "x-idempotency-key": "billing_close_export_1"
    },
    body: {
      period: "2026-02"
    }
  });
  assert.equal(periodClose.statusCode, 200);
  assert.equal(periodClose.json?.ok, true);
  assert.equal(periodClose.json?.period, "2026-02");
  assert.equal(periodClose.json?.usage?.verifiedRuns, 1);
  assert.equal(periodClose.json?.usage?.settledVolumeCents, 1250);
  assert.equal(typeof periodClose.json?.eventsDigest, "string");
  assert.equal(periodClose.json?.eventsDigest?.length, 64);
  assert.ok(periodClose.json?.artifact?.artifactId);
  assert.ok(periodClose.json?.artifact?.artifactHash);

  const periodCloseList = await request(api, {
    method: "GET",
    path: "/ops/finance/billing/period-close?period=2026-02&limit=20",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finr"
    }
  });
  assert.equal(periodCloseList.statusCode, 200);
  assert.equal(periodCloseList.json?.period, "2026-02");
  assert.equal(periodCloseList.json?.count, 1);
  assert.equal(periodCloseList.json?.latest?.artifactId, periodClose.json?.artifact?.artifactId);
  assert.equal(periodCloseList.json?.latest?.artifactType, "BillingPeriodClose.v1");
});

test("API e2e: billing stripe provider live mode posts to Stripe API", async () => {
  const stripeCalls = [];
  const mockStripeServer = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const formData = new URLSearchParams(body);
      stripeCalls.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        formData
      });
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "method not allowed" } }));
        return;
      }
      if (req.url === "/v1/checkout/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cs_live_test_123",
            url: "https://checkout.stripe.com/c/pay/cs_live_test_123",
            subscription: "sub_live_test_123"
          })
        );
        return;
      }
      if (req.url === "/v1/billing_portal/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "bps_live_test_123",
            url: "https://billing.stripe.com/p/session/bps_live_test_123"
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise((resolve) => mockStripeServer.listen(0, "127.0.0.1", resolve));
  const stripeAddress = mockStripeServer.address();
  assert.ok(stripeAddress && typeof stripeAddress === "object" && stripeAddress.port > 0);
  const stripeBaseUrl = `http://127.0.0.1:${stripeAddress.port}`;

  try {
    const api = createApi({
      now: () => "2026-02-07T00:00:00.000Z",
      opsTokens: "tok_finw:finance_write",
      billingStripeApiBaseUrl: stripeBaseUrl,
      billingStripeSecretKey: "sk_test_live_123",
      billingStripePriceIdBuilder: "price_builder_live_123",
      billingStripePriceIdGrowth: "price_growth_live_123",
      billingStripePriceIdEnterprise: "price_enterprise_live_123",
      billingStripeCheckoutSuccessUrl: "https://example.test/default-success",
      billingStripeCheckoutCancelUrl: "https://example.test/default-cancel",
      billingStripePortalReturnUrl: "https://example.test/default-return"
    });

    const tenantId = "tenant_billing_live_sessions";
    const checkout = await request(api, {
      method: "POST",
      path: "/ops/finance/billing/providers/stripe/checkout",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finw",
        "x-idempotency-key": "billing_live_checkout_1"
      },
      body: {
        plan: "growth",
        customerId: "cus_live_123"
      }
    });
    assert.equal(checkout.statusCode, 201);
    assert.equal(checkout.json?.checkoutSession?.mode, "live");
    assert.equal(checkout.json?.checkoutSession?.sessionId, "cs_live_test_123");
    assert.equal(checkout.json?.checkoutSession?.sessionUrl, "https://checkout.stripe.com/c/pay/cs_live_test_123");
    assert.equal(checkout.json?.checkoutSession?.priceId, "price_growth_live_123");
    assert.equal(checkout.json?.checkoutSession?.subscriptionId, "sub_live_test_123");

    const portal = await request(api, {
      method: "POST",
      path: "/ops/finance/billing/providers/stripe/portal",
      headers: {
        "x-proxy-tenant-id": tenantId,
        "x-proxy-ops-token": "tok_finw",
        "x-idempotency-key": "billing_live_portal_1"
      },
      body: {
        customerId: "cus_live_123"
      }
    });
    assert.equal(portal.statusCode, 201);
    assert.equal(portal.json?.portalSession?.mode, "live");
    assert.equal(portal.json?.portalSession?.sessionId, "bps_live_test_123");
    assert.equal(portal.json?.portalSession?.sessionUrl, "https://billing.stripe.com/p/session/bps_live_test_123");

    assert.equal(stripeCalls.length, 2);
    const checkoutCall = stripeCalls.find((call) => call.path === "/v1/checkout/sessions");
    const portalCall = stripeCalls.find((call) => call.path === "/v1/billing_portal/sessions");
    assert.ok(checkoutCall);
    assert.ok(portalCall);
    assert.equal(checkoutCall.headers.authorization, "Bearer sk_test_live_123");
    assert.equal(checkoutCall.formData.get("line_items[0][price]"), "price_growth_live_123");
    assert.equal(checkoutCall.formData.get("success_url"), "https://example.test/default-success");
    assert.equal(checkoutCall.formData.get("cancel_url"), "https://example.test/default-cancel");
    assert.equal(portalCall.headers.authorization, "Bearer sk_test_live_123");
    assert.equal(portalCall.formData.get("customer"), "cus_live_123");
    assert.equal(portalCall.formData.get("return_url"), "https://example.test/default-return");
  } finally {
    await new Promise((resolve) => mockStripeServer.close(resolve));
  }
});

test("API e2e: billing hard limit blocks additional verified runs", async () => {
  const api = createApi({
    now: () => "2026-02-07T00:00:00.000Z",
    opsTokens: ["tok_finw:finance_write"].join(";")
  });

  const tenantId = "tenant_billing_hard_limit";
  const payerAgentId = "agt_billing_limit_payer";
  const payeeAgentId = "agt_billing_limit_payee";

  const setPlan = await request(api, {
    method: "PUT",
    path: "/ops/finance/billing/plan",
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-proxy-ops-token": "tok_finw"
    },
    body: {
      plan: "free",
      hardLimitEnforced: true,
      planOverrides: {
        hardLimitVerifiedRunsPerMonth: 1,
        includedVerifiedRunsPerMonth: 1
      }
    }
  });
  assert.equal(setPlan.statusCode, 200);

  await registerAgent(api, { tenantId, agentId: payerAgentId });
  await registerAgent(api, { tenantId, agentId: payeeAgentId });

  const credit = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payerAgentId)}/wallet/credit`,
    headers: {
      "x-proxy-tenant-id": tenantId,
      "x-idempotency-key": "billing_limit_credit_1"
    },
    body: {
      amountCents: 4000,
      currency: "USD"
    }
  });
  assert.equal(credit.statusCode, 201);

  const firstCompletion = await createAndCompleteRun(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    runId: "run_billing_limit_1",
    amountCents: 500,
    idempotencyPrefix: "billing_limit_run_1"
  });
  assert.equal(firstCompletion.statusCode, 201);
  assert.equal(firstCompletion.json?.run?.status, "completed");

  const secondCompletion = await createAndCompleteRun(api, {
    tenantId,
    payerAgentId,
    payeeAgentId,
    runId: "run_billing_limit_2",
    amountCents: 500,
    idempotencyPrefix: "billing_limit_run_2"
  });
  assert.equal(secondCompletion.statusCode, 402);
  assert.equal(secondCompletion.json?.code, "BILLING_PLAN_LIMIT_EXCEEDED");
  assert.equal(secondCompletion.json?.details?.hardLimitVerifiedRunsPerMonth, 1);
});
