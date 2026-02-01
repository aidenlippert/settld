import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { sha256Hex } from "../src/core/crypto.js";
import { buildFinancePackBundleV1, verifyFinancePackBundleManifestV1 } from "../src/core/finance-pack-bundle.js";

function bytes(text) {
  return new TextEncoder().encode(text);
}

describe("FinancePackBundle.v1", () => {
  it("is deterministic for identical inputs", () => {
    const monthProofFiles = new Map([
      ["manifest.json", bytes('{"schemaVersion":"ProofBundleManifest.v1"}\n')],
      ["events/events.jsonl", bytes('{"id":"evt_1"}\n')]
    ]);
    const monthProofBundle = { manifestHash: sha256Hex(bytes("month_bundle")) };

    const glBatch = {
      artifactType: "GLBatch.v1",
      schemaVersion: "GLBatch.v1",
      artifactId: "gl_1",
      artifactHash: "h_gl",
      tenantId: "t",
      period: "2026-01",
      basis: "settledAt",
      batch: { lines: [] }
    };

    const journalCsv = {
      artifactType: "JournalCsv.v1",
      schemaVersion: "JournalCsv.v1",
      artifactId: "csv_1",
      artifactHash: "h_csv_art",
      tenantId: "t",
      period: "2026-01",
      basis: "settledAt",
      accountMapHash: "h_map",
      csv: "a,b\n1,2\n",
      csvSha256: "h_csv_bytes"
    };

    const reconcile = { ok: true, period: "2026-01", basis: "settledAt", entryCount: 1, totalsKeys: 1 };
    const reconcileBytes = bytes(`${canonicalJsonStringify(reconcile)}\n`);

    const a = buildFinancePackBundleV1({
      tenantId: "t",
      period: "2026-01",
      protocol: "1.0",
      createdAt: "2026-01-20T00:00:00.000Z",
      monthProofBundle,
      monthProofFiles,
      glBatchArtifact: glBatch,
      journalCsvArtifact: journalCsv,
      reconcileReport: reconcile,
      reconcileReportBytes: reconcileBytes
    });

    const b = buildFinancePackBundleV1({
      tenantId: "t",
      period: "2026-01",
      protocol: "1.0",
      createdAt: "2026-01-20T00:00:00.000Z",
      monthProofBundle,
      monthProofFiles,
      glBatchArtifact: glBatch,
      journalCsvArtifact: journalCsv,
      reconcileReport: reconcile,
      reconcileReportBytes: reconcileBytes
    });

    assert.equal(a.bundle.manifestHash, b.bundle.manifestHash);
    assert.equal(sha256Hex(Buffer.from(a.files.get("manifest.json"))), sha256Hex(Buffer.from(b.files.get("manifest.json"))));
  });

  it("detects tampering via manifest verification", () => {
    const monthProofFiles = new Map([["events/events.jsonl", bytes('{"id":"evt_1"}\n')]]);
    const monthProofBundle = { manifestHash: sha256Hex(bytes("month_bundle")) };
    const glBatch = { artifactType: "GLBatch.v1", schemaVersion: "GLBatch.v1", artifactId: "gl_1", artifactHash: "h_gl", tenantId: "t", period: "2026-01", basis: "settledAt", batch: { lines: [] } };
    const journalCsv = {
      artifactType: "JournalCsv.v1",
      schemaVersion: "JournalCsv.v1",
      artifactId: "csv_1",
      artifactHash: "h_csv_art",
      tenantId: "t",
      period: "2026-01",
      basis: "settledAt",
      accountMapHash: "h_map",
      csv: "a,b\n1,2\n",
      csvSha256: "h_csv_bytes"
    };
    const reconcile = { ok: true, period: "2026-01", basis: "settledAt", entryCount: 1, totalsKeys: 1 };
    const reconcileBytes = bytes(`${canonicalJsonStringify(reconcile)}\n`);

    const built = buildFinancePackBundleV1({
      tenantId: "t",
      period: "2026-01",
      protocol: "1.0",
      createdAt: "2026-01-20T00:00:00.000Z",
      monthProofBundle,
      monthProofFiles,
      glBatchArtifact: glBatch,
      journalCsvArtifact: journalCsv,
      reconcileReport: reconcile,
      reconcileReportBytes: reconcileBytes
    });

    const manifest = JSON.parse(new TextDecoder().decode(built.files.get("manifest.json")));
    const okBefore = verifyFinancePackBundleManifestV1({ files: built.files, manifest });
    assert.equal(okBefore.ok, true);

    // flip one byte in the CSV
    const original = built.files.get("finance/JournalCsv.v1.csv");
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 0xff;
    built.files.set("finance/JournalCsv.v1.csv", tampered);

    const okAfter = verifyFinancePackBundleManifestV1({ files: built.files, manifest });
    assert.equal(okAfter.ok, false);
    assert.equal(okAfter.error, "sha256 mismatch");
  });
});

