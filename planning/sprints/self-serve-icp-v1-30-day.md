# 30-Day Self-Serve Launch Board (ICP v1: AI Tool Providers)

Date baseline: February 7, 2026
Owner: PM + Backend + DevEx + GTM
Epic: `STLD-E12`

## Progress snapshot (2026-02-09)

Legend:
- `done`: acceptance appears satisfied in code/tests.
- `partial`: meaningful implementation exists, but acceptance is not fully met.
- `open`: little/no implementation evidence yet.

| Ticket | Status | Evidence | Remaining |
|---|---|---|---|
| `STLD-T183` Persist money rail operations/events | done | durable money-rail state and provider-event paths in `src/api/store.js`/`src/api/persistence.js`; e2e money-rail coverage in `test/api-e2e-ops-money-rails.test.js` | None |
| `STLD-T184` Wire durable adapter into API | done | money-rail API flows in `src/api/app.js` use durable store paths; critical-path checks include money rails | None |
| `STLD-T185` Billable usage event ledger | done | immutable usage event append/list in `src/api/store.js`; emit points in `src/api/app.js` (`VERIFIED_RUN`,`SETTLED_VOLUME`,`ARBITRATION_USAGE`) | None |
| `STLD-T186` Billing ingestion worker/period close | done | deterministic period-close + invoice draft generation in `src/api/app.js` (`/billing/period-close`) with billable usage digests | None |
| `STLD-T187` Public `/pricing` page | done | public pricing surface at `/pricing` in `services/magic-link/src/server.js`; coverage in `test/magic-link-service.test.js` | None |
| `STLD-T188` Stripe self-serve checkout by plan | done | tenant checkout + webhook lifecycle in `services/magic-link/src/server.js`; covered in `test/magic-link-service.test.js` | None |
| `STLD-T189` Plan quota enforcement | done | entitlement/quota enforcement paths and quota tests in `test/magic-link-service.test.js` (verification/storage/integrations/policy version caps) | None |
| `STLD-T190` Overage billing + threshold alerts | done | monthly one-shot 80%/100% verification-usage threshold alert emission/state in `services/magic-link/src/server.js` with audit trail + usage-report exposure (`thresholdAlerts`), validated in `test/magic-link-service.test.js` | None |
| `STLD-T191` Arbitration queue ops UI | done | shipped in S16 (`/ops/arbitration/workspace`) with tests | None |
| `STLD-T192` Arbitration evidence/ruling workspace | done | case detail + verdict workflow in `/ops/arbitration/workspace`; e2e coverage | None |
| `STLD-T193` Policy preset packs | done | preset catalog/apply APIs plus one-click preset UX and rollback coverage in `services/magic-link/src/server.js`; validated in `test/magic-link-service.test.js` | None |
| `STLD-T194` Public verified receipt endpoint + badge | done | new public receipt summary + badge endpoints in `services/magic-link/src/server.js` and coverage in `test/magic-link-service.test.js` | None |
| `STLD-T195` 10-minute first-settlement quickstart | done | dedicated quickstart documented in `docs/QUICKSTART_SDK_PYTHON.md` with runnable first-settlement path (`scripts/examples/sdk-first-verified-run.py` / `scripts/examples/sdk-first-paid-rfq.py`) and smoke coverage in `test/api-python-sdk-first-verified-run-smoke.test.js` + `test/api-python-sdk-first-paid-task-smoke.test.js` | None |
| `STLD-T196` Three reference integrations | done | three CI-backed reference integrations now validated: first verified run (Python), paid RFQ flow (Python), and tenant analytics (JS + Python) in `test/api-python-sdk-first-verified-run-smoke.test.js`, `test/api-python-sdk-first-paid-task-smoke.test.js`, and `test/sdk-tenant-analytics-examples-smoke.test.js` | None |
| `STLD-T197` Launch docs/changelog/email sequence | done | onboarding email sequence automation (welcome/sample/live milestones) shipped in `services/magic-link/src/onboarding-email-sequence.js` and wired in `services/magic-link/src/server.js`, with launch runbook docs + changelog update | None |
| `STLD-T198` Benchmark report + referral loop | done | referral event instrumentation (`referral_link_shared` / `referral_signup`) shipped in `services/magic-link/src/tenant-onboarding.js`; benchmark artifact builder shipped in `scripts/ci/build-self-serve-benchmark-report.mjs` with tests | None |
| `STLD-T199` MVSV dashboard + launch gate | done | explicit self-serve launch tracker (`planning/launch/self-serve-launch-tracker.json`) + gate evaluator (`scripts/ci/lib/self-serve-launch-gate.mjs`) + runnable gate report (`scripts/ci/run-self-serve-launch-gate.mjs`) with test coverage (`test/self-serve-launch-gate.test.js`) and npm entrypoint (`test:ops:self-serve-gate`) | None |

