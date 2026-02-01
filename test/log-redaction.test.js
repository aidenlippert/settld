import test from "node:test";
import assert from "node:assert/strict";

import { logger } from "../src/core/log.js";

test("logger: redacts secret/token/authorization fields", () => {
  const secret = "super_secret_value_12345";
  let captured = "";

  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (typeof cb === "function") cb();
    return true;
  };

  try {
    logger.info("redaction_test", {
      secret,
      token: secret,
      authorization: `Bearer ${secret}`,
      nested: { credentialRef: "vault://example", secretAccessKey: secret }
    });
  } finally {
    process.stdout.write = origWrite;
  }

  assert.ok(captured.includes("redaction_test"));
  assert.ok(!captured.includes(secret));
  assert.ok(captured.includes("[REDACTED]"));
});

