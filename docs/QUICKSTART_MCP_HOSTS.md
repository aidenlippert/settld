# Quickstart: MCP Host Integrations (Codex, Claude, Cursor, OpenClaw)

This guide is the fastest path to wire Settld into an agent host and confirm a first verified paid action.

Target outcome:

1. Host can call `settld.*` MCP tools.
2. Wallet mode is configured (`managed`, `byo`, or `none`).
3. Policy profile is applied.
4. Smoke call and first paid receipt are green.

For deeper tool-level examples, see `docs/QUICKSTART_MCP.md`.

## 1) Before you run `settld setup`

Required inputs:

- `SETTLD_BASE_URL` (local or hosted API URL)
- `SETTLD_TENANT_ID`
- one of:
  - `SETTLD_API_KEY` (`keyId.secret`), or
  - `SETTLD_BOOTSTRAP_API_KEY` (onboarding bootstrap key that mints `SETTLD_API_KEY` during setup)
- Node.js 20+

Recommended non-interactive pattern:

```bash
settld setup --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --settld-api-key 'sk_live_xxx.yyy' \
  --wallet-mode managed \
  --wallet-bootstrap remote \
  --profile-id engineering-spend \
  --smoke \
  --out-env ./.tmp/settld-openclaw.env
```

If you want setup to generate the tenant API key for you:

```bash
settld setup --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --bootstrap-api-key 'ml_admin_xxx' \
  --wallet-mode managed \
  --wallet-bootstrap remote \
  --profile-id engineering-spend \
  --smoke
```

If you want validation only (no config writes):

```bash
settld setup --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --settld-api-key 'sk_live_xxx.yyy' \
  --wallet-mode none \
  --preflight-only \
  --report-path ./.tmp/setup-preflight.json \
  --format json
```

## 2) Host setup flows

Unified setup command:

```bash
settld setup
```

The wizard handles:

- host selection (`codex|claude|cursor|openclaw`)
- wallet mode selection (`managed|byo|none`)
- preflight checks (API health, tenant auth, profile baseline, host config path)
- policy apply + optional smoke
- interactive menus with arrow keys (Up/Down + Enter) for choice steps

Host-specific non-interactive examples:

```bash
# Codex
settld setup --non-interactive --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke

# Claude
settld setup --non-interactive --host claude --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke

# Cursor
settld setup --non-interactive --host cursor --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke

# OpenClaw
settld setup --non-interactive --host openclaw --base-url http://127.0.0.1:3000 --tenant-id tenant_default --settld-api-key sk_live_xxx.yyy --wallet-mode none --profile-id engineering-spend --smoke
```

## 3) Wallet modes: managed vs BYO

### Managed (`--wallet-mode managed`)

Managed is the default and recommended first path.

`--wallet-bootstrap auto` behavior:

- If `--circle-api-key` (or `CIRCLE_API_KEY`) is present: local Circle bootstrap.
- If not present: remote onboarding bootstrap (`/v1/tenants/{tenantId}/onboarding/wallet-bootstrap`).

Force the path explicitly when needed:

```bash
# force remote wallet creation
settld setup --non-interactive --host openclaw --base-url https://api.settld.work --tenant-id tenant_default --settld-api-key 'sk_live_xxx.yyy' --wallet-mode managed --wallet-bootstrap remote --profile-id engineering-spend --smoke

# force local wallet creation with Circle credentials
settld setup --non-interactive --host openclaw --base-url https://api.settld.work --tenant-id tenant_default --settld-api-key 'sk_live_xxx.yyy' --wallet-mode managed --wallet-bootstrap local --circle-api-key 'TEST_API_KEY:...' --profile-id engineering-spend --smoke
```

### BYO (`--wallet-mode byo`)

Provide your own existing wallet values. Required keys:

- `CIRCLE_BASE_URL`
- `CIRCLE_BLOCKCHAIN`
- `CIRCLE_WALLET_ID_SPEND`
- `CIRCLE_WALLET_ID_ESCROW`
- `CIRCLE_TOKEN_ID_USDC`
- `CIRCLE_ENTITY_SECRET_HEX`

Pass as env or repeated `--wallet-env KEY=VALUE` flags:

```bash
settld setup --non-interactive \
  --host openclaw \
  --base-url https://api.settld.work \
  --tenant-id tenant_default \
  --settld-api-key 'sk_live_xxx.yyy' \
  --wallet-mode byo \
  --wallet-env CIRCLE_BASE_URL=https://api-sandbox.circle.com \
  --wallet-env CIRCLE_BLOCKCHAIN=BASE-SEPOLIA \
  --wallet-env CIRCLE_WALLET_ID_SPEND=wid_spend \
  --wallet-env CIRCLE_WALLET_ID_ESCROW=wid_escrow \
  --wallet-env CIRCLE_TOKEN_ID_USDC=token_usdc \
  --wallet-env CIRCLE_ENTITY_SECRET_HEX=$(openssl rand -hex 32) \
  --profile-id engineering-spend \
  --smoke
```

### None (`--wallet-mode none`)

Use this for policy/tooling setup without payment rails yet.

## 4) Activation after setup

`settld setup` writes host MCP config and prints `Combined exports`.

If you used `--out-env`, source it before running tools:

```bash
source ./.tmp/settld-openclaw.env
```

Then activate host-side:

- `codex`: restart Codex.
- `claude`: restart Claude Desktop.
- `cursor`: restart Cursor.
- `openclaw`: run `openclaw doctor`, ensure OpenClaw onboarding is complete (`openclaw onboard --install-daemon`), then run `openclaw tui`.

## 5) How the agent uses Settld after activation

After host activation, the agent interacts with Settld through MCP `settld.*` tools.

Typical flow:

1. Connectivity check: `settld.about`
2. Paid action: `settld.exa_search_paid` or `settld.weather_current_paid`
3. Policy gate + authorization happen server-side in Settld.
4. Settld records evidence/decision/receipt artifacts.
5. You can verify receipts offline (`settld x402 receipt verify`).

Quick local smoke:

```bash
npm run mcp:probe -- --call settld.about '{}'
```

First paid run + artifacts:

```bash
npm run demo:mcp-paid-exa
```

Verify first receipt from artifacts:

```bash
# replace <artifactDir> with the printed directory from demo output
settld x402 receipt verify <artifactDir>/x402-receipt.json --json-out /tmp/settld-first-receipt.json
```

## 6) Host config helper customization

Default host configuration logic is in:

- `scripts/setup/host-config.mjs`

If you need a custom resolver/writer, pass:

```bash
settld setup --host-config ./path/to/custom-host-config.mjs
```

Your helper should provide resolver/setup exports compatible with `scripts/setup/wizard.mjs`.

## 7) Troubleshooting

- `BYO wallet mode missing required env keys`
  - Provide all required Circle keys in section 3.
- `host config helper missing`
  - Add `scripts/setup/host-config.mjs` or pass `--host-config`.
- `SETTLD_API_KEY must be a non-empty string`
  - Ensure key is present in shell or setup flags.
- Host cannot run `npx`
  - Install Node.js 20+ and ensure `npx` is in `PATH`.
