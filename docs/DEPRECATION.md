# Deprecation Policy

Settld is infrastructure. We don’t break integrators casually.

## Protocol versions (`x-settld-protocol`)

- Format: `major.minor` (example: `1.0`)
- Server advertises:
  - `x-settld-protocol` (current)
  - `x-settld-supported-protocols` (comma-separated)

### Minimum windows

- Breaking change requires a protocol bump.
- Deprecated protocol versions remain supported for **at least 6 months**, except for urgent security fixes.

### Enforcing deprecation cutoffs

If configured, the server rejects deprecated versions past cutoff via `PROXY_PROTOCOL_DEPRECATIONS` and reason code `PROTOCOL_DEPRECATED`.

## APIs

When an API family is deprecated:
- it will be called out in `CHANGELOG.md`
- it may emit a warning header in non-test mode
- it will have a published replacement

Current split:
- Legacy contracts: `/ops/contracts` (mutable policy upsert; back-compat)
- Contracts v2: `/ops/contracts-v2` (contracts-as-code; hash-addressed + compiled)

