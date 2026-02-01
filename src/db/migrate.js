import fs from "node:fs/promises";
import path from "node:path";

import { MIGRATIONS_ADVISORY_LOCK_KEY } from "../core/maintenance-locks.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export async function migratePg({ pool, migrationsDir }) {
  if (!pool) throw new TypeError("pool is required");
  assertNonEmptyString(migrationsDir, "migrationsDir");

  const lockClient = await pool.connect();
  try {
    // Ensure only one process performs migrations at a time.
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATIONS_ADVISORY_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS proxy_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set();
    const existing = await lockClient.query("SELECT id FROM proxy_migrations ORDER BY id ASC");
    for (const row of existing.rows) {
      if (row?.id) applied.add(String(row.id));
    }

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith(".sql")).map((e) => e.name).sort();

    for (const filename of files) {
      if (applied.has(filename)) continue;
      const full = path.join(migrationsDir, filename);
      const sql = await fs.readFile(full, "utf8");

      try {
        await lockClient.query("BEGIN");
        await lockClient.query(sql);
        await lockClient.query("INSERT INTO proxy_migrations (id) VALUES ($1)", [filename]);
        await lockClient.query("COMMIT");
        applied.add(filename);
      } catch (err) {
        try {
          await lockClient.query("ROLLBACK");
        } catch {}
        throw err;
      }
    }

    return { applied: Array.from(applied.values()) };
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATIONS_ADVISORY_LOCK_KEY]);
    } catch {}
    lockClient.release();
  }
}
