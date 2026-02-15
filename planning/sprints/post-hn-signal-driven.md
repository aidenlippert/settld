# Settld Sprint Plan: Post-HN, Signal-Driven

Baseline: 2026-02-14 (Sat) · Philosophy: build what adoption demands, not what sounds good on a roadmap.

Non-negotiables:

- Do not lie in public copy.
- Make first install succeed on the broadest set of machines.
- Turn "interest" into a measurable funnel with unambiguous signal.

## Caution: Replace The Aspirational Roadmap

The existing `planning/sprints/s23-s34-plan.md` is a 24-week aspirational roadmap (ZK proofs, multi-region HA, marketplace semantic matching, 4-language conformance, SOC 2, published RFC) for a product with zero paying customers.

This plan supersedes it with signal-driven sequencing.

## What Just Shipped (S23.5, 2026-02-13)

| Item | Status | Evidence |
|---|---:|---|
| Doc drift fixed (`core-primitives.md`, `AgentIdentity.v1.md`) | Done | Docs align with code |
| `ToolCallAgreement.v1` + `ToolCallEvidence.v1` promoted to protocol objects | Done | Spec + schema + golden vectors + conformance |
| `maxDailyCents` enforced (daily spend accumulator) | Done | `test/api-e2e-wallet-policy-max-daily.test.js` |
| HN post live | Done | Posted 2026-02-13 |
| Tests | Done | 497 passing (`npm test`) |

## North Star

A developer who has never seen Settld goes from zero to a verified receipt in <= 10 minutes with zero questions.

For the `docs/QUICKSTART_X402_GATEWAY.md` funnel, "receipt" means: a successful `402 -> hold -> verify -> release` outcome plus a fetchable gate state via `GET /x402/gate/:id`.

## Sprint A (Launch Readiness, 72h) — 2026-02-14 (Sat) to 2026-02-17 (Tue, HN repost)

Goal: a stranger can get a verified receipt in <=10 minutes on Mac + Linux, and every claim in the HN post is defensible.

Scope rule: no new primitives. Only wiring, docs, UX friction, and instrumentation.

### A1. Claim-integrity (wire or remove)

Decision rule (hard): if you cannot (1) wire `cascadeSettlementCheck` into a real API path and (2) prove it with an integration test by Monday evening 2026-02-16, remove/soften the "compositional settlement" claim from HN copy + README/Quickstart.

Binary acceptance criteria:

- There exists at least one end-to-end route where calling settlement/release invokes `cascadeSettlementCheck`.
- There is an integration test that fails if `cascadeSettlementCheck` is not invoked.
- A failing cascade check produces a deterministic failure with a stable code surfaced in the response/receipt.
- HN post copy references the feature in a way that matches current behavior.

### A2. Quickstart reliability (Linux does not break by default)

Fix the `host.docker.internal` footgun on Linux and eliminate inferred steps.

Binary acceptance criteria:

- Quickstart contains a single golden path that does not require the reader to infer missing steps.
- Success is objective and copy-paste verifiable ("you will know it worked when...").
- Quickstart includes an explicit Linux path that does not rely on luck.
- Quickstart can be run twice in a row without manual cleanup (or it prints a single explicit cleanup action).

### A3. README funnel rewrite

Binary acceptance criteria:

- README top section has exactly one primary call-to-action path.
- The first screen contains a runnable command and an objective success check.
- All links in the first screen are valid and point to current docs.

### A4. Signal capture (make silence unambiguous)

Minimum viable funnel:

- One canonical inbound for quickstart failures.
- A Quickstart feedback issue template capturing: OS, Docker version, command run, output snippet, logs bundle.
- A tiny `scripts/collect-debug.*` tool that gathers versions + relevant logs into one bundle.
- A daily triage log artifact starting 2026-02-17.

Binary acceptance criteria:

- There is exactly one obvious "I tried and failed" link in README + Quickstart.
- A developer can submit a useful bug report in <3 minutes.
- A dated triage log exists for 2026-02-17.

Deliverable for Sprint A:

- HN post copy updated to match reality.
- README funnel simplified.
- Quickstart hardened (Linux included).
- Feedback funnel + debug bundle exists.
- `cascadeSettlementCheck` is either wired+tested, or its claim is removed from marketing copy.

## Sprint B (Post-HN Conversion, 1 week) — 2026-02-18 (Wed) to 2026-02-24 (Tue)

Goal: convert attention into first successful installs and first real receipts/settlements; respond fast enough that early adopters feel "alive product".

Scope rule: only build what directly reduces time-to-first-receipt/time-to-first-settlement, or fixes bugs found via triage.

### B1. Install doctor + error-message hardening

Binary acceptance criteria:

- A `doctor` command exists and prints versions, port checks, connectivity checks, and a single pass/fail with next steps.
- Top 5 install failures from triage have explicit remediation in docs or tooling.

### B2. One no-edit reference integration

Binary acceptance criteria:

- A user can run the reference integration end-to-end and produce a receipt without editing code.
- Integration demonstrates: work -> proof bundle -> verify -> receipt.

### B3. Metrics that matter (daily)

Track only:

- install attempts
- first receipt count
- first settlement (or first paid event) count

Binary acceptance criteria:

- You can answer each morning: how many tried, how many succeeded, where they dropped.

### B4. Support SLA (self-enforced)

Binary acceptance criteria:

- Every inbound gets a first response within 12 hours for the first 7 days post-HN.
- Every "install failed" gets a fix or documented workaround within 48 hours.

## Sprint C (Activation & Expansion, explicit 10-day block) — 2026-02-25 (Wed) to 2026-03-07 (Sat)

Goal: turn first users into repeat usage and at least 1-3 paying accounts (or explicit design partners), using only what triage taught you.

### C1. Ship the single biggest real blocker

Selection rule:

- pick the most common request that blocks real usage
- it must reduce integration time or increase trust in receipts
- it must be shippable end-to-end within <= 10 days

Binary acceptance criteria:

- Shipped improvement reduces time-to-first-receipt by a measured amount (even if small sample).
- Shipped improvement is reflected in docs and demo.

### C2. Pricing + packaging sanity pass

Binary acceptance criteria:

- Users can understand what triggers billing in <= 30 seconds.
- The first paid tier maps to a clear value boundary.

## Sprint D (Hardening, explicit 2-week block) — 2026-03-07 (Sat) to 2026-03-21 (Sat)

Goal: make it safe to keep running: reliability, security posture, and operability.

### D1. Reliability hardening based on real load shape

Binary acceptance criteria:

- No data-loss classes uncovered in triage remain unaddressed.
- Backpressure/rate limits exist where needed.
- Basic runbooks are proven by a kill-and-recover exercise.

### D2. Key management and rotation (minimum viable)

Binary acceptance criteria:

- Documented key storage approach for local + hosted.
- A rotation procedure exists and has been executed at least once.

## Decision Framework (End Of Sprint)

Ask:

1. Did anyone new try Settld this week? If yes: build what they asked for. If no: try a different distribution channel.
2. Did anyone who tried it come back? If yes: double down. If no: the first experience is broken; fix it.
3. What is the single biggest blocker to the next user? Build that. Only that.

## What Is Explicitly Deferred

These items from `planning/sprints/s23-s34-plan.md` are deferred until paying customers demand them:

- ZK selective disclosure proofs
- Multi-region HA
- Dynamic pricing engine
- Marketplace semantic matching
- SOC 2 Type II
- Protocol v2 RFC
- Multi-currency ledger
- 4-language conformance
- Template marketplace
- Trust graph visualization
