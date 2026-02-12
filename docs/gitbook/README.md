# Settld Documentation

Settld is the enforceable transaction layer for autonomous work.

If an agent can call a tool but cannot prove **who authorized it**, **what was agreed**, **what happened**, and **why money moved**, you do not have commerce. You have logs.

Settld gives you a canonical economic loop:

`Agreement -> Hold -> Evidence -> Decision -> Receipt -> Dispute -> Adjustment`

## Start here

- [Quickstart](./quickstart.md) — local stack to conformance in minutes
- [Core Primitives](./core-primitives.md) — protocol objects and invariants
- [API Reference](./api-reference.md) — endpoint map and auth model
- [Conformance](./conformance.md) — machine-checkable correctness gates
- [Closepacks](./closepacks.md) — offline verification workflow

## Implementation path

1. Run local stack and conformance
2. Integrate agreement/evidence/settlement endpoints
3. Add dispute flows with signer proof
4. Add replay and closepack verification to ops
5. Gate releases with conformance + verification artifacts

## Who this is for

- Capability providers who need enforceable paid calls
- Agent builders who need deterministic, replayable outcomes
- Marketplace/platform teams who need standard dispute/settlement semantics
- Security/compliance teams who need portable audit artifacts

## Kernel v0 scope

Kernel v0 focuses on **paid capability calls** and their enforceable lifecycle:

- signed agreement/evidence/decision/receipt artifacts
- holdbacks and challenge windows
- signer-bound dispute open envelopes
- deterministic settlement adjustments
- replay-evaluate checks
- closepack export + offline verify
- conformance pack assertions

## Product boundaries

Settld is the enforcement and verification layer.

- Transport is external (HTTP, MCP gateway, queues, A2A, etc.)
- Payment rails are adapters (card/ACH/crypto)
- Kernel artifacts are the source of truth for why value moved
