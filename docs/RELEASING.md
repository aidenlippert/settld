# Releasing Settld

This repo treats the **protocol** (docs + schemas + vectors + fixtures) as an API. Releases must be repeatable and reviewable.

See `docs/spec/VERSIONING.md` for “what requires a bump”.

## Release checklist

See `docs/RELEASE_CHECKLIST.md` for the definitive artifact completeness requirements.

1. Ensure `npm test` is green.
2. Ensure fixture determinism gate passes (it’s part of `npm test`).
3. Update `CHANGELOG.md`:
   - Add a new version section (Keep a Changelog format).
   - Call out any protocol-surface changes explicitly.
4. Bump tool version(s) you ship:
   - `packages/artifact-verify/package.json` `version`
   - `packages/api-sdk-python/pyproject.toml` `project.version` (when shipping Python SDK changes)
   - `SETTLD_VERSION` (repo/service version stamp)
5. Run packaging smoke test:
   - `node scripts/ci/npm-pack-smoke.mjs`
   - `node scripts/ci/cli-pack-smoke.mjs`
   - `node scripts/ci/run-public-openclaw-npx-smoke.mjs`
   - `python3 -m build packages/api-sdk-python --sdist --wheel --outdir /tmp/settld-python-dist-smoke`
   - Optionally generate full release artifacts locally: `npm run release:artifacts`
6. Create a tag and push it:
   - Tag format: `vX.Y.Z`
   - `git tag -a vX.Y.Z -m "vX.Y.Z"`
   - `git push origin vX.Y.Z`

On tag push, GitHub Actions builds and publishes release artifacts (Docker image, Helm chart, npm tarballs, Python wheel/sdist artifacts, SHA256SUMS).
If `NPM_TOKEN` is configured in repo secrets, the release lane also publishes:

- `settld` (CLI, so `npx settld ...` works directly),
- `settld-api-sdk` (JS SDK used by starter templates),
- `@settld/provider-kit` (provider middleware package),
- `create-settld-paid-tool` (scaffold CLI package).
  After publish, the workflow runs registry smoke checks and uploads `npm-postpublish-smoke-<version>` artifacts with command outputs + JSON summary evidence.
The `release_gate` job also runs a staging billing smoke (`dev:billing:smoke:prod`) and uploads `billing-smoke-prod.log` + `billing-smoke-status.json` as gate artifacts.

Python package publishing uses PyPI Trusted Publishing (OIDC) via either:

- the `python_publish` job in `.github/workflows/release.yml` (full release lane), or
- `.github/workflows/python-pypi.yml` (Python-only publish lane).

Before the first publish, configure a PyPI trusted publisher for this repo/workflow and allow the `pypi` GitHub environment.

## TestPyPI dry-run lane

Use `.github/workflows/python-testpypi.yml` as a manual pre-production lane:

1. Ensure `packages/api-sdk-python/pyproject.toml` `project.version` matches the version you plan to publish.
2. Run the `python-testpypi` workflow via `workflow_dispatch` and pass `version`.
3. The workflow builds wheel+sdist, asserts versioned filenames, and publishes to TestPyPI using OIDC (`testpypi` environment).
4. Validate installability from TestPyPI before running a production tag release.

## Python-only PyPI lane

Use `.github/workflows/python-pypi.yml` when you want to publish just the Python SDK to PyPI without waiting for other release jobs (Docker/Helm/conformance/audit).

1. Set `packages/api-sdk-python/pyproject.toml` `project.version` to the target version.
2. Ensure PyPI trusted publishing is configured for workflow `python-pypi.yml` and environment `pypi`.
3. Run the `python-pypi` workflow via `workflow_dispatch`.
4. Confirm wheel/sdist publish completed on PyPI and smoke-install in a clean venv.

## Release authenticity

Releases also publish a signed `ReleaseIndex.v1` (`release_index_v1.json` + `release_index_v1.sig`) to make artifact authenticity verifiable.

See `docs/spec/ReleaseIndex.v1.md` and `docs/spec/SUPPLY_CHAIN.md`.

The release workflow expects a repo secret named `SETTLD_RELEASE_SIGNING_PRIVATE_KEY_PEM` containing an Ed25519 private key PEM used only for signing release indexes.

The corresponding public key (and quorum policy, if used) is pinned in `trust/release-trust.json` and should be treated as a security-sensitive change (PR + review).

## Protocol vectors / fixtures rotation

If a change *intentionally* changes protocol meaning (schemas/spec semantics/strictness/canonicalization/hashing), do not “let it drift”:

- Update specs and schemas together.
- Rotate vectors and/or add fixtures deliberately.
- Add a clear “Protocol change” entry to `CHANGELOG.md`.
