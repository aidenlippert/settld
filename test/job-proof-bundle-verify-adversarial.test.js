import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { EVENT_ENVELOPE_VERSION, finalizeChainedEvent } from "../src/core/event-chain.js";
import { canonicalJsonStringify } from "../packages/artifact-verify/src/canonical-json.js";
import { sha256HexBytes, sha256HexUtf8 } from "../packages/artifact-verify/src/crypto.js";
import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/index.js";

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

function canonicalJsonlLines(values) {
  return values.map((v) => `${canonicalJsonStringify(v)}\n`).join("");
}

function buildMinimalSignedBundle() {
  const jobId = "job_adv_1";
  const tenantId = "tenant_default";
  const serverKeys = createEd25519Keypair();
  const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);
  const signer = { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem };

  const events = [];
  for (const d of [
    { id: "evt_1", at: "2026-01-01T00:00:00.000000Z", type: "JOB_CREATED", payload: { jobId } },
    { id: "evt_2", at: "2026-01-01T00:00:01.000000Z", type: "QUOTE_PROPOSED", payload: { jobId, amountCents: 1000 } },
    { id: "evt_3", at: "2026-01-01T00:00:02.000000Z", type: "BOOKED", payload: { jobId, policyHash: "cp_1" } }
  ]) {
    const base = {
      v: EVENT_ENVELOPE_VERSION,
      id: d.id,
      at: d.at,
      streamId: jobId,
      type: d.type,
      actor: { type: "server", id: "proxy" },
      payload: d.payload,
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
    const prevChainHash = events.length ? events[events.length - 1].chainHash : null;
    events.push(finalizeChainedEvent({ event: base, prevChainHash, signer }));
  }

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
  const publicKeysJson = {
    schemaVersion: "PublicKeys.v1",
    tenantId,
    generatedAt: "2026-01-01T00:00:03.000000Z",
    order: "keyId_asc",
    keys: [{ keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem }]
  };
  const publicKeysBytes = bytes(`${canonicalJsonStringify(publicKeysJson)}\n`);
  const jobSnapshot = { id: jobId, lastChainHash: events[events.length - 1].chainHash, lastEventId: events[events.length - 1].id };
  const snapshotBytes = bytes(`${canonicalJsonStringify(jobSnapshot)}\n`);

  const manifestCore = {
    schemaVersion: "ProofBundleManifest.v1",
    kind: "JobProofBundle.v1",
    tenantId,
    scope: { jobId },
    generatedAt: "2026-01-01T00:00:03.000000Z",
    files: [
      { name: "events/events.jsonl", sha256: sha256HexBytes(eventsBytes), bytes: eventsBytes.byteLength },
      { name: "events/payload_material.jsonl", sha256: sha256HexBytes(payloadMaterialBytes), bytes: payloadMaterialBytes.byteLength },
      { name: "keys/public_keys.json", sha256: sha256HexBytes(publicKeysBytes), bytes: publicKeysBytes.byteLength },
      { name: "job/snapshot.json", sha256: sha256HexBytes(snapshotBytes), bytes: snapshotBytes.byteLength }
    ]
  };
  const manifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
  const manifest = { ...manifestCore, manifestHash };

  return {
    tenantId,
    jobId,
    files: new Map([
      ["events/events.jsonl", eventsBytes],
      ["events/payload_material.jsonl", payloadMaterialBytes],
      ["keys/public_keys.json", publicKeysBytes],
      ["job/snapshot.json", snapshotBytes],
      ["manifest.json", bytes(`${canonicalJsonStringify(manifest)}\n`)]
    ])
  };
}

