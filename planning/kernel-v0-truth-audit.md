# Kernel v0 Truth Audit

Date: 2026-02-11  
Scope: repo-level audit (code + tests + workflows + docs)  
Legend:

* **TRUE** = implemented + validated by tests/conformance or directly enforced in code paths
* **PARTIAL** = implemented but missing a required invariant/guard OR not proven by existing tests/conformance
* **FALSE** = not shipped end-to-end (may be docs/runbooks only)

## 1) Economic kernel primitives and invariants

| Claim                                                              |   Status | Evidence                                                                                     | Notes / Gap | To make TRUE |
| ------------------------------------------------------------------ | -------: | -------------------------------------------------------------------------------------------- | ----------- | ------------ |
| Signed dispute-open envelope required for non-admin opens          | **TRUE** | `src/api/app.js:26271`, `src/core/dispute-open-envelope.js:51`                               | —           | —            |
| Holdback tick skips auto-release when arbitration is open          | **TRUE** | `src/api/app.js:16269`                                                                       | —           | —            |
| Deterministic holdback adjustment flow exists                      | **TRUE** | `src/core/settlement-adjustment.js:4`, `src/api/app.js:26509`                                | —           | —            |
| Tool-call replay endpoint exists and is wired                      | **TRUE** | `src/api/app.js:15889`                                                                       | —           | —            |
| Run settlement replay endpoint exists                              | **TRUE** | `src/api/app.js:27718`                                                                       | —           | —            |
| Closepack export + offline verify exists and is conformance-gated  | **TRUE** | `scripts/closepack/lib.mjs:244`, `conformance/kernel-v0/run.mjs:808`                         | —           | —            |
| SettlementDecisionRecord.v2 default path + policy pinning exists   | **TRUE** | `src/core/settlement-kernel.js:293`, `src/api/app.js:7054`                                   | —           | —            |
| `settld init capability` exists and has tests                      | **TRUE** | `bin/settld.js:169`, `scripts/init/capability.mjs:79`, `test/cli-init-capability.test.js:14` | —           | —            |
| Release workflow has CLI/SDK publish lane + assets/checksums gates | **TRUE** | `.github/workflows/release.yml`, `docs/RELEASE_CHECKLIST.md`                                 | —           | —            |

## 2) Dispute / arbitration correctness

| Claim                                                                          |      Status | Evidence                                                        | Notes / Gap                                                                                           | To make TRUE                                                                                               |
| ------------------------------------------------------------------------------ | ----------: | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Deterministic caseId is enforced                                               |    **TRUE** | (implied by audit note)                                         | —                                                                                                     | —                                                                                                          |
| Deterministic dispute-open envelope artifact ID is enforced                    | **PARTIAL** | `src/api/app.js:26202`, `src/core/dispute-open-envelope.js:137` | Envelope ID determinism not enforced server-side; possible duplicate envelopes for same semantic open | Enforce deterministic artifactId pattern (e.g., `env_case_${caseId}`) + uniqueness check + return existing |
| Dispute-open window/party/one-active-case rules are enforced with stable codes |    **TRUE** | (audit states semantics exist; earlier details in app.js)       | —                                                                                                     | Add conformance cases if any missing edge isn’t asserted                                                   |

## 3) Conformance and replay legitimacy

| Claim                                                                                       |   Status | Evidence                            | Notes / Gap | To make TRUE |
| ------------------------------------------------------------------------------------------- | -------: | ----------------------------------- | ----------- | ------------ |
| Tool-call replay-evaluate proves deterministic holdback adjustment expectation and compares | **TRUE** | `src/api/app.js:15889`              | —           | —            |
| Closepack offline verify checks envelope/verdict/bindings/replay                            | **TRUE** | `scripts/closepack/lib.mjs:244`     | —           | —            |
| Conformance gates closepack roundtrip                                                       | **TRUE** | `conformance/kernel-v0/run.mjs:808` | —           | —            |
| Deterministic verifier exists with at least one meaningful failing case                    | **TRUE** | `test/api-e2e-marketplace-tasks.test.js:1767`, `test/api-e2e-marketplace-tasks.test.js:1874` | E2E proves deterministic verifier can force refund path while replay stays consistent | — |

## 4) Reputation

| Claim                                                            |      Status | Evidence                                                             | Notes / Gap                                                                                      | To make TRUE                                                                                                                                  |
| ---------------------------------------------------------------- | ----------: | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Reputation is indexed/readable and idempotent insert paths exist | **TRUE** | `src/api/app.js:9637`, `src/api/app.js:9779`, `src/api/app.js:16135`, `conformance/kernel-v0/run.mjs:692`, `conformance/kernel-v0/run.mjs:788` | Conformance asserts event deduplication and aggregate stability across retries/tick reruns | — |

## 5) Distribution

