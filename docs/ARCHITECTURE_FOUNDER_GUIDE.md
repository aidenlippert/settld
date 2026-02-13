# Settld Founder Architecture Guide

Status date: February 12, 2026

## Why this document exists

This is the founder-level map of what Settld is actually building, what is already true in code, and what is still planned.  
It is intentionally opinionated: if a claim is not enforced by code/tests/conformance, it is not treated as shipped truth.

---

## 1) What Settld is

Settld is a verifiable execution-and-settlement infrastructure for delegated agent work.

The product has two surfaces that share one truth model:

1. Open protocol and verifier toolchain (portable, offline-verifiable)
2. Hosted workflow/controller product (Magic Link) that uses the same verification model

Core principle: hosted UX is never the only judge.  
Anything shown in hosted flows must be reproducible offline with the open verifier plus explicit trust anchors.

Primary references:

- `docs/OVERVIEW.md`
- `docs/spec/README.md`
- `docs/spec/INVARIANTS.md`
- `services/magic-link/README.md`

---

## 2) Product surfaces

## Protocol surface (open)

- Bundle formats + manifests + attestations + verification reports
- Deterministic verification semantics and stable warning/error codes
- Conformance vectors to prevent verifier drift across implementations

Key files:

- `packages/artifact-verify/bin/settld-verify.js`
- `packages/artifact-produce/bin/settld-produce.js`
- `conformance/v1/README.md`
- `docs/spec/CANONICAL_JSON.md`
- `docs/spec/STRICTNESS.md`

## Hosted surface (commercial)

- Upload + verification workflow (strict/compat/auto)
- Inbox/reporting/approval/hold flows
- Webhooks/integrations/billing usage and exports

Key files:

- `services/magic-link/src/server.js`
- `services/magic-link/src/tenant-settings.js`
- `services/magic-link/README.md`

## Economic kernel (shared truth engine)

- Event-sourced job lifecycle
- Deterministic replay
- Double-entry ledger as accounting truth

Key files:

- `src/core/job-state-machine.js`
- `src/core/job-reducer.js`
- `src/core/ledger.js`
- `src/core/escrow-ledger.js`
- `docs/JOB_STATE_MACHINE.md`
- `docs/LEDGER.md`

---

## 3) What is TRUE today (shipped truth)

This section summarizes current shipped truth based on repo state and audit evidence.

## 3.1 Dispute/holdback determinism is enforced

- Signed dispute-open envelopes are required for non-admin opens.
- Envelope/case IDs are deterministic from agreement hash.
- Artifact ID is bound to envelope ID and validated.
- Holdback auto-release is frozen while arbitration is open.

Evidence:

- `src/core/dispute-open-envelope.js`
- `src/api/app.js`
- `test/dispute-open-envelope-schemas.test.js`
- `test/api-e2e-tool-call-holdback-arbitration.test.js`
- `planning/kernel-v0-truth-audit.md`

## 3.2 Kernel replay and closepack verification flows exist

- Tool-call replay evaluation exists in API paths.
- Closepack export and offline verify are wired and conformance-gated.

Evidence:

- `src/api/app.js`
- `scripts/closepack/lib.mjs`
- `conformance/kernel-v0/run.mjs`

## 3.3 Open protocol and verifier posture is strong

- Large, explicit spec surface in `docs/spec/**`
- Deterministic verifier CLI and conformance vectors in `conformance/v1/**`
- Security hardening for archive ingestion paths with dedicated tests

Evidence:

- `docs/spec/INVARIANTS.md`
- `packages/artifact-verify/src/safe-unzip.js`
- `test/zip-security.test.js`
- `conformance/v1/README.md`

## 3.4 Billing catalog alignment is now implemented in Magic Link runtime

- Runtime plans now map to `free|builder|growth|enterprise`
- Legacy `scale` is normalized to `enterprise` for compatibility
- Hosted pricing/upgrade paths are aligned to the same tier set

Evidence:

- `services/magic-link/src/tenant-settings.js`
- `services/magic-link/src/server.js`
- `test/magic-link-service.test.js`

---

## 4) What is NOT TRUE yet (gaps to close)

These are strategic blockers still marked as not shipped end-to-end.

