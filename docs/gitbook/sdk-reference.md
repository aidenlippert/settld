# SDK Reference

Settld provides JavaScript and Python SDKs to reduce raw-HTTP integration overhead.

## JavaScript SDK

Path: `packages/api-sdk`

Typical workflow methods:

- create/submit lifecycle requests
- fetch artifacts and replay checks
- dispute operations and status reads
- reputation fact queries

## Python SDK

Path: `packages/api-sdk-python`

Typical workflow methods mirror JS flow:

- settlement lifecycle calls
- dispute flow operations
- replay checks
- reputation reads

## Integration pattern

1. Keep artifact IDs in your own datastore.
2. Treat settlement artifacts as first-class business records.
3. Use replay + closepack verification for sensitive incident paths.

## Versioning

Keep SDK versions aligned with protocol/object compatibility requirements for your deployment window.
