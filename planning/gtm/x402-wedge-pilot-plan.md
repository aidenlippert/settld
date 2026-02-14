# x402 Wedge Pilot Plan (90 Days)

Snapshot: 2026-02-13

This is a dev-first wedge (B2D) that sells into B2B budgets: "receipts + escrow + verify-before-release for agent transactions".

Status source-of-truth: GitHub Issues + Milestones (see `planning/STATUS.md`). This doc is an execution aid.

## ICPs (Who Buys)

- Enterprise teams deploying agents:
  - Pain: "my agents spent $X and I can't prove what we got" (CFO/compliance pressure).
  - Buyer: engineering leader + finance/compliance.
  - User: the developer running agent workflows.
- Agent marketplaces / API vendors:
  - Pain: escrow between buyers/sellers with verification and dispute windows.
  - Buyer: platform lead / product owner.
  - User: platform engineers.
- Multi-agent orchestration builders:
  - Pain: sub-agent failures require refund unwind across chains.
  - Buyer/user: same person (early-stage builder).

## Offer (Pilot Package)

- Timeline: 2-4 weeks
- Price: free pilot, paid conversion target by week 6-8 (manual invoicing during pilot)
- Deliverables:
  - x402 gateway installed in front of one revenue endpoint (or one internal agent workflow)
  - deterministic settlement receipts per transaction
  - dispute window enforced
  - exportable settlement ledger for audit

## Activation Milestones

- Day 1: gateway deployed + first successful 402 -> hold -> verify -> release receipt
- Week 1: 50+ real transactions with receipts
- Week 2: one dispute simulated and cleanly handled (holdback/refund path)
- Week 3-4: expand to 2nd endpoint/workflow + export to finance

## Success Scorecard

- Integration time:
  - Baseline: unknown
  - Target: < 2 hours to first receipt in staging; < 1 day in production
- Auto-resolution rate:
  - Target: > 95% of transactions auto-resolve without manual review
- Dispute rate:
  - Target: < 2% disputed (for stable workflows); measured, not guessed
- Time-to-settle:
  - Target: p50 < 5 minutes for auto-resolved flows
- Audit usefulness:
  - Target: finance can answer "what did we pay for" for a sampled week using exports only

## Target Accounts (Initial List)

- AI coding tool with per-task pricing (receipt pressure)
- Agent marketplace / "agent app store" (escrow pressure)
- Internal agents company with > $5K/mo tool spend (CFO pressure)

## Core Pitch (One Sentence)

"Your agent just spent money. Settld gives you a deterministic receipt, a dispute window, and verify-before-release escrow so you can prove what you got and control delegated spend."

## Conversion / Expansion Criteria

- Paid conversion triggers:
  - > 1,000 receipts generated
  - at least one audited export used by finance/compliance
  - clear success metrics met (integration time + auto-resolve)
- Billing posture:
  - Pilot phase: manual invoice off exports (no billing enforcement)
  - Post-pilot: usage metering/reporting becomes productized (Pro/Enterprise)
- Expansion triggers:
  - 2nd endpoint/workflow onboarded
  - delegation graph enabled for subcontract chains (composition demo)
