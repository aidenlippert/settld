import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem, sha256Hex } from "../src/core/crypto.js";
import { computeArtifactHash } from "../src/core/artifacts.js";
import { createChainedEvent, appendChainedEvent } from "../src/core/event-chain.js";
import { buildMonthProofBundleV1 } from "../src/core/proof-bundle.js";
import { buildFinancePackBundleV1 } from "../src/core/finance-pack-bundle.js";
import { GOVERNANCE_STREAM_ID } from "../src/core/governance.js";
import { DEFAULT_TENANT_ID } from "../src/core/tenancy.js";

import { verifyFinancePackBundleDir } from "../packages/artifact-verify/src/index.js";
import { writeZipFromDir } from "../scripts/proof-bundle/lib.mjs";

function bytes(text) {
  return new TextEncoder().encode(text);
}

async function writeFilesToDir({ files, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  for (const [name, content] of files.entries()) {
    const full = path.join(outDir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(content));
  }
}

async function runCli(args) {
  const proc = spawn("node", ["packages/artifact-verify/bin/settld-verify.js", ...args], {
    cwd: process.cwd(),
    stdio: "pipe"
  });
  const stdout = [];
  const stderr = [];
  proc.stdout.on("data", (d) => stdout.push(d));
  proc.stderr.on("data", (d) => stderr.push(d));
  const code = await new Promise((resolve) => proc.on("exit", resolve));
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

test("FinancePackBundle.v1 strict verification succeeds (MonthProof strict + signed VerificationReport)", async () => {
  const tenantId = "tenant_strict_finance_pack";
  const period = "2026-01";
  const createdAt = "2026-02-02T00:00:00.000Z";
  const generatedAt = createdAt;

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
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

  const monthEvents = [];
  const monthReq = createChainedEvent({
    streamId: `month_${period}`,
    type: "MONTH_CLOSE_REQUESTED",
    at: "2026-02-02T00:00:00.000Z",
    actor: { type: "system", id: "proxy" },
    payload: { period, basis: "settledAt" }
  });
  monthEvents.push(...appendChainedEvent({ events: monthEvents, event: monthReq, signer }));

  const glBatch = {
    artifactType: "GLBatch.v1",
    schemaVersion: "GLBatch.v1",
    artifactId: "gl_1",
    tenantId,
    period,
    basis: "settledAt",
    batch: { lines: [] }
  };
  glBatch.artifactHash = computeArtifactHash(glBatch);

  const csvText = "a,b\n1,2\n";
  const csvSha256 = sha256Hex(new TextEncoder().encode(csvText));
  const journalCsv = {
    artifactType: "JournalCsv.v1",
    schemaVersion: "JournalCsv.v1",
    artifactId: "csv_1",
    tenantId,
    period,
    basis: "settledAt",
    accountMapHash: "h_map",
    csv: csvText,
    csvSha256
  };
  journalCsv.artifactHash = computeArtifactHash(journalCsv);

  const reconcile = { ok: true, period, basis: "settledAt", entryCount: 0, totalsKeys: 0 };
  const reconcileBytes = bytes(`${canonicalJsonStringify(reconcile)}\n`);

  const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
    tenantId,
    period,
    basis: "settledAt",
    monthEvents,
    governanceEvents,
    governanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents.slice(-1)[0]?.chainHash ?? null, lastEventId: governanceEvents.slice(-1)[0]?.id ?? null },
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null },
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys: [],
    manifestSigner: signer,
    requireHeadAttestation: true,
    generatedAt
  });

  const built = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol: "1.0",
    createdAt,
    monthProofBundle: monthBundle,
    monthProofFiles: monthFiles,
    requireMonthProofAttestation: true,
    verificationReportSigner: signer,
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport: reconcile,
    reconcileReportBytes: reconcileBytes
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-finance-pack-strict-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files: built.files, outDir: dir });

  const ok = await verifyFinancePackBundleDir({ dir, strict: true });
  assert.equal(ok.ok, true, JSON.stringify(ok, null, 2));

  const zipPath = path.join(tmp, "bundle.zip");
  await writeZipFromDir({ dir, outPath: zipPath, mtime: new Date(createdAt), compression: "stored" });
  const cli = await runCli(["--strict", "--finance-pack", zipPath]);
  assert.equal(cli.code, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /finance-pack: OK/);
});

test("FinancePackBundle.v1 strict verification fails if verification report is unsigned", async () => {
  const tenantId = "tenant_strict_finance_pack_unsigned";
  const period = "2026-01";
  const createdAt = "2026-02-02T00:00:00.000Z";

  const { publicKeyPem, privateKeyPem } = createEd25519Keypair();
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

  const monthEvents = [];
  const monthReq = createChainedEvent({
    streamId: `month_${period}`,
    type: "MONTH_CLOSE_REQUESTED",
    at: "2026-02-02T00:00:00.000Z",
    actor: { type: "system", id: "proxy" },
    payload: { period, basis: "settledAt" }
  });
  monthEvents.push(...appendChainedEvent({ events: monthEvents, event: monthReq, signer }));

  const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
    tenantId,
    period,
    basis: "settledAt",
    monthEvents,
    governanceEvents,
    governanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: governanceEvents.slice(-1)[0]?.chainHash ?? null, lastEventId: governanceEvents.slice(-1)[0]?.id ?? null },
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot: { streamId: GOVERNANCE_STREAM_ID, lastChainHash: null, lastEventId: null },
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys: [],
    manifestSigner: signer,
    requireHeadAttestation: true,
    generatedAt: createdAt
  });

  const glBatch = { artifactType: "GLBatch.v1", schemaVersion: "GLBatch.v1", artifactId: "gl_1", tenantId, period, basis: "settledAt", batch: { lines: [] } };
  glBatch.artifactHash = computeArtifactHash(glBatch);
  const journalCsv = {
    artifactType: "JournalCsv.v1",
    schemaVersion: "JournalCsv.v1",
    artifactId: "csv_1",
    tenantId,
    period,
    basis: "settledAt",
    accountMapHash: "h_map",
    csv: "a,b\n1,2\n",
    csvSha256: sha256Hex(new TextEncoder().encode("a,b\n1,2\n"))
  };
  journalCsv.artifactHash = computeArtifactHash(journalCsv);
  const reconcile = { ok: true, period, basis: "settledAt", entryCount: 0, totalsKeys: 0 };
  const reconcileBytes = bytes(`${canonicalJsonStringify(reconcile)}\n`);

  const built = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol: "1.0",
    createdAt,
    monthProofBundle: monthBundle,
    monthProofFiles: monthFiles,
    requireMonthProofAttestation: true,
    verificationReportSigner: null,
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport: reconcile,
    reconcileReportBytes: reconcileBytes
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-finance-pack-strict-unsigned-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files: built.files, outDir: dir });

  const res = await verifyFinancePackBundleDir({ dir, strict: true });
  assert.equal(res.ok, false);
  assert.equal(res.error, "verification report invalid");
});

