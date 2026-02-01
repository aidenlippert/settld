import { presignS3Url } from "../../../src/core/s3-presign.js";
import { canonicalJsonStringify } from "../../../src/core/canonical-json.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function safeKeySegment(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replaceAll("\0", "");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return await fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  try {
    return await fetch(url, { ...(options ?? {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class S3Store {
  constructor({ endpoint, region, bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle = true }) {
    this.endpoint = endpoint ?? null;
    this.region = region ?? null;
    this.bucket = bucket ?? null;
    this.prefix = typeof prefix === "string" && prefix.trim() ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "settld/";
    this.accessKeyId = accessKeyId ?? null;
    this.secretAccessKey = secretAccessKey ?? null;
    this.forcePathStyle = forcePathStyle !== false;
  }

  objectKeyForArtifact({ artifactHash, artifactType = null }) {
    assertNonEmptyString(artifactHash, "artifactHash");
    const typeSeg = artifactType ? safeKeySegment(artifactType) : null;
    const base = typeSeg ? `artifacts/${typeSeg}/${safeKeySegment(artifactHash)}.json` : `artifacts/${safeKeySegment(artifactHash)}.json`;
    return `${this.prefix}${base}`.replaceAll(/\/{2,}/g, "/");
  }

  async putJsonIfAbsent({ key, json, timeoutMs = 10_000 }) {
    assertNonEmptyString(key, "key");
    if (!json || typeof json !== "object") throw new TypeError("json must be an object");
    assertNonEmptyString(this.endpoint, "endpoint");
    assertNonEmptyString(this.region, "region");
    assertNonEmptyString(this.bucket, "bucket");
    assertNonEmptyString(this.accessKeyId, "accessKeyId");
    assertNonEmptyString(this.secretAccessKey, "secretAccessKey");
    const body = canonicalJsonStringify(json);
    const url = presignS3Url({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      key,
      method: "PUT",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      forcePathStyle: this.forcePathStyle,
      expiresInSeconds: 300
    });

    const res = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json; charset=utf-8",
          // Best-effort immutability: if object already exists, storage should reject.
          "if-none-match": "*"
        },
        body
      },
      timeoutMs
    );

    // 412 == already exists when If-None-Match is honored; treat as OK for content-addressed keys.
    if (res.status === 412) return { ok: true, alreadyExisted: true };
    if (res.status >= 200 && res.status < 300) return { ok: true, alreadyExisted: false };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text ? text.slice(0, 500) : `http ${res.status}` };
  }

  async checkConnectivity({ timeoutMs = 2000 }) {
    assertNonEmptyString(this.endpoint, "endpoint");
    assertNonEmptyString(this.region, "region");
    assertNonEmptyString(this.bucket, "bucket");
    assertNonEmptyString(this.accessKeyId, "accessKeyId");
    assertNonEmptyString(this.secretAccessKey, "secretAccessKey");
    const key = `${this.prefix}health/ready.txt`.replaceAll(/\/{2,}/g, "/");
    const url = presignS3Url({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      key,
      method: "HEAD",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      forcePathStyle: this.forcePathStyle,
      expiresInSeconds: 60
    });
    const res = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
    // 200/404 indicates connectivity + auth; 403 indicates creds/bucket policy issue.
    if (res.status === 200 || res.status === 404) return { ok: true };
    return { ok: false, status: res.status };
  }
}
