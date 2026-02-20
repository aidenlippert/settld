# Control Plane

Settld composes five layers:

1. **Identity and Delegation**
2. **Policy and Authorization**
3. **Execution and Settlement**
4. **Evidence and Verification**
5. **Lifecycle and Operations**

Each layer emits artifacts consumed by the next layer. No layer may bypass upstream integrity checks.

## Core Invariants

- No settlement without verification checks.
- No mutable receipt history.
- No override without signed escalation decision.
- No stranded liabilities after insolvency.
