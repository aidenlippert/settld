# Conformance

Conformance verifies behavioral correctness of Kernel v0, not just schema validity.

## Why conformance exists

Conformance catches high-impact regressions:

- replay mismatches
- dispute/holdback lifecycle drift
- deterministic adjustment/idempotency violations
- closepack verification failures

## Run conformance

Installed CLI:

```bash
npx settld conformance kernel --ops-token tok_ops --json-out /tmp/kernel-report.json
```

Repo checkout:

```bash
./bin/settld.js conformance kernel --ops-token tok_ops --json-out /tmp/kernel-report.json
```

## Minimum assertions expected

- kernel artifact chain is complete
- replay-evaluate matches stored outcomes
- closepack export + offline verify succeeds
- dispute flow blocks auto-release and routes held funds deterministically
- idempotency constraints hold under retries

## CI usage

Store these as build artifacts:

- conformance JSON report
- closepack verify report
- release artifact checksum list (for releases)

## Run-twice idempotency check

Run critical flows twice and confirm deterministic uniqueness surfaces hold (no duplicate deterministic effects).

## Failure triage pattern

1. Inspect failing assertion from report JSON.
2. Map failure to primitive/invariant.
3. Fix invariant behavior (not only response shape).
4. Re-run until all assertions pass.

## Related files

- `conformance/kernel-v0/run.mjs`
- `test/conformance-kernel-v0.test.js`
- `docs/KERNEL_COMPATIBLE.md`
