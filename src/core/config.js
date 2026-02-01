function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function parseNonNegativeIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return n;
}

function parsePositiveIntEnv(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env[name] : null;
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${name} must be a positive safe integer`);
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

function safeSchemaName(name) {
  assertNonEmptyString(name, "PROXY_PG_SCHEMA");
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new TypeError("PROXY_PG_SCHEMA must match /^[a-zA-Z_][a-zA-Z0-9_]*$/");
  }
  return name;
}

function redactDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    if (u.password) u.password = "[REDACTED]";
    return u.toString();
  } catch {
    // Some PG URLs are non-standard; just redact anything after the first ':' in userinfo.
    const text = String(databaseUrl);
    const at = text.indexOf("@");
    const schemeSep = text.indexOf("://");
    if (schemeSep !== -1 && at !== -1) {
      const userInfo = text.slice(schemeSep + 3, at);
      const colon = userInfo.indexOf(":");
      if (colon !== -1) {
        const redactedUserInfo = `${userInfo.slice(0, colon)}:[REDACTED]`;
        return `${text.slice(0, schemeSep + 3)}${redactedUserInfo}${text.slice(at)}`;
      }
    }
    return "[REDACTED]";
  }
}

function countDestinationsByTenant(rawJson) {
  if (!rawJson || String(rawJson).trim() === "") return { tenants: 0, destinations: 0 };
  let parsed;
  try {
    parsed = JSON.parse(String(rawJson));
  } catch (err) {
    throw new TypeError(`invalid PROXY_EXPORT_DESTINATIONS JSON: ${err?.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("PROXY_EXPORT_DESTINATIONS must be a JSON object");
  let tenants = 0;
  let destinations = 0;
  for (const [tenantId, list] of Object.entries(parsed)) {
    if (!tenantId) continue;
    tenants += 1;
    if (Array.isArray(list)) destinations += list.length;
  }
  return { tenants, destinations };
}

function containsInlineSecrets(rawJson) {
  if (!rawJson || String(rawJson).trim() === "") return false;
  let parsed;
  try {
    parsed = JSON.parse(String(rawJson));
  } catch {
    return false;
  }

  const stack = [parsed];
  while (stack.length) {
    const v = stack.pop();
    if (!v) continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    if (typeof v === "object") {
      for (const [k, value] of Object.entries(v)) {
        const key = String(k).toLowerCase();
        if (key === "secret" || key === "accesskeyid" || key === "secretaccesskey") {
          if (typeof value === "string" && value.trim() !== "") return true;
        }
        stack.push(value);
      }
    }
  }
  return false;
}

export function loadConfig({ mode = "api" } = {}) {
  const resolvedMode = String(mode);
  if (resolvedMode !== "api" && resolvedMode !== "maintenance") throw new TypeError("mode must be api or maintenance");

  const nodeEnv = typeof process !== "undefined" ? (process.env.NODE_ENV ?? "development") : "development";

  const storeModeRaw = typeof process !== "undefined" ? (process.env.STORE ?? "memory") : "memory";
  const storeMode = resolvedMode === "maintenance" ? "pg" : String(storeModeRaw);
  if (storeMode !== "memory" && storeMode !== "pg") throw new TypeError("STORE must be memory or pg");

  const pgSchema = safeSchemaName(typeof process !== "undefined" ? (process.env.PROXY_PG_SCHEMA ?? "public") : "public");
  const persistenceDir = typeof process !== "undefined" ? (process.env.PROXY_DATA_DIR ?? null) : null;
  const databaseUrl = typeof process !== "undefined" ? (process.env.DATABASE_URL ?? null) : null;

  const migrateOnStartup = parseFlagEnv("PROXY_MIGRATE_ON_STARTUP", true);
  const pgLogSlowMs = parseNonNegativeIntEnv("PROXY_PG_LOG_SLOW_MS", 0);
  const pgWorkerStatementTimeoutMs = Math.min(60_000, parseNonNegativeIntEnv("PROXY_PG_WORKER_STATEMENT_TIMEOUT_MS", 0));

  if (storeMode === "pg") {
    if (!databaseUrl) throw new Error("STORE=pg requires DATABASE_URL");
  }
  if (resolvedMode === "maintenance") {
    if (!databaseUrl) throw new Error("maintenance mode requires DATABASE_URL");
  }

  const port = parsePositiveIntEnv("PORT", 3000);

  const maintenanceIntervalSeconds = parsePositiveIntEnv("PROXY_MAINTENANCE_INTERVAL_SECONDS", 300);
  const retentionCleanupBatchSize = parsePositiveIntEnv("PROXY_RETENTION_CLEANUP_BATCH_SIZE", 500);
  const retentionCleanupMaxMillis = parsePositiveIntEnv("PROXY_RETENTION_CLEANUP_MAX_MILLIS", 1500);
  const retentionCleanupDryRun = parseFlagEnv("PROXY_RETENTION_CLEANUP_DRY_RUN", false);

  // Quick validation pass for key hardening toggles.
  const allowInlineSecrets = parseFlagEnv("PROXY_ALLOW_INLINE_SECRETS", false);
  const exportDestinations = typeof process !== "undefined" ? (process.env.PROXY_EXPORT_DESTINATIONS ?? null) : null;
  if (nodeEnv === "production" && !allowInlineSecrets && containsInlineSecrets(exportDestinations)) {
    throw new Error("inline secrets in PROXY_EXPORT_DESTINATIONS are not allowed in production (use *Ref fields or set PROXY_ALLOW_INLINE_SECRETS=1)");
  }

  const maxBodyBytes = parsePositiveIntEnv("PROXY_MAX_BODY_BYTES", 1_000_000);
  const ingestMaxEvents = parsePositiveIntEnv("PROXY_INGEST_MAX_EVENTS", 200);

  const rateLimitRpm = parseNonNegativeIntEnv("PROXY_RATE_LIMIT_RPM", 0);
  const rateLimitBurst = parseNonNegativeIntEnv("PROXY_RATE_LIMIT_BURST", rateLimitRpm);

  const reclaimAfterSeconds = parsePositiveIntEnv("PROXY_RECLAIM_AFTER_SECONDS", 60);
  const outboxMaxAttempts = parsePositiveIntEnv("PROXY_OUTBOX_MAX_ATTEMPTS", 25);

  const workerConcurrencyArtifacts = Math.min(50, parsePositiveIntEnv("PROXY_WORKER_CONCURRENCY_ARTIFACTS", 1));
  const workerConcurrencyDeliveries = Math.min(50, parsePositiveIntEnv("PROXY_WORKER_CONCURRENCY_DELIVERIES", 1));
  const deliveryHttpTimeoutMs = parseNonNegativeIntEnv("PROXY_DELIVERY_HTTP_TIMEOUT_MS", 0);

  const secretsCacheTtlSeconds = parsePositiveIntEnv("PROXY_SECRETS_CACHE_TTL_SECONDS", 30);

  const evidencePresignMaxSeconds = parsePositiveIntEnv("PROXY_EVIDENCE_PRESIGN_MAX_SECONDS", 300);
  if (evidencePresignMaxSeconds > 3600) throw new TypeError("PROXY_EVIDENCE_PRESIGN_MAX_SECONDS must be <= 3600");

  const autotickEnabled = typeof process !== "undefined" && process.env.PROXY_AUTOTICK === "1";
  const autotickIntervalMs = (() => {
    const raw = typeof process !== "undefined" ? (process.env.PROXY_AUTOTICK_INTERVAL_MS ?? null) : null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new TypeError("PROXY_AUTOTICK_INTERVAL_MS must be a positive number");
      return Math.floor(n);
    }
    if (autotickEnabled) return 250;
    return 0;
  })();

  const autotickMaxMessages = (() => {
    const raw = typeof process !== "undefined" ? (process.env.PROXY_AUTOTICK_MAX_MESSAGES ?? null) : null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return 100;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new TypeError("PROXY_AUTOTICK_MAX_MESSAGES must be a positive number");
    return Math.floor(n);
  })();

  return {
    mode: resolvedMode,
    nodeEnv,
    store: {
      mode: storeMode,
      databaseUrl,
      pgSchema,
      pgLogSlowMs,
      pgWorkerStatementTimeoutMs,
      persistenceDir,
      migrateOnStartup
    },
    api: {
      port,
      autotick: {
        enabled: autotickEnabled,
        intervalMs: autotickIntervalMs,
        maxMessages: autotickMaxMessages
      }
    },
    maintenance: {
      intervalSeconds: maintenanceIntervalSeconds,
      retentionCleanup: {
        batchSize: retentionCleanupBatchSize,
        maxMillis: retentionCleanupMaxMillis,
        dryRun: retentionCleanupDryRun
      }
    },
    http: {
      maxBodyBytes,
      ingestMaxEvents
    },
    rateLimit: {
      rpm: rateLimitRpm,
      burst: rateLimitBurst
    },
    outbox: {
      reclaimAfterSeconds,
      maxAttempts: outboxMaxAttempts
    },
    workers: {
      concurrency: {
        artifacts: workerConcurrencyArtifacts,
        deliveries: workerConcurrencyDeliveries
      },
      deliveryHttpTimeoutMs
    },
    secrets: {
      cacheTtlSeconds: secretsCacheTtlSeconds
    },
    evidence: {
      presignMaxSeconds: evidencePresignMaxSeconds
    },
    exports: {
      allowInlineSecrets,
      destinationsConfigured: countDestinationsByTenant(exportDestinations)
    }
  };
}

export function configForLog(config) {
  if (!config || typeof config !== "object") throw new TypeError("config is required");
  const store = config.store ?? {};
  return {
    mode: config.mode ?? null,
    nodeEnv: config.nodeEnv ?? null,
    store: {
      mode: store.mode ?? null,
      pgSchema: store.pgSchema ?? null,
      migrateOnStartup: store.migrateOnStartup ?? null,
      pgLogSlowMs: store.pgLogSlowMs ?? null,
      pgWorkerStatementTimeoutMs: store.pgWorkerStatementTimeoutMs ?? null,
      persistenceDir: store.persistenceDir ?? null,
      databaseUrl: redactDatabaseUrl(store.databaseUrl ?? null)
    },
    api: config.api ?? null,
    maintenance: config.maintenance ?? null,
    http: config.http ?? null,
    rateLimit: config.rateLimit ?? null,
    outbox: config.outbox ?? null,
    workers: config.workers ?? null,
    secrets: config.secrets ?? null,
    evidence: config.evidence ?? null,
    exports: config.exports ?? null
  };
}
