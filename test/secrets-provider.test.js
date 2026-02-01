import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSecretsProvider } from "../src/core/secrets.js";
import { DEFAULT_TENANT_ID } from "../src/core/tenancy.js";

test("secrets: env provider is disabled unless explicitly enabled", async () => {
  const secrets = createSecretsProvider({ allowEnv: false, cacheTtlSeconds: 1 });
  await assert.rejects(
    () => secrets.getSecret({ tenantId: DEFAULT_TENANT_ID, ref: "env:SHOULD_NOT_EXIST" }),
    (err) => err?.code === "SECRET_PROVIDER_FORBIDDEN"
  );
});

test("secrets: file provider reads and trims trailing newline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "settld_secrets_"));
  const fp = path.join(dir, "secret.txt");
  await fs.writeFile(fp, "hello\n", "utf8");

  const secrets = createSecretsProvider({ allowEnv: false, cacheTtlSeconds: 1 });
  const s = await secrets.getSecret({ tenantId: DEFAULT_TENANT_ID, ref: `file:${fp}` });
  assert.equal(s.type, "string");
  assert.equal(s.value, "hello");
  assert.equal(s.metadata.provider, "file");
});

test("secrets: unknown provider is rejected", async () => {
  const secrets = createSecretsProvider({ allowEnv: false, cacheTtlSeconds: 1 });
  await assert.rejects(
    () => secrets.getSecret({ tenantId: DEFAULT_TENANT_ID, ref: "nope:whatever" }),
    (err) => err?.code === "SECRET_REF_INVALID"
  );
});

