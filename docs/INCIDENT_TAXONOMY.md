# Incident Taxonomy (v0.4)

Incidents are classified events that anchor evidence and claims workflows.

## Types (enforced)

Defined in `src/core/incidents.js`:

- `DAMAGE_PROPERTY`
- `PRIVACY_VIOLATION`
- `SAFETY_NEAR_MISS`
- `FAILURE_TO_COMPLETE`
- `ACCESS_FAILURE`
- `THEFT_ALLEGATION`
- `ROBOT_STUCK`
- `UNEXPECTED_HUMAN_CONTACT`

## Severity (enforced)

Integer scale `1..5`:

- `1` — minor anomaly / near-miss
- `3` — material anomaly; evidence likely required
- `5` — severe safety/property risk

## Event linkage

- Incidents are created by `INCIDENT_DETECTED` (robot) or `INCIDENT_REPORTED` (operator or server-on-behalf-of-customer).
- Evidence (`EVIDENCE_CAPTURED`) must reference an existing `incidentId`.
- Claims (`CLAIM_OPENED`) must reference an existing `incidentId`.
