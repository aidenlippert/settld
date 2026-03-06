# Nooterra Network: Beta Blueprint and Shipping Chunks

Date: March 3, 2026  
Scope: code-audited plan for what exists, what is missing, and how to ship a real public beta first.

## 1. What We Already Built (Code-Verified)

### 1.1 Trust/Economic kernel is real
- Identity registration, authority grants, delegation grants, agent cards, and reputation are implemented in the API and core modules.
- Deterministic policy hashing and policy decision fingerprinting are implemented.
- x402 stack is implemented end-to-end (wallet policy, gate create/quote/authorize/verify/reversal, receipt verification, webhook endpoints).
- Settlement, dispute, arbitration, explainability, and resolution paths are implemented.
- Ledger and escrow mechanics are implemented with deterministic semantics.
- Artifacts and proof bundles are implemented with canonical hashing and verification primitives.

Key references:
- `/Users/aidenlippert/nooterra/src/api/app.js`
- `/Users/aidenlippert/nooterra/src/core/policy.js`
- `/Users/aidenlippert/nooterra/src/core/policy-decision.js`
- `/Users/aidenlippert/nooterra/src/core/x402-gate.js`
- `/Users/aidenlippert/nooterra/src/core/x402-receipt-verifier.js`
- `/Users/aidenlippert/nooterra/src/core/settlement-kernel.js`
- `/Users/aidenlippert/nooterra/src/core/dispute-open-envelope.js`
- `/Users/aidenlippert/nooterra/src/core/ledger.js`
- `/Users/aidenlippert/nooterra/src/core/escrow-ledger.js`
- `/Users/aidenlippert/nooterra/src/core/artifacts.js`
- `/Users/aidenlippert/nooterra/src/core/proof-bundle.js`

### 1.2 Public API surfaces that matter for beta already exist
- Agent lifecycle: `POST /agents/register`, `GET /agents`.
- Delegation and authority: `POST /delegation-grants`, `POST /authority-grants`, revoke/list/get variants.
- Discovery and reputation: `POST /agent-cards`, `GET /public/agent-cards/discover`, `GET /public/agent-cards/stream`, `GET /relationships`.
- x402 critical flow:
  - `POST /x402/gate/create`
  - `POST /x402/gate/quote`
  - `POST /x402/gate/authorize-payment`
  - `POST /x402/gate/verify`
  - `POST /x402/gate/reversal`
  - `POST /x402/wallets`
  - `PUT /x402/wallets/:sponsorWalletRef/policy`
  - `POST /x402/wallets/:sponsorWalletRef/authorize`
- Settlement and dispute:
  - `GET /runs/:runId/settlement`
  - `GET /runs/:runId/settlement/policy-replay`
  - `GET /runs/:runId/settlement/replay-evaluate`
  - `GET /runs/:runId/settlement/explainability`
  - `POST /runs/:runId/settlement/resolve`
  - `POST /runs/:runId/dispute/:action`

Key references:
- `/Users/aidenlippert/nooterra/src/api/app.js:64268`
- `/Users/aidenlippert/nooterra/src/api/app.js:50058`
- `/Users/aidenlippert/nooterra/src/api/app.js:50304`
- `/Users/aidenlippert/nooterra/src/api/app.js:58599`
- `/Users/aidenlippert/nooterra/src/api/app.js:58959`
- `/Users/aidenlippert/nooterra/src/api/app.js:59019`
- `/Users/aidenlippert/nooterra/src/api/app.js:52245`
- `/Users/aidenlippert/nooterra/src/api/app.js:52560`
- `/Users/aidenlippert/nooterra/src/api/app.js:52751`
- `/Users/aidenlippert/nooterra/src/api/app.js:54433`
- `/Users/aidenlippert/nooterra/src/api/app.js:55895`
- `/Users/aidenlippert/nooterra/src/api/app.js:64624`
- `/Users/aidenlippert/nooterra/src/api/app.js:66464`
- `/Users/aidenlippert/nooterra/src/api/app.js:66559`
- `/Users/aidenlippert/nooterra/src/api/app.js:66758`
- `/Users/aidenlippert/nooterra/src/api/app.js:66884`
- `/Users/aidenlippert/nooterra/src/api/app.js:68902`

