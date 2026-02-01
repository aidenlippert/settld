import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { sha256Hex } from "../src/core/crypto.js";
import { buildFinancePackBundleV1 } from "../src/core/finance-pack-bundle.js";
import { computeArtifactHash } from "../src/core/artifacts.js";

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

describe("FinancePackBundle.v1 verification", () => {
  it("verifies a bundle dir and zip", async () => {
    const monthProofFiles = new Map([
      ["manifest.json", bytes(`{"schemaVersion":"ProofBundleManifest.v1","manifestHash":"${sha256Hex(bytes("month_bundle"))}"}\n`)],
      ["events/events.jsonl", bytes('{"id":"evt_1","type":"MONTH_CLOSE_REQUESTED"}\n')]
    ]);
    const monthProofBundle = { manifestHash: sha256Hex(bytes("month_bundle")) };

    const glBatch = {
      artifactType: "GLBatch.v1",
      schemaVersion: "GLBatch.v1",
      artifactId: "gl_1",
      tenantId: "t",
      period: "2026-01",
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
      tenantId: "t",
      period: "2026-01",
      basis: "settledAt",
      accountMapHash: "h_map",
      csv: csvText,
      csvSha256
    };
    journalCsv.artifactHash = computeArtifactHash(journalCsv);

    // This test isn't about reconcile correctness; only about bundle structure/hashes.
    const reconcile = { ok: true, period: "2026-01", basis: "settledAt", entryCount: 0, totalsKeys: 0 };
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

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-finance-pack-verify-"));
    const dir = path.join(tmp, "bundle");
    await writeFilesToDir({ files: built.files, outDir: dir });

    const ok = await verifyFinancePackBundleDir({ dir });
    assert.equal(ok.ok, true);

    const zipPath = path.join(tmp, "bundle.zip");
    await writeZipFromDir({ dir, outPath: zipPath, mtime: new Date("2026-01-20T00:00:00.000Z"), compression: "stored" });

    const cli = await runCli(["--finance-pack", zipPath]);
    assert.equal(cli.code, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /finance-pack: OK/);
  });
});
