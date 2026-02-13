/**
 * Verifies restored DB state matches expected digests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const expectedPath = process.argv[2];
if (!expectedPath) throw new Error("usage: node scripts/backup-restore/verify-state.mjs /path/to/expected.json");

const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));

// Compute actual by reusing capture-state with the current env vars.
// We inline-import capture-state and intercept stdout by calling its logic directly.
import pg from "pg";
import { canonicalJsonStringify } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";
import { normalizeTenantId } from "../../src/core/tenancy.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const TENANT_ID = normalizeTenantId(process.env.TENANT_ID ?? expected?.tenantId ?? "tenant_default");
const SCHEMA = (() => {
  const raw = String(process.env.PROXY_PG_SCHEMA ?? "public").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    throw new Error("PROXY_PG_SCHEMA must match [A-Za-z_][A-Za-z0-9_]*");
  }
  return raw;
})();

function digestRows(rows) {
  return sha256Hex(canonicalJsonStringify(rows));
}

const { Client } = pg;
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
await client.query(`SET search_path TO "${SCHEMA}", public`);

const tenantCountRes = await client.query("SELECT COUNT(DISTINCT tenant_id)::int AS n FROM snapshots");
const jobCountRes = await client.query("SELECT COUNT(*)::int AS n FROM snapshots WHERE tenant_id = $1 AND aggregate_type = 'job'", [TENANT_ID]);
const ledgerEntryCountRes = await client.query("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE tenant_id = $1", [TENANT_ID]);
const allocationCountRes = await client.query("SELECT COUNT(*)::int AS n FROM ledger_allocations WHERE tenant_id = $1", [TENANT_ID]);
const artifactCountRes = await client.query("SELECT COUNT(*)::int AS n FROM artifacts WHERE tenant_id = $1", [TENANT_ID]);
const partyStatementCountRes = await client.query("SELECT COUNT(*)::int AS n FROM party_statements WHERE tenant_id = $1", [TENANT_ID]);

const artifactsRes = await client.query(
  `
    SELECT artifact_id, artifact_type, artifact_hash
    FROM artifacts
    WHERE tenant_id = $1
      AND artifact_type IN ('SettlementStatement.v1','MonthlyStatement.v1','PartyStatement.v1','PayoutInstruction.v1')
    ORDER BY artifact_type ASC, artifact_id ASC
  `,
  [TENANT_ID]
);
const artifactsDigest = digestRows(
  artifactsRes.rows.map((r) => ({
    artifactId: String(r.artifact_id),
    artifactType: String(r.artifact_type),
    artifactHash: String(r.artifact_hash)
  }))
);

const ledgerEntriesRes = await client.query(
  `
    SELECT entry_id, entry_json
    FROM ledger_entries
    WHERE tenant_id = $1
    ORDER BY entry_id ASC
  `,
  [TENANT_ID]
);
const ledgerDigest = digestRows(
  ledgerEntriesRes.rows.map((r) => ({
    entryId: String(r.entry_id),
    entry: r.entry_json ?? null
  }))
);

const allocRes = await client.query(
  `
    SELECT entry_id, posting_id, account_id, party_id, party_role, currency, amount_cents
    FROM ledger_allocations
    WHERE tenant_id = $1
    ORDER BY entry_id ASC, posting_id ASC, party_id ASC
  `,
  [TENANT_ID]
);
const allocationsDigest = digestRows(
  allocRes.rows.map((r) => ({
    entryId: String(r.entry_id),
    postingId: String(r.posting_id),
    accountId: r.account_id === null ? null : String(r.account_id),
    partyId: String(r.party_id),
    partyRole: String(r.party_role),
    currency: String(r.currency),
    amountCents: Number(r.amount_cents)
  }))
);

const monthEventsRes = await client.query(
  `
    SELECT aggregate_id, seq, event_json
    FROM events
    WHERE tenant_id = $1 AND aggregate_type = 'month'
    ORDER BY aggregate_id ASC, seq ASC
  `,
  [TENANT_ID]
);
const monthEventsDigest = digestRows(
  monthEventsRes.rows.map((r) => ({
    monthId: String(r.aggregate_id),
    seq: Number(r.seq),
    event: r.event_json ?? null
  }))
);

await client.end();

const actual = {
  tenantId: TENANT_ID,
  counts: {
    tenants: Number(tenantCountRes.rows?.[0]?.n ?? 0),
    jobs: Number(jobCountRes.rows?.[0]?.n ?? 0),
    ledgerEntries: Number(ledgerEntryCountRes.rows?.[0]?.n ?? 0),
    allocations: Number(allocationCountRes.rows?.[0]?.n ?? 0),
    artifacts: Number(artifactCountRes.rows?.[0]?.n ?? 0),
    partyStatements: Number(partyStatementCountRes.rows?.[0]?.n ?? 0)
  },
  digests: {
    artifacts: artifactsDigest,
    ledgerEntries: ledgerDigest,
    allocations: allocationsDigest,
    monthEvents: monthEventsDigest
  }
};

assert.deepEqual(actual, expected, "state mismatch after restore");
process.stdout.write("ok\n");