## 4.1 Hosted baseline is not fully productized

Status: FALSE (per truth audit)

Gap theme:

- Staging/prod separation, durable worker model, quotas/rate limits, backup/restore drills, hard evidence of operational readiness

Evidence anchor:

- `planning/kernel-v0-truth-audit.md`
- `docs/ops/HOSTED_BASELINE_R2.md`

## 4.2 Real-money settlement alpha is not shipped

Status: FALSE (per truth audit)

Gap theme:

- Stripe Connect mapping + webhook ingestion + reconciliation + chargeback/refund operational policy tied to kernel IDs

Evidence anchor:

- `planning/kernel-v0-truth-audit.md`
- `docs/ops/PAYMENTS_ALPHA_R5.md`

## 4.3 Exact tarball `npx --package ./settld-<version>.tgz` CI smoke is partial

Status: PARTIAL (per truth audit)

Gap theme:

- CI covers related smoke paths but not the exact documented local tarball invocation path

Evidence anchor:

- `planning/kernel-v0-truth-audit.md`
- `scripts/ci/cli-pack-smoke.mjs`
- `.github/workflows/release.yml`

## 4.4 Dashboard remains primarily fixture-driven

Gap theme:

- The dashboard experience is still largely driven by demo fixtures and static exports; live API streaming console remains roadmap work

Evidence anchor:

- `dashboard/src/hooks/useDemoData.js`
- `dashboard/src/DemoApp.jsx`

---

## 5) Architecture map (how the code is laid out)

## Ring A: Normative protocol layer

Defines what artifacts are and how they verify.

- `docs/spec/**`
- `docs/spec/schemas/**`
- `conformance/v1/**`

## Ring B: Core domain kernel

Pure/domain-centric logic for state transitions, settlement semantics, and ledger invariants.

- `src/core/**`

## Ring C: API + persistence truth boundary

Operational truth implementation (API orchestration, store abstraction, Postgres durability, workers/outbox).

- `src/api/**`
- `src/db/**`

## Ring D: Productized hosted workflows and integrations

Buyer/operator workflow UX and automation around the same verification semantics.

- `services/magic-link/**`
- `packages/*` (SDKs, CLI tooling)

---

## 6) Data and trust flow (end-to-end)

1. Work happens and emits events.
2. Events are reduced into deterministic state and ledger consequences.
3. Artifacts are produced as bundles with manifest+hash commitments.
4. Verifier checks integrity, signatures, invariants, and policy/trust anchors.
5. Hosted workflow can display, route decisions, and trigger automations.
6. Any external party can re-run verification offline against exported artifacts.

The core design win is that commercial workflow convenience does not replace verification truth.

---

## 7) Founder operating metrics and checkpoints

## North-star metric

Monthly Verified Settled Value (MVSV)

Why it matters:

- Captures whether value is being verified and settled, not just “API called”
- Compounds with volume-based monetization

## Gate checkpoints that matter most now

1. Hosted baseline gate turns TRUE (ops evidence, not docs-only)
2. Real-money alpha gate turns TRUE (first design partner cash flow)
3. CI tarball smoke gap closes (distribution claim fully evidenced)

Reference:

- `planning/kernel-v0-truth-audit.md`

---

## 8) Practical reading order for new founder engineers

1. `docs/OVERVIEW.md`
2. `planning/kernel-v0-truth-audit.md`
3. `docs/spec/INVARIANTS.md`
4. `src/core/job-reducer.js`
5. `src/core/escrow-ledger.js`
6. `packages/artifact-verify/src/invoice-bundle.js`
7. `conformance/v1/README.md`
8. `services/magic-link/README.md`
9. `services/magic-link/src/server.js`
10. `test/magic-link-service.test.js`

---

## 9) Founder summary in one page

- Settld is building verifiable economic finality for agent work, not just another workflow dashboard.
- The strongest moat already shipped is protocol determinism + offline verification + conformance.
- The biggest business-risk gaps are operational/commercial, not core protocol correctness:
  - hosted baseline hardening
  - real-money rail deployment
- Product messaging and UX should keep emphasizing one non-negotiable differentiator:
  - “You can verify settlement outcomes without trusting our hosted app.”

