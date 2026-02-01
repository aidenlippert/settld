import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { sha256Hex } from "../src/core/crypto.js";
import { buildFinancePackBundleV1 } from "../src/core/finance-pack-bundle.js";

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

describe("FinancePackBundle.v1 zip determinism", () => {
  it("writes identical zip bytes for identical inputs", async () => {
    const monthProofFiles = new Map([
      ["manifest.json", bytes('{"schemaVersion":"ProofBundleManifest.v1"}\n')],
      ["events/events.jsonl", bytes('{"id":"evt_1"}\n')],
      ["verify/report.json", bytes('{"ok":true}\n')]
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

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-finance-pack-zip-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files: built.files, outDir: dir });

    const zipA = path.join(tmp, "a.zip");
    const zipB = path.join(tmp, "b.zip");

    const mtime = new Date("2026-01-20T00:00:00.000Z");
    await writeZipFromDir({ dir, outPath: zipA, mtime, compression: "stored" });
    await writeZipFromDir({ dir, outPath: zipB, mtime, compression: "stored" });

    const aBytes = new Uint8Array(await fs.readFile(zipA));
    const bBytes = new Uint8Array(await fs.readFile(zipB));
    assert.equal(sha256Hex(aBytes), sha256Hex(bBytes));
    assert.equal(aBytes.byteLength, bBytes.byteLength);
  });
});

