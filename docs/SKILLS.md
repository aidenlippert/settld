# Skills & Royalties (v0.3)

Skills are licensed to a job as explicit events. Royalties are deterministic and flow into the settlement ledger.

## Principles

- **Licensing is explicit**: paid capabilities must be licensed (`SKILL_LICENSED`) before use.
- **Usage is auditable**: the executor can emit `SKILL_USED` events during execution.
- **Settlement is deterministic**: developer royalties payable equals the sum of licensed skill fees.

## Events

### `SKILL_LICENSED` (server-signed)

Licenses a skill version to a job.

```json
{
  "jobId": "job_123",
  "skill": { "skillId": "skill_reset_lite", "version": "1.2.0", "developerId": "dev_abc" },
  "pricing": { "model": "PER_JOB", "amountCents": 399, "currency": "USD" },
  "licenseId": "lic_789",
  "terms": { "refundableUntilState": "EXECUTING", "requiresCertificationTier": "CERTIFIED" }
}
```

### `SKILL_USED` (robot- or operator-signed)

Proves the skill actually ran (v0.3 uses the `licenseId` as the linkage):

```json
{ "jobId": "job_123", "licenseId": "lic_789", "step": "wipe_surfaces" }
```

## Enforced invariants (v0.3)

- `SKILL_LICENSED` is rejected after execution starts.
- `SKILL_USED` is rejected unless a matching `SKILL_LICENSED` exists in the job stream.
- At `SETTLED` (job completed):
  - Developer royalties payable equals the sum of `SKILL_LICENSED.pricing.amountCents`.
  - The journal entry must balance to zero.

