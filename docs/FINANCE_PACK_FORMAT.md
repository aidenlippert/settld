# FinancePackBundle.v1 Format (Finance-Grade)

This document defines the on-disk format for `FinancePackBundle.v1` and its strict-verification invariants.

## Directory Layout

```
settld.json
manifest.json
month/...
finance/...
verify/verification_report.json
```

Notes:
- `month/` is a full embedded `MonthProofBundle.v1` directory tree.
- `verify/verification_report.json` is a signed, machine-ingestible `VerificationReport.v1`.

## `manifest.json` (FinancePackBundleManifest.v1)

`manifest.json` includes:
- `files[]`: sha256 hashes for the **non-verify** bundle files
- `manifestHash`: sha256 over canonical JSON of the manifest object **excluding** `manifestHash`

### Hashing Contract (`hashing.schemaVersion = FinancePackBundleManifestHash.v1`)

- `fileOrder = path_asc`
- `excludes = ["verify/**"]` (all `verify/*` derived outputs are intentionally excluded)

Rationale: `VerificationReport.v1` needs to refer to `manifestHash`, so including `verify/*` in the manifest would create circular hashing.

## `verify/verification_report.json` (VerificationReport.v1)

`VerificationReport.v1` is canonical JSON with:
- `tool`: identifies the generator/verifier version for auditability
- `signer`: provenance for the report signer (including governance event ref when available)
- `subject.manifestHash`: must equal the bundle `manifestHash`
- `reportHash`: sha256 over canonical JSON of the report core (excluding signature fields)
- `signature`: Ed25519 signature over `reportHash`

Strict verification requires the report to be present **and signed**.

If the tool version cannot be determined, the report will include a warning code `TOOL_VERSION_UNKNOWN`.

## Strict Verification Invariants

In strict mode (`settld-verify --strict --finance-pack ...`):
- The embedded `MonthProofBundle.v1` must strictly verify.
- `verify/verification_report.json` must exist, have a valid `reportHash`, and have a valid signature.
- `VerificationReport.v1.subject.manifestHash` must match the computed bundle `manifestHash`.
