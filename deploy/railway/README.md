# Railway Deployment

Use Railway for the backend services only.

- `nooterra.ai` and `www.nooterra.ai` should stay on Vercel.
- `api.nooterra.ai` should point to the Railway API service.
- `nooterra-magic-link` should stay private to Railway and be reached from the API over private networking.

## Services

Create separate services from this repo and set the Dockerfile path per service.

1. API

- Service name: `nooterra-api`
- Dockerfile path: `deploy/railway/Dockerfile.api`
- Public domain: `api.nooterra.ai`
- Health endpoint: `GET /healthz`

2. Maintenance worker

- Service name: `nooterra-maintenance`
- Dockerfile path: `deploy/railway/Dockerfile.maintenance`
- No public networking
- No healthcheck path

3. Magic-link

- Service name: `nooterra-magic-link`
- Dockerfile path: `deploy/railway/Dockerfile.magic-link`
- Mount a Railway volume at `/data`
- Keep it private to Railway
- Health endpoint: `GET /healthz`

## API variables

Set on `nooterra-api`:

- `NODE_ENV=production`
- `PORT=3000`
- `STORE=pg`
- `DATABASE_URL=...`
- `PROXY_ONBOARDING_BASE_URL=http://nooterra-magic-link.railway.internal:8787`
- `PROXY_CORS_ALLOW_ORIGINS=https://nooterra.ai,https://www.nooterra.ai,https://nooterra-website.vercel.app`
- `PROXY_AUTOTICK=1`
- `PROXY_OPS_TOKEN=...`
- `PROXY_INGEST_TOKEN=...`

Recommended controls for beta:

- `PROXY_RATE_LIMIT_RPM`
- `PROXY_RATE_LIMIT_BURST`
- `PROXY_RATE_LIMIT_PER_KEY_RPM`
- `PROXY_RATE_LIMIT_PER_KEY_BURST`

## Magic-link variables

Set on `nooterra-magic-link`:

- `NODE_ENV=production`
- `MAGIC_LINK_HOST=0.0.0.0`
- `MAGIC_LINK_PORT=8787`
- `MAGIC_LINK_DATA_DIR=/data`
- `MAGIC_LINK_REQUIRE_DURABLE_DATA_DIR=1`
- `MAGIC_LINK_API_KEY=...`
- `MAGIC_LINK_SETTINGS_KEY_HEX=...`
- `MAGIC_LINK_PUBLIC_SIGNUP_ENABLED=1`
- `MAGIC_LINK_BUYER_OTP_DELIVERY_MODE=resend`
- `MAGIC_LINK_RESEND_API_KEY=...`
- `MAGIC_LINK_RESEND_FROM=...`
- `MAGIC_LINK_NOOTERRA_API_BASE_URL=http://nooterra-api.railway.internal:3000`
- `MAGIC_LINK_NOOTERRA_OPS_TOKEN=...`
- `MAGIC_LINK_NOOTERRA_PROTOCOL=1.0`

Optional:

- `MAGIC_LINK_DECISION_OTP_DELIVERY_MODE=resend`

## Maintenance variables

Set on `nooterra-maintenance`:

- `NODE_ENV=production`
- `DATABASE_URL=...`
- `PROXY_MAINTENANCE_INTERVAL_SECONDS=300`

## Frontend variables

Set on the Vercel project:

- `VITE_NOOTERRA_API_BASE_URL=https://api.nooterra.ai`
- `VITE_NOOTERRA_AUTH_BASE_URL=https://api.nooterra.ai`

## Post-deploy validation

Run against the hosted API:

```sh
npm run -s ops:hosted-baseline:evidence -- \
  --base-url https://api.nooterra.ai \
  --tenant-id tenant_default \
  --ops-token "$PROXY_OPS_TOKEN" \
  --environment production \
  --out ./artifacts/ops/hosted-baseline-evidence-railway.json
```

Then run local CLI against hosted API:

```sh
nooterra agent status --agent-id <agent_id> --base-url https://api.nooterra.ai --ops-token "$PROXY_OPS_TOKEN"
```

## Reference

For full hosted controls and evidence expectations:

- `docs/ops/HOSTED_BASELINE_R2.md`
