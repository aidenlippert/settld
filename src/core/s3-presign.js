import crypto from "node:crypto";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePathPreservingSlashes(pathname) {
  const parts = pathname.split("/").filter((p) => p !== "");
  return `/${parts.map((p) => encodeRfc3986(p)).join("/")}`;
}

function sha256HexUtf8(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256(key, value, encoding = null) {
  const h = crypto.createHmac("sha256", key).update(value, "utf8");
  return encoding ? h.digest(encoding) : h.digest();
}

function toAmzDate(date) {
  // YYYYMMDDTHHMMSSZ
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey({ secretAccessKey, dateStamp, region, service }) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function canonicalQueryString(params) {
  const encoded = params.map(([k, v]) => [encodeRfc3986(String(k)), encodeRfc3986(String(v))]);
  encoded.sort((a, b) => {
    const kc = a[0].localeCompare(b[0]);
    if (kc !== 0) return kc;
    return a[1].localeCompare(b[1]);
  });
  return encoded.map(([k, v]) => `${k}=${v}`).join("&");
}

export function presignS3Url({
  endpoint,
  region,
  bucket,
  key,
  method,
  accessKeyId,
  secretAccessKey,
  forcePathStyle = true,
  expiresInSeconds,
  now = new Date()
}) {
  assertNonEmptyString(endpoint, "endpoint");
  assertNonEmptyString(region, "region");
  assertNonEmptyString(bucket, "bucket");
  assertNonEmptyString(key, "key");
  assertNonEmptyString(method, "method");
  assertNonEmptyString(accessKeyId, "accessKeyId");
  assertNonEmptyString(secretAccessKey, "secretAccessKey");
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) throw new TypeError("expiresInSeconds must be a positive integer");
  if (expiresInSeconds > 60 * 60 * 24 * 7) throw new TypeError("expiresInSeconds must be <= 604800 (7 days)");

  const base = new URL(endpoint);
  const encodedKey = encodePathPreservingSlashes(key).slice(1); // strip leading /
  const bucketSeg = encodeRfc3986(bucket);

  if (forcePathStyle) {
    base.pathname = `/${bucketSeg}/${encodedKey}`;
  } else {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `/${encodedKey}`;
  }
  base.search = "";

  const host = String(base.host).toLowerCase();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"]
  ];
  const query = canonicalQueryString(params);

  const canonicalRequest = [
    method.toUpperCase(),
    base.pathname,
    query,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256HexUtf8(canonicalRequest)].join("\n");
  const kSigning = signingKey({ secretAccessKey, dateStamp, region, service: "s3" });
  const signature = hmacSha256(kSigning, stringToSign, "hex");

  base.search = `${query}&X-Amz-Signature=${signature}`;
  return base.toString();
}

