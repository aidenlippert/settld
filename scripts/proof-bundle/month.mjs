import path from "node:path";

import { createPgStore } from "../../src/db/store-pg.js";
import { normalizeTenantId, DEFAULT_TENANT_ID } from "../../src/core/tenancy.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { MONTH_CLOSE_BASIS, makeMonthCloseStreamId } from "../../src/core/month-close.js";
import { buildMonthProofBundleV1 } from "../../src/core/proof-bundle.js";

import { ensureDir, writeFilesToDir, writeZipFromDir } from "./lib.mjs";

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const DATABASE_URL = process.env.DATABASE_URL ?? null;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const tenantId = normalizeTenantId(process.env.TENANT_ID ?? readArg("--tenant") ?? DEFAULT_TENANT_ID);
const period = readArg("--period") ?? readArg("--month") ?? null;
if (!period) throw new Error("usage: DATABASE_URL=... node scripts/proof-bundle/month.mjs --period YYYY-MM [--out <dir>] [--zip]");

const basis = String(readArg("--basis") ?? MONTH_CLOSE_BASIS.SETTLED_AT);
const outBase = readArg("--out") ?? path.join("demo", "proof-bundles");
const zipFlag = process.argv.includes("--zip");

const store = await createPgStore({ databaseUrl: DATABASE_URL, schema: process.env.PROXY_PG_SCHEMA ?? "public", migrateOnStartup: true });
try {
  const monthId = makeMonthCloseStreamId({ month: String(period), basis });
  const monthEvents = await store.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: monthId });
  if (!monthEvents.length) throw new Error("month close stream not found");

  const artifacts = await store.listArtifacts({ tenantId });
  const monthArtifacts = artifacts.filter((a) => {
    if (!a || typeof a !== "object") return false;
    if (a.period && String(a.period) === String(period)) return true; // GLBatch.v1
    if (a.month && String(a.month) === String(period)) return true; // MonthlyStatement.v1
    if (a.period && String(a.period) === String(period)) return true; // PartyStatement/PayoutInstruction include period
    return false;
  });

  const publicKeyByKeyId = store.publicKeyByKeyId instanceof Map ? store.publicKeyByKeyId : new Map();
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
  const generatedAt = store.nowIso ? store.nowIso() : new Date().toISOString();
  const manifestSigner = store?.serverSigner ? { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } : null;
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

  const { files, bundle } = buildMonthProofBundleV1({
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

  const outDir = path.join(outBase, `month_${tenantId}_${String(period)}_${bundle.manifestHash.slice(0, 12)}`);
  ensureDir(outDir);
  writeFilesToDir({ files, outDir });

  if (zipFlag) {
    const zipPath = `${outDir}.zip`;
    await writeZipFromDir({ dir: outDir, outPath: zipPath });
    process.stdout.write(`${zipPath}\n`);
  } else {
    process.stdout.write(`${outDir}\n`);
  }
} finally {
  await store.close?.();
}
