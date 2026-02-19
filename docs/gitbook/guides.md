# Guides

Use these guides to move from local proof-of-concept to production-grade operation.

## Local proof flow

- Start stack
- Run conformance
- Replay-evaluate a real agreement
- Export and verify closepack

See [Quickstart](./quickstart.md).

## Build a paid capability

- Generate capability template
- Publish signed manifest
- Emit evidence correctly
- Set holdback/challenge-window settlement terms
- Validate with conformance

## Integrate with your existing backend

- Choose SDK (JS/Python) or raw API
- Map your lifecycle to agreement/evidence/decision stages
- Persist artifact IDs for audit and replay
- Add replay and closepack checks into operational workflows
- For MCP host wiring (Claude/Cursor/Codex/OpenClaw), see `../QUICKSTART_MCP_HOSTS.md`

## Operate disputes safely

- Require signer-bound dispute envelope for non-admin opens
- Enforce challenge window
- Prevent multiple active dispute conflicts
- Ensure verdict routes held funds via deterministic adjustment

## Release process

- run tests + conformance
- produce release checksums/artifacts
- include closepack verify evidence
- document regression and replay findings

## Deep-dive pages

- [Dispute lifecycle](./dispute-lifecycle.md)
- [Replay and audit](./replay-and-audit.md)
- [SDK usage](./sdk-reference.md)
- [Operations runbook](./operations-runbook.md)
