import path from "node:path";

import { createPgStore } from "../../src/db/store-pg.js";
import { normalizeTenantId, DEFAULT_TENANT_ID } from "../../src/core/tenancy.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { buildJobProofBundleV1 } from "../../src/core/proof-bundle.js";

import { ensureDir, writeFilesToDir, writeZipFromDir } from "./lib.mjs";

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const DATABASE_URL = process.env.DATABASE_URL ?? null;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const tenantId = normalizeTenantId(process.env.TENANT_ID ?? readArg("--tenant") ?? DEFAULT_TENANT_ID);
const jobId = readArg("--job") ?? readArg("--jobId") ?? null;
if (!jobId) throw new Error("usage: DATABASE_URL=... node scripts/proof-bundle/job.mjs --job <jobId> [--out <dir>] [--zip]");

const outBase = readArg("--out") ?? path.join("demo", "proof-bundles");
const zipFlag = process.argv.includes("--zip");

const store = await createPgStore({ databaseUrl: DATABASE_URL, schema: process.env.PROXY_PG_SCHEMA ?? "public", migrateOnStartup: true });
try {
  const jobEvents = await store.listAggregateEvents({ tenantId, aggregateType: "job", aggregateId: String(jobId) });
  if (!jobEvents.length) throw new Error("job not found");
  const jobSnapshot = await store.getJob({ tenantId, jobId: String(jobId) });
  if (!jobSnapshot) throw new Error("job snapshot not found");

  const artifacts = await store.listArtifacts({ tenantId, jobId: String(jobId) });
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

  const contractDocsByHash = new Map();
  const customerContractHash = jobSnapshot?.booking?.customerContractHash ?? null;
  const operatorContractHash = jobSnapshot?.operatorContractHash ?? null;
  for (const h of [customerContractHash, operatorContractHash]) {
    if (typeof h !== "string" || !h.trim()) continue;
    if (typeof store.getContractV2ByHash === "function") {
      // eslint-disable-next-line no-await-in-loop
      const rec = await store.getContractV2ByHash({ tenantId, contractHash: String(h) });
      if (rec?.doc) contractDocsByHash.set(String(h), rec.doc);
    }
  }

  const publicKeyByKeyId = store.publicKeyByKeyId instanceof Map ? store.publicKeyByKeyId : new Map();
  const resolvedSignerKeys = (() => {
    if (typeof store.listSignerKeys !== "function") return Promise.resolve([]);
    return (async () => {
      const tenantKeys = await store.listSignerKeys({ tenantId });
      const defaultKeys = await store.listSignerKeys({ tenantId: DEFAULT_TENANT_ID });
      const all = [...(tenantKeys ?? []), ...(defaultKeys ?? [])];
      const byKeyId = new Map();
      for (const r of all) {
        const keyId = r?.keyId ? String(r.keyId) : null;
        if (!keyId) continue;
        byKeyId.set(keyId, r);
      }
      return Array.from(byKeyId.values());
    })();
  })();
  const signerKeys = await resolvedSignerKeys;
  const generatedAt = store.nowIso ? store.nowIso() : new Date().toISOString();
  const manifestSigner = store?.serverSigner ? { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem } : null;

  const { files, bundle } = buildJobProofBundleV1({
    tenantId,
    jobId: String(jobId),
    jobEvents,
    jobSnapshot,
    governanceEvents,
    governanceSnapshot,
    tenantGovernanceEvents,
    tenantGovernanceSnapshot,
    artifacts,
    contractDocsByHash,
    publicKeyByKeyId,
    signerKeys,
    manifestSigner,
    generatedAt
  });

  const outDir = path.join(outBase, `job_${tenantId}_${String(jobId)}_${bundle.manifestHash.slice(0, 12)}`);
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
