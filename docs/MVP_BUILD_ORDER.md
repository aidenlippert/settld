# MVP Build Order (sprint-sized)

This is the recommended implementation order for a narrow “managed environment” wedge.

## Sprint 1: Core spine

- Define job state machine + transition validation.
- Append-only event log with hash chaining.
- In-memory prototype API (create job, append event, replay).
- Minimal robot registration and heartbeat.

## Sprint 2: Booking + dispatch

- Quote object + booking workflow (hold/escrow stub).
- Deterministic matching scorer (capability + trust tiers).
- Reservation + idempotency keys.
- Basic replanning hooks (robot unavailable → re-match).

## Sprint 3: Assist + incident workflow

- Operator assist start/end events.
- Incident taxonomy and automatic evidence bundling triggers.
- Job timeline replay view (ops API endpoints).

## Sprint 4: Ledger correctness

- Double-entry ledger with settlement splits.
- Refund and partial completion accounting.
- Reconciliation reports (per job, per owner).

## Sprint 5: Skill packaging & certification tooling (internal)

- Skill bundle format + verification.
- Capability API stubs + robot adapter interface.
- Certification checklist automation (static + sim harness hooks).

