# API Reference

This page is the integration map. For endpoint-level schema details, use the generated OpenAPI reference.

## OpenAPI source of truth

- `openapi/settld.openapi.json`

## Auth model

Operator endpoints use scoped ops headers.

Common headers:

- `x-proxy-ops-token: <token>`
- `x-proxy-tenant-id: <tenantId>` (when required)

## Endpoint groups

## Platform

- `GET /healthz`

## Kernel lifecycle

Representative groups include:

- agreement/hold/evidence/settlement operations
- dispute open and verdict application
- replay-evaluate endpoints
- closepack export/verify endpoints

## Billing and plans

Representative endpoints:

- `GET /ops/finance/billing/plan`
- `POST /ops/finance/billing/providers/stripe/checkout`
- `POST /ops/finance/billing/providers/stripe/portal`

## Dashboard and API keys

Representative endpoints:

- `GET /api/dashboard/api-keys`
- `POST /api/dashboard/api-keys`
- `POST /api/dashboard/api-keys/:id/rotate`
- `POST /api/dashboard/api-keys/:id/revoke`

## Practical flow pattern

1. Create agreement + hold context
2. Submit evidence
3. Trigger settlement
4. Fetch resulting artifacts
5. Replay-evaluate
6. Export closepack for third-party verification

## cURL example

```bash
curl -s "http://127.0.0.1:3000/ops/tool-calls/replay-evaluate?agreementHash=<agreementHash>" \
  -H "x-proxy-ops-token: tok_ops"
```

## SDK alternatives

- JavaScript SDK: `packages/api-sdk`
- Python SDK: `packages/api-sdk-python`

## Recommendation

Expose generated OpenAPI pages in GitBook using the OpenAPI import feature and keep this page as architectural orientation.
