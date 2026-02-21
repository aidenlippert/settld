# Trust OS v1 Strategy

Date: 2026-02-21  
Owner: Settld Product + Platform

## Positioning

Settld is a Trust OS for autonomous agent actions.  
It is not a wallet replacement and not a prompt-only guardrail product.

Settld is the control plane that makes agent spending and execution:

1. enforceable,
2. auditable,
3. reversible when required,
4. portable across hosts and payment rails.

## Core Objective

Become the default trust and control layer for paid and high-risk autonomous actions.

Any agent integration should be able to:

1. act with bounded authority,
2. prove what happened,
3. emit deterministic receipts,
4. resolve disputes and apply reversals safely,
5. pass audit/compliance scrutiny,
6. plug into real operations workflows.

## Product Direction (Trust OS v1)

Current release focus: terminal-first onboarding + MCP host integration, with deterministic trust guarantees.

### Pillar 1: Policy Runtime Enforcement

Guarantee:
- Paid and high-risk actions are gated by deterministic decisions (`allow|challenge|deny|escalate`) and stable reason codes.

Implementation anchors:
- `src/api/app.js`
- `scripts/mcp/settld-mcp-server.mjs`
- `src/core/policy.js`
- `src/core/event-policy.js`

Test/gate anchors:
- `test/mcp-paid-exa-tool.test.js`
- `test/mcp-paid-weather-tool.test.js`
- `test/mcp-paid-llm-tool.test.js`
- `test/api-e2e-x402-authorize-payment.test.js`

### Pillar 2: Execution Binding + Evidence + Receipts

Guarantee:
- Request/authorization/policy/decision bindings are hash-addressable and replay/mutation failures are deterministic.

Implementation anchors:
- `src/core/settlement-kernel.js`
- `src/core/x402-receipt-verifier.js`
- `src/core/tool-call-agreement.js`
- `src/core/tool-call-evidence.js`
- `docs/spec/SettlementDecisionRecord.v2.md`

Test/gate anchors:
- `test/settlement-kernel.test.js`
- `test/x402-receipt-verifier.test.js`
- `test/api-e2e-proof-strict-settlement-gating.test.js`
- `test/api-e2e-idempotency-settlement-disputes.test.js`

### Pillar 3: Dispute + Reversal Engine

Guarantee:
- Dispute lifecycles and verdict outcomes are deterministic, idempotent, and financially safe.

Implementation anchors:
- `src/api/app.js`
- `src/core/dispute-open-envelope.js`
- `src/core/settlement-adjustment.js`
- `src/core/x402-reversal-command.js`
- `src/core/x402-provider-refund-decision.js`

Test/gate anchors:
- `test/api-e2e-tool-call-holdback-arbitration.test.js`
- `test/api-e2e-x402-gate-reversal.test.js`
- `test/x402-reversal-command.test.js`
- `test/arbitration-schemas.test.js`

### Pillar 4: Operator Controls

Guarantee:
- Challenged/escalated actions have auditable operator paths; emergency controls are explicit and recorded.

Implementation anchors:
- `src/api/app.js`
- `src/core/governance.js`
- `src/core/agent-wallets.js`
- `src/core/agreement-delegation.js`

Test/gate anchors:
- `test/api-e2e-ops-kernel-workspace.test.js`
- `test/api-e2e-ops-arbitration-workspace.test.js`
- `test/api-e2e-ops-arbitration-workspace-browser.test.js`

### Pillar 5: Rail Adapter Hardening

Guarantee:
- Rail adapters are pluggable but cannot bypass trust-kernel enforcement.

Implementation anchors:
- `services/x402-gateway/src/server.js`
- `src/core/money-rail-adapters.js`
- `src/core/x402-gate.js`
- `src/core/wallet-provider-bootstrap.js`

Test/gate anchors:
- `test/x402-gateway-autopay.test.js`
- `test/api-e2e-x402-provider-signature.test.js`
- `test/circle-sandbox-batch-settlement-e2e.test.js`
- `test/provider-conformance-strict-mode.test.js`

### Pillar 6: Profile-Based Policy UX

Guarantee:
- Policy profiles are deterministic, testable, and usable from terminal-first workflows.

