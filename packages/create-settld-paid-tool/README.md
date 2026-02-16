# create-settld-paid-tool

Scaffold a paid HTTP/MCP-compatible tool server powered by `@settld/provider-kit`.

## Usage

```bash
npx create-settld-paid-tool my-paid-tool
```

Or with explicit provider id:

```bash
npx create-settld-paid-tool my-paid-tool --provider-id prov_example_1
```

## What it creates

- `server.mjs` paid tool server (`402` challenge + offline SettldPay verify + provider signatures)
- `.env.example` runtime config template
- `package.json` starter with `npm start`
- `README.md` usage notes

## Local (repo) usage

```bash
node scripts/scaffold/create-settld-paid-tool.mjs my-paid-tool
```