## 2. What Is Missing (Beta Blockers vs Endgame Gaps)

### 2.1 Beta blockers (must fix before public online beta)
- Marketplace/provider publication durability gap in PG mode (in-memory map writes in route path).
- Finance reconciliation triage lacks full PG parity.
- `X402_WEBHOOK_ENDPOINT_UPSERT` contract mismatch between memory store and PG op-kind validation.
- `opsToken` query param path is risky for production logs/history leakage.
- External package story is fragmented: only `nooterra` appears publicly installed; SDK/scaffold/provider kit publication and install path are inconsistent.
- Version inconsistency (`package.json` vs `NOOTERRA_VERSION`) hurts release trust.
- Conformance command path expects `nooterra-verify` binary availability in ways that can fail for external users.

Key references:
- `/Users/aidenlippert/nooterra/src/api/app.js:48123`
- `/Users/aidenlippert/nooterra/src/api/app.js:48414`
- `/Users/aidenlippert/nooterra/src/api/app.js:23607`
- `/Users/aidenlippert/nooterra/src/api/store.js:2488`
- `/Users/aidenlippert/nooterra/src/db/store-pg.js:2797`
- `/Users/aidenlippert/nooterra/src/api/app.js:34178`
- `/Users/aidenlippert/nooterra/packages/create-nooterra-paid-tool/src/lib.js:238`
- `/Users/aidenlippert/nooterra/package.json:3`
- `/Users/aidenlippert/nooterra/NOOTERRA_VERSION:1`
- `/Users/aidenlippert/nooterra/conformance/v1/run.mjs:14`

### 2.2 Endgame gaps (not needed for beta, needed for network dominance)
- Federated global identity trust anchors and cross-network revocation sync.
- Cross-rail atomic settlement and broader liquidity orchestration.
- Public transparency log + inclusion proofs for independent third-party verification.
- Network-level governance quorum/threshold mechanics across independent operators.
- Adversarial-grade anti-sybil mechanisms for open network operation.

## 3. Shipping Order in Chunks

## Chunk 1: Public Beta Online (4-6 weeks)
Goal: real external users can use the hosted Nooterra Network today, not just run repo internals.

Deliverables:
1. Durable PG parity for beta-critical endpoints.
2. x402 webhook op-kind parity fix.
3. Remove query-param token auth path for ops UI/APIs.
4. Release consistency fixes (`NOOTERRA_VERSION` and package version alignment).
5. Publish coherent external developer surface (minimum: CLI + one official SDK + provider kit).
6. External install CI gate for npm/pip and quickstart smoke.
7. Production deployment topology with separate API + worker + maintenance processes.

Beta exit criteria:
1. A new external team can complete onboarding to first paid/gated run in under 30 minutes.
2. Data durability survives process restart for beta-critical entities.
3. Idempotent retry behavior is stable under duplicate request replay.
4. Each paid/gated run has verifiable settlement + explainability + artifact status retrieval.

## Chunk 2: Federated Trust Upgrade (6-10 weeks)
1. Federated identity anchors and trust exchange.
2. Governance quorum and signer threshold policy for network changes.
3. Public transparency feed and inclusion proof endpoints.

## Chunk 3: Economic Interop (8-12 weeks)
1. Multi-rail settlement adapters and reconciliation canon.
2. Cross-jurisdiction dispute interoperability profile.
3. Liquidity and exposure controls for cross-rail scaling.

## Chunk 4: Global Automation Substrate (ongoing)
1. Open agent market protocol across independent operators.
2. Strong anti-sybil reputation hardening.
3. Embodied/robotics policy profile bindings for physical actions.

## 4. Beta Flow Example (State-of-the-Art Grade)

Scenario: A finance agent hires a specialist risk-analysis agent, pays via x402 gate, and gets deterministic proof with reversible settlement if quality fails.

### 4.1 Actors
- `agt_finance_buyer` (payer)
- `agt_risk_provider` (payee)
- `agt_compliance_arbiter` (arbiter)

