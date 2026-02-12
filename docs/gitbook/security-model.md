# Security Model

Settld minimizes trust assumptions in settlement outcomes by making critical claims signed, bound, and independently verifiable.

## Threats this design addresses

- artifact tampering after execution
- ambiguous money movement without decision lineage
- unauthorized economic actions outside authority scope
- silent drift between stored decisions and replayed outcomes

## Core controls

## Signed artifacts + canonical hashing

Critical objects are signed and hash-bound.

## Authority-scoped execution

Authority grants constrain spend, scope, and time.

## Agreement/evidence binding

Evidence must align with agreement commitments (`callId`, `inputHash`, terms).

## Deterministic idempotent effects

Deterministic IDs and uniqueness constraints prevent duplicate financial side effects.

## Dispute legitimacy

Non-admin dispute open requires signer-bound envelope proof.

## Replay and closepack verification

Stored outcomes can be recomputed and verified offline.

## Boundaries (what Settld does not solve alone)

- correctness beyond configured policy/verifier semantics
- private key compromise
- unsafe tenant policy configuration
- jurisdiction-specific legal/compliance obligations by default

## Operational minimums

- signer key rotation + inventory controls
- monitor replay mismatches and dispute lag
- keep strict separation between demo/test/prod tokens
- include closepack verify in release and incident workflows

## References

- `SECURITY.md`
- `docs/spec/THREAT_MODEL.md`
- `docs/THREAT_MODEL.md`
- `docs/ALERTS.md`
- `docs/ONCALL_PLAYBOOK.md`