Implementation anchors:
- `scripts/profile/cli.mjs`
- `src/core/profile-templates.js`
- `src/core/policy-packs.js`
- `scripts/setup/wizard.mjs`

Test/gate anchors:
- `test/cli-profile.test.js`
- `test/setup-wizard.test.js`
- `docs/QUICKSTART_PROFILES.md`

### Pillar 7: Production Gates

Guarantee:
- Release readiness is fail-closed when deterministic trust gates regress.

Implementation anchors:
- `.github/workflows/tests.yml`
- `.github/workflows/release.yml`
- `scripts/ci/run-kernel-v0-ship-gate.mjs`
- `scripts/ci/run-production-cutover-gate.mjs`

Test/gate anchors:
- `test/production-cutover-gate-script.test.js`
- `test/throughput-gate-script-reporting.test.js`
- `test/x402-hitl-smoke-script.test.js`
- `test/mcp-host-cert-matrix-script.test.js`

## Users (Near Term)

1. Developers and agent builders who need safe paid-action execution.
2. Platform/runtime teams requiring enforceable controls across hosts.
3. Finance, ops, risk, and compliance stakeholders needing deterministic evidence.
4. Design partners running real-money agent spend with incident controls.

## Priority Use Cases

1. Agent-to-tool paid calls with deterministic policy envelopes.
2. Agent-to-agent settlement with challenge windows and receipts.
3. Procurement-style bounded spending with approvals/escalations.
4. API/service consumption under budget and compliance constraints.
5. Multi-agent workflows with auditable and bounded hop-by-hop execution.

## Explicit Non-Goals

1. Replacing all wallet providers.
2. Replacing all agent frameworks.
3. Becoming a single-host feature.
4. Shipping prompt-only governance without deterministic settlement controls.

## Roadmap (Now -> Long Term)

### Phase 1: Production Core (Now)
- Close v1 backend gaps.
- Complete deterministic gates.
- Finalize terminal-first host onboarding.
- Harden evidence artifacts for production review.

### Phase 2: Frictionless Adoption (Next)
- Default managed wallet path where possible.
- One-command onboarding for Codex/Claude/Cursor/OpenClaw.
- Strong first verified receipt path.
- Better operator reliability workflows.

### Phase 3: Platform Expansion
- Multiple adapter lanes under one trust contract.
- Richer profile packs + simulation.
- Tenant automation and enterprise controls.

### Phase 4: Agentverse Infrastructure
- Cross-runtime inter-agent trust fabric.
- Cross-tenant dispute/reputation/attestation primitives.
- Open standards leadership for machine-native commerce trust.

## Decision Record

Chosen approach: trust-kernel-first (policy + evidence + recourse), then rail expansion.

Rejected alternatives:
1. Rail-first product strategy (faster demo surface but weak durable moat).
2. Host-specific product strategy (faster initial distribution but no cross-host trust portability).

## Rollout and Rollback

Rollout:
1. Gate by deterministic CI artifacts and ship-gate checks.
2. Progress environments only when policy/runtime + evidence + reversal checks pass.
3. Promote adapter lanes behind conformance and abuse-path coverage.

Rollback:
1. Fail closed on gate regressions.
2. Block release promotion if kernel-v0 ship gate or production cutover gate fails.
3. Revert adapter-specific rollout independently from trust-kernel contract.

## Observability Requirements

1. Policy runtime: decision mix + p50/p95 latency.
2. Evidence/receipt: deterministic hash drift rate.
3. Disputes: open backlog, SLA breaches, reversal completion latency.
4. Rails: authorization failure rates, insolvency/reversal events.
5. Adoption: time-to-first-verified-receipt, host onboarding success rate.

## Success Criteria

Near term:
1. Terminal onboarding with minimal off-terminal steps.
2. End-to-end paid flow with verified receipt and no policy bypass.
3. Deterministic dispute-to-reversal CI path.
4. Host compatibility matrix with evidence artifacts.
5. Production cutover gates green.

Long term:
1. Settld is the default trust layer across multiple ecosystems.
2. Teams adopt Settld to reduce operational and compliance burden.
3. Agent commerce scales without becoming ungovernable.