### 4.2 Preconditions
1. Register agents and issue authority/delegation grants.
2. Create payer wallet and active wallet policy.
3. Publish provider agent card publicly with capabilities.
4. Set policy constraints: amount ceiling, risk class, evidence requirements.

### 4.3 Online transaction flow
1. Buyer discovers provider via `GET /public/agent-cards/discover`.
2. Buyer creates gated payment intent via `POST /x402/gate/create`.
3. Network mints quote via `POST /x402/gate/quote`.
4. Buyer authorizes payment via `POST /x402/gate/authorize-payment` with strict binding hash.
5. Provider returns result; network verifies via `POST /x402/gate/verify`.
6. Settlement is visible via `GET /runs/:runId/settlement`.
7. If output quality is disputed, open case via `POST /runs/:runId/dispute/open`.
8. Arbiter closes with signed verdict via `POST /runs/:runId/dispute/close`.
9. Resolve final payout/refund via `POST /runs/:runId/settlement/resolve`.
10. Retrieve explainability and artifact status:
   - `GET /runs/:runId/settlement/explainability`
   - `GET /artifacts/:artifactId/status`

### 4.4 Why this is state-of-the-art
1. Durable long-running orchestration with replayable state and idempotency semantics.
2. Strict policy + request-hash binding before payment authorization.
3. Native dispute/reversal path tied to settlement and evidence.
4. Explainability and replay-evaluate endpoints for auditable post-incident analysis.
5. Public discovery layer (agent cards + streaming updates) for networked agent commerce.

## 5. SOTA Parity Checklist for Beta

Target parity dimensions and baseline references:
1. Interoperable tool ecosystem: MCP compatibility expectations.
2. Multi-agent collaboration topology expectations (supervisor/collaborators).
3. Guardrail and policy enforcement expectations at inference/action boundaries.
4. Traceability and debugging expectations for step-level agent execution.
5. Async long-running execution expectations.

Nooterra Beta commitments:
1. Expose and stabilize discovery, trust, settlement, and dispute primitives first.
2. Guarantee deterministic artifacts and replay for every gated paid action.
3. Keep fail-closed behavior when evidence/policy/verdict bindings are missing or mismatched.
4. Maintain idempotent write semantics and durable PG-backed state for all beta-critical paths.

## 6. Immediate Execution Board (Chunk 1)

Week 1:
1. Fix PG durability gaps for provider publication/listings and finance triage.
2. Add missing PG op-kind support for x402 webhook endpoint upsert.
3. Remove query-token auth path.

Week 2:
1. Version and package consistency fixes.
2. Publish minimal SDK/provider-kit path and validate generated scaffold installability.
3. Conformance CLI external-path hardening.

Week 3:
1. Deploy split API/worker/maintenance topology.
2. Add external install and first-run smoke tests in CI.
3. Add beta telemetry and error budgets for critical routes.

Week 4:
1. Run three external beta design partners through the full paid flow.
2. Capture incident reports, replay proofs, and dispute drill outcomes.
3. Freeze beta contract and publish Beta API profile.

## 7. External Baselines (SOTA Sources)

- OpenAI Responses API tools, remote MCP, background mode (May 21, 2025):
  - https://openai.com/index/new-tools-and-features-in-the-responses-api/
- AWS Bedrock Agents overview:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html
- AWS Bedrock multi-agent collaboration:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html
- AWS Bedrock trace events:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/trace-events.html
- AWS Bedrock Guardrails:
  - https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
- LangGraph overview (durable execution, human-in-the-loop, stateful orchestration):
  - https://docs.langchain.com/oss/python/langgraph/overview
- MCP intro/spec (open interoperability standard):
  - https://modelcontextprotocol.io/docs/getting-started/intro
- Google A2A protocol announcement (April 9, 2025):
  - https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/

## 8. Operating Playbook: How We Build and Run This

