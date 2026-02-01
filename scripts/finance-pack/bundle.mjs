import fs from "node:fs";
import path from "node:path";

import { createPgStore } from "../../src/db/store-pg.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../src/core/tenancy.js";
import { MONTH_CLOSE_BASIS, makeMonthCloseStreamId, reduceMonthClose } from "../../src/core/month-close.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { buildMonthProofBundleV1 } from "../../src/core/proof-bundle.js";
import { buildFinancePackBundleV1 } from "../../src/core/finance-pack-bundle.js";
import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { reconcileGlBatchAgainstPartyStatements } from "../../packages/artifact-verify/src/index.js";

import { ensureDir, writeFilesToDir, writeZipFromDir } from "../proof-bundle/lib.mjs";

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function usageAndExit() {
  // eslint-disable-next-line no-console
  console.error(
    [
      "usage:",
      "  PG mode:",
      "    DATABASE_URL=... node scripts/finance-pack/bundle.mjs --period YYYY-MM [--tenant <tenantId>] [--basis settledAt] [--out <dir>] [--zip]",
      "  From-dir mode (no DB):",
      "    node scripts/finance-pack/bundle.mjs --from <pilot_output_dir> [--out <dir>] [--zip]"
    ].join("\n")
  );
  process.exit(2);
}

function pickLatestArtifact(list) {
  const sorted = [...list].sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")));
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function readJsonFile(filepath) {
  const raw = fs.readFileSync(filepath, "utf8");
  return JSON.parse(raw);
}

function readTextFileUtf8(filepath) {
  return fs.readFileSync(filepath, "utf8");
}

function readFilesRecursive({ dir }) {
  const files = new Map();
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = path.relative(dir, full).split(path.sep).join("/");
      files.set(rel, new Uint8Array(fs.readFileSync(full)));
    }
  }
  return files;
}

function loadArtifactsFromDir(dirpath) {
  if (!fs.existsSync(dirpath)) return [];
  const entries = fs.readdirSync(dirpath, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json"));
  const out = [];
  for (const e of entries) {
    const a = readJsonFile(path.join(dirpath, e.name));
    if (a && typeof a === "object") out.push(a);
  }
  return out;
}

const fromDir = readArg("--from");
const outBase = readArg("--out") ?? path.join("demo", "finance-pack", "bundles");
const zipFlag = process.argv.includes("--zip");

if (fromDir) {
  const root = path.resolve(fromDir);
  const monthDir = path.join(root, "proof", "month");
  if (!fs.existsSync(monthDir) || !fs.statSync(monthDir).isDirectory()) {
    throw new Error(`--from must point at a pilot output dir containing proof/month (missing: ${monthDir})`);
  }

  const monthEventsPath = path.join(monthDir, "events", "events.jsonl");
  const rawEvents = readTextFileUtf8(monthEventsPath)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const req = rawEvents.find((e) => e?.type === "MONTH_CLOSE_REQUESTED") ?? null;
  if (!req) throw new Error("MONTH_CLOSE_REQUESTED not found in proof/month/events/events.jsonl");

  const tenantId = normalizeTenantId(readArg("--tenant") ?? String(req.payload?.tenantId ?? DEFAULT_TENANT_ID));
  const period = String(readArg("--period") ?? readArg("--month") ?? req.payload?.month ?? "");
  const basis = String(req.payload?.basis ?? MONTH_CLOSE_BASIS.SETTLED_AT);
  if (!period) throw new Error("period missing (use --period or ensure MONTH_CLOSE_REQUESTED has payload.month)");
  const createdAt = String(req.payload?.requestedAt ?? req.at ?? new Date().toISOString());

  const monthManifest = readJsonFile(path.join(monthDir, "manifest.json"));
  const monthProofBundle = { manifestHash: String(monthManifest?.manifestHash ?? "") };
  if (!monthProofBundle.manifestHash) throw new Error("proof/month/manifest.json missing manifestHash");

  const monthProofFiles = readFilesRecursive({ dir: monthDir });

  const glBatchPath = path.join(root, "GLBatch.v1.json");
  const glBatch = fs.existsSync(glBatchPath)
    ? readJsonFile(glBatchPath)
    : pickLatestArtifact(loadArtifactsFromDir(path.join(monthDir, "artifacts", "GLBatch.v1")));
  if (!glBatch) throw new Error("missing GLBatch.v1.json (expected at root or proof/month/artifacts/GLBatch.v1)");

  const journalCsvPath = path.join(root, "JournalCsv.v1.json");
  const journalCsv = fs.existsSync(journalCsvPath)
    ? readJsonFile(journalCsvPath)
    : pickLatestArtifact(loadArtifactsFromDir(path.join(monthDir, "artifacts", "JournalCsv.v1")));
  if (!journalCsv) throw new Error("missing JournalCsv.v1.json (expected at root or proof/month/artifacts/JournalCsv.v1)");

  const partyStatements = loadArtifactsFromDir(path.join(monthDir, "artifacts", "PartyStatement.v1"));
  if (!partyStatements.length) throw new Error("missing PartyStatement.v1 artifacts under proof/month/artifacts/PartyStatement.v1");

  const reconcile = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements });
  if (!reconcile.ok) {
    const err = new Error(`reconcile failed: ${reconcile.error}`);
    err.detail = reconcile;
    throw err;
  }

  const protocol = String(readArg("--protocol") ?? "1.0");
  const reconcileBytes = new TextEncoder().encode(`${canonicalJsonStringify(reconcile)}\n`);
  const { files, bundle } = buildFinancePackBundleV1({
    tenantId,
    period,
    protocol,
    createdAt,
    monthProofBundle,
    monthProofFiles,
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport: reconcile,
    reconcileReportBytes: reconcileBytes
  });

  const outDir = path.join(outBase, `finance_pack_${tenantId}_${String(period)}_${bundle.manifestHash.slice(0, 12)}`);
  ensureDir(outDir);
  writeFilesToDir({ files, outDir });

  if (zipFlag) {
    const zipPath = `${outDir}.zip`;
    await writeZipFromDir({ dir: outDir, outPath: zipPath, mtime: new Date(createdAt), compression: "stored" });
    process.stdout.write(`${zipPath}\n`);
  } else {
    process.stdout.write(`${outDir}\n`);
  }
  process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL ?? null;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (or use --from)");

