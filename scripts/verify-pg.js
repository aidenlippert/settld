import { logger } from "../src/core/log.js";
import { createPgPool } from "../src/db/pg.js";
import { keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { verifyChainedEvents } from "../src/core/event-chain.js";
import { verifyArtifactHash, verifySettlementBalances } from "../packages/artifact-verify/src/index.js";

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name] ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

const databaseUrl = process.env.DATABASE_URL ?? null;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const schema = process.env.PROXY_PG_SCHEMA ?? "public";
const maxStreams = parsePositiveIntEnv("VERIFY_MAX_STREAMS", 100);
const maxArtifacts = parsePositiveIntEnv("VERIFY_MAX_ARTIFACTS", 100);
const maxLedgerEntries = parseNonNegativeIntEnv("VERIFY_MAX_LEDGER_ENTRIES", 0); // 0 = all

const pool = await createPgPool({ databaseUrl, schema });

async function loadPublicKeyByKeyId() {
  const map = new Map();

  try {
    const signer = await pool.query("SELECT public_key_pem FROM server_signer WHERE id = 1");
    if (signer.rows.length) {
      const publicKeyPem = String(signer.rows[0].public_key_pem);
      const keyId = keyIdFromPublicKeyPem(publicKeyPem);
      map.set(keyId, publicKeyPem);
    }
  } catch {
    // ignore
  }

  try {
    const res = await pool.query("SELECT key_id, public_key_pem FROM public_keys");
    for (const row of res.rows) {
      if (!row?.key_id || !row?.public_key_pem) continue;
      map.set(String(row.key_id), String(row.public_key_pem));
    }
  } catch {
    // ignore
  }

  try {
    const res = await pool.query("SELECT key_id, public_key_pem FROM signer_keys");
    for (const row of res.rows) {
      if (!row?.key_id || !row?.public_key_pem) continue;
      map.set(String(row.key_id), String(row.public_key_pem));
    }
  } catch {
    // ignore
  }

  return map;
}

function journalEntryBalances(entry) {
  const postings = Array.isArray(entry?.postings) ? entry.postings : [];
  let sum = 0;
  for (const p of postings) {
    const amt = p?.amountCents;
    if (!Number.isFinite(amt) || !Number.isSafeInteger(amt)) return { ok: false, error: "invalid posting amount" };
    sum += amt;
  }
  if (sum !== 0) return { ok: false, error: "unbalanced", sum };
  return { ok: true };
}

async function verifyLedger() {
  const balancesByTenant = new Map(); // tenantId -> Map(accountId -> balance)
  let checked = 0;

  const limitClause = maxLedgerEntries > 0 ? "LIMIT $1" : "";
  const args = maxLedgerEntries > 0 ? [maxLedgerEntries] : [];
  const res = await pool.query(
    `
      SELECT tenant_id, entry_id, entry_json
      FROM ledger_entries
      ORDER BY tenant_id ASC, entry_id ASC
      ${limitClause}
    `,
    args
  );

  for (const row of res.rows) {
    const tenantId = String(row.tenant_id ?? "tenant_default");
    const entryId = String(row.entry_id ?? "");
    const entry = row.entry_json ?? null;
    const ok = journalEntryBalances(entry);
    if (!ok.ok) {
      throw new Error(`ledger entry ${tenantId}:${entryId} invalid: ${ok.error}${ok.sum !== undefined ? ` sum=${ok.sum}` : ""}`);
    }
    checked += 1;

    if (!balancesByTenant.has(tenantId)) balancesByTenant.set(tenantId, new Map());
    const b = balancesByTenant.get(tenantId);
    for (const p of entry.postings) {
      const accountId = String(p.accountId);
      b.set(accountId, (b.get(accountId) ?? 0) + p.amountCents);
    }
  }

  const balances = await pool.query("SELECT tenant_id, account_id, balance_cents FROM ledger_balances");
  for (const row of balances.rows) {
    const tenantId = String(row.tenant_id ?? "tenant_default");
    const accountId = String(row.account_id ?? "");
    const db = Number(row.balance_cents ?? 0);
    const expected = balancesByTenant.get(tenantId)?.get(accountId) ?? 0;
    if (db !== expected) {
      throw new Error(`ledger_balances mismatch ${tenantId}:${accountId}: expected ${expected}, got ${db}`);
    }
  }

  return { checked };
}

async function verifyArtifacts() {
  const res = await pool.query(
    `
      SELECT tenant_id, artifact_id, artifact_hash, artifact_json
      FROM artifacts
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [maxArtifacts]
  );

  let checked = 0;
  for (const row of res.rows) {
    const tenantId = String(row.tenant_id ?? "tenant_default");
    const artifactId = String(row.artifact_id ?? "");
    const artifactHash = row.artifact_hash ? String(row.artifact_hash) : null;
    const artifact = row.artifact_json ?? null;
    if (!artifact || typeof artifact !== "object") throw new Error(`artifact ${tenantId}:${artifactId} missing artifact_json`);
    if (artifactHash && String(artifact.artifactHash ?? "") !== artifactHash) {
      throw new Error(`artifact hash column mismatch for ${tenantId}:${artifactId}`);
    }
    const h = verifyArtifactHash(artifact);
    if (!h.ok) throw new Error(`artifact ${tenantId}:${artifactId} hash verify failed: ${h.error}`);
    const s = verifySettlementBalances(artifact);
    if (!s.ok) throw new Error(`artifact ${tenantId}:${artifactId} settlement verify failed: ${s.error}`);
    checked += 1;
  }

  return { checked };
}

async function verifyStreams() {
  const publicKeyByKeyId = await loadPublicKeyByKeyId();

  const streams = await pool.query(
    `
      SELECT tenant_id, aggregate_type, aggregate_id
      FROM snapshots
      ORDER BY tenant_id ASC, aggregate_type ASC, aggregate_id ASC
      LIMIT $1
    `,
    [maxStreams]
  );

  let checked = 0;
  for (const row of streams.rows) {
    const tenantId = String(row.tenant_id ?? "tenant_default");
    const aggregateType = String(row.aggregate_type ?? "");
    const aggregateId = String(row.aggregate_id ?? "");

    const res = await pool.query(
      `
        SELECT event_json
        FROM events
        WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
        ORDER BY seq ASC
      `,
      [tenantId, aggregateType, aggregateId]
    );
    const events = res.rows.map((r) => r.event_json).filter(Boolean);
    const verify = verifyChainedEvents(events, { publicKeyByKeyId });
    if (!verify.ok) throw new Error(`chain verify failed for ${tenantId}:${aggregateType}:${aggregateId}: ${verify.error}`);
    checked += 1;
  }

  return { checked };
}

const startedMs = Date.now();
try {
  const ledger = await verifyLedger();
  const artifacts = await verifyArtifacts();
  const streams = await verifyStreams();

  const runtimeMs = Date.now() - startedMs;
  logger.info("verify.pg.ok", { schema, runtimeMs, ledger, artifacts, streams });
  process.exit(0);
} catch (err) {
  const runtimeMs = Date.now() - startedMs;
  logger.error("verify.pg.failed", { schema, runtimeMs, err });
  process.exit(1);
} finally {
  await pool.end();
}

