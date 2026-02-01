import test from "node:test";
import assert from "node:assert/strict";

import { checkUrlSafetySync } from "../src/core/url-safety.js";

test("url safety: blocks metadata IPs and file://", () => {
  const meta = checkUrlSafetySync("https://169.254.169.254/latest/meta-data/");
  assert.equal(meta.ok, false);
  assert.equal(meta.code, "URL_HOST_FORBIDDEN");

  const file = checkUrlSafetySync("file:///etc/passwd");
  assert.equal(file.ok, false);
  assert.equal(file.code, "URL_SCHEME_FORBIDDEN");
});

test("url safety: allows s3:// and minio:// URIs", () => {
  const s3 = checkUrlSafetySync("s3://bucket/key");
  assert.equal(s3.ok, true);

  const minio = checkUrlSafetySync("minio://bucket/key");
  assert.equal(minio.ok, true);
});

