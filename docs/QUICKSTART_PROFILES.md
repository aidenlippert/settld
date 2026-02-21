# Quickstart: Profiles CLI

Goal: scaffold, validate, and simulate a policy profile with the Settld CLI.

## Prerequisites

- Node.js 20+
- Repo checkout with dependencies installed (`npm ci`)

## 0) One-command runtime setup (recommended before `profile apply`)

Non-interactive setup (manual mode):

```bash
./bin/settld.js setup --yes --mode manual --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_runtime_apply --profile-id engineering-spend
```

Bootstrap mode (same flow, runtime key minted by onboarding endpoint):

```bash
./bin/settld.js setup --yes --mode bootstrap --host codex --base-url https://api.settld.work --tenant-id tenant_default --bootstrap-api-key mlk_admin_xxx --bootstrap-key-id sk_runtime --bootstrap-scopes runs:read,runs:write --idempotency-key profile_setup_bootstrap_1
```

If you only want runtime env + host wiring (without applying a profile), add:

```bash
--skip-profile-apply
```

To verify MCP wiring immediately during setup, add:

```bash
--smoke
```

Single command that loads setup exports and applies a profile:

```bash
eval "$(./bin/settld.js setup --yes --mode manual --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_runtime_apply | grep '^export ')" && ./bin/settld.js profile apply ./profiles/engineering-spend.profile.json --format json
```

## 1) List available starter profiles

Installed CLI:

```bash
npx settld profile list
```

Repo checkout:

```bash
./bin/settld.js profile list
```

Example output:

```text
engineering-spend	engineering	Engineering Spend
procurement	procurement	Procurement
data-api-buyer	data	Data API Buyer
```

## 2) Initialize a profile

Installed CLI:

```bash
npx settld profile init engineering-spend --out ./profiles/engineering-spend.profile.json
```

Repo checkout:

```bash
./bin/settld.js profile init engineering-spend --out ./profiles/engineering-spend.profile.json
```

Example output:

```text
ok	engineering-spend	/home/you/repo/profiles/engineering-spend
```

## 3) Validate profile schema + semantics

Installed CLI:

```bash
npx settld profile validate ./profiles/engineering-spend.profile.json --format json
```

Repo checkout:

```bash
./bin/settld.js profile validate ./profiles/engineering-spend.profile.json --format json
```

Example output:

```json
{
  "schemaVersion": "SettldProfileValidationReport.v1",
  "ok": true,
  "profileId": "engineering-spend",
  "errors": [],
  "warnings": []
}
```

## 4) Simulate policy decisions

Installed CLI:

```bash
npx settld profile simulate ./profiles/engineering-spend.profile.json --format json
```

Repo checkout:

```bash
./bin/settld.js profile simulate ./profiles/engineering-spend.profile.json --format json
```

Example output:

```json
{
  "schemaVersion": "SettldProfileSimulationReport.v1",
  "ok": true,
  "profileId": "engineering-spend",
  "decision": "allow",
  "requiredApprovers": 0,
  "approvalsProvided": 0,
  "selectedApprovalTier": "auto",
  "reasons": []
}
```

To simulate with explicit scenario data:

```bash
./bin/settld.js profile simulate ./profiles/engineering-spend.profile.json --scenario ./test/fixtures/profile/scenario-allow.json --format json
```

## 5) Apply profile to runtime

Set runtime connection/auth values:

```bash
export SETTLD_BASE_URL=http://127.0.0.1:3000
export SETTLD_TENANT_ID=tenant_default
export SETTLD_API_KEY=sk_runtime_apply
# optional override:
export SETTLD_SPONSOR_WALLET_REF=wallet_ops_default
```

Dry-run first (no live writes):

```bash
./bin/settld.js profile apply ./profiles/engineering-spend.profile.json --dry-run --format json
```

Then execute live apply:

```bash
./bin/settld.js profile apply ./profiles/engineering-spend.profile.json --format json
```

`profile apply` also accepts runtime-prefixed aliases:
`SETTLD_RUNTIME_BASE_URL`, `SETTLD_RUNTIME_TENANT_ID`, `SETTLD_RUNTIME_BEARER_TOKEN`.

## Common troubleshooting

- `unknown profile`: run `settld profile list` and use one of the listed IDs.
- `validation failed`: fix reported schema/semantic errors, then rerun `profile validate`.
- `scenario file not found`: pass an existing JSON scenario path to `profile simulate`.
- `profile apply missing runtime config`: set runtime base URL, tenant ID, bearer token, and wallet ref before running live apply.
