# OperatorAction.v1

`OperatorAction.v1` is the canonical operator-evidence artifact used for high-risk control actions.

It captures who acted, which case was affected, what action was taken, and why. The signed form binds this surface to an Ed25519 signature for offline verification.

## Purpose

`OperatorAction.v1` enables:

- deterministic replay/audit of emergency operator decisions,
- hash-based tamper detection over a frozen action surface,
- stable verification codes for schema/key/hash/signature failures.

## Emergency RBAC + dual-control policy

For `/ops/emergency/*` actions, `OperatorAction.v1` is evaluated against runtime authorization policy:

- Role matrix:
  - `pause|quarantine`: `oncall|ops_admin|incident_commander`
  - `revoke|kill-switch`: `ops_admin|incident_commander`
  - `resume`: follows the strictest targeted control class (`ops_admin|incident_commander` when resuming `revoke|kill-switch`)
- Dual-control:
  - `revoke|kill-switch` class actions require both `operatorAction` and `secondOperatorAction`.
  - The two approvals must be from distinct `actor.operatorId` and distinct `signature.keyId`.
  - Missing or non-distinct second approvals fail closed.

## Required fields

- `schemaVersion` (const: `OperatorAction.v1`)
- `caseRef`
  - `kind` (`challenge|dispute|escalation`)
  - `caseId`
- `action` (`APPROVE|REJECT|REQUEST_INFO|OVERRIDE_ALLOW|OVERRIDE_DENY`)
- `justificationCode` (uppercase machine token)
- `actor`
  - `operatorId`
- `actedAt` (ISO 8601 date-time)

Optional:

- `actionId`
- `justification`
- `actor.role` (lowercase token)
- `actor.tenantId`
- `actor.sessionId`
- `actor.metadata`
- `metadata`
- `signature`
  - `schemaVersion` (const: `OperatorActionSignature.v1`)
  - `algorithm` (const: `ed25519`)
  - `keyId`
  - `signedAt` (ISO 8601 date-time)
  - `actionHash` (`sha256` hex)
  - `signatureBase64`

Optional fields MUST be omitted when absent (not `null`) unless explicitly allowed by schema.

## Canonicalization + hashing

`actionHash` is computed over canonical JSON (RFC 8785 / JCS) of the unsigned `OperatorAction.v1` object.

Hash algorithm: `sha256` over canonical UTF-8 bytes, lowercase hex output.

`actionHash` is carried inside `signature.actionHash` in the signed envelope.

## Signing and verification

Signing (`signOperatorActionV1`) attaches a `signature` object and signs `actionHash` using Ed25519.

Verification (`verifyOperatorActionV1`) enforces:

1. `action.schemaVersion === OperatorAction.v1`,
2. `action.signature.schemaVersion === OperatorActionSignature.v1`,
3. `signature.keyId` matches the expected public key id,
4. `signature.actionHash` equals recomputed hash,
5. Ed25519 signature verification succeeds.

Failures return stable codes such as:

- `OPERATOR_ACTION_SCHEMA_MISMATCH`
- `OPERATOR_ACTION_SIGNATURE_SCHEMA_MISMATCH`
- `OPERATOR_ACTION_KEY_ID_MISMATCH`
- `OPERATOR_ACTION_HASH_MISMATCH`
- `OPERATOR_ACTION_SIGNATURE_INVALID`
- `OPERATOR_ACTION_SCHEMA_INVALID`

## Schema

See `docs/spec/schemas/OperatorAction.v1.schema.json`.
