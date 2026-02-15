import test from "node:test";
import assert from "node:assert/strict";

import { createApi } from "../src/api/app.js";
import { createEd25519Keypair, sha256Hex } from "../src/core/crypto.js";
import { request } from "./api-test-harness.js";

async function registerAgent(api, { agentId, walletPolicy = null } = {}) {
  const { publicKeyPem } = createEd25519Keypair();
  const created = await request(api, {
    method: "POST",
    path: "/agents/register",
    headers: { "x-idempotency-key": `agent_register_${agentId}` },
    body: {
      agentId,
      displayName: `Agent ${agentId}`,
      owner: { ownerType: "service", ownerId: "svc_wallet_policy" },
      publicKeyPem,
      ...(walletPolicy ? { walletPolicy } : {})
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  return agentId;
}

async function creditWallet(api, { agentId, amountCents, idempotencyKey }) {
  const response = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(agentId)}/wallet/credit`,
    headers: { "x-idempotency-key": idempotencyKey },
    body: { amountCents, currency: "USD" }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json.wallet;
}

test("API e2e: AgentIdentity.walletPolicy.maxDailyCents blocks additional escrow locks", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, {
    agentId: "agt_wallet_policy_daily_payer_1",
    walletPolicy: { maxDailyCents: 1000 }
  });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_wallet_policy_daily_payee_1" });

  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_policy_credit_1" });

  const run1 = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "wallet_policy_run_1" },
    body: {
      runId: "wallet_policy_run_1",
      taskType: "classification",
      settlement: {
        payerAgentId,
        amountCents: 800,
        currency: "USD"
      }
    }
  });
  assert.equal(run1.statusCode, 201, run1.body);

  const run2 = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "wallet_policy_run_2" },
    body: {
      runId: "wallet_policy_run_2",
      taskType: "classification",
      settlement: {
        payerAgentId,
        amountCents: 300,
        currency: "USD"
      }
    }
  });
  assert.equal(run2.statusCode, 409, run2.body);
  assert.equal(run2.json?.details?.code, "WALLET_POLICY_MAX_DAILY");
});

test("API e2e: maxDailyCents includes tool-call holdback escrow locks", async () => {
  const api = createApi({ opsToken: "tok_ops" });

  const payerAgentId = await registerAgent(api, {
    agentId: "agt_wallet_policy_daily_payer_2",
    walletPolicy: { maxDailyCents: 1000 }
  });
  const payeeAgentId = await registerAgent(api, { agentId: "agt_wallet_policy_daily_payee_2" });

  await creditWallet(api, { agentId: payerAgentId, amountCents: 5000, idempotencyKey: "wallet_policy_credit_2" });

  const run1 = await request(api, {
    method: "POST",
    path: `/agents/${encodeURIComponent(payeeAgentId)}/runs`,
    headers: { "x-idempotency-key": "wallet_policy_tc_run_1" },
    body: {
      runId: "wallet_policy_tc_run_1",
      taskType: "classification",
      settlement: {
        payerAgentId,
        amountCents: 800,
        currency: "USD"
      }
    }
  });
  assert.equal(run1.statusCode, 201, run1.body);

  const agreementHash = sha256Hex("wallet_policy_tc_agreement_1");
  const receiptHash = sha256Hex("wallet_policy_tc_receipt_1");

  const hold = await request(api, {
    method: "POST",
    path: "/ops/tool-calls/holds/lock",
    headers: { "x-idempotency-key": "wallet_policy_tc_hold_1" },
    body: {
      agreementHash,
      receiptHash,
      payerAgentId,
      payeeAgentId,
      amountCents: 1000,
      currency: "USD",
      holdbackBps: 5000,
      challengeWindowMs: 1000
    }
  });
  assert.equal(hold.statusCode, 409, hold.body);
  assert.equal(hold.json?.details?.code, "WALLET_POLICY_MAX_DAILY");
});

