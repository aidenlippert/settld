# Settld

Settld is the closure layer for delegated autonomous work: **verify what happened**, retain **audit-ready evidence**, and **settle** outcomes deterministically.

What you get in this repo:

- `settld` CLI for bundle verification + a conformance pack (CI / audit evidence)
- Runnable Node.js prototype (API + agent simulator)
- Protocol + product docs (schemas/specs, trust anchors, warning codes, etc.)

## 10-minute Demo: Verified Receipt (x402 Verify-Before-Release)

Prereqs: Node.js 20+.

```sh
npm ci && npm run quickstart:x402
```

By default the script keeps services running until you press Ctrl+C.

If you already ran `npm ci` in this repo, you can skip it:

```sh
npm run quickstart:x402
```

To run once and exit (CI-friendly):

```sh
npm ci && SETTLD_QUICKSTART_KEEP_ALIVE=0 npm run quickstart:x402
```

Success: prints `OK`, a `gateId=...`, and a `gateStateUrl=...`.

Next: `docs/QUICKSTART_X402_GATEWAY.md`

If you tried and failed:

- Run `./scripts/collect-debug.sh` and open a GitHub issue using the "Quickstart failure" template: https://github.com/aidenlippert/settld/issues/new?template=quickstart-failure.yml

The core mental model in this repo:

- **Jobs are state machines**: a job moves through explicit states (booked → executing → completed/aborted → settled).
- **Everything else is events**: every transition and operational action emits an event that can be replayed.
- **Trust is a black box**: telemetry/evidence are append-only, hash-chained, and (optionally) signed.
- **Money is a ledger**: every settlement is double-entry and must always balance.

## Bundle verification (CI / audit evidence)

- Overview: `docs/OVERVIEW.md`
- Quickstart: `docs/QUICKSTART_VERIFY.md`
- Kernel v0 quickstart (local dev stack + conformance + explorer): `docs/QUICKSTART_KERNEL_V0.md`
- Kernel v0 product surface (enforced vs not enforced): `docs/KERNEL_V0.md`
- Kernel Compatible policy + listing format: `docs/KERNEL_COMPATIBLE.md`
- Producer bootstrap: `docs/QUICKSTART_PRODUCE.md` (trust → produce → strict verify)
- SDK quickstart (first verified run): `docs/QUICKSTART_SDK.md`
- SDK quickstart (Python): `docs/QUICKSTART_SDK_PYTHON.md`
- x402 gateway quickstart (verify-before-release wedge): `docs/QUICKSTART_X402_GATEWAY.md`
- Integrations (GitHub Actions templates): `docs/integrations/README.md`
- Protocol contract (schemas/specs): `docs/spec/README.md`
- Conformance pack (portable oracle): `conformance/v1/README.md`
- Audit packet generator: `npm run audit:packet` (see `docs/RELEASE_CHECKLIST.md`)
- Support / filing bugs: `docs/SUPPORT.md`

## Quick start

Start the API:

```sh
PROXY_OPS_TOKEN=tok_ops npm run dev:api
```

Or start the full local dev stack (Postgres + MinIO + API + receiver + finance sink):

```sh
./bin/settld.js dev up
```

Developer helper flow (recommended for local Neon/PG usage):

```sh
npm run dev:env:init
# edit .env.dev once (DATABASE_URL, etc.)
npm run dev:start
```

Optional: start local Postgres + MinIO (for `STORE=pg` and S3-style evidence storage):

```sh
docker compose up -d
```

Run the full stack (API + maintenance + receiver + finance sink) via compose profile:

```sh
docker compose --profile app up --build
```

Initialize MinIO buckets (optional; required for S3/MinIO-backed evidence/artifact demos):

```sh
docker compose --profile init run --rm minio-init
```

Run the API backed by Postgres:

```sh
export STORE=pg
export DATABASE_URL=postgres://proxy:proxy@localhost:5432/proxy
npm run dev:api
```

Use MinIO for evidence objects (S3-compatible, via presigned URLs):

```sh
export PROXY_EVIDENCE_STORE=minio
export PROXY_EVIDENCE_S3_ENDPOINT=http://localhost:9000
export PROXY_EVIDENCE_S3_REGION=us-east-1
export PROXY_EVIDENCE_S3_BUCKET=proxy-evidence
export PROXY_EVIDENCE_S3_ACCESS_KEY_ID=proxy
export PROXY_EVIDENCE_S3_SECRET_ACCESS_KEY=proxysecret
export PROXY_EVIDENCE_S3_FORCE_PATH_STYLE=1
```

Create a job:

```sh
curl -sS -X POST http://localhost:3000/jobs \
  -H 'content-type: application/json' \
  -d '{"templateId":"reset_lite","constraints":{"roomsAllowed":["kitchen","living_room"],"privacyMode":"minimal"}}' | jq
```

Run the agent simulator (registers an executor and runs a sample job lifecycle):

```sh
npm run agent:sim
```

Run tests:

```sh
npm test
```

Run conformance (bundle verification oracle):

```sh
./bin/settld.js conformance test
```

Run conformance (kernel control plane, disputes + holdback):

```sh
./bin/settld.js conformance kernel --ops-token tok_ops
```

No-clone registry flow:

```sh
npx settld conformance kernel --ops-token tok_ops
```

No-clone release artifact flow (download `settld-<version>.tgz` from GitHub Releases):

```sh
npx --yes --package ./settld-<version>.tgz settld conformance kernel --ops-token tok_ops
```

Ops workspaces (HTML):

- Kernel Explorer: `GET /ops/kernel/workspace` (requires ops token)

## Docs

- `docs/PRD.md`
- `docs/ARCHITECTURE.md`
- `docs/DOMAIN_MODEL.md`
- `docs/JOB_STATE_MACHINE.md`
- `docs/EVENT_ENVELOPE.md`
- `docs/ACCESS.md`
- `docs/SKILLS.md`
- `docs/TRUST.md`
- `docs/LEDGER.md`
- `docs/SKILL_BUNDLE_FORMAT.md`
- `docs/CERTIFICATION_CHECKLIST.md`
- `docs/THREAT_MODEL.md`
- `docs/INCIDENT_TAXONOMY.md`
- `docs/ONCALL_PLAYBOOK.md`
- `docs/MVP_BUILD_ORDER.md`
- `docs/QUICKSTART_VERIFY.md`
- `docs/QUICKSTART_PRODUCE.md`
- `docs/QUICKSTART_SDK.md`
- `docs/QUICKSTART_SDK_PYTHON.md`
- `docs/ADOPTION_CHECKLIST.md`
- `docs/SUPPORT.md`
- `docs/OPERATIONS_SIGNING.md`
- `docs/KERNEL_V0.md`
- `docs/KERNEL_COMPATIBLE.md`
- `docs/ops/PAYMENTS_ALPHA_R5.md`
- `docs/ops/ARTIFACT_VERIFICATION_STATUS.md`
- `docs/ops/TRUST_CONFIG_WIZARD.md`
- `docs/integrations/README.md`
