import fs from "node:fs/promises";
import path from "node:path";

import { resetDeterministicIds } from "../../src/core/ids.js";
import { createChainedEvent, appendChainedEvent } from "../../src/core/event-chain.js";
import { keyIdFromPublicKeyPem } from "../../src/core/crypto.js";
import { buildJobProofBundleV1, buildMonthProofBundleV1 } from "../../src/core/proof-bundle.js";
import { buildFinancePackBundleV1 } from "../../src/core/finance-pack-bundle.js";
import { buildInvoiceBundleV1 } from "../../src/core/invoice-bundle.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { DEFAULT_TENANT_ID } from "../../src/core/tenancy.js";
import { computeArtifactHash } from "../../src/core/artifacts.js";
import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";
import { computeAgentReputation, computeAgentReputationV2 } from "../../src/core/agent-reputation.js";
import { buildInteractionDirectionMatrixV1 } from "../../src/core/interaction-directions.js";
import { buildToolManifestV1 } from "../../src/core/tool-manifest.js";
import { buildAuthorityGrantV1 } from "../../src/core/authority-grants.js";

function bytes(text) {
  return new TextEncoder().encode(text);
}

function parseJson(bytesValue) {
  return JSON.parse(new TextDecoder().decode(bytesValue));
}

async function loadTestSigner() {
  const p = path.resolve(process.cwd(), "test/fixtures/keys/ed25519_test_keypair.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function main() {
  process.env.PROXY_DETERMINISTIC_IDS = "1";
  resetDeterministicIds();

  const tenantId = "tenant_vectors";
  const jobId = "job_det_00000001";
  const period = "2026-01";
  const generatedAt = "2026-02-01T00:00:00.000Z";
  const createdAt = "2026-02-01T00:00:00.000Z";
  const toolCommit = "0123456789abcdef0123456789abcdef01234567";

  const { publicKeyPem, privateKeyPem } = await loadTestSigner();
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  const signer = { keyId, privateKeyPem };
  const publicKeyByKeyId = new Map([[keyId, publicKeyPem]]);

  const governanceEvents = [];
  const govRegistered = createChainedEvent({
    streamId: GOVERNANCE_STREAM_ID,
    type: "SERVER_SIGNER_KEY_REGISTERED",
    at: "2026-01-01T00:00:00.000Z",
    actor: { type: "system", id: "proxy" },
    payload: { tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, registeredAt: "2026-01-01T00:00:00.000Z", reason: "bootstrap" }
  });
  governanceEvents.push(...appendChainedEvent({ events: governanceEvents, event: govRegistered, signer }));

  const jobEvents = [];
  jobEvents.push(
    ...appendChainedEvent({
      events: jobEvents,
      signer,
      event: createChainedEvent({
        streamId: jobId,
        type: "JOB_CREATED",
        at: "2026-02-01T00:00:00.000Z",
        actor: { type: "system", id: "proxy" },
        payload: { jobId }
      })
    })
  );

  const jobSnapshot = { jobId, lastEventId: jobEvents[jobEvents.length - 1].id, lastChainHash: jobEvents[jobEvents.length - 1].chainHash };

  const { files: jobFiles, bundle: jobBundle } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    governanceEvents,
    governanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents[governanceEvents.length - 1].chainHash, lastEventId: governanceEvents[governanceEvents.length - 1].id },
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null },
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys: [
      { tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z", serverGoverned: true }
    ],
    manifestSigner: signer,
    governancePolicySigner: signer,
    toolCommit,
    requireHeadAttestation: true,
    generatedAt
  });

  const monthEvents = [];
  monthEvents.push(
    ...appendChainedEvent({
      events: monthEvents,
      signer,
      event: createChainedEvent({
        streamId: `month_${period}`,
        type: "MONTH_CLOSE_REQUESTED",
        at: "2026-02-01T00:00:00.000Z",
        actor: { type: "system", id: "proxy" },
        payload: { period, basis: "settledAt" }
      })
    })
  );

  const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
    tenantId,
    period,
    basis: "settledAt",
    monthEvents,
    governanceEvents,
    governanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents[governanceEvents.length - 1].chainHash, lastEventId: governanceEvents[governanceEvents.length - 1].id },
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null },
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys: [
      { tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z", serverGoverned: true }
    ],
    manifestSigner: signer,
    governancePolicySigner: signer,
    toolCommit,
    requireHeadAttestation: true,
    generatedAt
  });

  const glBatch = { artifactType: "GLBatch.v1", schemaVersion: "GLBatch.v1", artifactId: "gl_det", tenantId, period, basis: "settledAt", batch: { lines: [] } };
  glBatch.artifactHash = computeArtifactHash(glBatch);
  const csv = "a,b\n1,2\n";
  const journalCsv = {
    artifactType: "JournalCsv.v1",
    schemaVersion: "JournalCsv.v1",
    artifactId: "csv_det",
    tenantId,
    period,
    basis: "settledAt",
    accountMapHash: "h_map",
    csv,
    csvSha256: sha256Hex(bytes(csv))
  };
  journalCsv.artifactHash = computeArtifactHash(journalCsv);
  const reconcileReport = { ok: true, period, basis: "settledAt", entryCount: 0, totalsKeys: 0 };
  const reconcileBytes = bytes(`${canonicalJsonStringify(reconcileReport)}\n`);

  const canonicalJson = (() => {
    // These cases exist to make canonicalization rules cross-language implementable.
    // Each case includes the canonical string and its sha256 (over UTF-8 bytes).
    const cases = [];

    // Key ordering must not depend on insertion order.
    {
      const valueA = { b: 1, a: 2, c: { y: true, x: false } };
      const valueB = {};
      valueB.c = {};
      valueB.c.x = false;
      valueB.c.y = true;
      valueB.a = 2;
      valueB.b = 1;
      const canonical = canonicalJsonStringify(valueA);
      cases.push({
        name: "object_key_ordering_is_lexicographic",
        valueA,
        valueB,
        canonical,
        sha256: sha256Hex(canonical)
      });
    }

    // Unicode must be hashed as UTF-8 bytes of the canonical JSON string.
    {
      const value = { s: "café ∑ — 😀", escaped: "line\nbreak\tand\\slash" };
      const canonical = canonicalJsonStringify(value);
      cases.push({
        name: "unicode_and_escaping",
        value,
        canonical,
        sha256: sha256Hex(canonical)
      });
    }

    // Numbers must be finite and not -0; exponent formatting must be stable.
    {
      const value = { ints: [0, 1, -1, 10, 1000], floats: [1.5, 1e21, 1e-9] };
      const canonical = canonicalJsonStringify(value);
      cases.push({
        name: "number_serialization",
        value,
        canonical,
        sha256: sha256Hex(canonical)
      });
    }

    return { jcs: "RFC8785", cases };
  })();

  const { files: financeFiles, bundle: financeBundle } = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol: "1.0",
    createdAt,
    governancePolicySigner: signer,
    monthProofBundle: monthBundle,
    monthProofFiles: monthFiles,
    requireMonthProofAttestation: true,
    requireHeadAttestation: true,
    manifestSigner: signer,
    verificationReportSigner: signer,
    toolVersion: "0.0.0-vectors",
    toolCommit,
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport,
    reconcileReportBytes: reconcileBytes
  });

  const invoiceId = "inv_det_00000001";
  const { files: invoiceFiles, bundle: invoiceBundle } = buildInvoiceBundleV1({
    tenantId,
    invoiceId,
    protocol: "1.0",
    createdAt,
    governancePolicySigner: signer,
    jobProofBundle: jobBundle,
    jobProofFiles: jobFiles,
    requireJobProofAttestation: true,
    requireHeadAttestation: true,
    manifestSigner: signer,
    verificationReportSigner: signer,
    toolVersion: "0.0.0-vectors",
    toolCommit,
    pricingMatrix: {
      currency: "USD",
      prices: [
        { code: "WORK_MINUTES", unitPriceCents: "150" }
      ]
    },
    meteringReport: {
      generatedAt,
      items: [{ code: "WORK_MINUTES", quantity: "10" }],
      evidenceRefs: [
        { path: "job/snapshot.json", sha256: sha256Hex(jobFiles.get("job/snapshot.json")) }
      ]
    }
  });

  const agentIdentity = {
    schemaVersion: "AgentIdentity.v1",
    agentId: "agt_vectors_0001",
    tenantId,
    displayName: "Vector Agent",
    status: "active",
    owner: {
      ownerType: "business",
      ownerId: "acme_vectors"
    },
    keys: {
      keyId,
      algorithm: "ed25519",
      publicKeyPem
    },
    capabilities: ["dispatch_job", "verify_bundle"],
    walletPolicy: {
      maxPerTransactionCents: 5000,
      maxDailyCents: 50000,
      requireApprovalAboveCents: 25000
    },
    metadata: {
      stage: "vectors"
    },
    createdAt: generatedAt,
    updatedAt: generatedAt
  };
  const agentIdentityCanonical = canonicalJsonStringify(agentIdentity);

  const agentRun = {
    schemaVersion: "AgentRun.v1",
    runId: "run_vectors_0001",
    agentId: agentIdentity.agentId,
    tenantId,
    taskType: "translation",
    inputRef: "urn:task:vectors:translation",
    status: "completed",
    evidenceRefs: ["evidence://run_vectors_0001/output.json"],
    metrics: {
      latencyMs: 1200,
      tokensProcessed: 512
    },
    failure: null,
    startedAt: "2026-02-01T00:01:00.000Z",
    completedAt: "2026-02-01T00:02:00.000Z",
    failedAt: null,
    revision: 3,
    createdAt: generatedAt,
    updatedAt: "2026-02-01T00:02:00.000Z",
    lastEventId: "ev_run_vectors_0003",
    lastChainHash: "ch_run_vectors_0003"
  };
  const agentRunCanonical = canonicalJsonStringify(agentRun);

  const agentEvent = {
    schemaVersion: "AgentEvent.v1",
    v: 1,
    id: "ev_run_vectors_0003",
    streamId: agentRun.runId,
    type: "RUN_COMPLETED",
    at: "2026-02-01T00:02:00.000Z",
    actor: {
      type: "agent",
      id: agentIdentity.agentId
    },
    payload: {
      runId: agentRun.runId,
      outputRef: "evidence://run_vectors_0001/output.json",
      metrics: {
        latencyMs: 1200,
        tokensProcessed: 512
      }
    },
    payloadHash: "ph_run_vectors_0003",
    prevChainHash: "ch_run_vectors_0002",
    chainHash: "ch_run_vectors_0003",
    signature: "sig_run_vectors_0003",
    signerKeyId: keyId
  };
  const agentEventCanonical = canonicalJsonStringify(agentEvent);

  const agentWallet = {
    schemaVersion: "AgentWallet.v1",
    walletId: "wallet_agt_vectors_0001",
    agentId: agentIdentity.agentId,
    tenantId,
    currency: "USD",
    availableCents: 2750,
    escrowLockedCents: 1250,
    totalDebitedCents: 900,
    totalCreditedCents: 4900,
    revision: 7,
    createdAt: generatedAt,
    updatedAt: "2026-02-01T00:03:00.000Z"
  };
  const agentWalletCanonical = canonicalJsonStringify(agentWallet);

  const agentRunSettlement = {
    schemaVersion: "AgentRunSettlement.v1",
    settlementId: "setl_run_vectors_0001",
    runId: agentRun.runId,
    tenantId,
    agentId: agentIdentity.agentId,
    payerAgentId: "agt_vectors_payer_0001",
    amountCents: 1250,
    currency: "USD",
    status: "locked",
    lockedAt: "2026-02-01T00:00:30.000Z",
    resolvedAt: null,
    resolutionEventId: null,
    runStatus: null,
    revision: 0,
    createdAt: "2026-02-01T00:00:30.000Z",
    updatedAt: "2026-02-01T00:00:30.000Z"
  };
  const agentRunSettlementCanonical = canonicalJsonStringify(agentRunSettlement);

  const agentRunFailed = {
    schemaVersion: "AgentRun.v1",
    runId: "run_vectors_0002",
    agentId: agentIdentity.agentId,
    tenantId,
    taskType: "classification",
    inputRef: "urn:task:vectors:classification",
    status: "failed",
    evidenceRefs: [],
    metrics: null,
    failure: {
      code: "MODEL_TIMEOUT",
      message: "deterministic vector failure"
    },
    startedAt: "2026-02-01T00:05:00.000Z",
    completedAt: null,
    failedAt: "2026-02-01T00:06:00.000Z",
    revision: 2,
    createdAt: "2026-02-01T00:04:30.000Z",
    updatedAt: "2026-02-01T00:06:00.000Z",
    lastEventId: "ev_run_vectors_0002_2",
    lastChainHash: "ch_run_vectors_0002_2"
  };

  const agentReleasedSettlement = {
    ...agentRunSettlement,
    status: "released",
    resolvedAt: "2026-02-01T00:02:00.000Z",
    resolutionEventId: "ev_run_vectors_0003",
    runStatus: "completed",
    revision: 1,
    updatedAt: "2026-02-01T00:02:00.000Z"
  };
  const agentRefundedSettlement = {
    schemaVersion: "AgentRunSettlement.v1",
    settlementId: "setl_run_vectors_0002",
    runId: agentRunFailed.runId,
    tenantId,
    agentId: agentIdentity.agentId,
    payerAgentId: "agt_vectors_payer_0001",
    amountCents: 800,
    currency: "USD",
    status: "refunded",
    lockedAt: "2026-02-01T00:04:40.000Z",
    resolvedAt: "2026-02-01T00:06:00.000Z",
    resolutionEventId: "ev_run_vectors_0002_2",
    runStatus: "failed",
    revision: 1,
    createdAt: "2026-02-01T00:04:40.000Z",
    updatedAt: "2026-02-01T00:06:00.000Z"
  };
  const agentReputation = computeAgentReputation({
    tenantId,
    agentId: agentIdentity.agentId,
    runs: [agentRun, agentRunFailed],
    settlements: [agentReleasedSettlement, agentRefundedSettlement],
    at: "2026-02-01T00:06:00.000Z"
  });
  const agentReputationCanonical = canonicalJsonStringify(agentReputation);
  const agentReputationV2 = computeAgentReputationV2({
    tenantId,
    agentId: agentIdentity.agentId,
    runs: [agentRun, agentRunFailed],
    settlements: [agentReleasedSettlement, agentRefundedSettlement],
    at: "2026-02-01T00:06:00.000Z",
    primaryWindow: "30d"
  });
  const agentReputationV2Canonical = canonicalJsonStringify(agentReputationV2);
  const interactionDirectionMatrix = buildInteractionDirectionMatrixV1();
  const interactionDirectionMatrixCanonical = canonicalJsonStringify(interactionDirectionMatrix);

  const toolManifest = buildToolManifestV1({
    tenantId,
    toolId: "tool_vectors_translate_v1",
    name: "Translate (Vectors)",
    description: "vectorized tool manifest for hashing/signing interoperability",
    tool: {
      name: "translate",
      description: "Translate input text to a target language.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "to"],
        properties: {
          text: { type: "string" },
          to: { type: "string" }
        }
      }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    capabilities: ["translation"],
    signer,
    at: generatedAt
  });
  const toolManifestCanonical = canonicalJsonStringify(toolManifest);

  const authorityGrant = buildAuthorityGrantV1({
    tenantId,
    grantId: "auth_vectors_0001",
    grantedBy: { actorType: "human", actorId: "user_vectors_0001" },
    grantedTo: { actorType: "agent", actorId: agentIdentity.agentId },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 5000,
      toolIds: [toolManifest.toolId],
      pinnedManifests: { [toolManifest.toolId]: toolManifest.manifestHash },
      expiresAt: "2026-03-01T00:00:00.000Z"
    },
    signer,
    at: generatedAt
  });
  const authorityGrantCanonical = canonicalJsonStringify(authorityGrant);

  const out = {
    schemaVersion: "ProtocolVectors.v1",
    generatedAt,
    signer: { keyId },
    canonicalJson,
    jobProof: {
      manifestHash: jobBundle.manifestHash,
      headAttestationHash: parseJson(jobFiles.get("attestation/bundle_head_attestation.json")).attestationHash,
      verificationReportHash: parseJson(jobFiles.get("verify/verification_report.json")).reportHash
    },
    monthProof: {
      manifestHash: monthBundle.manifestHash,
      headAttestationHash: parseJson(monthFiles.get("attestation/bundle_head_attestation.json")).attestationHash,
      verificationReportHash: parseJson(monthFiles.get("verify/verification_report.json")).reportHash
    },
    financePack: {
      manifestHash: financeBundle.manifestHash,
      headAttestationHash: parseJson(financeFiles.get("attestation/bundle_head_attestation.json")).attestationHash,
      verificationReportHash: parseJson(financeFiles.get("verify/verification_report.json")).reportHash
    },
    invoice: {
      manifestHash: invoiceBundle.manifestHash,
      headAttestationHash: parseJson(invoiceFiles.get("attestation/bundle_head_attestation.json")).attestationHash,
      verificationReportHash: parseJson(invoiceFiles.get("verify/verification_report.json")).reportHash
    },
    agentIdentity: {
      schemaVersion: "AgentIdentity.v1",
      keyId,
      canonicalJson: agentIdentityCanonical,
      sha256: sha256Hex(agentIdentityCanonical)
    },
    agentRun: {
      schemaVersion: "AgentRun.v1",
      runId: agentRun.runId,
      status: agentRun.status,
      canonicalJson: agentRunCanonical,
      sha256: sha256Hex(agentRunCanonical)
    },
    agentEvent: {
      schemaVersion: "AgentEvent.v1",
      type: agentEvent.type,
      keyId,
      canonicalJson: agentEventCanonical,
      sha256: sha256Hex(agentEventCanonical)
    },
    agentWallet: {
      schemaVersion: "AgentWallet.v1",
      walletId: agentWallet.walletId,
      currency: agentWallet.currency,
      canonicalJson: agentWalletCanonical,
      sha256: sha256Hex(agentWalletCanonical)
    },
    agentRunSettlement: {
      schemaVersion: "AgentRunSettlement.v1",
      settlementId: agentRunSettlement.settlementId,
      status: agentRunSettlement.status,
      canonicalJson: agentRunSettlementCanonical,
      sha256: sha256Hex(agentRunSettlementCanonical)
    },
    agentReputation: {
      schemaVersion: "AgentReputation.v1",
      trustScore: agentReputation.trustScore,
      riskTier: agentReputation.riskTier,
      canonicalJson: agentReputationCanonical,
      sha256: sha256Hex(agentReputationCanonical)
    },
    agentReputationV2: {
      schemaVersion: "AgentReputation.v2",
      primaryWindow: agentReputationV2.primaryWindow,
      trustScore: agentReputationV2.trustScore,
      riskTier: agentReputationV2.riskTier,
      windowTrustScores: {
        "7d": agentReputationV2.windows?.["7d"]?.trustScore ?? null,
        "30d": agentReputationV2.windows?.["30d"]?.trustScore ?? null,
        allTime: agentReputationV2.windows?.allTime?.trustScore ?? null
      },
      canonicalJson: agentReputationV2Canonical,
      sha256: sha256Hex(agentReputationV2Canonical)
    },
    interactionDirectionMatrix: {
      schemaVersion: interactionDirectionMatrix.schemaVersion,
      directionalCount: interactionDirectionMatrix.directionalCount,
      entityTypes: interactionDirectionMatrix.entityTypes,
      canonicalJson: interactionDirectionMatrixCanonical,
      sha256: sha256Hex(interactionDirectionMatrixCanonical)
    },
    toolManifest: {
      schemaVersion: toolManifest.schemaVersion,
      toolId: toolManifest.toolId,
      manifestHash: toolManifest.manifestHash,
      signerKeyId: toolManifest.signature.signerKeyId,
      canonicalJson: toolManifestCanonical,
      sha256: sha256Hex(toolManifestCanonical)
    },
    authorityGrant: {
      schemaVersion: authorityGrant.schemaVersion,
      grantId: authorityGrant.grantId,
      grantHash: authorityGrant.grantHash,
      signerKeyId: authorityGrant.signature.signerKeyId,
      canonicalJson: authorityGrantCanonical,
      sha256: sha256Hex(authorityGrantCanonical)
    }
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
