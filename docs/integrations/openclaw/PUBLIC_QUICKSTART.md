# OpenClaw Public Quickstart (No Repo Clone)

Use this when you want a public user to set up Settld from npm in a fresh machine.

## 1) Install and onboard OpenClaw

Follow OpenClaw docs:

- https://docs.openclaw.ai/install/index
- https://docs.openclaw.ai/start/wizard

Then run onboarding:

```bash
openclaw onboard --install-daemon
openclaw doctor
```

If `openclaw` is not on PATH yet, use the npx fallback:

```bash
npx -y openclaw@latest onboard --install-daemon
```

## 2) Run Settld setup from npm

Interactive path (recommended):

```bash
npx -y settld@latest setup
```

Choose:

1. `host`: `openclaw`
2. wallet mode (`managed` recommended first)
3. wallet bootstrap (`remote` recommended for first setup)
4. keep preflight + smoke enabled
5. apply a starter profile (`engineering-spend`)

Non-interactive path (automation/support):

```bash
npx -y settld@latest setup \
  --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --settld-api-key 'sk_live_xxx.yyy' \
  --wallet-mode managed \
  --wallet-bootstrap remote \
  --profile-id engineering-spend \
  --smoke
```

If you do not have a tenant `sk_*` yet, let setup mint one:

```bash
npx -y settld@latest setup \
  --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --bootstrap-api-key 'ml_admin_xxx' \
  --wallet-mode managed \
  --wallet-bootstrap remote
```

## 3) Verify OpenClaw + Settld are wired

Run:

```bash
openclaw doctor
```

Then from OpenClaw chat/test prompt:

- `Call settld.about and return JSON.`

Expected result: success payload with Settld tool metadata.

## 4) Run first paid tool call

From OpenClaw prompt:

- `Run settld.weather_current_paid for city=Chicago unit=f and include x-settld-* headers in the response.`

Expected result:

- tool call succeeds
- response includes policy/decision/settlement headers (`x-settld-*`)

## 5) Verify receipt artifact (when available)

If you exported a receipt JSON from your Settld environment, verify it offline:

```bash
npx -y settld@latest x402 receipt verify ./receipt.json --format json
```

## Notes for operators

- Public users do not need to clone the Settld repo.
- Public path is valid only after publishing a package version that includes the current setup flow.
- For OpenClaw skill packaging and publish flow, see:
  - `docs/integrations/openclaw/settld-mcp-skill/SKILL.md`
  - `docs/integrations/openclaw/CLAWHUB_PUBLISH_CHECKLIST.md`
