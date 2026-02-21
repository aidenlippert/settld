# Trust OS v1 Threat Matrix

Status: Draft v1.0
Owner: Security + Trust Architecture
Last Updated: 2026-02-21

## 1) Method

This matrix maps concrete threat scenarios to:

1. impacted assets
2. preventive controls
3. detective controls
4. response actions
5. mandatory release gates

Severity scale:

- S1: Critical (financial loss, trust failure, legal exposure)
- S2: High (material service integrity risk)
- S3: Medium (degraded assurance, contained impact)
- S4: Low (localized or non-exploitable in default config)

## 2) Threat Matrix

| ID | Severity | Threat Scenario | Impacted Assets | Preventive Controls | Detective Controls | Response | Required Gate |
|---|---|---|---|---|---|---|---|
| T-001 | S1 | Delegation grant forgery | Authority boundaries, funds | Signed grants, trust anchors, revocation checks | Signature failure counters | Block request, incident open | AuthN/AuthZ conformance |
| T-002 | S1 | Stolen agent key used for spending | Funds, tenant trust | Short-lived delegation, rotation, revocation | Key anomaly alerts | Revoke key, quarantine agent | Key-rotation drill gate |
| T-003 | S1 | Request mutation after approval | Policy integrity | Intent hash binding at execution | Hash mismatch metrics | Deterministic deny + alert | Mutation regression gate |
| T-004 | S1 | Replay of prior authorized request | Funds, integrity | Nonce + idempotency + expiry enforcement | Replay-denied telemetry | Deny + tenant risk flag | Replay conformance gate |
| T-005 | S1 | MCP/host bypass around policy runtime | Trust kernel integrity | Mandatory trust middleware | Route inventory + bypass tests | Kill-switch integration path | Bypass negative test gate |
| T-006 | S2 | Policy fingerprint drift across environments | Audit/compliance trust | Canonical profile fingerprinting | Drift detector in CI | Block promotion | Fingerprint parity gate |
| T-007 | S2 | Time-skew exploit on expiry/challenge windows | Authorization correctness | Trusted time source, timestamp proofs | Clock skew alerting | Freeze sensitive ops | Time-hardening gate |
| T-008 | S1 | Double settlement via retry storms | Financial correctness | Idempotent keying and external ref dedupe | Duplicate external effect detector | Auto-reconcile + reversal | Retry chaos gate |
| T-009 | S1 | Ledger imbalance bug | Accounting integrity | Double-entry invariant checks | Journal imbalance alarms | Halt settlement pipeline | Ledger invariant gate |
| T-010 | S1 | Adapter returns forged/ambiguous status | Release/refund correctness | Adapter signing/verifier contract | Contract mismatch alerts | Quarantine adapter | Adapter conformance gate |
| T-011 | S1 | Evidence tampering post execution | Audit defensibility | Hash-chained append-only events | Verification report failures | Invalidate receipt | Offline verify parity gate |
| T-012 | S2 | Evidence omission in critical bundle paths | Incident readiness | Required evidence index surfaces | Missing-surface warning escalations | Force challenge/manual review | Evidence completeness gate |
| T-013 | S1 | Operator override abuse | Governance integrity | Signed operator actions + RBAC + dual-control | Override anomaly monitoring | Suspend operator privileges | Operator policy gate |
| T-014 | S2 | Emergency controls misused/mis-scoped | Availability/trust | Scoped controls + TTL + signed actions | Emergency action audit alerts | Emergency review workflow | Emergency drill gate |
| T-015 | S2 | Dispute spam abuse | Ops capacity | Rate controls, challenge economics, reputation thresholds | Queue anomaly detection | Throttle/auto-close policy | Dispute load gate |
| T-016 | S1 | Verdict tampering or lineage break | Recourse correctness | Signed verdicts + lineage hashes | Lineage validation failures | Reject verdict and reopen case | Dispute lineage gate |
| T-017 | S1 | Cross-tenant access leak | Privacy/compliance | Strict tenant isolation and scoped auth tokens | Access anomaly analytics | Containment and tenant notification | Tenant isolation test gate |
| T-018 | S1 | Prompt injection triggers unauthorized spend | Runtime safety | Tool permissioning + policy runtime hard-gate | High-risk call alerts | Challenge/escalate + revoke delegation | Prompt-injection scenario gate |
| T-019 | S1 | Sub-agent exceeds parent spend envelope | Liability and funds | Work-order envelope inheritance checks | Parent/child spend divergence | Freeze subtree and dispute trigger | Sub-agent envelope gate |
| T-020 | S2 | Reputation sybil inflation in marketplaces | Counterparty trust | Attestation weighting + anti-sybil heuristics | Graph anomaly detectors | De-rank + collateral requirement | Reputation resilience gate |
| T-021 | S2 | Determinism drift across hosts/verifiers | Reliability and confidence | Canonicalization + shared vectors | Cross-host parity failures | Block release | Cross-host determinism gate |
| T-022 | S1 | Secret leakage in logs/artifacts | Key and account security | Secret redaction + vault-only key paths | Secret scanning in CI/runtime | Rotate credentials, purge artifacts | Secret hygiene gate |
| T-023 | S1 | Adapter outage causes partial commits | Financial consistency | Two-phase settlement orchestration | Stuck transition alerts | Safe retry/reversal flow | Outage rehearsal gate |
| T-024 | S2 | Unauthorized policy/profile change | Enforcement integrity | Signed policy updates + approval workflow | Policy audit diff stream | Revert and incident review | Policy change control gate |

## 3) Control Families

1. Identity/authority controls: grants, revocation, key lifecycle.
2. Binding controls: intent/policy/evidence hash linkage.
3. Financial controls: idempotency, balancing, reconciliation.
4. Governance controls: signed operator actions, RBAC, dual-control.
5. Reliability controls: fail-closed gates, outage drills, release guardrails.
6. Determinism controls: canonicalization, vectors, fixture parity.

## 4) Gate Suite Required for Production Promotion

1. AuthN/AuthZ conformance gate.
2. Mutation + replay deterministic denial gate.
3. Offline verification parity gate.
4. Adapter conformance and outage rehearsal gate.
5. Ledger invariant and idempotent settlement chaos gate.
6. Operator override and emergency control policy gate.
7. Tenant isolation and secret hygiene gates.
8. Cutover packet and release promotion fail-closed gate.

## 5) Incident Response Playbook Mapping

- IR-01 Compromised delegation key: T-001, T-002
- IR-02 Unauthorized execution path/bypass: T-003, T-005
- IR-03 Financial duplication/imbalance: T-008, T-009, T-023
- IR-04 Evidence integrity failure: T-011, T-012, T-021
- IR-05 Operator/governance misuse: T-013, T-014, T-024
- IR-06 Isolation/compliance breach: T-017, T-022

## 6) Residual Risks (Accepted with Monitoring)

1. Cross-jurisdiction regulatory variance on reversal semantics.
2. External rail provider behavior changes outside API version commitments.
3. Human-in-the-loop latency during high-volume incident windows.

These risks require quarterly review with updated mitigations and drills.
