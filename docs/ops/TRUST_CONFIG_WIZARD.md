# Trust Config Wizard

Use this when you want to create an SLA policy config from a template.

## Fastest path for onboarding

If you want a ready starter policy during host setup, run:

```bash
settld setup --yes --mode manual --host codex --base-url http://127.0.0.1:3000 --tenant-id tenant_default --api-key sk_live_xxx.yyy --profile-id engineering-spend --smoke
```

This sets up host MCP config and applies a starter policy profile in one run.

## New policy wizard flow (template-based)

1. List templates:

```bash
npm run trust:wizard -- list --format text
```

2. Preview one template:

```bash
npm run trust:wizard -- show --template delivery_standard_v1 --format text
```

3. Render a policy config file:

```bash
npm run trust:wizard -- render --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --out ./policy.delivery.json --format json
```

4. Validate the same overrides:

```bash
npm run trust:wizard -- validate --template delivery_standard_v1 --overrides-json '{"metrics":{"targetCompletionMinutes":60}}' --format json
```

Supported commands:

- `list [--vertical delivery|security] [--format json|text]`
- `show --template <templateId> [--format json|text]`
- `render --template <templateId> [--overrides-json <json>] [--out <path>] [--format json|text]`
- `validate --template <templateId> [--overrides-json <json>] [--format json|text]`

## API endpoint

- `GET /ops/sla-templates`
  - Scope: `ops_read`
  - Optional query: `vertical=delivery|security`
  - Response: `SlaPolicyTemplateCatalog.v1`

Example:

```bash
curl -sS "http://localhost:3000/ops/sla-templates?vertical=security" \
  -H "x-proxy-ops-token: <ops_read_token>" | jq
```
