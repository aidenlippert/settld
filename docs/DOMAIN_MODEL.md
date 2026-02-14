# Settld Domain Model (v1)

## Actors

- **Agent**: Any autonomous entity that performs paid work or delegates paid work. Can be an AI agent, a tool endpoint, a robotic system, or any programmatic actor.
- **Principal**: The human or organization that owns/controls an agent and sets its economic policy (spending limits, delegation rules, approval requirements).
- **Counterparty**: The entity on the other side of an agreement (buyer or seller — roles are relative to a specific agreement).
- **Arbiter**: An entity (human, automated, or hybrid) authorized to render verdicts in disputes.
- **Verifier**: Any entity running settlement protocol verification — can be Settld, a third-party certified verifier, or the counterparty themselves (offline).

## First-class entities

### Agreement

A machine-readable economic contract between two or more parties for a specific piece of work.

Key fields:

- `agreementHash` (SHA-256, canonical — the identity of the agreement)
- parties (agent IDs, roles: buyer/seller/arbiter)
- pricing terms (amount, currency, fee splits, holdback %)
- SLA definition (completion criteria, time bounds, quality thresholds)
- evidence requirements (what constitutes proof of completion)
- dispute rules (window duration, arbitration method, cascading behavior)
- delegation policy (max depth, sub-agreement budget caps, allowed sub-contractors)
- settlement policy (auto-settle on pass, manual review, holdback release schedule)
- governance constraints inherited from principal (spending limit, approval gate)

### Evidence Bundle

Cryptographically committed proof-of-work artifacts.

Structure:

- `manifest.json`: commits to all file paths + SHA-256 hashes
- `attestation/`: signer commitments binding to the manifest hash
- `verify/`: verification report (not in manifest — validated by binding + signature)
- evidence content: referenced by hash, stored out-of-band (S3/object storage)

Bundle types:

- JobProofBundle.v1 — proof for a single unit of work
- MonthProofBundle.v1 — aggregated proof for a billing period
- FinancePackBundle.v1 — financial reconciliation evidence
- InvoiceBundle.v1 — work + terms + metering + claim
- ClosePack.v1 — pre-dispute wedge pack with embedded InvoiceBundle + evaluation surfaces

### Settlement Decision Record

Deterministic output of settlement policy evaluation.

Key fields:

- `agreementHash` — links to the agreement
- `policyHashUsed` — pins which policy version was evaluated
- `status` — pass/fail/warn
- evidence summary (findings, warnings, errors with stable codes)
- payout breakdown (platform fee, agent payout, holdback, reserves)
- signed by settlement decision signer

Invariant: same evidence + same policy → same decision. Always.

### Holdback

Portion of settlement held in reserve pending dispute window expiration.

- Created at settlement time per agreement terms.
- Released automatically when dispute window closes (if no dispute).
- Refunded (fully or partially) if dispute verdict favors buyer.
- Holdback adjustments are deterministic and signed.

### Dispute

A structured challenge to a settlement.

Lifecycle:

```
dispute_opened → evidence_attached → arbitration → verdict → adjustment
```

Key entities:

- `DisputeOpenEnvelope.v1` — signed by disputing party, references agreement + evidence
- `ArbitrationCase.v1` — case record with evidence links, timeline
- `ArbitrationVerdict.v1` — arbiter decision (release / partial refund / full refund)
- `SettlementAdjustment.v1` — deterministic ledger entries adjusting holdback

### Reputation Event

Append-only economic fact about an agent.

Types:

- `settlement_completed` — on-time, SLA met
- `settlement_failed` — deadline missed, SLA breached
- `dispute_opened` — party opened a dispute
- `dispute_won` / `dispute_lost` — outcome
- `delegation_depth` — how many hops deep this agent operated

Queryable via windowed API: "show me this agent's last 90 days of settlement history."

### Ledger Entry

Double-entry journal entry for money movement.

- Every entry balances to zero (sum of postings = 0).
- Account types: cash, escrow, platform revenue, agent payable, developer royalties, insurance reserve, claims expense, claims payable.
- Supports multi-currency extension (planned).

### Governance Policy

Machine-readable rules set by a principal (human/org) that constrain agent economic behavior.

- Spending limits (per-transaction, daily, monthly)
- Approval gates (amount thresholds requiring human sign-off)
- Delegation policy (max sub-agent depth, budget per delegation level)
- Allowed counterparties (whitelist/blacklist)
- Allowed settlement rails (fiat only, crypto only, both)
- Evidence retention requirements

## Entity relationships

```
Principal ──owns──▶ Agent
Agent ──creates──▶ Agreement ◀──accepts── Agent
Agreement ──requires──▶ Evidence Bundle
Evidence Bundle ──evaluated by──▶ Settlement Decision Record
Settlement Decision Record ──creates──▶ Ledger Entry + Holdback
Holdback ──challenged by──▶ Dispute
Dispute ──resolved by──▶ Arbiter ──renders──▶ Verdict
Verdict ──adjusts──▶ Holdback ──creates──▶ Ledger Entry (Adjustment)
Agent ──accumulates──▶ Reputation Events
Principal ──publishes──▶ Governance Policy ──constrains──▶ Agent
Agreement ──may spawn──▶ Sub-Agreement (compositional delegation)
```

## Compositional model (multi-hop)

When Agent A delegates to Agent B who delegates to Agent C:

```
Agreement_AB ──spawns──▶ Agreement_BC ──spawns──▶ Agreement_CD
     │                        │                        │
     ▼                        ▼                        ▼
Evidence_D ──rolls up──▶ Evidence_C ──rolls up──▶ Evidence_B
     │                        │                        │
     ▼                        ▼                        ▼
Settle_CD ──cascades──▶ Settle_BC ──cascades──▶ Settle_AB
```

- Sub-agreements inherit budget caps and delegation limits from parent.
- Evidence at leaf level rolls up through the chain.
- Settlement cascades bottom-up (deepest first).
- Disputes can propagate up or down the chain.
- Total payout across chain ≤ original agreement amount (invariant).
