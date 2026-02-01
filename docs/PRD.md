# Settld PRD (v0)

## One-line

Settld lets a person or business delegate real-world work to an agent (robot + optional operator assist) with strict limits, proof of what happened, and a clear “who pays if something goes wrong” answer.

## Who it’s for

- **Requesters**: Households and Businesses that purchase outcomes (“Reset my apartment”).
- **Owners**: Entities that provide robot capacity (time/location/reliability) and receive payouts.
- **Operators**: Trained humans that provide remote assist and exception handling.
- **Developers**: Publish skills; Settld certifies and distributes them.
- **Trust Counterparty**: Insurance/guarantee/claims partner (initially) and later first-party.

## Core promise

Delegation with accountability:

- Explicit authorization and revocation (where it can go / what it can touch / what it can record).
- Observable execution (telemetry, checkpoints, operator actions).
- Economic finality (escrow, payouts, refunds, chargebacks) with double-entry correctness.
- Claims-ready evidence (“black box”) that is privacy-respecting and tamper-evident.

## MVP scope (first shippable)

Target environments: managed or semi-managed (apartments common areas, hotels/serviced apartments, offices after-hours).

MVP capabilities:

1. **Task templates**: at least one narrow template (e.g., `reset_lite`).
2. **Booking**: quote → book → schedule window.
3. **Dispatch**: match robot + reserve; operator coverage optional but supported.
4. **Execution control**: job state machine + step checkpoints.
5. **Exception handling**: abort/assist/customer approval request path (logged).
6. **Telemetry black box**: append-only, hash-chained events; incident evidence bundles.
7. **Settlement ledger**: escrow, fee splits, refunds.
8. **Ops console primitives**: ability to list active jobs, view timeline, see incidents.

## Key user journeys

### 1) Requester books outcome

1. Select template + enter constraints (rooms allowed, pets, privacy mode, fragile items).
2. Choose time window.
3. Receive quote (transparent internally; auditable adjustments).
4. Book (payment hold/escrow).
5. Track execution (statuses + optional media based on privacy policy).
6. Receive completion report; rate.

### 2) Execution with assist

1. Robot begins; emits heartbeats + checkpoints.
2. Failure mode triggers exception policy:
   - request customer approval, OR
   - request operator assist, OR
   - abort and exit safely.
3. Operator intervention is structured and fully audited.

### 3) Incident & claims

1. Impact/complaint/flag triggers incident workflow.
2. Evidence bundle generated (timeline + key frames + operator actions).
3. Claim opened, triaged, resolved; refunds/payout adjustments via ledger.

## Non-goals for MVP

- Full autonomy in random single-family homes.
- Unbounded, free-form “LLM runs the robot” behavior.
- Decentralized economics / blockchain dependence.

## Success metrics (early)

- Completion rate (with assist) and incidents per job-hour.
- Operator minutes per job.
- On-time start and job duration variance.
- Claims rate, time-to-resolution, and net loss ratio.
- Gross margin per job (after ops + reserve).
