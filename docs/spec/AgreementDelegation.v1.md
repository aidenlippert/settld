# AgreementDelegation.v1

`AgreementDelegation.v1` defines a deterministic, hash-addressable link between a **parent agreement** and a **child agreement** created via delegation in a multi-hop agent chain.

It exists to make compositional settlement possible:

- prove parent -> child provenance without database traversal,
- enforce delegation depth limits (prevent unbounded chains),
- carry a budget cap for the child agreement derived from the parent.

## Schema

See `schemas/AgreementDelegation.v1.schema.json`.

## Canonicalization and hashing

When computing `delegationHash`:

- canonicalize JSON via RFC 8785 (JCS),
- hash canonical UTF-8 bytes via `sha256`,
- represent as lowercase hex.

`delegationHash` is computed over the immutable core fields and intentionally excludes mutable lifecycle fields:

Excluded fields:
- `delegationHash`
- `status`
- `resolvedAt`
- `updatedAt`
- `revision`
- `metadata`

## Required fields

- `schemaVersion` (const: `AgreementDelegation.v1`)
- `delegationId` (stable identifier, not derived from hash)
- `tenantId`
- `parentAgreementHash` (sha256 hex)
- `childAgreementHash` (sha256 hex)
- `delegatorAgentId` (agent that created/authorized the delegation)
- `delegateeAgentId` (agent that received the delegation authority)
- `budgetCapCents` (positive integer)
- `currency`
- `delegationDepth` (non-negative integer; depth of the child agreement relative to the root)
- `maxDelegationDepth` (non-negative integer)
- `createdAt` (ISO date-time)
- `delegationHash` (sha256 hex of immutable core)
- `status` (`active` | `settled` | `revoked`)
- `revision` (non-negative integer)
- `updatedAt` (ISO date-time)

## Optional fields

- `ancestorChain` (ordered array of sha256 hex agreement hashes; enables offline audit without traversal)
- `resolvedAt` (ISO date-time, set when `status` transitions out of `active`)
- `metadata` (free-form object; non-normative)

## Invariants

Implementations MUST enforce:

- `budgetCapCents > 0`
- `delegationDepth <= maxDelegationDepth`
- `parentAgreementHash != childAgreementHash`

If `ancestorChain` is provided, implementations MUST enforce:

- `ancestorChain.length == delegationDepth`
- `ancestorChain[ancestorChain.length - 1] == parentAgreementHash`
- no duplicates in `ancestorChain` (cycle defense)

Budget-capping is compositional:

- The caller/system that creates a child delegation MUST ensure `budgetCapCents` is <= the parent agreement's **remaining** budget at creation time.

## Deterministic pre-check failure codes

Some API workflows may bind settlement to a delegation graph and run deterministic pre-checks before a release/refund decision.

When those checks fail, implementations SHOULD return a stable `code` that is suitable for programmatic handling:

- `AGREEMENT_DELEGATION_CYCLE` — A cycle was detected in the parent-chain for the bound agreement.
- `AGREEMENT_DELEGATION_MULTIPLE_PARENTS` — Multiple parents were found for the same `childAgreementHash` (graph is not a function).

## Lifecycle semantics

`AgreementDelegation.v1` is intended to be created as `status=active` and later resolved:

- `status=settled`: child agreement has been settled and no further delegation actions should be taken.
- `status=revoked`: delegation authority is revoked (for example emergency revoke).

Status transitions mutate only lifecycle fields and MUST NOT change `delegationHash`.
