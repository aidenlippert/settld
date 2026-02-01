# Access (v0.3)

Access is modeled as a first-class, **revocable**, **time-scoped** dependency of a job. Access secrets are never written to the event log; only references are.

## Principles

- **No secrets in logs**: the event stream stores `credentialRef` (e.g. `vault://...`), never door codes/passwords.
- **Scoped and revocable**: access plans are time-bounded and can be revoked instantly.
- **Execution is gated**: the system rejects execution start without an active access plan and access granted within the plan window.
- **Revocation forces safe exit**: access revocation transitions the job to a safe-exit mode and rejects further “work” events.

## Events

### `ACCESS_PLAN_ISSUED` (server-signed)

Payload shape (current prototype, strict):

```json
{
  "jobId": "job_123",
  "accessPlanId": "ap_456",
  "method": "SMART_LOCK_CODE|BUILDING_CONCIERGE|ON_SITE_OWNER|DOCKED_IN_BUILDING",
  "credentialRef": "vault://access/ap_456/v1",
  "scope": { "areas": ["ENTRYWAY"], "noGo": ["BEDROOM_2"] },
  "validFrom": "2026-01-26T18:00:00Z",
  "validTo": "2026-01-26T22:00:00Z",
  "revocable": true,
  "requestedBy": "system|customer|ops"
}
```

### `ACCESS_GRANTED` / `ACCESS_DENIED` (robot- or operator-signed)

Payload includes the plan reference (no secrets):

```json
{ "jobId": "job_123", "accessPlanId": "ap_456", "method": "BUILDING_CONCIERGE" }
```

### `ACCESS_REVOKED` / `ACCESS_EXPIRED` (server-signed in v0.3)

```json
{ "jobId": "job_123", "accessPlanId": "ap_456", "requestedBy": "customer", "reason": "..." }
```

## Enforced invariants (v0.3)

- `ACCESS_GRANTED`/`ACCESS_DENIED` are rejected unless:
  - an `ACCESS_PLAN_ISSUED` exists, and
  - the `accessPlanId` matches the current plan, and
  - the event timestamp is within `[validFrom, validTo]`.
- `EXECUTION_STARTED` is rejected unless:
  - an access plan exists, and
  - access is currently granted, and
  - the event timestamp is within the plan window.
- After `ACCESS_REVOKED`, the job moves to `ABORTING_SAFE_EXIT`, and “work” events are rejected.