| Claim                                                                                 |      Status | Evidence                                                                | Notes / Gap                                                                               | To make TRUE                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------: | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tarball “no clone” path is documented                                                 |    **TRUE** | `docs/QUICKSTART_KERNEL_V0.md:15`                                       | —                                                                                         | —                                                                                                               |
| CI smoke explicitly tests **local tarball npx --package ./settld-<version>.tgz** path | **PARTIAL** | `scripts/ci/cli-pack-smoke.mjs:37`, `.github/workflows/release.yml:326` | Smoke focuses on unpacked tarball + registry npx, not the exact local tarball-npx command | Add a smoke step that runs the exact documented tarball npx invocation (guarded for CI environment constraints) |
| Registry publish is wired                                                             |    **TRUE** | `.github/workflows/release.yml` (publish lane exists)                   | Wired ≠ executed                                                                          | —                                                                                                               |
| “First live npm publish proven”                                                       |    **TRUE** | GitHub Actions run `21917972978` (`npm_publish` + `python_publish` + `github_release` green), release `v0.1.2`, `npm view settld@0.1.2 version -> 0.1.2`, `npm exec --yes --package settld@0.1.2 -- settld --version -> 0.1.2`, PyPI `settld-api-sdk-python==0.1.2` | — | — |

## 6) Hosted baseline

| Claim                                                                                                     |    Status | Evidence                         | Notes / Gap                                                        | To make TRUE                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------: | -------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Hosted baseline is fully productized (staging/prod separation, worker durability, quotas, restore drills) | **FALSE** | `docs/ops/HOSTED_BASELINE_R2.md` | Docs/runbooks/manual items exist, but not fully shipped end-to-end | Implement staging env, worker service, quotas/rate limits, backup+restore drill, SLO/alerts; document evidence links |

## 7) Real money

| Claim                                                                         |    Status | Evidence | Notes / Gap     | To make TRUE                                                                                                                  |
| ----------------------------------------------------------------------------- | --------: | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Real-money alpha exists (Connect/KYB/chargeback/reconciliation-by-kernel-ids) | **FALSE** | (none)   | Not implemented | Design-partner alpha: Stripe Connect mapping, webhook ingestion, reconciliation tables, refund/chargeback policy, risk limits |

---

# Launch gates

## Kernel v0 “State-of-the-art Dev Preview” gate

Must be TRUE:

* Signed dispute-open envelope requirement (TRUE)
* Holdback freeze + deterministic adjustment (TRUE)
* Tool-call replay-evaluate + run replay-evaluate (TRUE)
* Closepack export + offline verify, conformance-gated (TRUE)
* Deterministic verifier exists with at least one meaningful failing case (verify separately)
* Reputation: either TRUE **or** explicitly labeled “preview/experimental” with conformance proving idempotency for what you claim
* `npx settld …` from npm registry: **TRUE** (requires a real publish event)

May remain FALSE for this gate:

* Hosted baseline fully productized
* Real money rails

## CI prepublish release gate (must be knowable before publish)

Must be TRUE:

* Signed dispute-open envelope requirement
* Holdback freeze + deterministic adjustment
* Tool-call replay-evaluate + run replay-evaluate
* Closepack export + offline verify, conformance-gated
* Deterministic verifier exists with at least one meaningful failing case
* Reputation is indexed/readable and idempotent insert paths exist
* Registry publish is wired

May remain non-TRUE in prepublish CI:

* First live npm publish proven (this becomes verifiable only after publish)

## Hosted Product Gate (public onboarding at app/api domains)

Must be TRUE:

* Hosted baseline fully productized (staging/prod separation + worker + quotas + backup/restore drills)
* Auth/tenancy enforcement end-to-end (Clerk + tenant isolation)
* Observability + alerting + runbooks

## Real Money Alpha Gate

Must be TRUE:

* One payment rail mapping that respects kernel IDs
* Webhook ingestion + reconciliation reporting
* Refund/chargeback policy and negative balance handling
* Risk limits and throttles
* Design partner agreements and support process

---

# Immediate action items (to eliminate PARTIAL items)

1. Enforce deterministic envelope artifactId server-side
2. Add CI smoke for the *exact* documented tarball `npx --package ./settld-<version>.tgz …` path
3. Execute first tagged npm publish and record evidence (version, commands run, outcomes) in this file
4. Stand up staging/prod hosted baseline and mark each requirement with evidence links

---

# Postpublish evidence log

Add one entry per first successful registry publish proof:

First proven publish (current release line):

- Version/tag: `v0.1.2` (workflow_dispatch version `0.1.2`)
- Release workflow run URL: `https://github.com/aidenlippert/settld/actions/runs/21917972978`
- npm postpublish smoke artifact name: `npm-postpublish-smoke-0.1.2`
- Command evidence:
  - `npm view settld@0.1.2 version` -> `0.1.2`
  - `npm exec --yes --package settld@0.1.2 -- settld --version` -> `0.1.2`
  - `npm exec --yes --package settld@0.1.2 -- settld conformance kernel:list`
  - `npm exec --yes --package settld@0.1.2 -- settld --help` (contains `settld closepack verify`)
  - `npm exec --yes --package settld@0.1.2 -- settld init capability smoke-cap --out /tmp/settld-registry-starter`
  - `https://pypi.org/pypi/settld-api-sdk-python/0.1.2/json` -> `0.1.2`

When this section has a verified entry for the current release line, flip **“First live npm publish proven”** to `TRUE`.

---

If you drop this file into the repo, it becomes the “no-BS truth ledger” for the company. It also prevents the most common founder failure mode: marketing claims outrunning the product.

Founder note: your next two “PARTIAL → TRUE” wins that matter most for credibility are **(1) deterministic envelope artifactId** and **(2) first live npm publish evidence**. Everything else is either longer-horizon (hosted baseline) or strategically gated (real money).
