import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { resetDeterministicIds } from "../src/core/ids.js";
import { createChainedEvent, appendChainedEvent } from "../src/core/event-chain.js";
import { keyIdFromPublicKeyPem, sha256Hex } from "../src/core/crypto.js";
import { buildJobProofBundleV1, buildMonthProofBundleV1 } from "../src/core/proof-bundle.js";
import { buildFinancePackBundleV1 } from "../src/core/finance-pack-bundle.js";
import { GOVERNANCE_STREAM_ID } from "../src/core/governance.js";
import { DEFAULT_TENANT_ID } from "../src/core/tenancy.js";
import { computeArtifactHash } from "../src/core/artifacts.js";
import { canonicalJsonStringify } from "../src/core/canonical-json.js";

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

async function buildVectorsV1() {
  process.env.PROXY_DETERMINISTIC_IDS = "1";
  resetDeterministicIds();

  const tenantId = "tenant_vectors";
  const jobId = "job_det_00000001";
  const period = "2026-01";
  const generatedAt = "2026-02-01T00:00:00.000Z";
  const createdAt = "2026-02-01T00:00:00.000Z";

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
    signerKeys: [{ tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z", serverGoverned: true }],
    manifestSigner: signer,
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
    signerKeys: [{ tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z", serverGoverned: true }],
    manifestSigner: signer,
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

  const { files: financeFiles, bundle: financeBundle } = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol: "1.0",
    createdAt,
    monthProofBundle: monthBundle,
    monthProofFiles: monthFiles,
    requireMonthProofAttestation: true,
    requireHeadAttestation: true,
    manifestSigner: signer,
    verificationReportSigner: signer,
    toolVersion: "0.0.0-vectors",
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport,
    reconcileReportBytes: reconcileBytes
  });

  return {
    schemaVersion: "ProtocolVectors.v1",
    generatedAt,
    signer: { keyId },
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
    }
  };
}

test("protocol golden vectors (v1) stay stable", async () => {
  const fixturePath = path.resolve(process.cwd(), "test/fixtures/protocol-vectors/v1.json");
  const expected = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const actual = await buildVectorsV1();
  assert.deepEqual(actual, expected);
});