const tenantId = normalizeTenantId(process.env.TENANT_ID ?? readArg("--tenant") ?? DEFAULT_TENANT_ID);
const period = readArg("--period") ?? readArg("--month") ?? null;
if (!period) usageAndExit();

const basis = String(readArg("--basis") ?? MONTH_CLOSE_BASIS.SETTLED_AT);

const store = await createPgStore({ databaseUrl: DATABASE_URL, schema: process.env.PROXY_PG_SCHEMA ?? "public", migrateOnStartup: true });
try {
  const monthId = makeMonthCloseStreamId({ month: String(period), basis });
  const monthEvents = await store.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: monthId });
  if (!monthEvents.length) throw new Error("month close stream not found");
  const monthState = reduceMonthClose(monthEvents);
  const createdAt =
    (typeof monthState?.requestedAt === "string" && monthState.requestedAt.trim() ? monthState.requestedAt : null) ??
    (typeof monthEvents[0]?.at === "string" ? monthEvents[0].at : null) ??
    new Date().toISOString();

  const artifacts = await store.listArtifacts({ tenantId });
  const monthArtifacts = artifacts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    if (a.period && String(a.period) === String(period)) return true;
    if (a.month && String(a.month) === String(period)) return true;
    return false;
  });

  const glBatch = pickLatestArtifact(monthArtifacts.filter((a) => a?.artifactType === "GLBatch.v1"));
  if (!glBatch) throw new Error("missing GLBatch.v1 for period");

  const journalCsv = pickLatestArtifact(monthArtifacts.filter((a) => a?.artifactType === "JournalCsv.v1"));
  if (!journalCsv) throw new Error("missing JournalCsv.v1 for period");

  const partyStatements = monthArtifacts.filter((a) => a?.artifactType === "PartyStatement.v1");
  if (!partyStatements.length) throw new Error("missing PartyStatement.v1 artifacts for period");

  const reconcile = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements });
  if (!reconcile.ok) {
    const err = new Error(`reconcile failed: ${reconcile.error}`);
    err.detail = reconcile;
    throw err;
  }

  const publicKeyByKeyId = store.publicKeyByKeyId instanceof Map ? store.publicKeyByKeyId : new Map();
  const manifestSigner = store?.serverSigner ? { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } : null;
  let signerKeys = [];
  if (typeof store.listSignerKeys === "function") {
    const tenantKeys = await store.listSignerKeys({ tenantId });
    const defaultKeys = await store.listSignerKeys({ tenantId: DEFAULT_TENANT_ID });
    const all = [...(tenantKeys ?? []), ...(defaultKeys ?? [])];
    const byKeyId = new Map();
    for (const r of all) {
      const keyId = r?.keyId ? String(r.keyId) : null;
      if (!keyId) continue;
      byKeyId.set(keyId, r);
    }
    signerKeys = Array.from(byKeyId.values());
  }
  const tenantGovernanceEvents = await store.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
  const tenantGovernanceSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: tenantGovernanceEvents.length ? tenantGovernanceEvents[tenantGovernanceEvents.length - 1]?.id ?? null : null
  };
  const governanceEvents = await store.listAggregateEvents({ tenantId: DEFAULT_TENANT_ID, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
  const governanceSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: governanceEvents.length ? governanceEvents[governanceEvents.length - 1]?.id ?? null : null
  };
  const generatedAt = createdAt;
  const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
    tenantId,
    period: String(period),
    basis,
    monthEvents,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents,
    tenantGovernanceSnapshot,
    artifacts: monthArtifacts,
    contractDocsByHash: new Map(),
    publicKeyByKeyId,
    signerKeys,
    manifestSigner,
    requireHeadAttestation: true,
    generatedAt
  });

  const protocol = "1.0";
  const reconcileBytes = new TextEncoder().encode(`${canonicalJsonStringify(reconcile)}\n`);
  const { files, bundle } = buildFinancePackBundleV1({
    tenantId,
    period: String(period),
    protocol,
    createdAt,
    monthProofBundle: monthBundle,
    monthProofFiles: monthFiles,
    requireMonthProofAttestation: true,
    verificationReportSigner: manifestSigner,
    glBatchArtifact: glBatch,
    journalCsvArtifact: journalCsv,
    reconcileReport: reconcile,
    reconcileReportBytes: reconcileBytes
  });

  const outDir = path.join(outBase, `finance_pack_${tenantId}_${String(period)}_${bundle.manifestHash.slice(0, 12)}`);
  ensureDir(outDir);
  writeFilesToDir({ files, outDir });

  if (zipFlag) {
    const zipPath = `${outDir}.zip`;
    await writeZipFromDir({ dir: outDir, outPath: zipPath, mtime: new Date(createdAt), compression: "stored" });
    process.stdout.write(`${zipPath}\n`);
  } else {
    process.stdout.write(`${outDir}\n`);
  }
} finally {
  await store.close?.();
}
