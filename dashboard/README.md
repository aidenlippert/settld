# Settld Demo Dashboard

This is a small React/Vite/Tailwind UI that turns the repo demos into a
**clickable command center** (scenario picker + truth strip + replay + artifacts).

## Run (local)

1) Generate fresh Settld demo outputs:

```bash
npm run demo:delivery
```

Optional (enables the Finance Pack scenario in the UI):

```bash
npm run pilot:finance-pack
```

2) Export the generated JSON into the dashboard’s static fixture folder:

```bash
npm run demo:ui:prep
```

3) Install UI deps and start the dev server:

```bash
cd dashboard
npm install
npm run dev
```

Or from repo root (after installing deps in `dashboard/`):

```bash
npm run demo:ui
```

By default the UI runs on `http://127.0.0.1:5173` (so it doesn’t conflict with the Settld API on port 3000).

## Operator Inbox

The escalation operator surface is available at:

- `http://127.0.0.1:5173/operator`

It uses live API calls to:

- `GET /x402/gate/escalations`
- `GET /x402/gate/escalations/:id`
- `POST /x402/gate/escalations/:id/resolve`

Configure API base URL, tenant, protocol, and bearer key in the page header.

For local dev, default API base URL is `"/__settld"` which is proxied by Vite to `http://127.0.0.1:3000`.
This avoids browser CORS issues between ports `5173` and `3000`.

## Site Auth (Auth0 primary)

Website auth is production-first via Auth0:

- `VITE_AUTH0_DOMAIN`
- `VITE_AUTH0_CLIENT_ID`
- `VITE_AUTH0_AUDIENCE` (optional, recommended for API access tokens)
- `VITE_SETTLD_API_BASE_URL` (for `/operator`, example `https://api.settld.work`)

In Auth0 application settings, use your real domains:

- Allowed Callback URLs: `https://settld.work/app`
- Allowed Logout URLs: `https://settld.work`
- Allowed Web Origins: `https://settld.work`

Legacy OTP auth fallback still exists (for private environments / self-hosted auth service):

- `VITE_SETTLD_AUTH_BASE_URL`
- `VITE_SETTLD_AUTH_TENANT_ID`
- `POST /v1/public/signup`
- `POST /v1/tenants/:tenantId/buyer/login/otp`
- `POST /v1/tenants/:tenantId/buyer/login`
- `GET /v1/buyer/me`
- `POST /v1/buyer/logout`
- `GET/POST /v1/tenants/:tenantId/buyer/users`

## Data sources

At runtime the UI tries, in order:

1) `dashboard/public/demo/index.json` + scenario fixtures:
   - `dashboard/public/demo/delivery/latest/*`
   - `dashboard/public/demo/finance/latest/*` (if generated)
2) legacy `dashboard/public/demo/latest/*.json` (kept for compatibility)
3) `dashboard/public/demo/sample/*.json` (checked-in minimal sample)
3) embedded fallback values
