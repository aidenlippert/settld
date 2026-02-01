import test from "node:test";
import assert from "node:assert/strict";

import { createPgPool, quoteIdent } from "../src/db/pg.js";
import { createPgStore } from "../src/db/store-pg.js";

const databaseUrl = process.env.DATABASE_URL ?? null;

(databaseUrl ? test : test.skip)("pg: concurrent startup is safe (migrations + server_signer)", async () => {
  const schema = `t_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  let storeA = null;
  let storeB = null;
  try {
    [storeA, storeB] = await Promise.all([
      createPgStore({ databaseUrl, schema, dropSchemaOnClose: false }),
      createPgStore({ databaseUrl, schema, dropSchemaOnClose: false })
    ]);

    assert.equal(storeA.serverSigner.keyId, storeB.serverSigner.keyId);
    assert.equal(storeA.serverSigner.publicKeyPem, storeB.serverSigner.publicKeyPem);
    assert.equal(storeA.serverSigner.privateKeyPem, storeB.serverSigner.privateKeyPem);

    const signerCount = await storeA.pg.pool.query("SELECT COUNT(*)::int AS c FROM server_signer");
    assert.equal(Number(signerCount.rows[0].c), 1);

    const migrationCount = await storeA.pg.pool.query("SELECT COUNT(*)::int AS c FROM proxy_migrations");
    assert.ok(Number(migrationCount.rows[0].c) >= 1);
  } finally {
    try {
      await storeB?.close?.();
    } catch {}
    try {
      await storeA?.close?.();
    } catch {}

    const adminPool = await createPgPool({ databaseUrl, schema: "public" });
    try {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    } finally {
      await adminPool.end();
    }
  }
});