## ICP v1 definition

- Segment: AI tool providers (1-30 engineers, API-first, rapid ship cadence)
- Buyers: founder, product engineer, platform lead
- Primary users: backend and platform engineers integrating proof/settlement/dispute APIs
- Trigger events: paid endpoint launch, dispute/refund growth, enterprise onboarding requiring verifiable receipts
- Must-win outcomes: machine-verifiable receipts, automatic settlement, policy caps, dispute workflow

## Positioning

Settld for AI Tool Providers:

`Turn any tool invocation into a verified economic transaction: contract, proof, settlement, dispute.`

## Pricing v1 (self-serve usage-led)

1. Free
- Sandbox only + capped live trial
- No real payout rails

2. Builder ($99/mo)
- 10k verified runs/month included
- 0.75% settled volume fee
- Basic dispute workflows
- 30-day evidence retention

3. Growth ($599/mo)
- 100k verified runs/month included
- 0.45% settled volume fee
- Arbitration queue + policy packs
- 180-day retention + exports

4. Enterprise (custom annual)
- volume tiers
- 0.20%-0.35% settled volume fee
- custom compliance/support terms

Overages:
- verified runs: $0.01/run (Builder), $0.007/run (Growth)
- arbitration cases: $2/case (Builder), $1/case (Growth)

## North-star and funnel

- North-star: `MVSV` (Monthly Verified Settled Value)
- Secondary: verified settlements count, take-rate revenue, dispute rate, time-to-first-settlement

Funnel:
1. signup
2. tenant + API key created
3. first instrumented endpoint
4. first verified run
5. first live settlement

## Week-by-week execution

### Week 1: Productization core
- `STLD-T183` persist money rail operations/events
- `STLD-T184` wire durable money rail adapter into API
- `STLD-T185` ship billable usage event ledger
- `STLD-T186` billing pipeline ingestion worker

### Week 2: Self-serve commercial layer
- `STLD-T187` publish `/pricing`
- `STLD-T188` Stripe self-serve checkout + plan lifecycle
- `STLD-T189` plan quota enforcement in API gateway
- `STLD-T190` overage billing + threshold alerts

### Week 3: Trust + ops surface
- `STLD-T191` arbitration queue UI
- `STLD-T192` arbitration evidence/ruling workspace
- `STLD-T193` policy presets (budget caps, dispute windows, holdbacks)
- `STLD-T194` public verified receipt endpoint + badge

### Week 4: Launch + growth
- `STLD-T195` 10-minute first-settlement quickstart
- `STLD-T196` three reference integrations
- `STLD-T197` launch docs + changelog + onboarding email sequence
- `STLD-T198` benchmark report + referral loop
- `STLD-T199` MVSV dashboard + go/no-go launch gate

## 30-day launch exit criteria

- 20 self-serve signups
- 8 teams reach first live settlement
- 3 paying customers
- median time-to-first-settlement < 20 minutes
- arbitration median resolution < 24 hours

## Dependency anchors to current master backlog

- Money rails/reconcile: `STLD-T171`, `STLD-T172`
- Billing and pricing baseline: `STLD-T141`, `STLD-T142`, `STLD-T143`, `STLD-T144`, `STLD-T179`
- Arbitration foundation: `STLD-T173`
- Policy/delegation controls: `STLD-T122`, `STLD-T124`
- Scale/benchmark baseline: `STLD-T177`
- Reference apps baseline: `STLD-T178`
