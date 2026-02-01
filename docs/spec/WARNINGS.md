# Verification warnings

Warnings are protocol objects, not strings.

## Shape

Each warning is a canonical JSON object:

- `code` (required, closed set)
- `message` (optional, string or null)
- `detail` (optional, any JSON)

Warnings are normalized (deduped + sorted) before being emitted in verification reports.

## Codes (closed set)

- `LEGACY_KEYS_FORMAT_USED`
- `NONSERVER_REVOCATION_NOT_ENFORCED`
- `MISSING_GOVERNANCE_SNAPSHOT_LENIENT`
- `UNSIGNED_REPORT_LENIENT`
- `TOOL_VERSION_UNKNOWN`

