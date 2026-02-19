# Parallel Execution Runbook (Manager + 2 Workers)

## Purpose

Provide a repeatable operator process for running one manager with two parallel workers without ownership collisions, missing handoffs, or unclear closure.

## Roles

| Role | Primary responsibility | Required output |
|---|---|---|
| Manager | Define scope, assign worker ownership, monitor progress, merge outcomes, close run | Filled run log under `planning/ownership/parallel-runs/` |
| Worker 1 | Execute assigned scope inside approved file boundaries | Change summary + verification notes |
| Worker 2 | Execute assigned scope inside approved file boundaries | Change summary + verification notes |

## Preflight

1. Create a run ID: `YYYY-MM-DD-<short-topic>`.
2. Confirm file ownership boundaries for manager and each worker.
3. Define acceptance criteria and smoke checks before work starts.
4. Open run log file: `planning/ownership/parallel-runs/<run-id>.md`.
5. Record explicit stop/escalation rule: workers stop if scope moves outside assigned ownership.

## Worker Brief Format

Use this exact structure per worker:

- `objective`: one sentence outcome.
- `owned_paths`: explicit allow-list paths.
- `deliverables`: files/artifacts expected at handoff.
- `verification`: commands or checks worker must run.
- `escalate_if`: blockers, ownership conflicts, or unclear requirements.

## Execution Flow

1. Manager writes both worker briefs in the run log.
2. Manager starts Worker 1 and Worker 2 in parallel.
3. Workers post heartbeat updates using: `done`, `next`, `risk`, `needs`.
4. Manager resolves conflicts immediately; no overlapping writes.
5. Workers submit final handoff packets:
   - files changed
   - acceptance criteria status
   - verification evidence
   - open risks (if any)

## Smoke Gate (Manager + 2 Workers)

Manager closes the run only if all checks pass:

1. Both workers stayed within `owned_paths`.
2. All declared deliverables exist.
3. Required verification checks ran and were captured in log.
4. Manager reviewed outputs and documented final disposition.
5. Closure checklist in run log is fully completed.

## Closure Checklist Template

Copy into each run log and mark each line:

- [ ] Run purpose and scope documented.
- [ ] Worker assignments documented with ownership boundaries.
- [ ] Worker outputs captured with file references.
- [ ] Verification evidence captured.
- [ ] Open risks captured (or explicitly `none`).
- [ ] Final manager decision recorded (`closed` or `follow-up required`).
