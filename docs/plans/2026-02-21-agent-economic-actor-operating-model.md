# Agent Economic Actor Operating Model (v1)

Date: 2026-02-21  
Owner: Product + Platform + Risk

## Why this model

Goal: let agents spend and act with much more autonomy while keeping actions bounded, auditable, and reversible.

Settld does this by treating autonomy as a controlled envelope:

1. identity + delegation,
2. policy-bound authorization,
3. deterministic evidence + receipts,
4. dispute/reversal recourse.

## How customers are served

Primary user groups:

1. Agent builders: quick setup, policy profiles, paid tool calls, receipts.
2. Platform/runtime teams: central controls across hosts, no-bypass enforcement.
3. Ops/finance/risk/compliance: audit exports, dispute workflows, deterministic reconciliation.
4. Design partners: staged rollout with fail-closed release gates.

## Deployment modes

### Mode A: Hosted control plane + managed wallet (default)
- `settld setup --wallet-mode managed --wallet-bootstrap remote`
- Fastest time-to-first-paid-call, least wallet ops burden.

### Mode B: Hosted control plane + BYO wallet
- `settld setup --wallet-mode byo`
- Customer controls custody while Settld enforces trust contract.

### Mode C: Hosted/self-hosted control plane + no wallet rails
- `settld setup --wallet-mode none`
- Non-paid trust control path (proof/audit/dispute readiness before spend).

Reference flows:
- `docs/QUICKSTART_MCP_HOSTS.md`
- `scripts/setup/onboard.mjs`
- `services/magic-link/src/server.js`

## Should Settld manage agent wallets?

Answer: optional and policy-dependent.

1. Managed mode: Settld control plane bootstraps wallet provider config and returns runtime env.
2. BYO mode: customer supplies wallet env/refs; Settld still enforces policy and receipts.
3. No-wallet mode: only trust/evidence control path is active.

Wallet bootstrap and runtime bootstrap endpoints:
- `POST /v1/tenants/{tenantId}/onboarding/wallet-bootstrap`
- `POST /v1/tenants/{tenantId}/onboarding/runtime-bootstrap`
- `POST /v1/tenants/{tenantId}/onboarding/runtime-bootstrap/smoke-test`

## Should every agent have identity?

Yes.

Identity model (already defined in spec surface):

1. `AgentPassport.v1`: principal binding + active key anchors + delegation root + policy envelope.
2. `DelegationGrant.v1`: bounded authority transfer (scope, spend limits, depth, revocation).
3. `ExecutionIntent.v1`: canonical request/risk/spend/policy binding precondition.

Spec anchors:
- `docs/spec/AgentPassport.v1.md`
- `docs/spec/DelegationGrant.v1.md`
- `docs/spec/ExecutionIntent.v1.md`

Runtime anchors:
- `src/api/app.js` (passport validation, delegation lineage, wallet policy enforcement)
- `src/core/settlement-kernel.js`

## How wallet assignment should work

Do not default to “1 wallet per agent.”  
Default to deterministic assignment:

`tenant + environment + profile + risk tier + delegation depth -> sponsorWalletRef + policyRef + policyVersion`

Recommended rules:

1. High-risk financial agents: dedicated sponsor wallet.
2. Low-risk read/compute agents: pooled sponsor wallet with strict per-call and daily limits.
3. Delegated child agents: inherited wallet policy with depth checks and tighter caps.
4. Cross-team isolation: separate wallet by business unit + policy pack.

## How agents get funded

Funding control should be policy-driven, not ad hoc:

1. Prefund sponsor wallet.
2. Enforce per-call, per-day, and cumulative limits.
3. Add threshold-based top-up automation.
4. Lock escrow before authorization where required.
5. Require deterministic reserve and rollback semantics on failure.

Current code anchors:
- `src/api/app.js` (`computeX402DailyAuthorizedExposureCents`, wallet policy checks, reserve + rollback)
- `src/core/money-rail-adapters.js`
- `src/core/x402-gate.js`

## Setup flow (operator runbook)

1. Tenant bootstrap (runtime key material and tenant setup).
2. Wallet bootstrap (`managed` local/remote or `byo` env resolution).
3. Runtime bootstrap (MCP env + host config).
4. Profile apply (`settld profile ...`) and passport generation.
5. Host smoke test and first paid call run.
6. Conformance matrix + release gate checks.

Command anchors:
- `settld setup`
- `settld profile init|validate|simulate|apply`
- `npm run mcp:probe`
- `settld doctor`

## What this enables agents to do

As autonomy tiers increase, agents can do more actions safely:

### Tier 0 (Observe)
- Read-only calls, no spend.

### Tier 1 (Bounded spend)
- Paid tool calls under strict caps and allowlists.

### Tier 2 (Delegated execution)
- Multi-step workflows with delegation lineage and challenge windows.

### Tier 3 (Conditional autonomy)
- Challenge/escalate fallback and operator overrides.

### Tier 4 (Programmatic economic actor)
- Cross-tool/cross-agent spend orchestration with deterministic receipts, disputes, and reversals.

## Hard controls (must stay fail-closed)

1. No policy bypass across MCP stdio, MCP HTTP bridge, and gateway paths.
2. Authority boundaries: who can sign/revoke/pause/kill-switch.
3. Adapter invariant conformance for every rail lane.
4. Determinism soak checks for repeat export/verification.
5. Onboarding SLO gates for real operator usability.

## What still must be built

1. No-bypass negative matrix as release blocker.
2. Authority boundary and rollback drill automation.
3. Shared adapter invariant gate for all rails.
4. Deterministic repeat-run soak gate.
5. Onboarding SLO CI gate tied to runtime metrics.

Execution artifacts:
- `planning/jira/trust-os-v1-gap-closure-backlog.json`
- `planning/jira/trust-os-v1-gap-closure-tickets.csv`
- `planning/jira/agent-economic-actor-backlog.json`

## External research references

- Coinbase AgentKit docs: [https://docs.cdp.coinbase.com/agent-kit/docs/welcome](https://docs.cdp.coinbase.com/agent-kit/docs/welcome)
- Coinbase Agentic Wallet docs: [https://docs.cdp.coinbase.com/agentic-wallet/welcome](https://docs.cdp.coinbase.com/agentic-wallet/welcome)
- Circle docs: [https://developers.circle.com/](https://developers.circle.com/)
- Privy docs: [https://docs.privy.io/](https://docs.privy.io/)
- SPIFFE overview: [https://spiffe.io/docs/latest/spiffe-about/overview/](https://spiffe.io/docs/latest/spiffe-about/overview/)
- EIP-4337: [https://eips.ethereum.org/EIPS/eip-4337](https://eips.ethereum.org/EIPS/eip-4337)