## 8.1 Build model (five planes)
1. Builder plane (developer tools): agent scaffolding, local runtime, intent/work-order/session CLIs.
2. Customer plane (tenant onboarding): public auth mode discovery, signup/login, onboarding wizard, runtime bootstrap, first paid call.
3. Wallet plane (funding + spend control): wallet bootstrap and funding options in control plane; x402 wallet policy and authorization in trust kernel.
4. Reliability plane (SRE): liveness/readiness/metrics endpoints, worker queues, retries/dead-letter, synthetic probes.
5. Intent integrity plane (cross-party correctness): intent contracts, hash-bound execution intent, strict request binding, replayable session evidence.

## 8.2 Developer workflow (how devs build agents)

Existing command surfaces:
- `nooterra agent init <name>`
- `nooterra agent run ...`
- `nooterra agent intent propose|counter|accept ...`
- `nooterra agent work-order create|accept|complete ...`
- `nooterra agent session stream|replay-pack ...`

Code references:
- `/Users/aidenlippert/nooterra/bin/nooterra.js`
- `/Users/aidenlippert/nooterra/scripts/agent/cli.mjs`
- `/Users/aidenlippert/nooterra/src/agentverse/scaffold/init.js`
- `/Users/aidenlippert/nooterra/src/agentverse/runtime/agent-daemon.js`

Recommended build path:
1. Scaffold agent project with policy file and tests.
2. Implement agent handler and enforce capability/risk constraints in policy.
3. Run daemon against hosted API with API key/tenant/protocol headers.
4. Execute end-to-end via intent -> work-order -> completion -> settlement trace.
5. Publish agent card after capability attestation checks pass.

## 8.3 Customer and developer onboarding flows

Developer onboarding (CLI-first):
1. `nooterra setup` or `nooterra onboard` for base URL, tenant, auth, wallet mode.
2. `nooterra login` for OTP/session flow when applicable.
3. `nooterra dev up` for local stack.

Customer onboarding (hosted control plane):
1. Discover auth mode: `GET /v1/public/auth-mode`.
2. Signup flow: `POST /v1/public/signup` (if enabled).
3. Tenant buyer login OTP flow:
   - `POST /v1/tenants/{tenantId}/buyer/login/otp`
   - `POST /v1/tenants/{tenantId}/buyer/login`
4. Guided onboarding:
   - `POST /v1/tenants/{tenantId}/onboarding/runtime-bootstrap`
   - `POST /v1/tenants/{tenantId}/onboarding/runtime-bootstrap/smoke-test`
   - `POST /v1/tenants/{tenantId}/onboarding/first-paid-call`
   - `GET /v1/tenants/{tenantId}/onboarding-metrics`

Code references:
- `/Users/aidenlippert/nooterra/scripts/setup/onboard.mjs`
- `/Users/aidenlippert/nooterra/scripts/setup/login.mjs`
- `/Users/aidenlippert/nooterra/services/magic-link/src/server.js:15271`
- `/Users/aidenlippert/nooterra/services/magic-link/src/server.js:15374`
- `/Users/aidenlippert/nooterra/services/magic-link/src/server.js:15388`

## 8.4 Wallet connection model

Two layers (both required in beta):
1. Control-plane wallet bootstrap/funding:
   - `POST /v1/tenants/{tenantId}/onboarding/wallet-bootstrap`
   - `POST /v1/tenants/{tenantId}/onboarding/wallet-funding`
   - Supports hosted funding options and transfer/faucet paths.
2. Trust-kernel wallet and payment authorization:
   - `POST /x402/wallets`
   - `PUT /x402/wallets/{sponsorWalletRef}/policy`
   - `POST /x402/gate/create`
   - `POST /x402/gate/quote`
   - `POST /x402/gate/authorize-payment`
   - `POST /x402/gate/verify`
   - `POST /x402/gate/reversal`

Developer/ops wallet checks:
- `nooterra wallet status`
- `nooterra wallet fund ...`
- `nooterra wallet balance --watch`

Code references:
- `/Users/aidenlippert/nooterra/src/core/wallet-provider-bootstrap.js`
- `/Users/aidenlippert/nooterra/scripts/wallet/cli.mjs`
- `/Users/aidenlippert/nooterra/src/api/app.js:50765`
- `/Users/aidenlippert/nooterra/src/api/app.js:52245`

