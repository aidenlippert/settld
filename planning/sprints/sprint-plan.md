# Settld Multi-Sprint Operating Plan (S1-S12)

Note: this document is a **historical multi-sprint plan**, not a live "what's open" tracker.
For current status, use `planning/STATUS.md` and the evidence trackers it links.

## Skills and flow used

- `brainstorming`: captured assumptions and success criteria from existing repo state and your vision.
- `ai-workforce-orchestrator`: split work across Product, Platform, Application, Quality, DevOps, GTM.
- `ai-tech-lead-architect`: sequenced technical dependencies and release gates.
- `ai-pm-sprint-planner`: converted strategy into sprinted, ticketed backlog.
- `ai-qa-verification-engineer`: defined deterministic and release-blocking quality bars.
- `ai-gtm-pilot-operator`: defined pilot motion, conversion path, and growth scorecard.

## Strategic goals (next 12 sprints)

1. Ship a revenue-ready Release 1 that turns verified transactions into paid production usage.
2. Convert Settld from "tooling" to "operating rail" with money movement and dispute/arbitration confidence.
3. Create repeatable customer acquisition through developer adoption plus pilot-led enterprise conversion.

## Baseline assumptions

- Sprint length: 2 weeks.
- Planning horizon: 12 sprints (24 weeks).
- Current date baseline: February 7, 2026.
- Release 1 target window: end of Sprint 4 (April 2026).
- First revenue milestone: Sprint 5 (May 2026).

## Release 1 (what we ship first)

### Release name

- `Settld Verified Transactions v1`

### Release objective

- Be the default way an AI-agent product proves work, settles funds, and handles disputes with deterministic evidence.

### Included in Release 1

- Identity registration + agent profiles (already shipped).
- Wallet balances + crediting (already shipped).
- Task marketplace, bidding, counter-offers, acceptance (already shipped).
- Agreement lifecycle + change orders + cancellation (already shipped).
- Verification execution + status outputs (already shipped).
- Settlement + policy replay + resolve + dispute endpoints (already shipped).
- External payout rail integration (first sandbox provider) + reconciliation v1.
- Escrow + netting engine v1 for microtransaction safety.
- Arbitration layer v1 (arbiter assignment, verdict, appeal artifacts).
- Policy control plane + delegation/org auth basics for enterprise governance.
- R1 SDK templates + integration relay starter kits.

### Deferred to Release 2+

- Full verifier plugin ecosystem marketplace maturity.
- Advanced selective-disclosure/privacy proofs for regulated workloads.
- Broad multi-provider payout orchestration and global rails expansion.

## Monetization model (how we make money)

### Pricing structure

1. `Developer` (free)
- Goal: adoption and protocol standardization.
- Limits: low monthly verified runs, community support, no advanced finance ops.

2. `Growth` (paid SaaS)
- Target: agent startups and automation teams in production.
- Pricing shape: base platform fee + usage (verified runs / settlement volume).
- Includes: reconciliation ops, disputes, SLA analytics, webhook relays.

3. `Enterprise` (annual contracts)
- Target: large operators, marketplaces, and autonomous operations teams.
- Pricing shape: annual platform minimum + volume tiers + premium modules.
- Includes: policy governance, delegation/org auth, custom integrations, premium support.

### Revenue motion by phase

- S1-S2: prove activation (first verified transaction, first paid task path).
- S3-S4: prove reliability and governance (release-grade confidence).
- S5-S6: convert pilots to paid annual contracts.
- S7-S12: expand ACV through rails, plugin platform, and compliance/privacy upsell.

## GTM and customer acquisition strategy

### Beachhead ICPs

1. Agent-native SaaS teams needing verifiable work logs + payout confidence.
2. BPO/operations teams automating high-volume delegated workflows.
3. Marketplace operators coordinating multi-party autonomous task execution.

### Customer acquisition channels

1. Founder-led outbound to design partners (top 20 target accounts).
2. Developer-led inbound via SDK quickstarts, integration templates, and technical content.
3. Pilot-driven enterprise conversion with success scorecards and executive business cases.

### Pilot model

- 6-week paid pilot.
- Milestones: integration complete, first verified run, first settlement, first dispute/arbitration drill.
- Conversion trigger: measurable reduction in dispute cycle time + increased settlement confidence + finance ops efficiency.

## Sprint map (12 sprints)

### S1-S4: Release 1 build and launch

- `S1`: lock R1 API contracts, SLOs, pricing model, pilot account selection.
- `S2`: integrate first external money rail sandbox, netting worker core, policy registry v1, SDK onboarding kits.
- `S3`: reconciliation workflows, arbitration lifecycle APIs, delegation chain auth, billing exports, pilot onboarding.
- `S4`: release gate matrix, performance benchmark, policy/delegation security tests, docs/migration guides.

### S5-S8: Revenue conversion and platform expansion

- `S5`: R1 commercial launch, convert pilots to annual contracts, revenue scorecard cadence.
- `S6`: plugin registry + sandbox implementation.
- `S7`: selective-disclosure proof envelope and privacy-ready verification flows.
- `S8`: certify first external plugins and package expansion offers.

### S9-S12: Scale and category leadership

- `S9`: second payout rail, advanced reconciliation automation, trust graph enhancements.
- `S10`: enterprise governance depth (role packs, audit automations, policy simulation).
- `S11`: multi-region reliability and throughput uplift.
- `S12`: marketplace/discovery maturity and expansion sales playbook hardening.

### S13: Massive sprint - autonomous network activation

- `Objective`: switch from release-ready platform to live autonomous transaction network with production money flow and first lighthouse production customers.
- `Target window`: July 27, 2026 to August 7, 2026.
- `North-star outcomes`:
- first production rail settlement + reconciliation cycle closes with zero critical mismatches.
- escrow net-close runs deterministically at production load without ledger drift.
- full arbitration + appeal lifecycle executes with evidence-bound verdict artifacts.
- selective-disclosure dispute evidence works in live arbitration workflows.
- first 3 lighthouse customers execute paid production transactions.

#### S13 delivery metrics

- reliability: p95 settlement latency under target at 10x load drill.
- trust: 0 deterministic replay drift in go-live gate suite.
- revenue: first transaction-fee invoice issued and reconciled to settlement ledger.
- growth: 3 production logos activated with at least one paid verified run each.

#### S13 critical path tickets

- `STLD-T171`, `STLD-T172`, `STLD-T173`, `STLD-T177`, `STLD-T179`, `STLD-T180`, `STLD-T182`.

## Quality and release gates

- No critical deterministic regressions in verification, settlement, or replay paths.
- All critical endpoints have idempotency and conflict tests.
- Conformance + fixture determinism suites pass before each release cut.
- Rollback runbook validated for every infra-impacting change.

## KPI scorecard

### Product and reliability

- p95 settlement latency.
- verification determinism drift incidents.
- dispute resolution cycle time.
- API uptime and incident severity counts.

### Growth and revenue

- time-to-first-verified-transaction.
- free-to-paid conversion.
- pilot-to-annual conversion rate.
- MRR and net revenue retention (from S6 onward).

### GTM execution

- meetings booked with ICP accounts.
- pilot starts per sprint.
- pilot success rate against scorecard milestones.

## Immediate next execution steps

1. Run S1 kickoff against the archived export `planning/jira/backlog.2026-02-14.pre-post-hn.json` tickets `STLD-T101` to `STLD-T107` and `STLD-T131` to `STLD-T148`.
2. Establish weekly operating review: Product, Reliability, Revenue dashboards.
3. Set release readiness checkpoint at end of S2 and S3 to protect S4 launch confidence.
