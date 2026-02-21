# Trust OS v1 Sprint 01 PR Starters

Use these as starter branch names and PR titles for Sprint 01 committed tickets.

Base branch recommendation: `feat/prod-cutover-gate`
Branch prefix rule: `codex/`

## Ticket PR starters

1. `NOO-43`
- Branch: `codex/noo-43-policydecision-schema-signing`
- PR title: `NOO-43 define and implement PolicyDecision.v1 schema + signing`

2. `NOO-45`
- Branch: `codex/noo-45-normalize-reason-codes-policy-fingerprints`
- PR title: `NOO-45 normalize reason codes and policy fingerprinting across runtimes`

3. `NOO-44`
- Branch: `codex/noo-44-enforce-trust-middleware-high-risk-routes`
- PR title: `NOO-44 enforce trust-kernel middleware on all high-risk routes`

4. `NOO-47`
- Branch: `codex/noo-47-enforce-executionintent-fingerprint-binding`
- PR title: `NOO-47 enforce ExecutionIntent request fingerprint binding across authorize+execute`

5. `NOO-48`
- Branch: `codex/noo-48-replay-mutation-deterministic-denials`
- PR title: `NOO-48 implement replay and mutation deterministic denial paths`

6. `NOO-46`
- Branch: `codex/noo-46-host-bridge-bypass-regression-suite`
- PR title: `NOO-46 add MCP and host bridge bypass regression suite`

7. `NOO-50`
- Branch: `codex/noo-50-offline-verify-parity-gate`
- PR title: `NOO-50 add offline verification parity gate for receipt bundles`

8. `NOO-55`
- Branch: `codex/noo-55-operatoraction-schema-signature-verification`
- PR title: `NOO-55 define OperatorAction.v1 schema and signature verification`

9. `NOO-57`
- Branch: `codex/noo-57-emergency-control-apis`
- PR title: `NOO-57 implement emergency control APIs (pause/quarantine/revoke/kill-switch)`

10. `NOO-62`
- Branch: `codex/noo-62-hosted-baseline-evidence-packet`
- PR title: `NOO-62 publish hosted baseline evidence packet per release candidate`

## PR body snippet (copy into description)

```md
Closes NOO-###

## What Changed
- ...

## Why
- ...

## Test Plan
- [ ] npm test
- [ ] targeted tests: ...

## Evidence
- ...
```
