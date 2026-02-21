# Trust OS v1 Traceability (Code + Tests + Backlog)

Date: 2026-02-21  
Source backlog: `planning/jira/backlog.json`

Purpose:
- Tie Trust OS pillars to concrete implementation and validation anchors.
- Make scope drift visible by tracking coverage status and explicit gap tickets.

## Coverage Matrix

| Pillar | Epic(s) | Code anchors | Test/gate anchors | Coverage | Drift/Gaps |
|---|---|---|---|---|---|
| Policy runtime enforcement | `STLD-E2401` | `src/api/app.js`, `scripts/mcp/settld-mcp-server.mjs`, `src/core/policy.js` | `test/mcp-paid-exa-tool.test.js`, `test/mcp-paid-weather-tool.test.js`, `test/api-e2e-x402-authorize-payment.test.js` | Yellow | Add explicit negative matrix proving no bypass across stdio/http MCP + bridge paths. |
| Execution binding + receipts | `STLD-E2402` | `src/core/settlement-kernel.js`, `src/core/x402-receipt-verifier.js`, `src/core/tool-call-agreement.js`, `src/core/tool-call-evidence.js` | `test/settlement-kernel.test.js`, `test/x402-receipt-verifier.test.js`, `test/api-e2e-proof-strict-settlement-gating.test.js` | Green | Expand long-run determinism soak checks for repeated export runs. |
| Dispute + reversal engine | `STLD-E2403` | `src/api/app.js`, `src/core/dispute-open-envelope.js`, `src/core/settlement-adjustment.js`, `src/core/x402-reversal-command.js` | `test/api-e2e-tool-call-holdback-arbitration.test.js`, `test/api-e2e-x402-gate-reversal.test.js`, `test/x402-reversal-command.test.js` | Green | Add SLA-bound timing SLO checks as release blockers. |
| Operator controls | `STLD-E2404` | `src/api/app.js`, `src/core/governance.js`, `src/core/agreement-delegation.js` | `test/api-e2e-ops-kernel-workspace.test.js`, `test/api-e2e-ops-arbitration-workspace.test.js` | Yellow | Kill-switch semantics and rollback drills need explicit gate coverage. |
| Rail adapter hardening | `STLD-E2405` | `services/x402-gateway/src/server.js`, `src/core/money-rail-adapters.js`, `src/core/x402-gate.js` | `test/x402-gateway-autopay.test.js`, `test/api-e2e-x402-provider-signature.test.js`, `test/circle-sandbox-batch-settlement-e2e.test.js` | Yellow | Enforce shared trust-kernel invariant suite for every new adapter lane. |
| Profile-based policy UX | `STLD-E2406` | `scripts/profile/cli.mjs`, `src/core/profile-templates.js`, `src/core/policy-packs.js`, `scripts/setup/wizard.mjs` | `test/cli-profile.test.js`, `test/setup-wizard.test.js`, `docs/QUICKSTART_PROFILES.md` | Green | Add numeric onboarding SLO checks to CI to prevent UX regressions. |
| Production gates | `STLD-E2407`, `STLD-E2408` | `.github/workflows/tests.yml`, `.github/workflows/release.yml`, `scripts/ci/run-kernel-v0-ship-gate.mjs`, `scripts/ci/run-production-cutover-gate.mjs` | `test/production-cutover-gate-script.test.js`, `test/throughput-gate-script-reporting.test.js`, `test/mcp-host-cert-matrix-script.test.js` | Green | Standardize authority-boundary checks (who can sign/revoke/pause) as mandatory gate evidence. |

## Priority Gap Tickets

Gap-closure tickets are defined in:
- `planning/jira/trust-os-v1-gap-closure-backlog.json`
- `planning/jira/trust-os-v1-gap-closure-epics.csv`
- `planning/jira/trust-os-v1-gap-closure-tickets.csv`

These are intentionally additive to `planning/jira/backlog.json` and do not change existing keys.

