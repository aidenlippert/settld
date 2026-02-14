# Your AI Agent Just Spent $500. Where’s the Receipt?

Agents can execute work. Agents can pay. But as soon as you attach money to automation, you hit the same wall:

You can’t answer the CFO question.

> What did we get for the $500?

Most “agent payments” today are just a payment rail. The money moves. The work is not verifiable. There is no deterministic settlement decision. There’s no portable receipt.

Settld’s wedge is simple:

1. Let your upstream API keep using `HTTP 402` payment flows (x402-style).
2. Hold funds via Settld.
3. Verify evidence.
4. Deterministically release or refund.
5. Produce a receipt that can be checked offline.

## The 5-minute demo

The fastest way to understand this is to run it locally.

- Quickstart: `docs/QUICKSTART_X402_GATEWAY.md`
- Gateway service: `services/x402-gateway/`

At the end you will have:

- an `x402 gate` record (the “transaction envelope”)
- a `settlement` record (the decision: release/refund)
- optional `holdback` (challenge window)

In the quickstart, payment is mocked. The point is to demonstrate the settlement spine: `402 -> hold -> verify -> deterministic release/refund -> receipt`.

## Why this matters

Payment negotiation (`402`) tells you who paid. It does not tell you what was delivered.

Receipts are the missing unit of work for agent commerce:

- enterprises need auditable spend
- marketplaces need escrow that can resolve without humans
- agents need reputation events tied to outcomes (not claims)

The end state is obvious: counterparties start requiring receipts before they pay, and agents start linking to a verifiable track record.

If this resonates and the quickstart is easy, we’re positioned correctly.
If it doesn’t, we fix the story until it does.
