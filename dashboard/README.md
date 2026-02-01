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

## Data sources

At runtime the UI tries, in order:

1) `dashboard/public/demo/index.json` + scenario fixtures:
   - `dashboard/public/demo/delivery/latest/*`
   - `dashboard/public/demo/finance/latest/*` (if generated)
2) legacy `dashboard/public/demo/latest/*.json` (kept for compatibility)
3) `dashboard/public/demo/sample/*.json` (checked-in minimal sample)
3) embedded fallback values
