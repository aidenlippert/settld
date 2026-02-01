import fs from "node:fs/promises";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parsePositiveIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return n;
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function parseFlagEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const v = String(raw).trim();
  if (v === "1") return true;
  if (v === "0") return false;
  throw new TypeError(`${name} must be 0 or 1`);
}

async function readSecretRef(ref) {
  assertNonEmptyString(ref, "ref");
  const text = String(ref).trim();
  const idx = text.indexOf(":");
  if (idx === -1) return { ok: false, code: "SECRET_REF_INVALID", message: "secret ref must be env:NAME or file:/path" };
  const scheme = text.slice(0, idx);
  const rest = text.slice(idx + 1);
  if (scheme === "env") {
    const key = rest.trim();
    if (!key) return { ok: false, code: "SECRET_REF_INVALID", message: "env: requires a variable name" };
    const v = typeof process !== "undefined" ? process.env[key] : null;
    if (typeof v !== "string" || v.trim() === "") return { ok: false, code: "SECRET_NOT_FOUND", message: `env var ${key} is empty` };
    return { ok: true, value: v.trim() };
  }
  if (scheme === "file") {
    const filePath = rest.trim();
    if (!filePath) return { ok: false, code: "SECRET_REF_INVALID", message: "file: requires a path" };
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const v = String(raw).replace(/\r?\n$/, "");
      if (!v.trim()) return { ok: false, code: "SECRET_NOT_FOUND", message: "file secret is empty" };
      return { ok: true, value: v };
    } catch (err) {
      return { ok: false, code: "SECRET_READ_FAILED", message: err?.message ?? "failed to read secret file" };
    }
  }
  return { ok: false, code: "SECRET_PROVIDER_FORBIDDEN", message: `unsupported secret ref provider: ${scheme}` };
}

