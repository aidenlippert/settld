import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { canonicalJsonlLines } from "../src/core/proof-bundle.js";
import { createChainedEvent, finalizeChainedEvent } from "../src/core/event-chain.js";

import { canonicalJsonStringify } from "../packages/artifact-verify/src/canonical-json.js";
import { sha256HexBytes, sha256HexUtf8 } from "../packages/artifact-verify/src/crypto.js";
import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/job-proof-bundle.js";
import { writeFilesToDir } from "../scripts/proof-bundle/lib.mjs";

function bytes(text) {
  return new TextEncoder().encode(String(text));
}

test("JobProofBundle.v1 verification does not enforce revokedAt for non-server-required signer kinds", async () => {
  const tenantId = "tenant_default";
  const jobId = "job_key_validity_2";
  const generatedAt = "2026-01-01T00:00:03.000000Z";

  const robotKeys = createEd25519Keypair();
  const robotKeyId = keyIdFromPublicKeyPem(robotKeys.publicKeyPem);

  // Use an event type that requires a robot signer.
  const events = [];
  const e1 = createChainedEvent({
    streamId: jobId,
    type: "JOB_HEARTBEAT",
    at: "2026-01-01T00:00:02.000000Z",
    actor: { type: "robot", id: "rob1" },
    payload: { beat: 1 }
  });
  events.push(finalizeChainedEvent({ event: e1, prevChainHash: null, signer: { keyId: robotKeyId, privateKeyPem: robotKeys.privateKeyPem } }));

  const payloadMaterial = events.map((e) => ({
    v: e.v,
    id: e.id,
    at: e.at,
    streamId: e.streamId,
    type: e.type,
    actor: e.actor,
    payload: e.payload
  }));

  const eventsBytes = bytes(canonicalJsonlLines(events));
  const payloadMaterialBytes = bytes(canonicalJsonlLines(payloadMaterial));

  // Revoked long before event.at. For robot keys, we do not use revokedAt to reject signatures offline.
  const publicKeysJson = {
    schemaVersion: "PublicKeys.v1",
    tenantId,
    generatedAt,
    order: "keyId_asc",
    keys: [{ keyId: robotKeyId, publicKeyPem: robotKeys.publicKeyPem, purpose: "robot", revokedAt: "2025-01-01T00:00:00.000000Z" }]
  };
  const publicKeysBytes = bytes(`${canonicalJsonStringify(publicKeysJson)}\n`);

  const jobSnapshot = { id: jobId, lastChainHash: events[events.length - 1].chainHash, lastEventId: events[events.length - 1].id };
  const snapshotBytes = bytes(`${canonicalJsonStringify(jobSnapshot)}\n`);

  const manifestCore = {
    schemaVersion: "ProofBundleManifest.v1",
    kind: "JobProofBundle.v1",
    tenantId,
    scope: { jobId },
    generatedAt,
    files: [
      { name: "events/events.jsonl", sha256: sha256HexBytes(eventsBytes), bytes: eventsBytes.byteLength },
      { name: "events/payload_material.jsonl", sha256: sha256HexBytes(payloadMaterialBytes), bytes: payloadMaterialBytes.byteLength },
      { name: "keys/public_keys.json", sha256: sha256HexBytes(publicKeysBytes), bytes: publicKeysBytes.byteLength },
      { name: "job/snapshot.json", sha256: sha256HexBytes(snapshotBytes), bytes: snapshotBytes.byteLength }
    ]
  };
  const manifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  const manifest = { ...manifestCore, manifestHash };

  const files = new Map([
    ["events/events.jsonl", eventsBytes],
    ["events/payload_material.jsonl", payloadMaterialBytes],
    ["keys/public_keys.json", publicKeysBytes],
    ["job/snapshot.json", snapshotBytes],
    ["manifest.json", bytes(`${canonicalJsonStringify(manifest)}\n`)]
  ]);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-key-validity-nonserver-"));
  const dir = path.join(tmp, "bundle");
  await writeFilesToDir({ files, outDir: dir });

  const res = await verifyJobProofBundleDir({ dir });
  assert.equal(res.ok, true);
});

