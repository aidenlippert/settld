import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv/dist/2020.js";

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

async function loadSchemas() {
  const base = path.resolve(process.cwd(), "docs/spec/schemas");
  const names = (await fs.readdir(base)).filter((n) => n.endsWith(".json")).sort();
  const schemas = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(base, name), "utf8");
    schemas.push(JSON.parse(raw));
  }
  return schemas;
}

async function loadTestSigner() {
  const p = path.resolve(process.cwd(), "test/fixtures/keys/ed25519_test_keypair.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function buildMinimalBundles() {
  process.env.PROXY_DETERMINISTIC_IDS = "1";
  resetDeterministicIds();

  const tenantId = "tenant_schema_test";
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

  const signerKeys = [{ tenantId: DEFAULT_TENANT_ID, keyId, publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z", serverGoverned: true }];

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

  const job = buildJobProofBundleV1({
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
    signerKeys,
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

  const month = buildMonthProofBundleV1({
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
    signerKeys,
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

  const finance = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol: "1.0",
    createdAt,
    monthProofBundle: month.bundle,
    monthProofFiles: month.files,
    requireMonthProofAttestation: true,
    requireHeadAttestation: true,
    manifestSigner: signer,
    verificationReportSigner: signer,
    toolVersion: "0.0.0-schema-test",
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport,
    reconcileReportBytes: reconcileBytes
  });

  return { job, month, finance };
}

test("docs/spec/schemas validate real generated bundles (smoke)", async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const schema of await loadSchemas()) {
    if (schema && typeof schema === "object" && typeof schema.$id === "string") ajv.addSchema(schema, schema.$id);
  }

  const validateReport = ajv.getSchema("https://settld.local/schemas/VerificationReport.v1.schema.json");
  const validateAttestation = ajv.getSchema("https://settld.local/schemas/BundleHeadAttestation.v1.schema.json");
  const validateProofManifest = ajv.getSchema("https://settld.local/schemas/ProofBundleManifest.v1.schema.json");
  const validateFinanceManifest = ajv.getSchema("https://settld.local/schemas/FinancePackBundleManifest.v1.schema.json");
  const validateKeys = ajv.getSchema("https://settld.local/schemas/PublicKeys.v1.schema.json");

  assert.ok(validateReport);
  assert.ok(validateAttestation);
  assert.ok(validateProofManifest);
  assert.ok(validateFinanceManifest);
  assert.ok(validateKeys);

  const { job, month, finance } = await buildMinimalBundles();

  // Proof bundles
  assert.equal(validateProofManifest(parseJson(job.files.get("manifest.json"))), true);
  assert.equal(validateAttestation(parseJson(job.files.get("attestation/bundle_head_attestation.json"))), true);
  assert.equal(validateReport(parseJson(job.files.get("verify/verification_report.json"))), true);
  assert.equal(validateKeys(parseJson(job.files.get("keys/public_keys.json"))), true);

  assert.equal(validateProofManifest(parseJson(month.files.get("manifest.json"))), true);
  assert.equal(validateAttestation(parseJson(month.files.get("attestation/bundle_head_attestation.json"))), true);
  assert.equal(validateReport(parseJson(month.files.get("verify/verification_report.json"))), true);
  assert.equal(validateKeys(parseJson(month.files.get("keys/public_keys.json"))), true);

  // FinancePack
  assert.equal(validateFinanceManifest(parseJson(finance.files.get("manifest.json"))), true);
  assert.equal(validateAttestation(parseJson(finance.files.get("attestation/bundle_head_attestation.json"))), true);
  assert.equal(validateReport(parseJson(finance.files.get("verify/verification_report.json"))), true);
});

test("schema catches missing required fields (smoke)", async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const schema of await loadSchemas()) {
    if (schema && typeof schema === "object" && typeof schema.$id === "string") ajv.addSchema(schema, schema.$id);
  }
  const validateReport = ajv.getSchema("https://settld.local/schemas/VerificationReport.v1.schema.json");
  assert.ok(validateReport);

  const examplePath = path.resolve(process.cwd(), "docs/spec/examples/verification_report_v1.example.json");
  const example = JSON.parse(await fs.readFile(examplePath, "utf8"));
  assert.equal(validateReport(example), true);

  const broken = { ...example };
  // eslint-disable-next-line no-prototype-builtins
  assert.equal(Object.prototype.hasOwnProperty.call(broken, "subject"), true);
  delete broken.subject;
  assert.equal(validateReport(broken), false);
});
