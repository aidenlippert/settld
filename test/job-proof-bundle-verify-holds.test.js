import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { EVENT_ENVELOPE_VERSION, finalizeChainedEvent } from "../src/core/event-chain.js";
import { canonicalJsonStringify } from "../packages/artifact-verify/src/canonical-json.js";
import { sha256HexBytes, sha256HexUtf8 } from "../packages/artifact-verify/src/crypto.js";
import { verifyJobProofBundleDir } from "../packages/artifact-verify/src/index.js";
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

function canonicalJsonlLines(values) {
  return values.map((v) => `${canonicalJsonStringify(v)}\n`).join("");
}

function computeFactsHashV1({ evaluatedAtChainHash, requiredZonesHash, requiredZoneIds }) {
  const facts = {
    schemaVersion: "ZoneCoverageFacts.v1",
    evaluatedAtChainHash,
    requiredZonesHash,
    thresholdPct: 95,
    requiredZoneIds: [...new Set(requiredZoneIds)].sort(),
    coverageByZone: [],
    excusedZones: [],
    excuseIncidentTypes: ["BLOCKED_ZONE"]
  };
  return sha256HexUtf8(canonicalJsonStringify(facts));
}

describe("JobProofBundle.v1 verification (hold provenance + full chain integrity)", () => {
  it("verifies hold triggering/releasing proof refs (dir + zip)", async () => {
    const jobId = "job_1";
    const tenantId = "tenant_default";
    const evaluatedAtChainHash = null; // placeholder until completion event is finalized

    const serverKeys = createEd25519Keypair();
    const robotKeys = createEd25519Keypair();
    const serverKeyId = keyIdFromPublicKeyPem(serverKeys.publicKeyPem);
    const robotKeyId = keyIdFromPublicKeyPem(robotKeys.publicKeyPem);

    const signers = {
      server: { keyId: serverKeyId, privateKeyPem: serverKeys.privateKeyPem },
      robot: { keyId: robotKeyId, privateKeyPem: robotKeys.privateKeyPem }
    };

    const drafts = [
      {
        id: "evt_quote_1",
        at: "2026-01-01T00:00:00.000000Z",
        type: "QUOTE_PROPOSED",
        actor: { type: "server", id: "proxy" },
        payload: { jobId, amountCents: 1000, currency: "USD" },
        signer: "server"
      },
      {
        id: "evt_book_1",
        at: "2026-01-01T00:00:00.500000Z",
        type: "BOOKED",
        actor: { type: "server", id: "proxy" },
        payload: {
          jobId,
          requiredZonesHash: "rz_1",
          requiredZones: { schemaVersion: "ZoneSet.v1", zoneSetId: "zones_1", zones: [{ zoneId: "zone_default", label: "zone_default" }] },
          policyHash: "cp_1",
          policySnapshot: { proofPolicy: { zoneCoverage: { thresholdPct: 95 }, gateMode: "holdback" }, holdbackPolicy: { holdPercent: 100 } }
        },
        signer: "server"
      },
      {
        id: "evt_complete_1",
        at: "2026-01-01T00:00:01.000000Z",
        type: "EXECUTION_COMPLETED",
        actor: { type: "robot", id: "robot_1" },
        payload: { jobId },
        signer: "robot"
      }
    ];

    const events = [];
    for (const d of drafts) {
      const base = {
        v: EVENT_ENVELOPE_VERSION,
        id: d.id,
        at: d.at,
        streamId: jobId,
        type: d.type,
        actor: d.actor,
        payload: d.payload,
        payloadHash: null,
        prevChainHash: null,
        chainHash: null,
        signature: null,
        signerKeyId: null
      };
      const prevChainHash = events.length ? events[events.length - 1].chainHash : null;
      events.push(finalizeChainedEvent({ event: base, prevChainHash, signer: signers[d.signer] }));
    }

    const completionChainHash = events[events.length - 1].chainHash;
    assert.ok(completionChainHash);

    const factsHash = computeFactsHashV1({
      evaluatedAtChainHash: completionChainHash,
      requiredZonesHash: "rz_1",
      requiredZoneIds: ["zone_default"]
    });

    const proofHeldBase = {
      v: EVENT_ENVELOPE_VERSION,
      id: "evt_proof_held_1",
      at: "2026-01-01T00:00:01.250000Z",
      streamId: jobId,
      type: "PROOF_EVALUATED",
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload: {
        jobId,
        evaluatedAt: "2026-01-01T00:00:01.250000Z",
        evaluatedAtChainHash: completionChainHash,
        evaluationId: "e".repeat(64),
        customerPolicyHash: "cp_1",
        operatorPolicyHash: null,
        requiredZonesHash: "rz_1",
        factsHash,
        status: "INSUFFICIENT_EVIDENCE",
        reasonCodes: ["MISSING_ZONE_COVERAGE"],
        missingEvidence: ["ZONE_COVERAGE"],
        triggeredFacts: null,
        metrics: null
      },
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
    events.push(finalizeChainedEvent({ event: proofHeldBase, prevChainHash: events[events.length - 1].chainHash, signer: signers.server }));
    const proofHeld = events[events.length - 1];

    const holdId = `hold_${"a".repeat(64)}`;
    const heldBase = {
      v: EVENT_ENVELOPE_VERSION,
      id: "evt_hold_1",
      at: "2026-01-01T00:00:01.300000Z",
      streamId: jobId,
      type: "SETTLEMENT_HELD",
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload: {
        jobId,
        holdId,
        heldAt: "2026-01-01T00:00:01.300000Z",
        evaluatedAtChainHash: completionChainHash,
        customerPolicyHash: "cp_1",
        operatorPolicyHash: null,
        factsHash,
        triggeringProofRef: {
          proofEventId: proofHeld.id,
          proofEventAt: proofHeld.payload.evaluatedAt,
          proofEventChainHash: proofHeld.chainHash,
          proofEventPayloadHash: proofHeld.payloadHash,
          proofEventSignerKeyId: proofHeld.signerKeyId,
          proofEventSignature: proofHeld.signature,
          evaluationId: proofHeld.payload.evaluationId,
          evaluatedAtChainHash: proofHeld.payload.evaluatedAtChainHash,
          status: proofHeld.payload.status,
          reasonCodes: proofHeld.payload.reasonCodes,
          requiredZonesHash: proofHeld.payload.requiredZonesHash,
          customerPolicyHash: proofHeld.payload.customerPolicyHash,
          operatorPolicyHash: proofHeld.payload.operatorPolicyHash,
          factsHash: proofHeld.payload.factsHash
        },
        reasonCodes: proofHeld.payload.reasonCodes,
        missingEvidence: proofHeld.payload.missingEvidence,
        pricingAnchor: {
          quoteEventId: "evt_quote_1",
          quoteEventChainHash: events[0].chainHash,
          quoteEventPayloadHash: events[0].payloadHash,
          customerPolicyHash: "cp_1",
          operatorPolicyHash: null,
          evaluatedAtChainHash: completionChainHash
        },
        exposure: {
          expected: { currency: "USD", amountGrossCents: 1000, amountNetCents: 900, coverageFeeCents: 100, splits: { platformFeeCents: 0 } },
          holdPolicy: { gateMode: "holdback", insufficientEvidenceMode: "ALLOW", holdPercent: 100 },
          held: { currency: "USD", amountGrossCents: 1000, amountNetCents: 900, coverageFeeCents: 100, splits: { platformFeeCents: 0 } }
        }
      },
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
    events.push(finalizeChainedEvent({ event: heldBase, prevChainHash: events[events.length - 1].chainHash, signer: signers.server }));

    const proofPassBase = {
      v: EVENT_ENVELOPE_VERSION,
      id: "evt_proof_pass_1",
      at: "2026-01-01T00:00:02.000000Z",
      streamId: jobId,
      type: "PROOF_EVALUATED",
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload: {
        jobId,
        evaluatedAt: "2026-01-01T00:00:02.000000Z",
        evaluatedAtChainHash: completionChainHash,
        evaluationId: "d".repeat(64),
        customerPolicyHash: "cp_1",
        operatorPolicyHash: null,
        requiredZonesHash: "rz_1",
        factsHash,
        status: "PASS",
        reasonCodes: [],
        missingEvidence: [],
        triggeredFacts: null,
        metrics: null
      },
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
    events.push(finalizeChainedEvent({ event: proofPassBase, prevChainHash: events[events.length - 1].chainHash, signer: signers.server }));
    const proofPass = events[events.length - 1];

    const releasedBase = {
      v: EVENT_ENVELOPE_VERSION,
      id: "evt_release_1",
      at: "2026-01-01T00:00:02.100000Z",
      streamId: jobId,
      type: "SETTLEMENT_RELEASED",
      actor: { type: "proof", id: "proof_verifier_v1" },
      payload: {
        jobId,
        holdId,
        releasedAt: "2026-01-01T00:00:02.100000Z",
        releaseReason: "PROOF_FINAL",
        releasingProofRef: {
          proofEventId: proofPass.id,
          proofEventAt: proofPass.payload.evaluatedAt,
          proofEventChainHash: proofPass.chainHash,
          proofEventPayloadHash: proofPass.payloadHash,
          proofEventSignerKeyId: proofPass.signerKeyId,
          proofEventSignature: proofPass.signature,
          evaluationId: proofPass.payload.evaluationId,
          evaluatedAtChainHash: proofPass.payload.evaluatedAtChainHash,
          status: proofPass.payload.status,
          reasonCodes: proofPass.payload.reasonCodes,
          requiredZonesHash: proofPass.payload.requiredZonesHash,
          customerPolicyHash: proofPass.payload.customerPolicyHash,
          operatorPolicyHash: proofPass.payload.operatorPolicyHash,
          factsHash: proofPass.payload.factsHash
        }
      },
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
    events.push(finalizeChainedEvent({ event: releasedBase, prevChainHash: events[events.length - 1].chainHash, signer: signers.server }));

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

    const files = new Map([
      ["events/events.jsonl", eventsBytes],
      ["events/payload_material.jsonl", payloadMaterialBytes],
      ["keys/public_keys.json", publicKeysBytes],
      ["job/snapshot.json", snapshotBytes],
      ["manifest.json", bytes(`${canonicalJsonStringify(manifest)}\n`)]
    ]);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-job-proof-verify-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files, outDir: dir });

    const ok = await verifyJobProofBundleDir({ dir });
    assert.equal(ok.ok, true);
    assert.equal(ok.provenanceRefs?.checked > 0, true);
    assert.equal(ok.eventStream?.ok, true);

    const zipPath = path.join(tmp, "bundle.zip");
    await writeZipFromDir({ dir, outPath: zipPath, mtime: new Date("2026-01-01T00:00:03.000000Z"), compression: "stored" });

    const cli = await runCli(["--job-proof", zipPath]);
    assert.equal(cli.code, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /job-proof: OK/);
  });
});
