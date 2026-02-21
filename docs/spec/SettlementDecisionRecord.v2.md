# SettlementDecisionRecord.v2

`SettlementDecisionRecord.v2` is the canonical decision artifact for an `AgentRunSettlement.v1` state transition.

It is identical in semantic intent to `SettlementDecisionRecord.v1`, but adds **replay-critical policy pinning** so decisions can be re-evaluated deterministically from protocol artifacts alone.

## Purpose

- make settlement decisions replayable and attributable;
- bind payout/refund decisions to specific run/settlement lineage;
- provide a stable hash (`decisionHash`) for downstream receipt binding;
- pin the **exact policy hash used** during evaluation (`policyHashUsed`).

## Required fields

- `schemaVersion` (const: `SettlementDecisionRecord.v2`)
- all required fields from `SettlementDecisionRecord.v1`
- `policyHashUsed` (sha256 hex, lowercase)

Optional fields:

- all optional fields from `SettlementDecisionRecord.v1`
- `policyNormalizationVersion` (string; OPTIONAL; v2 emitters SHOULD include this to pin the normalization algorithm used to compute `policyHashUsed`)
- `profileHashUsed` (sha256 hex, lowercase; OPTIONAL; emit when an authorization/policy profile fingerprint is available, for example `bindings.spendAuthorization.policyFingerprint`)
- `verificationMethodHashUsed` (sha256 hex, lowercase; OPTIONAL; omit when absent)
- `bindings` (object; OPTIONAL) - settlement receipt trail bindings for gateway-style flows:
  - `authorizationRef`
  - `token` (`kid`, `sha256`, `expiresAt`)
  - `request` (`sha256`)
  - `response` (`status`, `sha256`)
  - `providerSig` (`required`, `present`, `verified`, `providerKeyId`, `error`)
  - `reserve` (`adapter`, `mode`, `reserveId`, `status`)
  - `policyDecisionFingerprint` (`fingerprintVersion`, `policyId`, `policyVersion`, `policyHash`, `verificationMethodHash`, `evaluationHash`)

## Policy pinning rules

- `policyHashUsed` MUST be the hash of the normalized policy object actually evaluated.
- If the evaluated policy is carried inline (for example, in an agreement payload), `policyHashUsed` MUST match the normalized inline policy payload.
- If the policy is resolved from a policy registry, `policyHashUsed` MUST match the policy payload referenced by the registry entry.
- `profileHashUsed`, when present, MUST be the hash of the concrete profile/fingerprint material used to authorize or constrain policy evaluation for this decision.
- `verificationMethodHashUsed` SHOULD be set when verifier selection depends on an explicit verification method payload.

## Canonicalization and hashing

`decisionHash` is computed over canonical JSON after removing `decisionHash` from the object:

1. canonicalize JSON with RFC 8785 (JCS),
2. hash canonical UTF-8 bytes using `sha256`,
3. encode as lowercase hex.

## Schema

See `schemas/SettlementDecisionRecord.v2.schema.json`.