export async function loadConfig() {
  const nodeEnv = typeof process !== "undefined" ? (process.env.NODE_ENV ?? "development") : "development";
  const port = parsePositiveIntEnv("FINANCE_SINK_PORT", 4100);

  const ackMaxInflight = Math.min(100, parsePositiveIntEnv("FINANCE_SINK_ACK_MAX_INFLIGHT", 10));
  const ackRetryMax = Math.min(1000, parsePositiveIntEnv("FINANCE_SINK_ACK_RETRY_MAX", 50));
  const ackTimeoutMs = parsePositiveIntEnv("FINANCE_SINK_ACK_TIMEOUT_MS", 5000);

  const dedupeDbPath =
    typeof process !== "undefined" ? (process.env.FINANCE_SINK_DEDUPE_DB_PATH ?? "./finance-sink-dedupe.jsonl") : "./finance-sink-dedupe.jsonl";

  const tenantId = typeof process !== "undefined" ? (process.env.FINANCE_SINK_TENANT_ID ?? "tenant_default") : "tenant_default";
  const destinationId = typeof process !== "undefined" ? (process.env.FINANCE_SINK_DESTINATION_ID ?? null) : null;
  const ackUrl = typeof process !== "undefined" ? (process.env.FINANCE_SINK_ACK_URL ?? null) : null;

  const allowInlineSecrets = parseFlagEnv("FINANCE_SINK_ALLOW_INLINE_SECRETS", nodeEnv !== "production");
  const hmacSecretInline = typeof process !== "undefined" ? (process.env.FINANCE_SINK_HMAC_SECRET ?? null) : null;
  const hmacSecretRef = typeof process !== "undefined" ? (process.env.FINANCE_SINK_HMAC_SECRET_REF ?? null) : null;

  let hmacSecret = null;
  if (allowInlineSecrets && typeof hmacSecretInline === "string" && hmacSecretInline.trim()) {
    hmacSecret = hmacSecretInline.trim();
  } else if (typeof hmacSecretRef === "string" && hmacSecretRef.trim()) {
    const resolved = await readSecretRef(hmacSecretRef);
    if (!resolved.ok) {
      const err = new Error(resolved.message);
      err.code = resolved.code;
      throw err;
    }
    hmacSecret = resolved.value;
  }

  const s3Endpoint = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_ENDPOINT ?? null) : null;
  const s3Region = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_REGION ?? "us-east-1") : "us-east-1";
  const s3Bucket = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_BUCKET ?? null) : null;
  const s3Prefix = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_PREFIX ?? "finance/") : "finance/";
  const s3ForcePathStyle = parseFlagEnv("FINANCE_SINK_S3_FORCE_PATH_STYLE", true);

  const s3AccessKeyIdInline = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_ACCESS_KEY_ID ?? null) : null;
  const s3SecretAccessKeyInline = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_SECRET_ACCESS_KEY ?? null) : null;
  const s3AccessKeyIdRef = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_ACCESS_KEY_ID_REF ?? null) : null;
  const s3SecretAccessKeyRef = typeof process !== "undefined" ? (process.env.FINANCE_SINK_S3_SECRET_ACCESS_KEY_REF ?? null) : null;

  let s3AccessKeyId = null;
  if (allowInlineSecrets && typeof s3AccessKeyIdInline === "string" && s3AccessKeyIdInline.trim()) {
    s3AccessKeyId = s3AccessKeyIdInline.trim();
  } else if (typeof s3AccessKeyIdRef === "string" && s3AccessKeyIdRef.trim()) {
    const resolved = await readSecretRef(s3AccessKeyIdRef);
    if (!resolved.ok) {
      const err = new Error(resolved.message);
      err.code = resolved.code;
      throw err;
    }
    s3AccessKeyId = resolved.value;
  }

  let s3SecretAccessKey = null;
  if (allowInlineSecrets && typeof s3SecretAccessKeyInline === "string" && s3SecretAccessKeyInline.trim()) {
    s3SecretAccessKey = s3SecretAccessKeyInline.trim();
  } else if (typeof s3SecretAccessKeyRef === "string" && s3SecretAccessKeyRef.trim()) {
    const resolved = await readSecretRef(s3SecretAccessKeyRef);
    if (!resolved.ok) {
      const err = new Error(resolved.message);
      err.code = resolved.code;
      throw err;
    }
    s3SecretAccessKey = resolved.value;
  }

  const testDelayFirstResponseMs = nodeEnv === "test" ? parseNonNegativeIntEnv("FINANCE_SINK_TEST_DELAY_FIRST_RESPONSE_MS", 0) : 0;

  return {
    nodeEnv,
    port,
    tenantId,
    destinationId,
    ackUrl,
    hmacSecret,
    allowInlineSecrets,
    dedupeDbPath,
    ack: {
      maxInflight: ackMaxInflight,
      retryMax: ackRetryMax,
      timeoutMs: ackTimeoutMs
    },
    s3: {
      endpoint: s3Endpoint,
      region: s3Region,
      bucket: s3Bucket,
      prefix: s3Prefix,
      forcePathStyle: s3ForcePathStyle,
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretAccessKey
    },
    test: {
      delayFirstResponseMs: testDelayFirstResponseMs
    }
  };
}

export function validateConfigForReady(cfg) {
  if (!cfg || typeof cfg !== "object") throw new TypeError("cfg is required");
  assertNonEmptyString(cfg.tenantId, "FINANCE_SINK_TENANT_ID");
  assertNonEmptyString(cfg.destinationId, "FINANCE_SINK_DESTINATION_ID");
  assertNonEmptyString(cfg.ackUrl, "FINANCE_SINK_ACK_URL");
  assertNonEmptyString(cfg.hmacSecret, "FINANCE_SINK_HMAC_SECRET[_REF]");

  const s3 = cfg.s3 ?? {};
  assertNonEmptyString(s3.endpoint, "FINANCE_SINK_S3_ENDPOINT");
  assertNonEmptyString(s3.region, "FINANCE_SINK_S3_REGION");
  assertNonEmptyString(s3.bucket, "FINANCE_SINK_S3_BUCKET");
  assertNonEmptyString(s3.prefix, "FINANCE_SINK_S3_PREFIX");
  assertNonEmptyString(s3.accessKeyId, "FINANCE_SINK_S3_ACCESS_KEY_ID[_REF]");
  assertNonEmptyString(s3.secretAccessKey, "FINANCE_SINK_S3_SECRET_ACCESS_KEY[_REF]");
}

