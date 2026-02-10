# Repo Settings (Recommended)

These are GitHub-side settings we expect for a fail-closed kernel repo.

## Branch Protection (main)

- Require a pull request before merging.
- Require status checks to pass before merging:
  - `tests / pr_issue_link_guard`
  - `tests / changelog_guard`
  - `tests / unit_tests`
  - `tests / openapi_drift`
  - `tests / npm_pack_smoke (ubuntu-latest)`
  - `tests / npm_pack_smoke (macos-latest)`
  - `tests / npm_pack_smoke (windows-latest)`
  - `tests / cli_cross_platform (ubuntu-latest)`
  - `tests / cli_cross_platform (macos-latest)`
  - `tests / cli_cross_platform (windows-latest)`
  - `tests / python_verifier_conformance`
  - `tests / github_action_settld_verify (jobproof)`
  - `tests / github_action_settld_verify (monthproof)`
  - `tests / github_action_settld_verify (financepack)`
- Dismiss stale PR approvals when new commits are pushed.
- Require linear history.
- Block force pushes and deletions.
- Require conversation resolution.

Optional:

- Require signed commits.
- Require CODEOWNERS review (if/when CODEOWNERS exists).

## Actions

- Keep secrets scoped to environments (staging/prod).
- Require manual approval for production deployments (if/when added).

