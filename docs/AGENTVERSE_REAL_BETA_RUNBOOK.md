# Agentverse Real Beta Runbook

This runbook is the shortest path from local code to a real beta signal.

## 1. Local Preconditions

- Node.js `20.x`
- npm `>=10`
- clean install:

```sh
npm ci
```

## 2. Real Local Validation (Required)

Run these in order:

```sh
npm run -s test:ops:agentverse-live-e2e
npm run -s test:ops:agentverse-gate
npm run -s publish:precheck
```

What these prove:

- `agentverse-live-e2e`: daemon talks to a real API server over HTTP and completes a work order end-to-end.
- `agentverse-gate`: import, CLI routing, scaffold, policy, registry, smoke checks.
- `publish:precheck`: fail-closed publish readiness + dry `npm pack` validation.

## 3. Build Tarball Artifact

```sh
npm run -s publish:tarball
```

Output artifact:

- `nooterra-<version>.tgz`

## 4. CLI Real Smoke (Manual)

Start API:

```sh
npm run -s dev:api
```

In another terminal:

```sh
nooterra agent init demo-agent --capability code_review --dir ./demo-agent --force
cd demo-agent
nooterra agent run --agent-id agt_demo_agent --base-url http://127.0.0.1:3000 --ops-token tok_ops
```

Then create workload from API/SDK or existing CLI task flows and verify:

- work order moves `created -> accepted -> completed`
- completion receipt exists
- session events/replay are retrievable

## 5. Publish

Dry-run publish:

```sh
NOOTERRA_PUBLISH_DRY_RUN=1 npm run -s publish:agentverse
```

Real npm publish:

```sh
NOOTERRA_PUBLISH_DRY_RUN=0 npm run -s publish:agentverse -- --access public
```

CI publish path:

- Trigger `.github/workflows/publish.yml`
- Set `publish=true`
- Ensure `NPM_TOKEN` is configured in GitHub secrets

## 6. Do We Need Railway?

Not required for local real testing.

Use Railway when you need public internet testing with external agents or design partners. For hosted topology and controls, use:

- `docs/ops/HOSTED_BASELINE_R2.md`

Minimum hosted split for real beta:

- API service (`npm run start:prod`)
- maintenance worker (`npm run start:maintenance`)
- optional magic-link service (`npm run start:magic-link`)

## 7. Beta Exit Criteria

Ship beta only when all are true:

- local live e2e passes
- agentverse gate passes
- prepublish check passes
- tarball builds successfully
- hosted baseline evidence is green for target environment