## 8.5 Uptime and reliability confirmation

Health/metrics endpoints (API and control plane):
- API: `GET /health`, `GET /healthz`, `GET /metrics`
- Magic-link: `GET /health`, `GET /healthz`, `GET /metrics`

Readiness signals already include:
1. DB reachability + latency.
2. Outbox pending depth.
3. Delivery pending/failed counters.
4. Ingest rejection counters.
5. Build/version metadata and auth mode hints.

Beta uptime discipline:
1. Split deployment roles: API, workers, maintenance.
2. Alert on queue depth growth and failed delivery growth.
3. Add synthetic canaries:
   - run first-paid-call flow at fixed cadence,
   - run conformance matrix on schedule,
   - verify artifact/explainability retrieval.
4. Enforce SLOs:
   - API availability (healthz) target,
   - payment authorization latency target,
   - settlement finalization latency target.

Code references:
- `/Users/aidenlippert/nooterra/src/api/app.js:34462`
- `/Users/aidenlippert/nooterra/src/api/app.js:34635`
- `/Users/aidenlippert/nooterra/src/api/app.js:34869`
- `/Users/aidenlippert/nooterra/services/magic-link/src/server.js:15258`
- `/Users/aidenlippert/nooterra/services/magic-link/src/server.js:15264`

## 8.6 Intent correctness across parties (critical)

Mechanisms already present:
1. Intent contract lifecycle with canonical `intentHash`:
   - propose -> counter -> accept.
2. Work-order intent binding enforcement:
   - work-order creation/settlement requires accepted intent binding.
3. x402 execution-intent validation:
   - strict request binding required,
   - tenant/agent/run/agreement/quote/policy/idempotency checks,
   - expiry checks and spend/currency bounds.
4. Idempotency-key + request-hash replay safety on writes.
5. Session event chain and replay artifacts:
   - replay-pack/transcript export,
   - replay verification API.
6. Dispute/settlement evidence binding checks:
   - close/resolve paths fail if request-hash evidence mismatches.

Code references:
- `/Users/aidenlippert/nooterra/src/core/intent-contract.js`
- `/Users/aidenlippert/nooterra/src/api/app.js:61190`
- `/Users/aidenlippert/nooterra/src/api/app.js:61560`
- `/Users/aidenlippert/nooterra/src/api/app.js:15766`
- `/Users/aidenlippert/nooterra/src/api/app.js:15964`
- `/Users/aidenlippert/nooterra/src/api/app.js:57202`
- `/Users/aidenlippert/nooterra/src/api/app.js:57228`
- `/Users/aidenlippert/nooterra/src/api/app.js:68902`

Hard rule for network trust:
1. No side-effecting authorization without strict request binding and valid execution intent.
2. No settlement finalization without matching binding evidence or signed dispute outcome.
3. Every cross-party claim must resolve to immutable hash-linked artifacts.

## 9. Enterprise Execution Package (Beta)

These files convert this blueprint into importable execution artifacts:
1. Epics CSV: `/Users/aidenlippert/nooterra/planning/jira/nooterra-network-beta-epics.csv`
2. Tickets CSV: `/Users/aidenlippert/nooterra/planning/jira/nooterra-network-beta-tickets.csv`
3. Backlog JSON: `/Users/aidenlippert/nooterra/planning/jira/nooterra-network-beta-backlog.json`
4. Sprinted delivery plan: `/Users/aidenlippert/nooterra/planning/sprints/nooterra-network-beta-enterprise-plan.md`
5. Release gates: `/Users/aidenlippert/nooterra/planning/launch/nooterra-network-beta-release-gates.md`

Execution principle:
1. Ship beta planes in dependency order (kernel -> identity -> builder/onboarding -> payments/intent -> reliability -> ops -> launch).
2. Gate every promotion on machine-readable evidence reports with explicit `schemaVersion`.
3. Keep paid/high-risk paths fail-closed by default when evidence, policy, or binding artifacts are missing or mismatched.
