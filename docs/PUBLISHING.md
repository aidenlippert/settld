# Publishing

## Local Prepublish Validation

Run the publish precheck report (fail-closed):

```sh
npm run -s publish:precheck
```

This writes JSON to:

- `artifacts/publish/prepublish-check.json`

## Agentverse Package Dry Run

```sh
NOOTERRA_PUBLISH_DRY_RUN=1 npm run -s publish:agentverse
```

## Build Tarball

```sh
npm run -s publish:tarball
```

This writes:

- `nooterra-<version>.tgz`

## npm Publish

```sh
NOOTERRA_PUBLISH_DRY_RUN=0 npm run -s publish:agentverse -- --access public
```

## GitHub Workflows

- CI gate workflow: `.github/workflows/ci.yml`
- Publish workflow: `.github/workflows/publish.yml`

## Real Beta Validation Before Publish

```sh
npm run -s test:ops:agentverse-live-e2e
npm run -s test:ops:agentverse-gate
npm run -s publish:precheck
```

See full operator runbook:

- `docs/AGENTVERSE_REAL_BETA_RUNBOOK.md`
