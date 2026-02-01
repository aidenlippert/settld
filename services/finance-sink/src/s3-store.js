import { presignS3Url } from "../../../src/core/s3-presign.js";
import { canonicalJsonStringify } from "../../../src/core/canonical-json.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
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
    this.prefix = typeof prefix === "string" && prefix.trim() ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "";
    this.accessKeyId = accessKeyId ?? null;
    this.secretAccessKey = secretAccessKey ?? null;
    this.forcePathStyle = forcePathStyle !== false;
  }

  qualifyKey(key) {
    assertNonEmptyString(key, "key");
    return `${this.prefix}${key}`.replaceAll(/\/{2,}/g, "/");
  }

  async putBytesIfAbsent({ key, bytes, contentType = "application/octet-stream", timeoutMs = 10_000 }) {
    assertNonEmptyString(key, "key");
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
    assertNonEmptyString(this.endpoint, "endpoint");
    assertNonEmptyString(this.region, "region");
    assertNonEmptyString(this.bucket, "bucket");
    assertNonEmptyString(this.accessKeyId, "accessKeyId");
    assertNonEmptyString(this.secretAccessKey, "secretAccessKey");
    const fullKey = this.qualifyKey(key);
    const url = presignS3Url({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      key: fullKey,
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
          "content-type": contentType,
          "if-none-match": "*"
        },
        body: bytes
      },
      timeoutMs
    );

    if (res.status === 412) return { ok: true, alreadyExisted: true };
    if (res.status >= 200 && res.status < 300) return { ok: true, alreadyExisted: false };
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: text ? text.slice(0, 500) : `http ${res.status}` };
  }

  async putJsonIfAbsent({ key, json, timeoutMs = 10_000 }) {
    assertNonEmptyString(key, "key");
    if (!json || typeof json !== "object") throw new TypeError("json must be an object");
    const body = canonicalJsonStringify(json);
    return await this.putBytesIfAbsent({ key, bytes: new TextEncoder().encode(body), contentType: "application/json; charset=utf-8", timeoutMs });
  }

  async getBytes({ bucket, key, endpoint = null, region = null, forcePathStyle = null, timeoutMs = 10_000 }) {
    assertNonEmptyString(bucket, "bucket");
    assertNonEmptyString(key, "key");
    const ep = endpoint ?? this.endpoint;
    const reg = region ?? this.region;
    const fps = forcePathStyle === null || forcePathStyle === undefined ? this.forcePathStyle : Boolean(forcePathStyle);
    assertNonEmptyString(ep, "endpoint");
    assertNonEmptyString(reg, "region");
    assertNonEmptyString(this.accessKeyId, "accessKeyId");
    assertNonEmptyString(this.secretAccessKey, "secretAccessKey");

    const url = presignS3Url({
      endpoint: ep,
      region: reg,
      bucket,
      key,
      method: "GET",
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      forcePathStyle: fps,
      expiresInSeconds: 300
    });
    const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
    if (res.status === 404) {
      const err = new Error("not found");
      err.code = "ENOENT";
      throw err;
    }
    if (!res.ok) throw new Error(`s3 get failed (${res.status})`);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  }

  async checkConnectivity({ timeoutMs = 2000 }) {
    assertNonEmptyString(this.endpoint, "endpoint");
    assertNonEmptyString(this.region, "region");
    assertNonEmptyString(this.bucket, "bucket");
    assertNonEmptyString(this.accessKeyId, "accessKeyId");
    assertNonEmptyString(this.secretAccessKey, "secretAccessKey");
    const key = this.qualifyKey("health/ready.txt");
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
    if (res.status === 200 || res.status === 404) return { ok: true };
    return { ok: false, status: res.status };
  }
}

