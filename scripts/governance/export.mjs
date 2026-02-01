import path from "node:path";

import { createPgStore } from "../../src/db/store-pg.js";
import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { sha256Hex, signHashHexEd25519 } from "../../src/core/crypto.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../src/core/tenancy.js";
import { GOVERNANCE_STREAM_ID } from "../../src/core/governance.js";
import { canonicalJsonlLines, computeProofBundleManifestV1 } from "../../src/core/proof-bundle.js";

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
      "  DATABASE_URL=... node scripts/governance/export.mjs [--tenant <tenantId>] [--out <dir>] [--zip]",
      "",
      "notes:",
      "  - exports both governance scopes: tenant + global",
      "  - output is self-contained (events + snapshots + keys + manifest + head attestation)"
    ].join("\n")
  );
  process.exit(2);
}

const DATABASE_URL = process.env.DATABASE_URL ?? null;
if (!DATABASE_URL) usageAndExit();

const tenantId = normalizeTenantId(process.env.TENANT_ID ?? readArg("--tenant") ?? DEFAULT_TENANT_ID);
const outBase = readArg("--out") ?? path.join("demo", "governance-export");
const zipFlag = process.argv.includes("--zip");

const store = await createPgStore({ databaseUrl: DATABASE_URL, schema: process.env.PROXY_PG_SCHEMA ?? "public", migrateOnStartup: true });
try {
  const generatedAt = store.nowIso ? store.nowIso() : new Date().toISOString();

  const tenantEvents = await store.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
  const globalEvents = await store.listAggregateEvents({ tenantId: DEFAULT_TENANT_ID, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });

  const tenantSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: tenantEvents.length ? tenantEvents[tenantEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: tenantEvents.length ? tenantEvents[tenantEvents.length - 1]?.id ?? null : null
  };
  const globalSnapshot = {
    streamId: GOVERNANCE_STREAM_ID,
    lastChainHash: globalEvents.length ? globalEvents[globalEvents.length - 1]?.chainHash ?? null : null,
    lastEventId: globalEvents.length ? globalEvents[globalEvents.length - 1]?.id ?? null : null
  };

  const files = new Map();

  function writeGovernanceScope(scope, events, snapshot) {
    const payloadMaterial = events.map((e) => ({
      v: e?.v ?? null,
      id: e?.id ?? null,
      at: e?.at ?? null,
      streamId: e?.streamId ?? null,
      type: e?.type ?? null,
      actor: e?.actor ?? null,
      payload: e?.payload ?? null
    }));
    files.set(`governance/${scope}/events/events.jsonl`, new TextEncoder().encode(canonicalJsonlLines(events)));
    files.set(`governance/${scope}/events/payload_material.jsonl`, new TextEncoder().encode(canonicalJsonlLines(payloadMaterial)));
    files.set(`governance/${scope}/snapshot.json`, new TextEncoder().encode(`${canonicalJsonStringify(snapshot)}\n`));
  }

  writeGovernanceScope("tenant", tenantEvents, tenantSnapshot);
  writeGovernanceScope("global", globalEvents, globalSnapshot);

  // keys/public_keys.json: include keys used to sign any governance event.
  const signerKeyIds = Array.from(
    new Set([...tenantEvents, ...globalEvents].map((e) => (typeof e?.signerKeyId === "string" ? e.signerKeyId : null)).filter(Boolean))
  ).sort();
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

  const metaByKeyId = new Map();
  for (const r of signerKeys) {
    if (!r || typeof r !== "object") continue;
    const kid = typeof r.keyId === "string" && r.keyId.trim() ? r.keyId : null;
    if (!kid) continue;
    metaByKeyId.set(kid, r);
  }

  const keys = [];
  for (const keyId of signerKeyIds) {
    const publicKeyPem = publicKeyByKeyId.get(keyId) ?? null;
    if (!publicKeyPem) continue;
    const meta = metaByKeyId.get(keyId) ?? null;
    keys.push({
      keyId,
      publicKeyPem: String(publicKeyPem),
      tenantId: meta?.tenantId ?? tenantId,
      purpose: meta?.purpose ?? null,
      status: meta?.status ?? null,
      createdAt: meta?.createdAt ?? null,
      rotatedAt: meta?.rotatedAt ?? null,
      revokedAt: meta?.revokedAt ?? null
    });
  }
  keys.sort((a, b) => String(a.keyId).localeCompare(String(b.keyId)));
  const publicKeysFile = { schemaVersion: "PublicKeys.v1", tenantId, generatedAt, order: "keyId_asc", keys };
  files.set("keys/public_keys.json", new TextEncoder().encode(`${canonicalJsonStringify(publicKeysFile)}\n`));

  const kind = "GovernanceExport.v1";
  const scope = { tenantId };
  const { manifest, manifestHash } = computeProofBundleManifestV1({ files, generatedAt, kind, tenantId, scope });
  files.set("manifest.json", new TextEncoder().encode(`${canonicalJsonStringify({ ...manifest, manifestHash })}\n`));

  // Head attestation (server-signed).
  if (store?.serverSigner?.privateKeyPem) {
    const attCore = {
      schemaVersion: "BundleHeadAttestation.v1",
      kind,
      tenantId,
      scope,
      generatedAt,
      manifestHash,
      heads: {
        governance: {
          tenant: { lastChainHash: tenantSnapshot.lastChainHash, lastEventId: tenantSnapshot.lastEventId },
          global: { lastChainHash: globalSnapshot.lastChainHash, lastEventId: globalSnapshot.lastEventId }
        }
      },
      signedAt: generatedAt,
      signerKeyId: store.serverSigner.keyId
    };
    const attestationHash = sha256Hex(canonicalJsonStringify(attCore));
    const signature = signHashHexEd25519(attestationHash, store.serverSigner.privateKeyPem);
    const att = { ...attCore, attestationHash, signature };
    files.set("attestation/bundle_head_attestation.json", new TextEncoder().encode(`${canonicalJsonStringify(att)}\n`));
  }

  const outDir = path.join(outBase, `gov_${tenantId}_${manifestHash.slice(0, 12)}`);
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

