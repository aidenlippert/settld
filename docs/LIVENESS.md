# Execution Liveness (v0.6)

Settld treats “job liveness” as an event-sourced contract:

- Robots emit signed heartbeats into the job stream.
- The server detects missing heartbeats and appends a signed `JOB_EXECUTION_STALLED` event (validated at append-time).
- When heartbeats resume, the server can append `JOB_EXECUTION_RESUMED` to return the job to `EXECUTING`.

## Events

### `JOB_HEARTBEAT` (robot-signed)

Constraints:

- Only allowed during `EXECUTING`, `ASSISTED`, `STALLED`, or `ABORTING_SAFE_EXIT`.
- `payload.t` must equal `event.at` (single source of time).
- `payload.robotId` must match `event.actor.id`.

Payload:

```json
{
  "jobId": "job_123",
  "robotId": "rob_1",
  "t": "2026-01-26T00:00:00.000Z",
  "stage": "TASK",
  "progress": 3,
  "assistRequested": false
}
```

### `JOB_EXECUTION_STALLED` (server-signed)

Constraints:

- Only allowed during `EXECUTING` or `ASSISTED`.
- Must be past the tier policy `stallAfterMs` threshold for the projected `lastHeartbeatAt` (append-time enforced).
- Includes a policy snapshot so stalls are auditable even if defaults evolve later.

Payload (reference-only, no media):

```json
{
  "jobId": "job_123",
  "robotId": "rob_1",
  "detectedAt": "2026-01-26T00:05:00.000Z",
  "reason": "NO_HEARTBEAT",
  "lastHeartbeatAt": "2026-01-26T00:01:00.000Z",
  "policy": { "heartbeatIntervalMs": 60000, "stallAfterMs": 180000 }
}
```

### `JOB_EXECUTION_RESUMED` (robot- or server-signed)

Constraints:

- Only allowed from `STALLED`.
- If server-signed, the server must have observed a post-stall heartbeat (append-time enforced).

## Policy

The current default policy is tier-driven and deterministic:

- `heartbeatIntervalMs` per environment tier
- `stallAfterMs = 3 * heartbeatIntervalMs`

See `src/core/liveness.js`.

## Ops hook (“liveness tick”)

The server uses an internal tick (`api.tickLiveness()`) to scan active jobs and append stall/resume events through the normal append pipeline (no direct state mutation).

Outbox side-effects (stubs for now):

- `JOB_STATUS_CHANGED` when a stall/resume changes the job status
- `ESCALATION_NEEDED` when `requiresOperatorCoverage` is true
