# Settld Architecture (v0)

Settld is a **trust fabric + runtime + ledger** for embodied work.

## Layers (logical)

1. **Marketplace**: task templates, quotes, booking, payments, scheduling.
2. **Operations**: fleet health, dispatch, runtime control, operator assist.
3. **Skills**: packaging, certification, licensing, execution orchestration.
4. **Trust**: telemetry black box, incident detection, claims, audits.

Ship as a **modular monolith** initially with strict boundaries; split later.

## Architectural spine: jobs + events

- A **Job** is a state machine (the “source of truth” for what should happen next).
- An **Event** is the audit trail (what did happen), emitted by:
  - cloud services (quote created, booking confirmed),
  - agent (entered space, checkpoint done),
  - operator (assist start/end, action approvals),
  - requester (approval granted/revoked, complaint filed).

Invariants:

- State transitions are explicit and validated.
- Events are append-only.
- Every settlement is balanced (sum of postings is zero).

## Core components (eventual)

### Settld Cloud

- **Job Orchestrator**: validates and advances job state, emits job events.
- **Dispatch Service**: matching + reservation + replanning.
- **Ledger Service**: holds, escrow, settlement, refunds, chargebacks, splits.
- **Trust Service**: evidence bundling, incident/claims workflow.
- **Skill Registry**: signed bundles, certification tiers, distribution rules.

### Settld Agent (on/near robot)

- Secure channel to cloud (mTLS + rotating certs).
- Advertises capabilities/health.
- Downloads/verifies signed skill bundles.
- Executes job plans and emits telemetry/checkpoints.
- **Local policy enforcement**: clamps cloud-requested actions to safety bounds.
- Privacy enforcement (sensor gating, retention rules).

### Operator Assist

- Live streaming (WebRTC) + command channel.
- Structured interventions (approve grasp, set nav target, select object).
- All operator actions are logged into the black box.

## Data & storage (eventual)

- Transactional truth: Postgres (jobs, bookings, entities, ledger).
- Cache/locks: Redis (reservations, idempotency, rate limits).
- Event bus: Kafka/PubSub (job events, telemetry envelopes).
- Evidence: object storage (S3/GCS).
- Telemetry analytics: log pipeline + time-series for what is queried.

## Security posture (MVP principles)

- Device identity and attestation.
- Signed artifacts (skills) and signed/hashed logs (black box).
- Principle of least privilege across:
  - access plans (time-bounded, revocable),
  - operator consoles (scoped actions),
  - skills (capability-limited).
