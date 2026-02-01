# Trust (v0.4)

Settld’s trust layer is a “privacy-respecting black box”: an append-only, tamper-evident event log with signer policy, plus minimal evidence references and a deterministic claims workflow.

## Core guarantees

- **Validated causality at append-time**: the server rejects events that break the chain, violate schema, violate signer policy, or violate core job/claims gates.
- **Tamper-evidence**: each event commits to its canonical payload (`payloadHash`) and to the previous link (`chainHash`), so deletion/reordering is detectable.
- **Proof of actor**: sensitive event families require signatures (robot/operator/server) based on event type.
- **Minimal recording**: raw media is never embedded in the event log; evidence is stored out-of-band and only referenced.
- **Deterministic economics**: claims adjustments and payouts produce double-entry ledger postings that always balance.

## Incident events

Incidents create the “what went wrong” anchor for evidence and claims.

- `INCIDENT_DETECTED` (robot-signed): anomaly detected during execution.
- `INCIDENT_REPORTED` (server- or operator-signed): customer report or operator report.

Incidents are keyed by `incidentId` and include a strict taxonomy type and integer severity `1..5`.

## Evidence events

Evidence is out-of-band and reference-only:

- `EVIDENCE_CAPTURED` (robot- or server-signed)

`EVIDENCE_CAPTURED` payloads include:

- `evidenceRef`: object-storage style URI (e.g. `obj://...`) — never raw bytes.
- metadata: `kind`, `durationSeconds`, `contentType`, `redaction`.

Evidence must reference an existing `incidentId` (append-time enforced).

## Claims workflow

Claims are modeled as a strict event-driven workflow:

- `CLAIM_OPENED` (server-signed)
- `CLAIM_TRIAGED` (server- or operator-signed)
- `CLAIM_APPROVED` / `CLAIM_DENIED` (server-signed)
- `JOB_ADJUSTED` (server-signed) — ties approval to deterministic ledger adjustments
- `CLAIM_PAID` (server-signed) — references the external payment and posts ledger entries

Append-time gates enforce that claims:

- reference an existing incident,
- can’t be approved/denied twice,
- can’t be paid before adjustment,
- can’t be approved for “no-execution” jobs except explicit access failures.

## Ledger linkage (high level)

- `JOB_ADJUSTED` creates `acct_claims_payable` for the approved total (payout + refund) and offsets it via:
  - `acct_claims_expense` for payouts, and/or
  - proportional reversals of job settlement allocations for refunds.
- `CLAIM_PAID` reduces `acct_claims_payable` and credits `acct_cash`.

See `docs/LEDGER.md` for the exact posting rules.