describe("JobProofBundle.v1 verification (adversarial integrity)", () => {
  it("fails if an event is removed without re-chaining subsequent events", async () => {
    const { files } = buildMinimalSignedBundle();

    const originalEvents = String(Buffer.from(files.get("events/events.jsonl")).toString("utf8")).trimEnd().split("\n");
    assert.equal(originalEvents.length, 3);

    // Remove the middle event line, leaving the remaining events unchanged (prevChainHash now wrong).
    const tamperedEventsJsonl = `${originalEvents[0]}\n${originalEvents[2]}\n`;
    const tamperedEventsBytes = bytes(tamperedEventsJsonl);
    files.set("events/events.jsonl", tamperedEventsBytes);

    const originalMaterial = String(Buffer.from(files.get("events/payload_material.jsonl")).toString("utf8")).trimEnd().split("\n");
    assert.equal(originalMaterial.length, 3);
    const tamperedMaterialJsonl = `${originalMaterial[0]}\n${originalMaterial[2]}\n`;
    const tamperedMaterialBytes = bytes(tamperedMaterialJsonl);
    files.set("events/payload_material.jsonl", tamperedMaterialBytes);

    // Update job snapshot head to match the now-truncated list (attacker tries to look consistent).
    const snapshot = JSON.parse(Buffer.from(files.get("job/snapshot.json")).toString("utf8"));
    snapshot.lastEventId = "evt_3";
    snapshot.lastChainHash = JSON.parse(originalEvents[2]).chainHash;
    const snapshotBytes = bytes(`${canonicalJsonStringify(snapshot)}\n`);
    files.set("job/snapshot.json", snapshotBytes);

    // Update manifest hashes to match the tampered bytes.
    const manifestCore = JSON.parse(Buffer.from(files.get("manifest.json")).toString("utf8"));
    manifestCore.files = manifestCore.files.map((f) => {
      if (f.name === "events/events.jsonl") return { ...f, sha256: sha256HexBytes(tamperedEventsBytes), bytes: tamperedEventsBytes.byteLength };
      if (f.name === "events/payload_material.jsonl") return { ...f, sha256: sha256HexBytes(tamperedMaterialBytes), bytes: tamperedMaterialBytes.byteLength };
      if (f.name === "job/snapshot.json") return { ...f, sha256: sha256HexBytes(snapshotBytes), bytes: snapshotBytes.byteLength };
      return f;
    });
    delete manifestCore.manifestHash;
    const manifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
    const manifestBytes = bytes(`${canonicalJsonStringify({ ...manifestCore, manifestHash })}\n`);
    files.set("manifest.json", manifestBytes);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-adv-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files, outDir: dir });

    const res = await verifyJobProofBundleDir({ dir });
    assert.equal(res.ok, false);
    assert.equal(res.error, "event stream integrity invalid");
  });

  it("fails if a signed event signature is tampered", async () => {
    const { files } = buildMinimalSignedBundle();
    const originalEvents = String(Buffer.from(files.get("events/events.jsonl")).toString("utf8")).trimEnd().split("\n");

    const e1 = JSON.parse(originalEvents[0]);
    e1.signature = "AAAA"; // invalid base64 for ed25519 signature length, but still decodes
    const tamperedEventsJsonl = `${canonicalJsonStringify(e1)}\n${originalEvents[1]}\n${originalEvents[2]}\n`;
    const tamperedEventsBytes = bytes(tamperedEventsJsonl);
    files.set("events/events.jsonl", tamperedEventsBytes);

    const manifestCore = JSON.parse(Buffer.from(files.get("manifest.json")).toString("utf8"));
    manifestCore.files = manifestCore.files.map((f) => {
      if (f.name === "events/events.jsonl") return { ...f, sha256: sha256HexBytes(tamperedEventsBytes), bytes: tamperedEventsBytes.byteLength };
      return f;
    });
    delete manifestCore.manifestHash;
    const manifestHash = sha256HexUtf8(canonicalJsonStringify(manifestCore));
    const manifestBytes = bytes(`${canonicalJsonStringify({ ...manifestCore, manifestHash })}\n`);
    files.set("manifest.json", manifestBytes);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-adv2-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files, outDir: dir });

    const res = await verifyJobProofBundleDir({ dir });
    assert.equal(res.ok, false);
    assert.equal(res.error, "event stream integrity invalid");
  });
});
