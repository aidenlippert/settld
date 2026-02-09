# Self-Serve Launch Automation (S197/S198)

This runbook covers the self-serve launch automation surfaces:

- onboarding email sequence automation,
- referral funnel instrumentation,
- benchmark artifact generation for launch reporting.

## 1) Onboarding email sequence

Magic Link now emits a milestone-based onboarding email sequence per tenant:

- `welcome`
- `sample_verified_nudge`
- `first_settlement_completed`

Implementation:

- `services/magic-link/src/onboarding-email-sequence.js`
- wired from `services/magic-link/src/server.js` on tenant create, onboarding events, and upload progress.

Environment controls:

```bash
MAGIC_LINK_ONBOARDING_EMAIL_SEQUENCE_ENABLED=1
MAGIC_LINK_ONBOARDING_EMAIL_DELIVERY_MODE=record   # record|log|smtp
```

Default behavior:

- uses `smtp` when SMTP is configured,
- falls back to `record` otherwise.

Record mode writes deterministic outbox files:

- `onboarding-email-outbox/<tenantId>/<stepKey>/*.json`
- per-tenant state: `tenants/<tenantId>/onboarding_email_sequence.json`

## 2) Referral loop instrumentation

Referral loop signals are ingested through onboarding events:

- `referral_link_shared`
- `referral_signup`

Endpoint:

```bash
POST /v1/tenants/{tenantId}/onboarding/events
```

Example payloads:

```json
{ "eventType": "referral_link_shared", "metadata": { "channel": "email", "campaign": "launch_v1" } }
```

```json
{ "eventType": "referral_signup", "metadata": { "sourceTenantId": "tenant_a", "referredTenantId": "tenant_b" } }
```

Metrics exposure:

- `GET /v1/tenants/{tenantId}/onboarding-metrics`
- includes `referral.linkSharedCount`, `referral.signupCount`, `referral.conversionRatePct`.

## 3) Launch benchmark artifact

Build benchmark report from launch gate + throughput + incident rehearsal artifacts:

```bash
node scripts/ci/build-self-serve-benchmark-report.mjs
```

Output:

- `artifacts/launch/self-serve-benchmark-report.json`

Inputs (defaults):

- `artifacts/gates/self-serve-launch-gate.json`
- `artifacts/throughput/10x-drill-summary.json`
- `artifacts/throughput/10x-incident-rehearsal-summary.json`

NPM shortcut:

```bash
npm run test:ops:self-serve-benchmark
```
