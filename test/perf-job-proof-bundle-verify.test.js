import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { buildJobProofBundleV1 } from "../src/core/proof-bundle.js";

import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/job-proof-bundle.js";
import { writeFilesToDir } from "../scripts/proof-bundle/lib.mjs";

test("perf: verifyJobProofBundleDir baseline (skipped unless SETTLD_PERF_TESTS=1)", { skip: process.env.SETTLD_PERF_TESTS !== "1" }, async () => {
  const tenantId = "tenant_default";
  const jobId = "job_perf_verify_1";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);

  const jobEvents = [];
  let prev = null;
  for (let i = 0; i < 10_000; i += 1) {
    const e = createChainedEvent({
      streamId: jobId,
      type: i === 0 ? "JOB_CREATED" : "TELEMETRY_HEARTBEAT",
      at: `2026-01-01T00:00:${String(Math.floor(i / 100) % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}000Z`,
      actor: { type: "ops", id: "perf" },
      payload: { jobId, i }
    });
    const fin = finalizeChainedEvent({ event: e, prevChainHash: prev, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } });
    prev = fin.chainHash;
    jobEvents.push(fin);
  }

  const jobSnapshot = { id: jobId, lastChainHash: jobEvents[jobEvents.length - 1].chainHash, lastEventId: jobEvents[jobEvents.length - 1].id };
  const publicKeyByKeyId = new Map([[serverKeyId, serverKeys.publicKeyPem]]);

  const { files } = buildJobProofBundleV1({
    tenantId,
    jobId,
    jobEvents,
    jobSnapshot,
    governanceEvents: [],
    governanceSnapshot: { streamId: "governance", lastChainHash: null, lastEventId: null },
    tenantGovernanceEvents: [],
    tenantGovernanceSnapshot: { streamId: "governance", lastChainHash: null, lastEventId: null },
    artifacts: [],
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys: [{ tenantId, keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem, status: "ACTIVE", purpose: "SIGNER" }],
    manifestSigner: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
    generatedAt
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-perf-job-proof-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });

  const t0 = Date.now();
  const res = await verifyJobProofBundleDir({ dir, strict: true });
  const dtMs = Date.now() - t0;

  assert.equal(res.ok, true);
  // Baseline only: set a generous bound and tune per CI hardware later.
  assert.ok(dtMs < 15_000, `verification took too long: ${dtMs}ms`);
});

