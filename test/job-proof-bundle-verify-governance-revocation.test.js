import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";
import { canonicalJsonlLines } from "../src/core/proof-bundle.js";

import { canonicalJsonStringify } from "../packages/artifact-verify/src/canonical-json.js";
import { sha256HexBytes, sha256HexUtf8 } from "../packages/artifact-verify/src/crypto.js";
import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/job-proof-bundle.js";
import { writeFilesToDir } from "../scripts/proof-bundle/lib.mjs";

function bytes(text) {
  return new TextEncoder().encode(String(text));
}

test("JobProofBundle.v1 verification derives server key revocation from governance stream (does not trust keys metadata)", async () => {
  const tenantId = "tenant_default";
  const jobId = "job_gov_revocation_1";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);

  // Governance stream: revoke server key at t=00:00:00.
  const govEvents = [];
  const g1 = createChainedEvent({
    streamId: "governance",
    type: "SERVER_SIGNER_KEY_REVOKED",
    at: "2026-01-01T00:00:00.000000Z",
    actor: { type: "finance", id: "admin" },
    payload: { tenantId, keyId: serverKeyId, revokedAt: "2026-01-01T00:00:00.000000Z", reason: "compromised" }
  });
  govEvents.push(finalizeChainedEvent({ event: g1, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const govMaterial = govEvents.map((e) => ({
    v: e.v,
    id: e.id,
    at: e.at,
    streamId: e.streamId,
    type: e.type,
    actor: e.actor,
    payload: e.payload
  }));

  // Job stream: a server-signed event after revocation.
  const jobEvents = [];
  const j1 = createChainedEvent({
    streamId: jobId,
    type: "JOB_CREATED",
    at: "2026-01-01T00:00:01.000000Z",
    actor: { type: "ops", id: "sys" },
    payload: { jobId }
  });
  jobEvents.push(finalizeChainedEvent({ event: j1, prevChainHash: null, signer: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem } }));

  const jobMaterial = jobEvents.map((e) => ({
    v: e.v,
    id: e.id,
    at: e.at,
    streamId: e.streamId,
    type: e.type,
    actor: e.actor,
    payload: e.payload
  }));

  const jobEventsBytes = bytes(canonicalJsonlLines(jobEvents));
  const jobMaterialBytes = bytes(canonicalJsonlLines(jobMaterial));
  const govEventsBytes = bytes(canonicalJsonlLines(govEvents));
  const govMaterialBytes = bytes(canonicalJsonlLines(govMaterial));

  // keys/public_keys.json has no revokedAt metadata (should still fail because governance says revoked).
  const publicKeysJson = {
    schemaVersion: "PublicKeys.v1",
    tenantId,
    generatedAt,
    order: "keyId_asc",
    keys: [{ keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem }]
  };
  const publicKeysBytes = bytes(`${canonicalJsonStringify(publicKeysJson)}\n`);

  const jobSnapshot = { id: jobId, lastChainHash: jobEvents[jobEvents.length - 1].chainHash, lastEventId: jobEvents[jobEvents.length - 1].id };
  const snapshotBytes = bytes(`${canonicalJsonStringify(jobSnapshot)}\n`);
  const govSnapshot = { streamId: "governance", lastChainHash: govEvents[govEvents.length - 1].chainHash, lastEventId: govEvents[govEvents.length - 1].id };
  const govSnapshotBytes = bytes(`${canonicalJsonStringify(govSnapshot)}\n`);

  const manifestCore = {
    schemaVersion: "ProofBundleManifest.v1",
    kind: "JobProofBundle.v1",
    tenantId,
    scope: { jobId },
    generatedAt,
    files: [
      { name: "events/events.jsonl", sha256: sha256HexBytes(jobEventsBytes), bytes: jobEventsBytes.byteLength },
      { name: "events/payload_material.jsonl", sha256: sha256HexBytes(jobMaterialBytes), bytes: jobMaterialBytes.byteLength },
      { name: "governance/events/events.jsonl", sha256: sha256HexBytes(govEventsBytes), bytes: govEventsBytes.byteLength },
      { name: "governance/events/payload_material.jsonl", sha256: sha256HexBytes(govMaterialBytes), bytes: govMaterialBytes.byteLength },
      { name: "governance/snapshot.json", sha256: sha256HexBytes(govSnapshotBytes), bytes: govSnapshotBytes.byteLength },
      { name: "keys/public_keys.json", sha256: sha256HexBytes(publicKeysBytes), bytes: publicKeysBytes.byteLength },
      { name: "job/snapshot.json", sha256: sha256HexBytes(snapshotBytes), bytes: snapshotBytes.byteLength }
    ]
  };
  const manifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  const manifest = { ...manifestCore, manifestHash };

  const files = new Map([
    ["events/events.jsonl", jobEventsBytes],
    ["events/payload_material.jsonl", jobMaterialBytes],
    ["governance/events/events.jsonl", govEventsBytes],
    ["governance/events/payload_material.jsonl", govMaterialBytes],
    ["governance/snapshot.json", govSnapshotBytes],
    ["keys/public_keys.json", publicKeysBytes],
    ["job/snapshot.json", snapshotBytes],
    ["manifest.json", bytes(`${canonicalJsonStringify(manifest)}\n`)]
  ]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-gov-revoke-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });

  const res = await verifyJobProofBundleDir({ dir });
  assert.equal(res.ok, false);
  assert.equal(res.error, "event stream integrity invalid");
  assert.equal(res.detail?.reason, "KEY_REVOKED");
});

