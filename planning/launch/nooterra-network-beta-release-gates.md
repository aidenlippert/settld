# Nooterra Network Beta Release Gates

Date: March 3, 2026  
Applies to: Chunk A-C beta delivery and promotion decisions.

## Promotion Rule

A beta release is promotable only when all required gates below are green for the same commit SHA and all gate reports include machine-readable JSON with explicit `schemaVersion`.

## Required Gates

| Gate ID | Purpose | Command | Required Artifact | Owning Tickets |
|---|---|---|---|---|
| NB-G1 | Public onboarding contract health | `npm run -s test:ops:public-onboarding-gate` | `artifacts/ops/public-onboarding-gate.json` | `STLD-NBT201`, `STLD-NBT401`, `STLD-NBT402`, `STLD-NBT404` |
| NB-G2 | Onboarding SLO enforcement | `npm run -s test:ops:onboarding-policy-slo-gate` | `artifacts/ops/onboarding-policy-slo-gate.json` | `STLD-NBT404` |
| NB-G3 | Hosted baseline evidence (durability + integrity) | `npm run -s ops:hosted-baseline:evidence -- --base-url "$NOOTERRA_BASE_URL" --tenant-id "$NOOTERRA_TENANT_ID" --ops-token "$NOOTERRA_OPS_TOKEN" --environment beta --out ./artifacts/ops/hosted-baseline-beta.json` | `artifacts/ops/hosted-baseline-beta.json` | `STLD-NBT101`, `STLD-NBT102`, `STLD-NBT701` |
| NB-G4 | Production cutover safety gate | `npm run -s test:ops:production-cutover-gate` | `artifacts/ops/production-cutover-gate.json` | `STLD-NBT701`, `STLD-NBT702`, `STLD-NBT705` |
| NB-G5 | External developer install and first-run confidence | `npm run -s sdk:smoke && npm run -s sdk:smoke:py && npm run -s sdk:first-run` | `artifacts/sdk/first-run-smoke.json` | `STLD-NBT302`, `STLD-NBT304`, `STLD-NBT901` |
| NB-G6 | Agent runtime usable from clean scaffold | `npm run -s test:ops:agentverse-gate && npm run -s test:ops:agentverse-live-e2e` | `artifacts/ops/agentverse-gate.json` | `STLD-NBT301`, `STLD-NBT305` |
| NB-G7 | Throughput and incident rehearsal | `npm run -s test:ops:throughput:10x && npm run -s test:ops:throughput:incident` | `artifacts/ops/throughput-incident-report.json` | `STLD-NBT702`, `STLD-NBT703`, `STLD-NBT705` |
| NB-G8 | Conformance and replay verification parity | `npm run -s conformance:session:v1 && npm run -s conformance:session-stream:v1 && npm run -s session:replay:verify` | `artifacts/conformance/beta-conformance-report.json` | `STLD-NBT106`, `STLD-NBT603`, `STLD-NBT604` |
| NB-G9 | Release promotion guard aggregation | `npm run -s test:ops:release-promotion-materialize-inputs && npm run -s test:ops:release-promotion-guard` | `artifacts/ops/release-promotion-guard.json` | `STLD-NBT903` |

## Optional But Recommended Gates

| Gate ID | Purpose | Command | Artifact | Related Tickets |
|---|---|---|---|---|
| NB-O1 | Serving mode boundary no-bypass confidence | `npm run -s test:ops:serving-mode-boundary-gate` | `artifacts/ops/serving-mode-boundary-gate.json` | `STLD-NBT602`, `STLD-NBT605` |
| NB-O2 | Nooterra verified posture check | `npm run -s test:ops:nooterra-verified-gate` | `artifacts/ops/nooterra-verified-gate.json` | `STLD-NBT604`, `STLD-NBT903` |
| NB-O3 | Offline verification parity | `npm run -s test:ops:offline-verification-parity-gate` | `artifacts/ops/offline-verification-parity.json` | `STLD-NBT603`, `STLD-NBT604` |
| NB-O4 | Settlement replay/explainability latency budget watch | `npm run -s test:ops:settlement-latency-budget-gate` | `artifacts/gates/settlement-latency-budget-gate.json` | `STLD-NBT504` |
| NB-O5 | Degraded payment-rail fail-closed simulation | `npm run -s test:ops:money-rails-degraded-mode` | `artifacts/gates/money-rails-degraded-mode-gate.json` | `STLD-NBT505` |

## Fail-Closed Promotion Policy

1. Missing artifact for any required gate is a hard block.
2. Artifact parse failure or missing `schemaVersion` is a hard block.
3. Any gate with unresolved `blockingIssues` is a hard block.
4. Manual override is allowed only for documented false-positive cases signed by Program Core and Security lead.

## Minimum Evidence Packet For Beta Launch Decision

1. `public-onboarding-gate.json`
2. `hosted-baseline-beta.json`
3. `production-cutover-gate.json`
4. `first-run-smoke.json`
5. `agentverse-gate.json`
6. `throughput-incident-report.json`
7. `beta-conformance-report.json`
8. `release-promotion-guard.json`

## Review Cadence

1. Daily gate review in Weeks 5-6.
2. Weekly integrated release-readiness review in Weeks 1-4.
3. Post-incident gate review within 24 hours of any severity-1 event.
