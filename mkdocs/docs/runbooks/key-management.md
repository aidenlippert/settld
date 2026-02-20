# Key Management

## Key Classes

- Identity/delegation keys
- Provider verification keys
- Webhook signing secrets

## Rotation Rules

- Rotate with overlap windows.
- Maintain previous key acceptance for safe transition windows.
- Record key IDs and effective intervals in audit logs.
- Never destroy keys needed for historical receipt verification.
