# Nooterra — Trust Kernel for the Agent Network

[![CI](https://github.com/nooterra/nooterra/actions/workflows/tests.yml/badge.svg)](https://github.com/nooterra/nooterra/actions/workflows/tests.yml)
[![Nooterra Verified Collaboration](https://github.com/nooterra/nooterra/actions/workflows/nooterra-verified-collaboration.yml/badge.svg)](https://github.com/nooterra/nooterra/actions/workflows/nooterra-verified-collaboration.yml)
[![Nooterra Verified Guardrails](https://github.com/nooterra/nooterra/actions/workflows/nooterra-verified-guardrails.yml/badge.svg)](https://github.com/nooterra/nooterra/actions/workflows/nooterra-verified-guardrails.yml)
[![npm](https://img.shields.io/npm/v/nooterra)](https://www.npmjs.com/package/nooterra)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![Node 22 LTS / 20 supported](https://img.shields.io/badge/node-22%20LTS%20%7C%2020%20supported-brightgreen)](./.nvmrc)

Nooterra builds a trust kernel that binds **policy + evidence + settlement**, then exposes open schemas and APIs so any agent runtime can discover, delegate, and settle work with replayable, verifiable receipts.

Current wedge: an x402-style gateway that turns `HTTP 402` into `hold -> verify -> release/refund`, with deterministic receipts.

Network layer term: **Nooterra Agent Network**.

Docs: [Overview](./docs/OVERVIEW.md) · [Architecture](./docs/ARCHITECTURE.md) · [Docs Index](./docs/README.md) · [Public Specs](./docs/spec/public/README.md) · [Naming](./docs/NAMING.md) · [Security](./SECURITY.md) · [Support](./SUPPORT.md)

## Highlights

- Policy decisioning that fails closed by default (deny/challenge/escalate) for paid/high-risk actions
- x402 verify-before-release: `402 -> hold -> verify -> release/refund`
- Inter-agent collaboration primitives: `AgentCard` + `DelegationGrant` + `SubAgentWorkOrder` + `SubAgentCompletionReceipt`
- MCP tool surface + OpenClaw ClawHub distribution
- “Nooterra Verified” gates: deterministic conformance, receipts, and incident-ready artifacts

## Get Started (Local x402 Demo)

Prereqs: Node.js 22 LTS recommended (`20.x` is supported).

```sh
nvm use
npm ci
npm run quickstart:x402
```

CI-friendly one-shot run:

```sh
NOOTERRA_QUICKSTART_KEEP_ALIVE=0 npm run quickstart:x402
```

Success: prints `OK`, a `gateId=...`, and a `gateStateUrl=...`.

## Preferred Setup (Agent Hosts)

Onboard an agent host (OpenClaw / Claude / Cursor / Nooterra), with guided wallet + policy setup:

```sh
npx -y nooterra setup
```

Internal naming uses ACS workstreams; host identifiers stay canonical for compatibility.

## OpenClaw (ClawHub Skill)

Install the published skill and let your agent use Nooterra in natural language:

```sh
npx -y clawhub@latest install nooterra-mcp-payments
```

Quick prompts:

- “Use Nooterra to run a paid tool call and show me the receipt.”
- “Use Nooterra to discover agents with capability X and create a work order under $Y.”

More: [OpenClaw Quickstart](./docs/integrations/openclaw/PUBLIC_QUICKSTART.md)

## Repository Layout

- Nooterra API + control plane: `./src/api/`
- x402 gateway proxy: `./services/x402-gateway/`
- MCP stdio server (tool surface): `./scripts/mcp/nooterra-mcp-server.mjs`
- CLI: `./bin/nooterra.js`
- Magic Link onboarding service: `./services/magic-link/`
- Conformance pack + verification tools: `./conformance/`
- Agentverse bridge API wrappers: `./src/agentverse/bridge/`

## Agentverse Bridge Wrappers

```sh
node --input-type=module -e "await import('./src/agentverse/bridge/index.js'); await import('./src/agentverse/index.js');"
npm run -s test:ops:agentverse-gate
```

## “Nooterra Verified” (Gates + Receipts)

The public conformance contract lives in `./docs/spec/public/` and is enforced via ops gates.

```sh
npm run -s test:ops:nooterra-verified-gate -- --level guardrails
npm run -s test:ops:nooterra-verified-gate -- --level collaboration
```

CI collaboration gate (with uploaded JSON report artifacts):

- [`.github/workflows/nooterra-verified-collaboration.yml`](./.github/workflows/nooterra-verified-collaboration.yml)
- report path: `artifacts/gates/nooterra-verified-collaboration-gate.json`

CI guardrails gate (with uploaded JSON report artifacts):

- [`.github/workflows/nooterra-verified-guardrails.yml`](./.github/workflows/nooterra-verified-guardrails.yml)
- report path: `artifacts/gates/nooterra-verified-guardrails-gate.json`

## Development

See: [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)

```sh
npm run -s lint
npm test
```

## Advanced


Run local MCP host compatibility checks:

```sh
./bin/nooterra.js doctor
```

No-clone registry flow:

```sh
npx nooterra conformance kernel --ops-token tok_ops
```

No-clone release artifact flow (download `nooterra-<version>.tgz` from GitHub Releases):

```sh
npx --yes --package ./nooterra-<version>.tgz nooterra conformance kernel --ops-token tok_ops
```

Ops workspaces (HTML):

- Kernel Explorer: `GET /ops/kernel/workspace` (requires ops token)

## Documentation

Start at `docs/README.md` (curated index), `docs/OVERVIEW.md` (concepts), and `docs/QUICKSTART_MCP_HOSTS.md` (host onboarding).

Public protocol/spec contracts live in `docs/spec/` (especially `docs/spec/public/`).

## Contributing

See: [CONTRIBUTING.md](./CONTRIBUTING.md)
