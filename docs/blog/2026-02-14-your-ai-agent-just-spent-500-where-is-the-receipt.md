# Your AI Agent Just Spent $500. Where's the Receipt?

Every agent stack today can do the work.

What it cannot do is produce a receipt you can actually trust.

If you are shipping agents, you have this problem already:

- Your agent calls tools, vendors, models, and other agents.
- Money moves.
- Later someone asks: "What did we get for that spend?"

Most teams answer with logs, screenshots, and vibes. That does not scale, and it does not pass a CFO or audit review.

Settld is the missing layer between "work done" and "money moved": deterministic settlement with verifiable evidence and a receipt trail.

This post is a 10-minute, self-serve demo: put a thin gateway in front of an `x402`-style API. When the upstream says `402 Payment Required`, the gateway creates a Settld hold. When the upstream returns the resource, Settld verifies evidence and releases (or holds back) deterministically.

## The Wedge: x402 Gateway (Verify Before Release)

x402 gives you a clean payment negotiation surface at the HTTP layer.

But it still does not solve:

- Proving the work/resource was delivered correctly
- Applying deterministic payout logic
- Producing a receipt trail that a counterparty can verify offline

The x402 gateway is the smallest thing you can install to feel the difference immediately:

1. Client requests `/resource`
2. Upstream replies `402` with `x-payment-required`
3. Gateway creates a Settld gate + escrow hold and returns `x-settld-gate-id`
4. Client retries with `x-settld-gate-id` + payment proof
5. Gateway verifies the delivered response, Settld issues a deterministic decision and receipt

You do not need to redesign your API. You put a proxy in front of it.

## Run It Locally (10 minutes)

This repo includes:

- A local Settld API (in-memory)
- A mock x402-style upstream (`services/x402-gateway/examples/upstream-mock.js`)
- The x402 gateway (`services/x402-gateway/`)

Quickstart:

- `docs/QUICKSTART_X402_GATEWAY.md`

The single thing to notice: your client experience stays the same (it still sees a `402`), but now there is an explicit settlement object with deterministic outcomes and an audit-friendly trail.

## What You Get (Immediately)

- A stable "gate id" you can attach to your own logs and job ids
- A deterministic verify+decision step (no human-in-the-loop required for the happy path)
- A receipt-like trail (`x-settld-*` headers + API query surface) that you can store and audit later

## What This Unlocks

Once you have `verify -> decide -> receipt` in the loop, you can add the things enterprises and marketplaces actually require:

- Holdbacks and dispute windows that do not rely on customer support tickets
- Reputation events based on completed/failed/disputed settlements
- Governance controls ("do not spend with low-reputation counterparties", "cap delegation depth", "require approval above $X")
- Delegated, multi-hop settlement (the hard moat)

## If You Build Agents, This Is the New Default

Agents will transact. The only question is whether they transact with receipts and deterministic settlement, or with chaos.

If you want to wire this into a real x402 flow (real payment rail, no demo shortcuts), the gateway stays the same shape. The funding source changes.

