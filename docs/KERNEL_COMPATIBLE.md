# Kernel Compatible Policy (v0)

This policy defines when a capability implementation can be listed as "Kernel Compatible".

## Eligibility Requirements

A capability must satisfy all three checks:

1. Kernel conformance passes for supported flow(s).
2. Closepack export verifies offline.
3. At least one deterministic verifier case passes.

Required commands (or equivalent CI jobs):

```sh
./bin/settld.js conformance kernel --ops-token tok_ops
./bin/settld.js closepack export --agreement-hash <sha256> --out /tmp/<agreementHash>.zip --ops-token tok_ops
./bin/settld.js closepack verify /tmp/<agreementHash>.zip
```

## Listing Contract

Each listed capability entry must provide:

- `id` (stable identifier)
- `name`
- `repoPath` (or external repository URL)
- `deterministicVerifierRef`
- `conformanceCaseIds` (array)
- `closepackVerified` (boolean)
- `lastVerifiedAt` (ISO timestamp)

Canonical listing file:

- `docs/kernel-compatible/capabilities.json`

Hosted/static mirror:

- `dashboard/public/kernel-compatible/capabilities.json`

## Badge Rules

- Badge text: `Kernel Compatible (v0)`
- Badge can be shown only while latest verification is passing.
- Badge must be removed within 24h if conformance or closepack verification regresses.

## Revocation Conditions

Listing is revoked when:

- conformance fails on latest stable release,
- closepack verify returns `ok=false`,
- deterministic verifier case is removed or fails repeatedly,
- artifact-chain replay mismatches are unresolved.

## Submission Flow (No Meeting Required)

1. Open a PR updating `docs/kernel-compatible/capabilities.json`.
2. Include machine-readable evidence paths or CI links for conformance and closepack verify.
3. Maintainer verifies evidence and merges if checks pass.
