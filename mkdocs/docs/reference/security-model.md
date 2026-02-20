# Security Model

## Controls

- Quote and evidence signature verification
- Request/quote-bound authorization constraints
- Replay prevention with one-time tokens and nonce checks
- Signed escalation decisions and auditable override lineage
- Offline verification against exported evidence bundles

## Operational Security

- Rotate secrets with overlap windows
- Verify all webhooks with timestamp tolerance + timing-safe compare
- Preserve historical keys needed for long-term verification
- Fail closed when verification requirements are unmet
