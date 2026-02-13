# Kernel v0 Quickstart (Local)

Goal: run the full “economic loop” locally and inspect artifacts (holdback, disputes, deterministic adjustments, replay-evaluate).

## No-Clone CLI Path

Registry form (recommended once package is published):

```sh
npx settld --version
npx settld dev up
npx settld conformance kernel --ops-token tok_ops
```

Release tarball fallback:

If you downloaded a release asset like `settld-<version>.tgz`, you can run CLI commands without cloning this repo:

```sh
npx --yes --package ./settld-<version>.tgz settld --version
npx --yes --package ./settld-<version>.tgz settld dev up
npx --yes --package ./settld-<version>.tgz settld conformance kernel --ops-token tok_ops
```

Use the same pattern for all commands in this doc.

## 1) Start The Dev Stack

Recommended (one command):

```sh
./bin/settld.js dev up
```

Equivalent (manual):

```sh
docker compose --profile app up -d --build
docker compose --profile init run --rm minio-init
```

Defaults:

- API: `http://127.0.0.1:3000`
- tenant: `tenant_default`
- ops token: `tok_ops`

## 2) Run Kernel Conformance

This will exercise:

- tool-call holdback disputes (freeze maintenance tick, issue verdict, deterministic adjustment)
- marketplace run replay-evaluate (`/runs/:runId/settlement/replay-evaluate`)
- deterministic verifier plugin selection (`verifier://settld/deterministic/latency-threshold-v1` or `verifier://settld/deterministic/schema-check-v1`)

```sh
./bin/settld.js conformance kernel --ops-token tok_ops --json-out /tmp/settld-kernel-v0-report.json
```

The runner prints `INFO ...` lines with `agreementHash` and `runId`.

## 3) Open Kernel Explorer

Open:

`http://127.0.0.1:3000/ops/kernel/workspace?opsToken=tok_ops`

Then paste the `agreementHash` from conformance into the “Tool Call Agreement” panel.

## 4) Verify Replay Evaluate

Use the `runId` printed by conformance:

```sh
curl -sS "http://127.0.0.1:3000/runs/<runId>/settlement/replay-evaluate" \
  -H "x-proxy-tenant-id: tenant_default" \
  -H "x-proxy-ops-token: tok_ops" | jq
```

## Shutdown

```sh
./bin/settld.js dev down
```

To wipe volumes (fresh DB + buckets):

```sh
./bin/settld.js dev down --wipe
```

## Product Surfaces

- Kernel v0 contract surface and guarantees: `docs/KERNEL_V0.md`
- Kernel Compatible badge criteria + listing flow: `docs/KERNEL_COMPATIBLE.md`
- Reference capability listing JSON: `docs/kernel-compatible/capabilities.json`
