import test from "node:test";
import assert from "node:assert/strict";

import { selectMarketplaceAutoAwardBidV1 } from "../src/core/marketplace-auto-award.js";

test("selectMarketplaceAutoAwardBidV1 deterministically selects the lowest unique amount/eta bid", () => {
  const rfq = {
    rfqId: "rfq_auto_1",
    budgetCents: 2500
  };
  const bids = [
    {
      bidId: "bid_b",
      bidderAgentId: "agt_b",
      amountCents: 2100,
      currency: "USD",
      etaSeconds: 900,
      status: "pending",
      createdAt: "2026-03-05T00:00:05.000Z"
    },
    {
      bidId: "bid_a",
      bidderAgentId: "agt_a",
      amountCents: 2100,
      currency: "USD",
      etaSeconds: 600,
      status: "pending",
      createdAt: "2026-03-05T00:00:10.000Z"
    }
  ];

  const first = selectMarketplaceAutoAwardBidV1({
    rfq,
    bids,
    decidedAt: "2026-03-05T01:00:00.000Z"
  });
  const second = selectMarketplaceAutoAwardBidV1({
    rfq,
    bids,
    decidedAt: "2026-03-05T01:00:00.000Z"
  });

  assert.equal(first.selectedBid?.bidId, "bid_a");
  assert.equal(first.decision.outcome, "selected");
  assert.equal(first.decision.selectedBidId, "bid_a");
  assert.equal(first.decision.decisionHash, second.decision.decisionHash);
});

test("selectMarketplaceAutoAwardBidV1 fails closed when the best bids are ambiguous", () => {
  const outcome = selectMarketplaceAutoAwardBidV1({
    rfq: {
      rfqId: "rfq_auto_ambiguous",
      budgetCents: 2500
    },
    bids: [
      {
        bidId: "bid_a",
        bidderAgentId: "agt_a",
        amountCents: 2000,
        currency: "USD",
        etaSeconds: 600,
        status: "pending",
        createdAt: "2026-03-05T00:00:00.000Z"
      },
      {
        bidId: "bid_b",
        bidderAgentId: "agt_b",
        amountCents: 2000,
        currency: "USD",
        etaSeconds: 600,
        status: "pending",
        createdAt: "2026-03-05T00:00:01.000Z"
      }
    ],
    decidedAt: "2026-03-05T01:00:00.000Z"
  });

  assert.equal(outcome.selectedBid, null);
  assert.equal(outcome.decision.outcome, "blocked");
  assert.equal(outcome.decision.reasonCode, "MARKETPLACE_AUTO_AWARD_AMBIGUOUS");
  assert.deepEqual(outcome.decision.tiedBidIds, ["bid_a", "bid_b"]);
});

test("selectMarketplaceAutoAwardBidV1 fails closed when the best bid is over budget", () => {
  const blocked = selectMarketplaceAutoAwardBidV1({
    rfq: {
      rfqId: "rfq_auto_budget",
      budgetCents: 1500
    },
    bids: [
      {
        bidId: "bid_budget",
        bidderAgentId: "agt_budget",
        amountCents: 1900,
        currency: "USD",
        etaSeconds: 300,
        status: "pending",
        createdAt: "2026-03-05T00:00:00.000Z"
      }
    ],
    decidedAt: "2026-03-05T01:00:00.000Z"
  });
  assert.equal(blocked.selectedBid, null);
  assert.equal(blocked.decision.reasonCode, "MARKETPLACE_AUTO_AWARD_OVER_BUDGET");

  const allowed = selectMarketplaceAutoAwardBidV1({
    rfq: {
      rfqId: "rfq_auto_budget",
      budgetCents: 1500
    },
    bids: [
      {
        bidId: "bid_budget",
        bidderAgentId: "agt_budget",
        amountCents: 1900,
        currency: "USD",
        etaSeconds: 300,
        status: "pending",
        createdAt: "2026-03-05T00:00:00.000Z"
      }
    ],
    allowOverBudget: true,
    decidedAt: "2026-03-05T01:00:00.000Z"
  });
  assert.equal(allowed.selectedBid?.bidId, "bid_budget");
  assert.equal(allowed.decision.outcome, "selected");
});
