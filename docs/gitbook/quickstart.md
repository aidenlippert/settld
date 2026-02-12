# Quickstart

Get from zero to a verified Kernel v0 flow in minutes.

## Prerequisites

- Node.js 20+
- Docker Desktop / Docker Engine running
- `jq` installed (recommended for local checks)

## 1) Start local stack

Installed CLI:

```bash
npx settld dev up
```

Repo checkout:

```bash
./bin/settld.js dev up
```

Expected:

- API healthy on local URL
- local ops token available (`tok_ops` in default dev path)

## 2) Create a capability template

Installed CLI:

```bash
npx settld init capability my-capability
```

Repo checkout:

```bash
./bin/settld.js init capability my-capability
```

Then run the generated capability server (follow generated README in the capability folder).

## 3) Run kernel conformance

Installed CLI:

```bash
npx settld conformance kernel --ops-token tok_ops --json-out /tmp/kernel-report.json
```

Repo checkout:

```bash
./bin/settld.js conformance kernel --ops-token tok_ops --json-out /tmp/kernel-report.json
```

Expected:

- conformance PASS
- report at `/tmp/kernel-report.json`

## 4) Export and verify a closepack

Use an agreement hash from conformance/test output:

```bash
npx settld closepack export --agreement-hash <agreementHash> --out closepack.zip
npx settld closepack verify closepack.zip --json-out /tmp/closepack-verify.json
```

Expected:

- closepack verify passes
- JSON verification report produced

## 5) Replay-evaluate

```bash
curl -s "http://127.0.0.1:3000/ops/tool-calls/replay-evaluate?agreementHash=<agreementHash>" \
  -H "x-proxy-ops-token: tok_ops" | jq .
```

Expected: replay comparison fields indicate consistency/match.

## Troubleshooting

### Docker not found

Install/start Docker. Then rerun `dev up`.

### Node engine warning

Use Node 20+.

### Ops token permission error

Use token with at least `ops_read` scope.

### Port conflicts

Stop process on API port (`3000`) or configure alternate local runtime settings.
