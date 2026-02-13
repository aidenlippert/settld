# Settld Protocol Specs

This directory freezes the **wire-format contracts** that Settld emits and verifies (bundles, manifests, attestations, and verification reports).

These specs are written so an independent implementer can build a verifier without reading Settld’s source.

## Canonicalization + hashing (global rules)

- **Canonical JSON**: JSON objects are canonicalized using RFC 8785 (JCS).
- **Hashing**: all hashes in these specs are `sha256` over UTF-8 bytes of canonical JSON (or raw file bytes, as specified), represented as lowercase hex.
- **Derived outputs**: bundle manifests intentionally **exclude** `verify/**` to avoid circular hashing; those files are verified out-of-band by signature and by binding to the `manifestHash`.

## Documents

- `CANONICAL_JSON.md` — canonical JSON rules used before hashing/signing.
- `VERSIONING.md` — tool vs protocol versioning policy (SemVer + protocol object evolution).
- `REFERENCE_VERIFIER_BEHAVIOR.md` — filesystem/path/ordering rules to prevent cross-impl drift.
- `REFERENCE_IMPLEMENTATIONS.md` — reference verifier implementations and conformance parity policy.
- `THREAT_MODEL.md` — explicit threats, mitigations, and residual risks (evidence-backed).
- `INVARIANTS.md` — checklist mapping protocol claims → spec → code → tests → codes.
- `MONEY_RAIL_STATE_MACHINE.md` — deterministic payout/collection lifecycle and transition rules.
- `ESCROW_NETTING_INVARIANTS.md` — deterministic escrow mutation, settlement partition, and netting invariants.
- `CRYPTOGRAPHY.md` — crypto primitives + byte-level hashing/signing inventory.
- `VERIFIER_ENVIRONMENT.md` — operational assumptions and hardening guidance.
- `ProofBundleManifest.v1.md` — JobProof/MonthProof manifest + hashing contract.
- `FinancePackBundleManifest.v1.md` — FinancePack manifest + hashing contract.
- `BundleHeadAttestation.v1.md` — signed head commitment for bundles.
- `GovernancePolicy.v1.md` — signer authorization policy (strict verification).
- `GovernancePolicy.v2.md` — signer authorization policy (signed by governance root).
- `RevocationList.v1.md` — prospective revocation/rotation list (signed by governance root).
- `TimestampProof.v1.md` — trustworthy signing time proof (for historical acceptance).
- `VerificationReport.v1.md` — signed, machine-ingestible strict verification report.
- `PricingMatrixSignatures.v2.md` — buyer signature surface for pricing terms in `InvoiceBundle.v1` (canonical JSON binding; recommended).
- `PricingMatrixSignatures.v1.md` — legacy buyer signature surface (raw bytes binding).
- `ClosePack.v1.md` — pre-dispute invoice package embedding `InvoiceBundle.v1` + evidence index.
- `ClosePackManifest.v1.md` — ClosePack manifest + hashing contract.
- `EvidenceIndex.v1.md` — deterministic evidence reference index for ClosePack.
- `SlaDefinition.v1.md` / `SlaEvaluation.v1.md` — deterministic SLA rules + evaluation surfaces for ClosePack.
- `AcceptanceCriteria.v1.md` / `AcceptanceEvaluation.v1.md` — deterministic acceptance rules + evaluation surfaces for ClosePack.
- `VerifyCliOutput.v1.md` — `settld-verify --format json` machine output contract.
- `VerifyAboutOutput.v1.md` — `settld-verify --about --format json` tool metadata contract.
- `ProduceCliOutput.v1.md` — `settld-produce --format json` machine output contract.
- `ToolManifest.v1.md` — signed tool/capability manifest that can be pinned by hash.
- `AgentIdentity.v1.md` — portable autonomous agent identity contract.
- `AgentWallet.v1.md` — deterministic autonomous wallet snapshot contract.
- `AgentRun.v1.md` — deterministic agent run snapshot contract.
- `AgentEvent.v1.md` — append-only event envelope for agent runs.
- `AgentRunSettlement.v1.md` — deterministic run escrow/settlement contract.
- `MarketplaceOffer.v2.md` — canonical pre-contract offer artifact derived from negotiation proposals.
- `MarketplaceAcceptance.v2.md` — canonical acceptance artifact bound to a `MarketplaceOffer.v2` hash.
- `SettlementDecisionRecord.v1.md` — legacy settlement decision artifact (historical verification).
- `SettlementDecisionRecord.v2.md` — settlement decision artifact with replay-critical policy pinning (current).
- `SettlementReceipt.v1.md` — canonical settlement finality receipt bound to a decision hash.
- `FundingHold.v1.md` — deterministic escrow hold for holdback/challenge-window workflows.
- `SettlementAdjustment.v1.md` — deterministic, idempotent adjustment artifact for held-funds release/refund.
- `SettlementKernel.v1.md` — binding invariants + stable verification error semantics for settlement decision/receipt integrity.
- `ArbitrationCase.v1.md` — formal arbitration case contract with appeal linkage.
- `DisputeOpenEnvelope.v1.md` — signed dispute opener-proof envelope bound to tool-call hold/receipt/agreement hashes.
- `ArbitrationVerdict.v1.md` — signed arbitration verdict contract with appeal references.
- `ReputationEvent.v1.md` — append-only, deterministic economic reputation fact artifact.
- `AgentReputation.v1.md` — deterministic trust score snapshot derived from runs + settlement outcomes.
- `AgentReputation.v2.md` — reputation with recency windows (`7d`, `30d`, `allTime`) for marketplace ranking.
- `InteractionDirectionMatrix.v1.md` — frozen `4x4` directional interaction matrix (`agent|human|robot|machine`).
- `TenantSettings.v2.md` — Magic Link / Verify Cloud tenant configuration contract (current).
- `TenantSettings.v1.md` — legacy (still accepted for stored settings migration).
- `WARNINGS.md` — warning codes (closed set) and semantics.
- `ERRORS.md` — error codes (stable identifiers) and semantics.
- `PRODUCER_ERRORS.md` — producer/tooling error codes (stable identifiers) and semantics.
- `STRICTNESS.md` — strict vs non-strict verification contract.
- `TRUST_ANCHORS.md` — verifier trust anchors and out-of-band key injection.
- `TOOL_PROVENANCE.md` — tool version/commit derivation rules.
- `REMOTE_SIGNER.md` — tooling contract for remote/delegated signing (no private keys on disk).
- `RemoteSignerRequest.v1.md` / `RemoteSignerResponse.v1.md` — versioned stdio wrapper contract for process-based signers.
- `SIGNER_PROVIDER_PLUGIN.md` — tooling contract for signer provider plugins (KMS/HSM/Vault integrations).
- `ReleaseIndex.v1.md` — signed release manifest (artifact authenticity).
- `ReleaseIndexSignatures.v1.md` — detached multi-signature wrapper for `ReleaseIndex.v1`.
- `ReleaseTrust.v1.md` — trusted release signing keys (legacy/simple mapping).
- `ReleaseTrust.v2.md` — trusted release signing keys with rotation/revocation + quorum.
- `SUPPLY_CHAIN.md` — release-channel threat model and verification procedure.

## Legacy archive

Legacy protocol objects are retained under `docs/spec/legacy/` (including `legacy/schemas/`) for historical verification only.
Current integrations should use the active specs listed above.

## Schemas + examples

- `schemas/` contains JSON Schema for the on-disk JSON documents.
- `examples/` contains minimal example instances (illustrative, not authoritative vectors).

## Quickstart

See `docs/QUICKSTART_VERIFY.md` for a CI-friendly verifier quickstart using `settld-verify --format json`.

## Conformance + audit evidence

- Conformance oracle: `conformance/v1/README.md`
- Audit packet (specs + vectors + conformance + checksums): `npm run audit:packet`
