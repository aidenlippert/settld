# FinancePackBundleManifest.v1

This manifest is stored at `manifest.json` within FinancePack bundles.

## Hashing contract

- `hashing.schemaVersion = "FinancePackBundleManifestHash.v1"`
- file order: `path_asc`
- excludes: `["verify/**"]`

Rationale: `verify/verification_report.json` must reference `manifestHash`, so including `verify/**` in the manifest would create circular hashing.

## manifestHash

`manifestHash = sha256_hex( canonical_json_stringify(manifest_without_hash) )`

## File entries

`files[]` entries include:

- `name` (path relative to FinancePack bundle root)
- `sha256` (hex sha256 of raw file bytes)
- `bytes` (byte length)

