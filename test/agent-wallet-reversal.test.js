import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_RUN_SETTLEMENT_STATUS,
  createAgentRunSettlement,
  createAgentWallet,
  creditAgentWallet,
  refundReleasedAgentRunSettlement,
  resolveAgentRunSettlement,
  transferAgentWalletAvailable
} from "../src/core/agent-wallets.js";

test("agent wallets: transferAgentWalletAvailable moves available funds and updates counters", () => {
  const at = "2026-02-18T02:00:00.000Z";
  const fromBase = createAgentWallet({ tenantId: "tenant_default", agentId: "agt_from_1", at });
  const toBase = createAgentWallet({ tenantId: "tenant_default", agentId: "agt_to_1", at });
  const fromWallet = creditAgentWallet({ wallet: fromBase, amountCents: 1000, at });

  const moved = transferAgentWalletAvailable({ fromWallet, toWallet: toBase, amountCents: 300, at });
  assert.equal(moved.fromWallet.availableCents, 700);
  assert.equal(moved.fromWallet.totalDebitedCents, 300);
  assert.equal(moved.toWallet.availableCents, 300);
  assert.equal(moved.toWallet.totalCreditedCents, 300);
});

test("agent settlements: refundReleasedAgentRunSettlement converts released to refunded", () => {
  const at = "2026-02-18T02:05:00.000Z";
  const locked = createAgentRunSettlement({
    tenantId: "tenant_default",
    runId: "run_refund_1",
    agentId: "agt_payee_1",
    payerAgentId: "agt_payer_1",
    amountCents: 500,
    currency: "USD",
    at
  });
  const released = resolveAgentRunSettlement({
    settlement: locked,
    status: AGENT_RUN_SETTLEMENT_STATUS.RELEASED,
    runStatus: "completed",
    releasedAmountCents: 500,
    refundedAmountCents: 0,
    at
  });
  const refunded = refundReleasedAgentRunSettlement({
    settlement: released,
    runStatus: "refunded",
    decisionReason: "x402_refund_accepted",
    at: "2026-02-18T02:06:00.000Z"
  });
  assert.equal(refunded.status, AGENT_RUN_SETTLEMENT_STATUS.REFUNDED);
  assert.equal(refunded.releasedAmountCents, 0);
  assert.equal(refunded.refundedAmountCents, 500);
  assert.equal(refunded.releaseRatePct, 0);
});
