# Replay and Audit

Replay proves your stored settlement result still matches recomputed evaluation under the same pinned context.

## Replay goals

- verify decision consistency
- detect policy/verifier drift impact
- produce audit-ready evidence for incident/compliance reviews

## Tool-call replay

Use replay endpoint with agreement hash and compare:

- decision outcome
- reason codes/evaluation summary
- pinned policy/verifier references
- expected deterministic adjustment behavior

## Audit workflow

1. Fetch artifacts for subject agreement.
2. Run replay-evaluate.
3. Export closepack.
4. Run offline verify.
5. Store replay + verify reports with incident/release packet.

## Release gate recommendation

Make replay mismatch rate and closepack verify failures release-blocking thresholds.
