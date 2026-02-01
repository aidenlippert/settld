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

function computeOldFactsHashWithoutCoverage({ evaluatedAtChainHash }) {
  const facts = {
    schemaVersion: "ZoneCoverageFacts.v1",
    evaluatedAtChainHash,
    requiredZonesHash: "rz_1",
    thresholdPct: 95,
    requiredZoneIds: ["zone_a"],
    coverageByZone: [],
    excusedZones: [],
    excuseIncidentTypes: ["BLOCKED_ZONE"]
  };
  return sha256HexUtf8(canonicalJsonStringify(facts));
}

describe("JobProofBundle.v1 verification (freshness at decision time)", () => {
  it("fails if settlementProofRef points to a proof that was stale at settlement time", async () => {
    const jobId = "job_1";
    const tenantId = "tenant_default";

    const serverKeys = createEd25519Keypair();
    const robotKeys = createEd25519Keypair();
    const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);
    const robotKeyId = keyIdFromPublicKeyPem(robotKeys.publicKeyPem);
    const signers = {
      server: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
      robot: { keyId: robotKeyId, privateKeyPem: robotKeys.privateKeyPem }
    };

    const events = [];
    function push({ id, at, type, actor, payload, signer }) {
      const base = {
        v: EVENT_ENVELOPE_VERSION,
        id,
        at,
        streamId: jobId,
        type,
        actor,
        payload,
        payloadHash: null,
        prevChainHash: null,
        chainHash: null,
        signature: null,
        signerKeyId: null
      };
      const prevChainHash = events.length ? events[events.length - 1].chainHash : null;
      events.push(finalizeChainedEvent({ event: base, prevChainHash, signer: signers[signer] }));
    }

    push({
      id: "evt_book_1",
      at: "2026-01-01T00:00:00.000000Z",
      type: "BOOKED",
      actor: { type: "server", id: "proxy" },
      payload: {
        jobId,
        requiredZonesHash: "rz_1",
        requiredZones: { schemaVersion: "ZoneSet.v1", zoneSetId: "zones_1", zones: [{ zoneId: "zone_a", label: "zone_a" }] },
        policyHash: "cp_1",
        policySnapshot: { proofPolicy: { zoneCoverage: { thresholdPct: 95 }, gateMode: "strict" } }
      },
      signer: "server"
    });

    push({
      id: "evt_complete_1",
      at: "2026-01-01T00:10:00.000000Z",
      type: "EXECUTION_COMPLETED",
      actor: { type: "robot", id: "robot_1" },
      payload: { jobId },
      signer: "robot"
    });
    const completionChainHash = events[events.length - 1].chainHash;

    const oldFactsHash = computeOldFactsHashWithoutCoverage({ evaluatedAtChainHash: completionChainHash });

    push({
      id: "evt_proof_old",
      at: "2026-01-01T00:11:00.000000Z",
      type: "PROOF_EVALUATED",
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload: {
        jobId,
        evaluatedAt: "2026-01-01T00:11:00.000000Z",
        evaluatedAtChainHash: completionChainHash,
        evaluationId: "e".repeat(64),
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_ZONE_COVERAGE"],
        missingEvidence: ["ZONE_COVERAGE"],
        requiredZonesHash: "rz_1",
        customerPolicyHash: "cp_1",
        operatorPolicyHash: null,
        factsHash: oldFactsHash
      },
      signer: "server"
    });
    const proofOld = events[events.length - 1];

    // Late evidence arrives BEFORE settlement (so settlement must not be allowed to rely on old proof).
    push({
      id: "evt_cov_1",
      at: "2026-01-01T00:10:00.500000Z",
      type: "ZONE_COVERAGE_REPORTED",
      actor: { type: "robot", id: "robot_1" },
      payload: {
        jobId,
        zoneId: "zone_a",
        coveragePct: 100,
        window: { startAt: "2026-01-01T00:00:00.000000Z", endAt: "2026-01-01T00:10:00.000000Z" },
        source: "robot"
      },
      signer: "robot"
    });

    push({
      id: "evt_settle_1",
      at: "2026-01-01T00:12:00.000000Z",
      type: "SETTLED",
      actor: { type: "finance", id: "proxy" },
      payload: {
        settlementProofRef: {
          proofEventId: proofOld.id,
          proofEventAt: proofOld.payload.evaluatedAt,
          proofEventChainHash: proofOld.chainHash,
          proofEventPayloadHash: proofOld.payloadHash,
          proofEventSignerKeyId: proofOld.signerKeyId,
          proofEventSignature: proofOld.signature,
          evaluationId: proofOld.payload.evaluationId,
          evaluatedAtChainHash: proofOld.payload.evaluatedAtChainHash,
          status: proofOld.payload.status,
          reasonCodes: proofOld.payload.reasonCodes,
          requiredZonesHash: proofOld.payload.requiredZonesHash,
          customerPolicyHash: proofOld.payload.customerPolicyHash,
          operatorPolicyHash: proofOld.payload.operatorPolicyHash,
          factsHash: proofOld.payload.factsHash
        }
      },
      signer: "server"
    });

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
      keys: [
        { keyId: serverKeyId, publicKeyPem: serverKeys.publicKeyPem },
        { keyId: robotKeyId, publicKeyPem: robotKeys.publicKeyPem }
      ]
    };
    const publicKeysBytes = bytes(`${canonicalJsonStringify(publicKeysJson)}\n`);
    const jobSnapshot = { id: jobId, lastChainHash: events[events.length - 1].chainHash, lastEventId: events[events.length - 1].id };
    const snapshotBytes = bytes(`${canonicalJsonStringify(jobSnapshot)}\n`);

    const manifestCore = {
      schemaVersion: "ProofBundleManifest.v1",
      kind: "JobProofBundle.v1",
      tenantId,
      scope: { jobId },
      generatedAt: "2026-01-01T00:12:00.500000Z",
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

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-freshness-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files, outDir: dir });

    const res = await verifyJobProofBundleDir({ dir });
    assert.equal(res.ok, false);
    assert.equal(res.error, "provenance refs invalid");
    const errors = res.detail?.errors ?? [];
    assert.equal(Array.isArray(errors), true);
    assert.ok(errors.some((e) => e?.error === "settlement stale at decision time"));
  });
});
