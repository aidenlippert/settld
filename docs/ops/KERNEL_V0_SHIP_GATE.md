# Kernel v0 Ship Gate

This is the fail-closed release gate for shipping the current Kernel v0 OSS rails.

## Command

```bash
node scripts/ci/run-kernel-v0-ship-gate.mjs
```

Optional:

```bash
RUN_KERNEL_V0_QUICKSTART_SMOKE=0 node scripts/ci/run-kernel-v0-ship-gate.mjs
```

Report output:

- `artifacts/gates/kernel-v0-ship-gate.json`

## CI enforcement

1. `.github/workflows/tests.yml` runs `kernel_v0_ship_gate` on every `push` to `main`.
2. `.github/workflows/tests.yml` also runs `production_cutover_gate` on every `push` to `main`.
3. `.github/workflows/release.yml` blocks release unless that same commit has successful `kernel_v0_ship_gate` and `production_cutover_gate` results from `tests.yml`.

## Included checks

1. Launch-claim truth gate (`check-kernel-v0-launch-gate.mjs --mode prepublish`)
2. Core x402 e2e confidence suite
3. API/SDK contract freeze + OpenAPI snapshot checks
4. x402 quickstart smoke (`quickstart:x402`, default on)

Any failed check stops the sequence and returns non-zero.

## Rollout plan

1. Canary: ship to internal/demo environments and run full gate before every cut.
2. Scale-out: ship to design-partner environments after two consecutive green gate runs.
3. Full OSS release: publish only when the latest gate report is green and attached to release notes.

## Rollback triggers

Rollback immediately if any of the following happen after release:

1. Deterministic replay/receipt verification mismatch in production-like flow.
2. x402 authorize/verify path starts returning unexpected non-contract error codes.
3. Quickstart regression (`quickstart:x402`) fails on clean environment.

## Rollback execution

1. Freeze new rollout and revert to previous known-good release/tag.
2. Re-run ship gate against rollback candidate.
3. Re-open rollout only after green gate + root-cause note.

## Monitoring and alerting

Track at minimum:

1. `x402` authorize/verify success and conflict code distribution.
2. Receipt verification failures.
3. Quickstart smoke health in CI cadence.

## Owner / on-call

- Release owner: Platform/Kernel maintainer
- Escalation owner: API maintainer
- Rollback approver: Tech lead on-call
