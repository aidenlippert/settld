# Settld Domain Model (v0)

## Actors

- **Requester**: Household or Business that pays and grants scoped access.
- **Owner**: supplies robots and receives payouts.
- **Robot**: endpoint with capabilities, health, and safety profile.
- **Operator**: remote assist + exception handling; actions are audited.
- **Developer**: publishes skills.
- **Trust Counterparty**: insurance/guarantee/claims partner.

## First-class entities

### Job

Purchasable outcome with SLA and constraints.

Key fields:

- `templateId` (e.g., `reset_lite`)
- constraints (rooms allowed, privacy mode, fragile items, pets, etc.)
- scheduling window
- price quote + risk premium
- selected robot + operator coverage (optional)
- state machine status

### Task Template

Defines:

- required skills
- environment requirements (managed vs home)
- SLA expectations
- pricing inputs and guardrails

### Skill

Signed bundle:

- metadata (name, version, developer, description)
- required capabilities + safety constraints
- deterministic policy graph (BT/SM) and tests
- optional model artifacts
- certification tier

### Capability

Robot-agnostic API surface (e.g., `NavigateTo`, `Pick`, `Place`, `ObserveROI`).

Robots advertise:

- mobility/manipulation properties
- allowed speed/force envelopes
- autonomy/teleop allowed flags
- sensor modes (privacy implications)

### Access Plan

Time-bounded, revocable credential set and instructions to access the space:

- credential scope + expiry
- revocation path
- entry/exit safe behaviors

### Incident / Claim

Incident: operationally detected anomaly or requester-reported issue.

Claim: workflow for remediation/payout:

- triage, classify, evidence bundle attach
- approve small payouts quickly, escalate large claims
- ledger adjustments (refunds, owner clawbacks, reserve draws)

### Ledger

Double-entry system of record for money movement:

- escrow/holds
- payout splits (owner, Settld fee, operator fee, developer royalty, reserve)
- refunds, chargebacks, tips

Invariant: every journal entry balances to zero.

## Trust scores (initially naive)

Used for dispatch, pricing, and environment gating:

- robot trust score
- owner trust score
- building trust score
- skill trust score / certification tier
