import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { buildJobProofBundleV1 } from "../src/core/proof-bundle.js";
import { GOVERNANCE_STREAM_ID } from "../src/core/governance.js";

import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/job-proof-bundle.js";
import { writeFilesToDir } from "../scripts/proof-bundle/lib.mjs";

test("JobProofBundle.v1 strict verification succeeds with dual-scope governance streams (and governed server signer)", async () => {
  const tenantId = "tenant_default";
  const jobId = "job_strict_dual_gov_1";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);

  const jobEvents = [];
  const e1 = createChainedEvent({
    streamId: jobId,
    type: "JOB_CREATED",
    at: "2026-01-01T00:00:01.000000Z",
    actor: { type: "ops", id: "sys" },
    payload: { jobId }
  });
  jobEvents.push(finalizeChainedEvent({ event: e1, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const jobSnapshot = { id: jobId, lastChainHash: jobEvents[jobEvents.length - 1].chainHash, lastEventId: jobEvents[jobEvents.length - 1].id };

  const tenantGovernanceEvents = [];
  const governanceEvents = [];
  const g0 = createChainedEvent({
    streamId: GOVERNANCE_STREAM_ID,
    type: "SERVER_SIGNER_KEY_REGISTERED",
    at: "2026-01-01T00:00:00.000000Z",
    actor: { type: "ops", id: "bootstrap" },
    payload: { tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, registeredAt: "2026-01-01T00:00:00.000000Z" }
  });
  governanceEvents.push(finalizeChainedEvent({ event: g0, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const tenantGovernanceSnapshot = { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null };
  const governanceSnapshot = { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents[0].chainHash, lastEventId: governanceEvents[0].id };

  const publicKeyByKeyId = new Map([[serverKeyId, serverKeys.publicKeyPem]]);
  const signerKeys = [{ tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, status: "ACTIVE", purpose: "SIGNER" }];

  const { files } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents,
    tenantGovernanceSnapshot,
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys,
    manifestSigner: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
    generatedAt
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-strict-dual-gov-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });

  const res = await verifyJobProofBundleDir({ dir, strict: true });
  assert.equal(res.ok, true);
  assert.equal(res.strict, true);
  assert.ok(Array.isArray(res.warnings));
});

test("JobProofBundle.v1 strict verification fails when verify/verification_report.json is missing", async () => {
  const tenantId = "tenant_default";
  const jobId = "job_strict_missing_report_1";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);

  const jobEvents = [];
  const e1 = createChainedEvent({
    streamId: jobId,
    type: "JOB_CREATED",
    at: "2026-01-01T00:00:01.000000Z",
    actor: { type: "ops", id: "sys" },
    payload: { jobId }
  });
  jobEvents.push(finalizeChainedEvent({ event: e1, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const jobSnapshot = { id: jobId, lastChainHash: jobEvents[jobEvents.length - 1].chainHash, lastEventId: jobEvents[jobEvents.length - 1].id };

  const governanceEvents = [];
  const g0 = createChainedEvent({
    streamId: GOVERNANCE_STREAM_ID,
    type: "SERVER_SIGNER_KEY_REGISTERED",
    at: "2026-01-01T00:00:00.000000Z",
    actor: { type: "ops", id: "bootstrap" },
    payload: { tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, registeredAt: "2026-01-01T00:00:00.000000Z" }
  });
  governanceEvents.push(finalizeChainedEvent({ event: g0, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const tenantGovernanceSnapshot = { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null };
  const governanceSnapshot = { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents[0].chainHash, lastEventId: governanceEvents[0].id };

  const publicKeyByKeyId = new Map([[serverKeyId, serverKeys.publicKeyPem]]);
  const signerKeys = [{ tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, status: "ACTIVE", purpose: "SIGNER" }];

  const { files } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot,
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys,
    manifestSigner: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
    generatedAt
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-strict-missing-report-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });
  await fs.rm(path.join(dir, "verify", "verification_report.json"));

  const res = await verifyJobProofBundleDir({ dir, strict: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, "missing verify/verification_report.json");
});

test("JobProofBundle.v1 strict verification fails when governance streams are missing", async () => {
  const tenantId = "tenant_default";
  const jobId = "job_strict_missing_gov_1";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);

  const jobEvents = [];
  const e1 = createChainedEvent({
    streamId: jobId,
    type: "JOB_CREATED",
    at: "2026-01-01T00:00:01.000000Z",
    actor: { type: "ops", id: "sys" },
    payload: { jobId }
  });
  jobEvents.push(finalizeChainedEvent({ event: e1, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const jobSnapshot = { id: jobId, lastChainHash: jobEvents[jobEvents.length - 1].chainHash, lastEventId: jobEvents[jobEvents.length - 1].id };

  const publicKeyByKeyId = new Map([[serverKeyId, serverKeys.publicKeyPem]]);
  const signerKeys = [{ tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, status: "ACTIVE", purpose: "SIGNER" }];

  // Intentionally omit governance streams from the bundle.
  const { files } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys,
    manifestSigner: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
    generatedAt
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-strict-missing-gov-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });

  const res = await verifyJobProofBundleDir({ dir, strict: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, "manifest missing required files");
});
