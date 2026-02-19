# CI Flake Budget

This repo runs with a strict flake budget for paid-call kernel coverage.

## Policy

- Budget: 0
- No hidden retries in CI for test workflows.
- No `continue-on-error: true` for test jobs.
- No shell-level suppression (`|| true`) for test commands.

## Scope

- `.github/workflows/tests.yml`
- The paid-call kernel suite job (`mcp_paid_call_kernel_suite`)
- Existing `unit_tests` and quickstart smoke jobs

## Escalation

If a test flakes:

1. Open/attach an issue immediately (`type:ops` or `type:bug`).
2. Either:
   - fix the test in the same PR, or
   - quarantine with explicit owner + expiry date + follow-up issue.
3. Do not merge by masking failure with retries or error suppression.

## Enforcement

`scripts/ci/flake-budget-guard.mjs` enforces the policy markers and blocks forbidden flaky-tolerance patterns in `tests.yml`.

