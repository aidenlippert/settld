# Install

## Prerequisites

- Node.js `20.x`
- npm `>=10`

## Local Setup

```sh
npm ci
```

## Agentverse Bridge Import Smoke

```sh
node --input-type=module -e "await import('./src/agentverse/bridge/index.js'); await import('./src/agentverse/index.js');"
```

## Agentverse Gate

```sh
npm run -s test:ops:agentverse-gate
```

## Agentverse Live E2E

```sh
npm run -s test:ops:agentverse-live-e2e
```

## Agentverse CLI

```sh
node bin/agentverse-cli.js --help
```

## Runbook

- `docs/AGENTVERSE_REAL_BETA_RUNBOOK.md`
