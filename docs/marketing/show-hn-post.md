# Show HN Draft

## Title (pick one)

1. Show HN (Repost): Settld – verify-before-release gateway for HTTP 402 (x402) APIs (OSS)
2. Show HN (Repost): Settld – verifiable settlement receipts for agent spend (OSS)
3. Show HN (Repost): Settld – deterministic release/refund decisions + receipt trail for x402

---

## Post Body

Hi HN,

Settld is an open source artifact protocol + verifier for producing hash-bound “settlement receipts”: deterministic records that tie *terms + evidence refs + a release/refund decision* together so a counterparty can verify what happened without trusting your database.

Fastest way to try it is the in-repo x402 gateway demo (about 10 minutes):

```bash
npm ci && npm run quickstart:x402
```

It runs a local Settld API, a mock upstream that returns `HTTP 402 Payment Required` + `x-payment-required`, and a thin gateway. First request returns `402` plus `x-settld-gate-id`. Retry with that gate id and `x-payment: paid`, and the gateway calls Settld to:

`hold -> verify -> release/refund (+ optional holdback)` and returns a receipt-like trail via `x-settld-*` headers (and a `GET /x402/gate/:id` inspection endpoint).

Full quickstart (Docker + Linux notes): `docs/QUICKSTART_X402_GATEWAY.md`

Two boundaries up front:

- This is not a payment processor. The demo uses `X402_AUTOFUND=1` to simulate funding in an internal ledger so escrow-style holds can be created.
- Multi-hop “agents hiring agents” is not automatic today. The repo includes an `AgreementDelegation.v1` primitive + deterministic cycle checks when a gate is bound to an agreement graph; full compositional settlement is still in progress.

Feedback I’d love:

1. If you’re shipping agent workflows that spend money today, what evidence would you require to automate release/refund?
2. Where would this break first in your stack: metering, dispute windows, refunds/chargebacks, or trust anchors?

---

## Submission Notes (not part of the post)

- Post Tue-Thu mornings ET if you want feedback quickly.
- If someone says “just use Stripe Connect”: Stripe moves money; Settld decides how much should move based on verifiable evidence, deterministically.
- If someone says “just use a smart contract”: smart contracts can enforce on-chain state; Settld is about verifying off-chain work completion and producing portable, deterministic receipts.
