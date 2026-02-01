#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJsonStringify } from "../src/canonical-json.js";
import {
  reconcileGlBatchAgainstPartyStatements,
  verifyArtifactHash,
  verifyArtifactVersion,
  verifyFinancePackBundleDir,
  verifyJobProofBundleDir,
  verifySettlementBalances
} from "../src/index.js";

function usage() {
  // eslint-disable-next-line no-console
  console.error("usage:");
  console.error("  settld-verify <artifact.json> [artifact2.json ...]");
  console.error("  settld-verify --reconcile <month-proof-bundle-dir>");
  console.error("  settld-verify [--strict] [--report-json <path>] --job-proof <JobProofBundle.v1.zip|dir>");
  console.error("  settld-verify [--strict] [--report-json <path>] --finance-pack <FinancePackBundle.v1.zip|dir>");
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(current, e.name);
      if (e.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(fp);
      } else if (e.isFile()) {
        out.push(fp);
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

async function unzipToTemp(zipPath) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "settld-finance-pack-"));
  const pyCode = `
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
  `.trim();
  const py = spawn(
    "python3",
    [
      "-c",
      pyCode,
      zipPath,
      tmp
    ],
    { stdio: "inherit" }
  );

  await new Promise((resolve, reject) => {
    py.on("error", reject);
    py.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`python3 unzip failed with exit code ${code}`))));
  });
  return tmp;
}

async function main() {
  const rawArgs = process.argv.slice(2).filter(Boolean);
  let strict = false;
  let reportJsonPath = null;
  const args = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = rawArgs[i];
    if (a === "--strict") {
      strict = true;
      continue;
    }
    if (a === "--report-json") {
      reportJsonPath = rawArgs[i + 1] ?? null;
      if (!reportJsonPath) {
        usage();
        process.exit(2);
      }
      i += 1;
      continue;
    }
    args.push(a);
  }
  if (!args.length) {
    usage();
    process.exit(2);
  }

  if (args[0] === "--reconcile") {
    const dir = args[1] ?? null;
    if (!dir) {
      usage();
      process.exit(2);
    }

    const files = await listFilesRecursive(dir);
    const glCandidates = files.filter((fp) => fp.includes(`${path.sep}artifacts${path.sep}GLBatch.v1${path.sep}`) && fp.endsWith(".json"));
    const psCandidates = files.filter((fp) => fp.includes(`${path.sep}artifacts${path.sep}PartyStatement.v1${path.sep}`) && fp.endsWith(".json"));

    if (glCandidates.length !== 1) {
      // eslint-disable-next-line no-console
      console.error(`reconcile: expected exactly 1 GLBatch.v1 artifact, got ${glCandidates.length}`);
      process.exit(1);
    }
    if (!psCandidates.length) {
      // eslint-disable-next-line no-console
      console.error("reconcile: expected at least 1 PartyStatement.v1 artifact, got 0");
      process.exit(1);
    }

    const glBatch = JSON.parse(await fs.readFile(glCandidates[0], "utf8"));
    const partyStatements = [];
    for (const fp of psCandidates) {
      // eslint-disable-next-line no-await-in-loop
      partyStatements.push(JSON.parse(await fs.readFile(fp, "utf8")));
    }

    const result = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`reconcile: FAILED (${result.error})`);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`reconcile: OK (period=${result.period} basis=${result.basis} entries=${result.entryCount})`);
    process.exit(0);
  }

  if (args[0] === "--finance-pack") {
    const target = args[1] ?? null;
    if (!target) {
      usage();
      process.exit(2);
    }

    const resolved = path.resolve(target);
    const dir = resolved.endsWith(".zip") ? await unzipToTemp(resolved) : resolved;
    const result = await verifyFinancePackBundleDir({ dir, strict });
    if (reportJsonPath) await fs.writeFile(reportJsonPath, canonicalJsonStringify(result) + "\n", "utf8");
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`finance-pack: FAILED (${result.error})`);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`finance-pack: OK (tenant=${result.tenantId} period=${result.period})`);
    process.exit(0);
  }

  if (args[0] === "--job-proof") {
    const target = args[1] ?? null;
    if (!target) {
      usage();
      process.exit(2);
    }

    const resolved = path.resolve(target);
    const dir = resolved.endsWith(".zip") ? await unzipToTemp(resolved) : resolved;
    const result = await verifyJobProofBundleDir({ dir, strict });
    if (reportJsonPath) await fs.writeFile(reportJsonPath, canonicalJsonStringify(result) + "\n", "utf8");
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error(`job-proof: FAILED (${result.error})`);
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result, null, 2));
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`job-proof: OK (tenant=${result.tenantId ?? "?"} kind=${result.kind ?? "?"})`);
    process.exit(0);
  }

  let okAll = true;
  for (const fp of args) {
    let json;
    try {
      const raw = await fs.readFile(fp, "utf8");
      json = JSON.parse(raw);
    } catch (err) {
      okAll = false;
      // eslint-disable-next-line no-console
      console.error(`${fp}: FAILED (invalid JSON) ${err?.message ?? ""}`.trim());
      continue;
    }

    const hash = verifyArtifactHash(json);
    if (!hash.ok) {
      okAll = false;
      // eslint-disable-next-line no-console
      console.error(`${fp}: FAILED (${hash.error})`);
      continue;
    }

    const ver = verifyArtifactVersion(json);
    if (!ver.ok) {
      okAll = false;
      // eslint-disable-next-line no-console
      console.error(`${fp}: FAILED (${ver.error})`);
      continue;
    }

    const bal = verifySettlementBalances(json);
    if (!bal.ok) {
      okAll = false;
      // eslint-disable-next-line no-console
      console.error(`${fp}: FAILED (${bal.error})`);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`${fp}: VERIFIED`);
  }

  process.exit(okAll ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
