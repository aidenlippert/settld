# Local Environment

## Required Inputs

- Tenant ID
- Ops token
- API base URL
- Optional Auth0 values for operator auth surfaces

## Recommended Local Checks

```bash
npm test
npm run test:ops:go-live-gate
npx settld conformance kernel --ops-token tok_ops
```

## Configuration Principles

- Fail closed by default in production-like environments
- Keep key and policy material tenant-scoped
- Treat exports as reconciliation source-of-truth
