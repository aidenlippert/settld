import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

function trustRootSetHashHex(keyIds) {
  const list = Array.isArray(keyIds) ? keyIds.map(String).filter(Boolean).sort() : [];
  const data = JSON.stringify(list);
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function parseSettingsKeyHex(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("MAGIC_LINK_SETTINGS_KEY_HEX must be 64 hex chars (32 bytes)");
  return Buffer.from(s, "hex");
}

function encryptStringAes256Gcm({ key, plaintext }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext ?? ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, ciphertext]);
  return `enc:v1:${packed.toString("base64")}`;
}

function decryptStringAes256Gcm({ key, value }) {
  const v = String(value ?? "");
  if (!v.startsWith("enc:v1:")) return v;
  const b64 = v.slice("enc:v1:".length);
  const packed = Buffer.from(b64, "base64");
  if (packed.length < 12 + 16) throw new Error("invalid ciphertext");
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return plaintext;
}

export const TENANT_PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    plan: "free",
    displayName: "Free",
    limits: Object.freeze({
      maxVerificationsPerMonth: 100,
      maxStoredBundles: 100,
      maxPolicyVersions: 10,
      maxIntegrations: 5,
      retentionDays: 30,
    }),
    billing: Object.freeze({
      subscriptionCents: 0,
      pricePerVerificationCents: 0,
    }),
  }),
  builder: Object.freeze({
    plan: "builder",
    displayName: "Builder",
    limits: Object.freeze({
      maxVerificationsPerMonth: 10000,
      maxStoredBundles: 1000,
      maxPolicyVersions: 20,
      maxIntegrations: 10,
      retentionDays: 30,
    }),
    billing: Object.freeze({
      subscriptionCents: 9900,
      pricePerVerificationCents: 1,
      pricePerSettledVolumeBps: 75,
      pricePerArbitrationCaseCents: 200,
    }),
  }),
  growth: Object.freeze({
    plan: "growth",
    displayName: "Growth",
    limits: Object.freeze({
      maxVerificationsPerMonth: 100000,
      maxStoredBundles: 10000,
      maxPolicyVersions: 50,
      maxIntegrations: 25,
      retentionDays: 180,
    }),
    billing: Object.freeze({
      subscriptionCents: 59900,
      pricePerVerificationCents: 0.7,
      pricePerSettledVolumeBps: 45,
      pricePerArbitrationCaseCents: 100,
    }),
  }),
  enterprise: Object.freeze({
    plan: "enterprise",
    displayName: "Enterprise",
    limits: Object.freeze({
      maxVerificationsPerMonth: null,
      maxStoredBundles: null,
      maxPolicyVersions: null,
      maxIntegrations: null,
      retentionDays: 365,
    }),
    billing: Object.freeze({
      // Enterprise is contract-priced; defaults are zero and set via negotiated terms.
      subscriptionCents: 0,
      pricePerVerificationCents: 0,
    }),
  }),
});

export function normalizeTenantPlan(value, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (allowNull) return null;
    return "free";
  }
  const rawPlan = String(value).trim().toLowerCase();
  // Backward compatibility for older persisted settings.
  const plan = rawPlan === "scale" ? "enterprise" : rawPlan;
  if (!Object.prototype.hasOwnProperty.call(TENANT_PLAN_CATALOG, plan)) {
    throw new TypeError("plan must be free|builder|growth|enterprise");
  }
  return plan;
}

export function defaultTenantSettings() {
  return {
    schemaVersion: "TenantSettings.v2",
    plan: "free",
    defaultMode: "auto",
    governanceTrustRootsJson: null,
    pricingSignerKeysJson: null,
    trustedPricingSignerKeyIds: null,
    retentionDays: 30,
    maxUploadBytesOverride: null,
    maxVerificationsPerMonth: null,
    maxStoredBundles: null,
    vendorPolicies: null,
    contractPolicies: null,
    buyerAuthEmailDomains: [],
    buyerUserRoles: null,
    buyerNotifications: { emails: [], deliveryMode: "smtp", webhookUrl: null, webhookSecret: null },
    autoDecision: {
      enabled: false,
      approveOnGreen: false,
      approveOnAmber: false,
      holdOnRed: false,
      templateIds: null,
      actorName: "Settld AutoDecision",
      actorEmail: "automation@settld.local"
    },
    paymentTriggers: { enabled: false, deliveryMode: "record", webhookUrl: null, webhookSecret: null },
    decisionAuthEmailDomains: [],
    settlementDecisionSigner: null,
    rateLimits: { uploadsPerHour: 100, verificationViewsPerHour: 1000, decisionsPerHour: 300, otpRequestsPerHour: 300 },
    webhooks: [],
    artifactStorage: { storeBundleZip: true, storePdf: true, precomputeMonthlyAuditPackets: false },
    archiveExportSink: null
  };
}

export function resolveTenantEntitlements({ settings, defaultBilling = null } = {}) {
  const source = isPlainObject(settings) ? settings : defaultTenantSettings();
  const plan = normalizeTenantPlan(source.plan, { allowNull: false });
  const base = TENANT_PLAN_CATALOG[plan] ?? TENANT_PLAN_CATALOG.free;
  const fallbackBilling = isPlainObject(defaultBilling) ? defaultBilling : null;
  const fallbackSubscriptionCents = Number(String(fallbackBilling?.subscriptionCents ?? ""));
  const fallbackPerVerificationCents = Number(String(fallbackBilling?.pricePerVerificationCents ?? ""));

  const maxVerificationsPerMonth = Number.isInteger(source.maxVerificationsPerMonth) ? source.maxVerificationsPerMonth : base.limits.maxVerificationsPerMonth;
  const maxStoredBundles = Number.isInteger(source.maxStoredBundles) ? source.maxStoredBundles : base.limits.maxStoredBundles;
  const retentionDays = Number.isInteger(source.retentionDays) ? source.retentionDays : base.limits.retentionDays;
  const uploadsPerHour = Number.isInteger(source?.rateLimits?.uploadsPerHour) ? source.rateLimits.uploadsPerHour : defaultTenantSettings().rateLimits.uploadsPerHour;
  const verificationViewsPerHour = Number.isInteger(source?.rateLimits?.verificationViewsPerHour)
    ? source.rateLimits.verificationViewsPerHour
    : defaultTenantSettings().rateLimits.verificationViewsPerHour;
  const decisionsPerHour = Number.isInteger(source?.rateLimits?.decisionsPerHour)
    ? source.rateLimits.decisionsPerHour
    : defaultTenantSettings().rateLimits.decisionsPerHour;

  const baseSubscriptionCents = Number(String(base?.billing?.subscriptionCents ?? ""));
  const basePerVerificationCents = Number(String(base?.billing?.pricePerVerificationCents ?? ""));
  const subscriptionCents = Number.isFinite(baseSubscriptionCents) && baseSubscriptionCents >= 0
    ? baseSubscriptionCents
    : Number.isFinite(fallbackSubscriptionCents) && fallbackSubscriptionCents >= 0
      ? fallbackSubscriptionCents
      : 0;
  const pricePerVerificationCents = Number.isFinite(basePerVerificationCents) && basePerVerificationCents >= 0
    ? basePerVerificationCents
    : Number.isFinite(fallbackPerVerificationCents) && fallbackPerVerificationCents >= 0
      ? fallbackPerVerificationCents
      : 0;

  return {
    schemaVersion: "TenantEntitlements.v1",
    plan,
    displayName: base.displayName,
    limits: {
      maxVerificationsPerMonth,
      maxStoredBundles,
      maxPolicyVersions: base.limits.maxPolicyVersions,
      maxIntegrations: base.limits.maxIntegrations,
      retentionDays
    },
    rateLimits: {
      uploadsPerHour,
      verificationViewsPerHour,
      decisionsPerHour
    },
    billing: {
      subscriptionCents,
      pricePerVerificationCents
    }
  };
}

function normalizeEmailLower(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 320) return null;
  const email = raw.toLowerCase();
  if (/\s/.test(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  return email;
}

function normalizeSafeId(raw, { fieldName, maxLen = 128 } = {}) {
  const id = String(raw ?? "").trim();
  if (!id) return { ok: false, error: `${fieldName} must be a non-empty string` };
  if (id.length > maxLen) return { ok: false, error: `${fieldName} must be <= ${maxLen} chars` };
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: `${fieldName} must match [A-Za-z0-9_-]+` };
  return { ok: true, id };
}

function normalizeTrustRootsJson(value) {
  if (value === undefined) return { ok: true, roots: undefined };
  if (value === null) return { ok: true, roots: null };
  if (!isPlainObject(value)) return { ok: false, error: "governanceTrustRootsJson must be an object or null" };
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyId = String(k ?? "").trim();
    if (!keyId) continue;
    if (typeof v !== "string" || !v.trim()) return { ok: false, error: "governanceTrustRootsJson values must be non-empty strings" };
    out[keyId] = v;
  }
  return { ok: true, roots: out };
}

function normalizePricingSignerKeysJson(value) {
  if (value === undefined) return { ok: true, keys: undefined };
  if (value === null) return { ok: true, keys: null };
  if (!isPlainObject(value)) return { ok: false, error: "pricingSignerKeysJson must be an object or null" };
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyId = String(k ?? "").trim();
    if (!keyId) continue;
    if (typeof v !== "string" || !v.trim()) return { ok: false, error: "pricingSignerKeysJson values must be non-empty strings" };
    out[keyId] = v;
  }
  return { ok: true, keys: out };
}

function normalizeWebhookConfigList(value, { current = [] } = {}) {
  if (value === undefined) return { ok: true, webhooks: undefined };
  if (!Array.isArray(value)) return { ok: false, error: "webhooks must be an array" };
  const cur = Array.isArray(current) ? current : [];

  const out = [];
  for (const w of value) {
    if (!isPlainObject(w)) return { ok: false, error: "webhook must be an object" };
    const url = typeof w.url === "string" ? w.url.trim() : "";
    if (!url) return { ok: false, error: "webhook.url is required" };
    const enabled = Boolean(w.enabled);
    const eventsRaw = Array.isArray(w.events) ? w.events.map((e) => String(e ?? "").trim()).filter(Boolean) : [];
    const eventsSet = new Set(eventsRaw);
    const events = [...eventsSet].sort();
    const allowed = new Set(["verification.completed", "verification.failed", "decision.approved", "decision.held"]);
    for (const e of events) if (!allowed.has(e)) return { ok: false, error: "invalid webhook event", event: e };
    if (!events.length) return { ok: false, error: "webhook.events must be non-empty" };

    let secret = w.secret;
    if (secret === undefined) {
      // Carry forward existing secret if url+events match.
      const prior = cur.find((p) => isPlainObject(p) && p.url === url && Array.isArray(p.events) && JSON.stringify([...new Set(p.events)].sort()) === JSON.stringify(events));
      secret = prior ? prior.secret : null;
    }
    if (secret !== null && secret !== undefined && typeof secret !== "string") return { ok: false, error: "webhook.secret must be string|null" };
    const secretNorm = typeof secret === "string" ? secret : secret === null ? null : null;

    out.push({ url, events, enabled, secret: secretNorm });
  }
  return { ok: true, webhooks: out };
}

function normalizeArtifactStorageConfig(value, { current } = {}) {
  if (value === undefined) return { ok: true, artifactStorage: undefined };
  if (value === null) return { ok: true, artifactStorage: null };
  if (!isPlainObject(value)) return { ok: false, error: "artifactStorage must be an object or null" };
  const base = { ...defaultTenantSettings().artifactStorage, ...(isPlainObject(current) ? current : {}) };
  const out = {};
  for (const k of ["storeBundleZip", "storePdf", "precomputeMonthlyAuditPackets"]) {
    if (value[k] === undefined) out[k] = Boolean(base[k]);
    else out[k] = Boolean(value[k]);
  }
  return { ok: true, artifactStorage: out };
}

function normalizeArchiveExportSink(value, { current } = {}) {
  if (value === undefined) return { ok: true, archiveExportSink: undefined };
  if (value === null) return { ok: true, archiveExportSink: null };
  if (!isPlainObject(value)) return { ok: false, error: "archiveExportSink must be an object or null" };

  const cur = isPlainObject(current) ? current : null;

  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (type !== "s3") return { ok: false, error: "archiveExportSink.type must be s3" };

  const enabled = Boolean(value.enabled);
  const endpointRaw = value.endpoint === null || value.endpoint === undefined ? null : String(value.endpoint);
  const endpoint = endpointRaw && endpointRaw.trim() ? endpointRaw.trim() : null;
  if (endpoint !== null) {
    try {
      const u = new URL(endpoint);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "archiveExportSink.endpoint must be http(s)" };
    } catch {
      return { ok: false, error: "archiveExportSink.endpoint invalid URL" };
    }
  }

  const regionRaw = value.region === null || value.region === undefined ? null : String(value.region);
  const region = regionRaw && regionRaw.trim() ? regionRaw.trim() : null;

  const bucketRaw = value.bucket === null || value.bucket === undefined ? null : String(value.bucket);
  const bucket = bucketRaw && bucketRaw.trim() ? bucketRaw.trim() : null;
  const prefixRaw = value.prefix === null || value.prefix === undefined ? null : String(value.prefix);
  const prefix = prefixRaw && prefixRaw.trim() ? prefixRaw.trim().replaceAll("\\", "/").replace(/^\/+/, "") : "";

  const accessKeyIdRaw = value.accessKeyId === null || value.accessKeyId === undefined ? null : String(value.accessKeyId);
  const accessKeyId = accessKeyIdRaw && accessKeyIdRaw.trim() ? accessKeyIdRaw.trim() : null;

  let secretAccessKey = value.secretAccessKey;
  if (secretAccessKey === undefined && cur && typeof cur.secretAccessKey === "string") secretAccessKey = cur.secretAccessKey;
  if (secretAccessKey !== null && secretAccessKey !== undefined && typeof secretAccessKey !== "string") return { ok: false, error: "archiveExportSink.secretAccessKey must be string|null" };
  const secretAccessKeyNorm = typeof secretAccessKey === "string" && secretAccessKey.trim() ? secretAccessKey : null;

  let sessionToken = value.sessionToken;
  if (sessionToken === undefined && cur && typeof cur.sessionToken === "string") sessionToken = cur.sessionToken;
  if (sessionToken !== null && sessionToken !== undefined && typeof sessionToken !== "string") return { ok: false, error: "archiveExportSink.sessionToken must be string|null" };
  const sessionTokenNorm = typeof sessionToken === "string" && sessionToken.trim() ? sessionToken : null;

  const sseRaw = typeof value.sse === "string" ? value.sse.trim() : "";
  const sse = sseRaw === "aes256" || sseRaw === "aws:kms" ? sseRaw : "none";
  const kmsKeyIdRaw = value.kmsKeyId === null || value.kmsKeyId === undefined ? null : String(value.kmsKeyId);
  const kmsKeyId = kmsKeyIdRaw && kmsKeyIdRaw.trim() ? kmsKeyIdRaw.trim() : null;
  if (sse === "aws:kms" && !kmsKeyId) return { ok: false, error: "archiveExportSink.kmsKeyId required when sse=aws:kms" };

  const pathStyle = value.pathStyle === null || value.pathStyle === undefined ? null : Boolean(value.pathStyle);

  if (enabled) {
    if (!bucket) return { ok: false, error: "archiveExportSink.bucket is required when enabled" };
    if (!accessKeyId || !secretAccessKeyNorm) return { ok: false, error: "archiveExportSink accessKeyId/secretAccessKey required when enabled" };
    if (!region && !endpoint) return { ok: false, error: "archiveExportSink.region is required when enabled (unless endpoint is set)" };
  }

  return {
    ok: true,
    archiveExportSink: {
      type,
      enabled,
      endpoint,
      region,
      bucket,
      prefix,
      pathStyle,
      accessKeyId,
      secretAccessKey: secretAccessKeyNorm,
      sessionToken: sessionTokenNorm,
      sse,
      kmsKeyId
    }
  };
}

function normalizeBuyerNotifications(value, { current } = {}) {
  if (value === undefined) return { ok: true, buyerNotifications: undefined };
  if (value === null) return { ok: true, buyerNotifications: { ...defaultTenantSettings().buyerNotifications } };
  if (!isPlainObject(value)) return { ok: false, error: "buyerNotifications must be an object or null" };

  const cur = isPlainObject(current) ? current : defaultTenantSettings().buyerNotifications;

  let emails = value.emails;
  if (emails === undefined) emails = cur?.emails;
  if (emails === null) emails = [];
  if (!Array.isArray(emails)) return { ok: false, error: "buyerNotifications.emails must be an array or null" };
  const normalizedEmails = [];
  for (const raw of emails) {
    const email = normalizeEmailLower(raw);
    if (!email) return { ok: false, error: "buyerNotifications.emails contains invalid email", email: raw };
    normalizedEmails.push(email);
  }

  const deliveryModeRaw = value.deliveryMode === undefined ? cur?.deliveryMode : value.deliveryMode;
  const deliveryMode = String(deliveryModeRaw ?? "smtp").trim().toLowerCase();
  if (deliveryMode !== "smtp" && deliveryMode !== "webhook" && deliveryMode !== "record") {
    return { ok: false, error: "buyerNotifications.deliveryMode must be smtp|webhook|record" };
  }

  const webhookUrlRaw = value.webhookUrl === undefined ? cur?.webhookUrl : value.webhookUrl;
  const webhookUrl = webhookUrlRaw === null || webhookUrlRaw === undefined ? null : String(webhookUrlRaw).trim();
  if (deliveryMode === "webhook") {
    if (!webhookUrl) return { ok: false, error: "buyerNotifications.webhookUrl is required when deliveryMode=webhook" };
    try {
      const u = new URL(webhookUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "buyerNotifications.webhookUrl must be http(s)" };
    } catch {
      return { ok: false, error: "buyerNotifications.webhookUrl invalid URL" };
    }
  }

  let webhookSecret = value.webhookSecret;
  if (webhookSecret === undefined && cur && typeof cur.webhookSecret === "string") webhookSecret = cur.webhookSecret;
  if (webhookSecret !== null && webhookSecret !== undefined && typeof webhookSecret !== "string") {
    return { ok: false, error: "buyerNotifications.webhookSecret must be string|null" };
  }
  const webhookSecretNorm = typeof webhookSecret === "string" && webhookSecret.trim() ? webhookSecret : null;

  return {
    ok: true,
    buyerNotifications: {
      emails: [...new Set(normalizedEmails)].sort(),
      deliveryMode,
      webhookUrl: webhookUrl || null,
      webhookSecret: webhookSecretNorm
    }
  };
}

function normalizeAutoDecision(value, { current } = {}) {
  if (value === undefined) return { ok: true, autoDecision: undefined };
  if (value === null) return { ok: true, autoDecision: { ...defaultTenantSettings().autoDecision } };
  if (!isPlainObject(value)) return { ok: false, error: "autoDecision must be an object or null" };

  const cur = isPlainObject(current) ? current : defaultTenantSettings().autoDecision;
  const out = {};

  const enabledRaw = value.enabled === undefined ? cur?.enabled : value.enabled;
  out.enabled = Boolean(enabledRaw);
  const approveOnGreenRaw = value.approveOnGreen === undefined ? cur?.approveOnGreen : value.approveOnGreen;
  out.approveOnGreen = Boolean(approveOnGreenRaw);
  const approveOnAmberRaw = value.approveOnAmber === undefined ? cur?.approveOnAmber : value.approveOnAmber;
  out.approveOnAmber = Boolean(approveOnAmberRaw);
  const holdOnRedRaw = value.holdOnRed === undefined ? cur?.holdOnRed : value.holdOnRed;
  out.holdOnRed = Boolean(holdOnRedRaw);

  let templateIdsRaw = value.templateIds;
  if (templateIdsRaw === undefined) templateIdsRaw = cur?.templateIds;
  if (templateIdsRaw === null) out.templateIds = null;
  else if (templateIdsRaw === undefined) out.templateIds = null;
  else if (!Array.isArray(templateIdsRaw)) return { ok: false, error: "autoDecision.templateIds must be an array or null" };
  else {
    const ids = [];
    for (const row of templateIdsRaw) {
      const parsed = normalizeSafeId(row, { fieldName: "autoDecision.templateIds[]" });
      if (!parsed.ok) return parsed;
      ids.push(parsed.id);
    }
    out.templateIds = [...new Set(ids)].sort();
  }

  let actorNameRaw = value.actorName;
  if (actorNameRaw === undefined) actorNameRaw = cur?.actorName;
  const actorName = String(actorNameRaw ?? "").trim();
  if (!actorName) return { ok: false, error: "autoDecision.actorName is required" };
  if (actorName.length > 200) return { ok: false, error: "autoDecision.actorName must be <= 200 chars" };
  out.actorName = actorName;

  let actorEmailRaw = value.actorEmail;
  if (actorEmailRaw === undefined) actorEmailRaw = cur?.actorEmail;
  const actorEmail = normalizeEmailLower(actorEmailRaw);
  if (!actorEmail) return { ok: false, error: "autoDecision.actorEmail must be a valid email" };
  out.actorEmail = actorEmail;

  if (out.enabled && !out.approveOnGreen && !out.approveOnAmber && !out.holdOnRed) {
    return { ok: false, error: "autoDecision enabled requires at least one action: approveOnGreen, approveOnAmber, or holdOnRed" };
  }

  return { ok: true, autoDecision: out };
}

function normalizePaymentTriggers(value, { current } = {}) {
  if (value === undefined) return { ok: true, paymentTriggers: undefined };
  if (value === null) return { ok: true, paymentTriggers: { ...defaultTenantSettings().paymentTriggers } };
  if (!isPlainObject(value)) return { ok: false, error: "paymentTriggers must be an object or null" };

  const cur = isPlainObject(current) ? current : defaultTenantSettings().paymentTriggers;
  const out = {};

  const enabledRaw = value.enabled === undefined ? cur?.enabled : value.enabled;
  out.enabled = Boolean(enabledRaw);

  const deliveryModeRaw = value.deliveryMode === undefined ? cur?.deliveryMode : value.deliveryMode;
  const deliveryMode = String(deliveryModeRaw ?? "record").trim().toLowerCase();
  if (deliveryMode !== "record" && deliveryMode !== "webhook") return { ok: false, error: "paymentTriggers.deliveryMode must be record|webhook" };
  out.deliveryMode = deliveryMode;

  const webhookUrlRaw = value.webhookUrl === undefined ? cur?.webhookUrl : value.webhookUrl;
  const webhookUrl = webhookUrlRaw === null || webhookUrlRaw === undefined ? null : String(webhookUrlRaw).trim();
  if (deliveryMode === "webhook" && out.enabled) {
    if (!webhookUrl) return { ok: false, error: "paymentTriggers.webhookUrl is required when enabled and deliveryMode=webhook" };
    try {
      const u = new URL(webhookUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "paymentTriggers.webhookUrl must be http(s)" };
    } catch {
      return { ok: false, error: "paymentTriggers.webhookUrl invalid URL" };
    }
  }
  out.webhookUrl = webhookUrl || null;

  let webhookSecret = value.webhookSecret;
  if (webhookSecret === undefined && cur && typeof cur.webhookSecret === "string") webhookSecret = cur.webhookSecret;
  if (webhookSecret !== null && webhookSecret !== undefined && typeof webhookSecret !== "string") return { ok: false, error: "paymentTriggers.webhookSecret must be string|null" };
  out.webhookSecret = typeof webhookSecret === "string" && webhookSecret.trim() ? webhookSecret : null;

  return { ok: true, paymentTriggers: out };
}

function normalizeRateLimits(value, { current } = {}) {
  if (value === undefined) return { ok: true, rateLimits: undefined };
  if (value === null) return { ok: true, rateLimits: { ...defaultTenantSettings().rateLimits } };
  if (!isPlainObject(value)) return { ok: false, error: "rateLimits must be an object or null" };

  const base = { ...defaultTenantSettings().rateLimits, ...(isPlainObject(current) ? current : {}) };
  const out = {};
  for (const field of ["uploadsPerHour", "verificationViewsPerHour", "decisionsPerHour", "otpRequestsPerHour"]) {
    const raw = value[field] === undefined ? base[field] : value[field];
    const n = Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return { ok: false, error: `rateLimits.${field} must be an integer 0..1000000` };
    out[field] = n;
  }
  return { ok: true, rateLimits: out };
}

function normalizePolicyProfile(profile) {
  if (!isPlainObject(profile)) return { ok: false, error: "policy profile must be an object" };
  const allowed = new Set([
    "requiredMode",
    "failOnWarnings",
    "allowAmberApprovals",
    "requiredPricingMatrixSignerKeyIds",
    "requireProducerReceiptPresent",
    "retentionDays"
  ]);
  for (const k of Object.keys(profile)) {
    if (!allowed.has(k)) return { ok: false, error: `unknown policy field: ${k}` };
  }

  const out = {};

  if (profile.requiredMode !== undefined) {
    const v = String(profile.requiredMode ?? "").trim().toLowerCase();
    if (v !== "auto" && v !== "strict" && v !== "compat") return { ok: false, error: "policy.requiredMode must be auto|strict|compat" };
    out.requiredMode = v;
  }
  if (profile.failOnWarnings !== undefined) out.failOnWarnings = Boolean(profile.failOnWarnings);
  if (profile.allowAmberApprovals !== undefined) out.allowAmberApprovals = Boolean(profile.allowAmberApprovals);
  if (profile.requireProducerReceiptPresent !== undefined) out.requireProducerReceiptPresent = Boolean(profile.requireProducerReceiptPresent);

  if (profile.requiredPricingMatrixSignerKeyIds !== undefined) {
    if (profile.requiredPricingMatrixSignerKeyIds === null) out.requiredPricingMatrixSignerKeyIds = null;
    else if (!Array.isArray(profile.requiredPricingMatrixSignerKeyIds)) return { ok: false, error: "policy.requiredPricingMatrixSignerKeyIds must be an array or null" };
    else {
      const list = profile.requiredPricingMatrixSignerKeyIds.map((x) => String(x ?? "").trim()).filter(Boolean);
      const uniq = [...new Set(list)].sort();
      out.requiredPricingMatrixSignerKeyIds = uniq;
    }
  }

  if (profile.retentionDays !== undefined) {
    if (profile.retentionDays === null) out.retentionDays = null;
    else {
      const n = Number.parseInt(String(profile.retentionDays ?? ""), 10);
      if (!Number.isInteger(n) || n < 1 || n > 3650) return { ok: false, error: "policy.retentionDays must be null or an integer 1..3650" };
      out.retentionDays = n;
    }
  }

  return { ok: true, policy: out };
}

function normalizePoliciesMap(value, { current, idName }) {
  if (value === undefined) return { ok: true, map: undefined };
  if (value === null) return { ok: true, map: null };
  if (!isPlainObject(value)) return { ok: false, error: `${idName}Policies must be an object or null` };

  const cur = isPlainObject(current) ? current : null;
  const merged = cur ? { ...cur } : {};

  for (const [rawId, row] of Object.entries(value)) {
    const id = String(rawId ?? "").trim();
    if (!id) continue;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return { ok: false, error: `${idName} policy id invalid`, id };
    if (row === null) {
      delete merged[id];
      continue;
    }
    const parsed = normalizePolicyProfile(row);
    if (!parsed.ok) return parsed;
    merged[id] = parsed.policy;
  }

  return { ok: true, map: merged };
}

function normalizeSettingsPatch(patch, { currentSettings }) {
  if (!isPlainObject(patch)) return { ok: false, error: "settings body must be an object" };
  const out = {};

  if (patch.plan !== undefined) {
    try {
      out.plan = normalizeTenantPlan(patch.plan, { allowNull: false });
    } catch (err) {
      return { ok: false, error: err?.message ?? "plan must be free|builder|growth|enterprise" };
    }
  }

  if (patch.defaultMode !== undefined) {
    const v = String(patch.defaultMode ?? "").trim().toLowerCase();
    if (v !== "auto" && v !== "strict" && v !== "compat") return { ok: false, error: "defaultMode must be auto|strict|compat" };
    out.defaultMode = v;
  }

  if (patch.retentionDays !== undefined) {
    const n = Number.parseInt(String(patch.retentionDays ?? ""), 10);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return { ok: false, error: "retentionDays must be an integer 1..3650" };
    out.retentionDays = n;
  }

  if (patch.maxUploadBytesOverride !== undefined) {
    if (patch.maxUploadBytesOverride === null) out.maxUploadBytesOverride = null;
    else {
      const n = Number.parseInt(String(patch.maxUploadBytesOverride ?? ""), 10);
      if (!Number.isInteger(n) || n < 1) return { ok: false, error: "maxUploadBytesOverride must be null or a positive integer" };
      out.maxUploadBytesOverride = n;
    }
  }

  if (patch.trustedPricingSignerKeyIds !== undefined) {
    if (patch.trustedPricingSignerKeyIds === null) out.trustedPricingSignerKeyIds = null;
    else if (!Array.isArray(patch.trustedPricingSignerKeyIds)) return { ok: false, error: "trustedPricingSignerKeyIds must be an array or null" };
    else {
      const list = patch.trustedPricingSignerKeyIds.map((x) => String(x ?? "").trim()).filter(Boolean);
      for (const kid of list) {
        if (kid.length > 128 || /\s/.test(kid)) return { ok: false, error: "trustedPricingSignerKeyIds entries must be non-empty keyId strings", keyId: kid };
      }
      out.trustedPricingSignerKeyIds = [...new Set(list)].sort();
    }
  }

  if (patch.maxVerificationsPerMonth !== undefined) {
    if (patch.maxVerificationsPerMonth === null) out.maxVerificationsPerMonth = null;
    else {
      const n = Number.parseInt(String(patch.maxVerificationsPerMonth ?? ""), 10);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: "maxVerificationsPerMonth must be null or an integer >= 0" };
      out.maxVerificationsPerMonth = n;
    }
  }

  if (patch.maxStoredBundles !== undefined) {
    if (patch.maxStoredBundles === null) out.maxStoredBundles = null;
    else {
      const n = Number.parseInt(String(patch.maxStoredBundles ?? ""), 10);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: "maxStoredBundles must be null or an integer >= 0" };
      out.maxStoredBundles = n;
    }
  }

  const trust = normalizeTrustRootsJson(patch.governanceTrustRootsJson);
  if (!trust.ok) return trust;
  if (trust.roots !== undefined) out.governanceTrustRootsJson = trust.roots;

  const pricingSigners = normalizePricingSignerKeysJson(patch.pricingSignerKeysJson);
  if (!pricingSigners.ok) return pricingSigners;
  if (pricingSigners.keys !== undefined) out.pricingSignerKeysJson = pricingSigners.keys;

  const webhooks = normalizeWebhookConfigList(patch.webhooks, { current: currentSettings?.webhooks ?? [] });
  if (!webhooks.ok) return webhooks;
  if (webhooks.webhooks !== undefined) out.webhooks = webhooks.webhooks;

  const artifactStorage = normalizeArtifactStorageConfig(patch.artifactStorage, { current: currentSettings?.artifactStorage ?? null });
  if (!artifactStorage.ok) return artifactStorage;
  if (artifactStorage.artifactStorage !== undefined) out.artifactStorage = artifactStorage.artifactStorage;

  const archiveExportSink = normalizeArchiveExportSink(patch.archiveExportSink, { current: currentSettings?.archiveExportSink ?? null });
  if (!archiveExportSink.ok) return archiveExportSink;
  if (archiveExportSink.archiveExportSink !== undefined) out.archiveExportSink = archiveExportSink.archiveExportSink;

  const buyerNotifications = normalizeBuyerNotifications(patch.buyerNotifications, { current: currentSettings?.buyerNotifications ?? null });
  if (!buyerNotifications.ok) return buyerNotifications;
  if (buyerNotifications.buyerNotifications !== undefined) out.buyerNotifications = buyerNotifications.buyerNotifications;

  const autoDecision = normalizeAutoDecision(patch.autoDecision, { current: currentSettings?.autoDecision ?? null });
  if (!autoDecision.ok) return autoDecision;
  if (autoDecision.autoDecision !== undefined) out.autoDecision = autoDecision.autoDecision;

  const paymentTriggers = normalizePaymentTriggers(patch.paymentTriggers, { current: currentSettings?.paymentTriggers ?? null });
  if (!paymentTriggers.ok) return paymentTriggers;
  if (paymentTriggers.paymentTriggers !== undefined) out.paymentTriggers = paymentTriggers.paymentTriggers;

  const rateLimits = normalizeRateLimits(patch.rateLimits, { current: currentSettings?.rateLimits ?? null });
  if (!rateLimits.ok) return rateLimits;
  if (rateLimits.rateLimits !== undefined) out.rateLimits = rateLimits.rateLimits;

  const vendorPolicies = normalizePoliciesMap(patch.vendorPolicies, { current: currentSettings?.vendorPolicies ?? null, idName: "vendor" });
  if (!vendorPolicies.ok) return vendorPolicies;
  if (vendorPolicies.map !== undefined) out.vendorPolicies = vendorPolicies.map;

  const contractPolicies = normalizePoliciesMap(patch.contractPolicies, { current: currentSettings?.contractPolicies ?? null, idName: "contract" });
  if (!contractPolicies.ok) return contractPolicies;
  if (contractPolicies.map !== undefined) out.contractPolicies = contractPolicies.map;

  if (patch.buyerAuthEmailDomains !== undefined) {
    if (patch.buyerAuthEmailDomains === null) out.buyerAuthEmailDomains = [];
    else if (!Array.isArray(patch.buyerAuthEmailDomains)) return { ok: false, error: "buyerAuthEmailDomains must be an array or null" };
    else {
      const raw = patch.buyerAuthEmailDomains.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
      const domains = [];
      for (const d of raw) {
        if (d.includes("@")) return { ok: false, error: "buyerAuthEmailDomains must not include @", domain: d };
        if (!/^[a-z0-9.-]{1,255}$/.test(d) || d.startsWith(".") || d.endsWith(".") || d.includes("..")) {
          return { ok: false, error: "buyerAuthEmailDomains contains invalid domain", domain: d };
        }
        domains.push(d);
      }
      out.buyerAuthEmailDomains = [...new Set(domains)].sort();
    }
  }

  if (patch.buyerUserRoles !== undefined) {
    if (patch.buyerUserRoles === null) out.buyerUserRoles = null;
    else if (!isPlainObject(patch.buyerUserRoles)) return { ok: false, error: "buyerUserRoles must be an object or null" };
    else {
      const outRoles = {};
      const allowed = new Set(["admin", "approver", "viewer"]);
      for (const [rawEmail, rawRole] of Object.entries(patch.buyerUserRoles)) {
        const email = normalizeEmailLower(rawEmail);
        if (!email) return { ok: false, error: "buyerUserRoles contains invalid email", email: rawEmail };
        const role = String(rawRole ?? "").trim().toLowerCase();
        if (!allowed.has(role)) return { ok: false, error: "buyerUserRoles contains invalid role", email, role: rawRole };
        outRoles[email] = role;
      }
      out.buyerUserRoles = outRoles;
    }
  }

  if (patch.decisionAuthEmailDomains !== undefined) {
    if (patch.decisionAuthEmailDomains === null) out.decisionAuthEmailDomains = [];
    else if (!Array.isArray(patch.decisionAuthEmailDomains)) return { ok: false, error: "decisionAuthEmailDomains must be an array or null" };
    else {
      const raw = patch.decisionAuthEmailDomains.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
      const domains = [];
      for (const d of raw) {
        if (d.includes("@")) return { ok: false, error: "decisionAuthEmailDomains must not include @", domain: d };
        if (!/^[a-z0-9.-]{1,255}$/.test(d) || d.startsWith(".") || d.endsWith(".") || d.includes("..")) {
          return { ok: false, error: "decisionAuthEmailDomains contains invalid domain", domain: d };
        }
        domains.push(d);
      }
      out.decisionAuthEmailDomains = [...new Set(domains)].sort();
    }
  }

  if (patch.settlementDecisionSigner !== undefined) {
    if (patch.settlementDecisionSigner === null) out.settlementDecisionSigner = null;
    else if (!isPlainObject(patch.settlementDecisionSigner)) return { ok: false, error: "settlementDecisionSigner must be an object or null" };
    else {
      const cur = isPlainObject(currentSettings?.settlementDecisionSigner) ? currentSettings.settlementDecisionSigner : null;
      const s = patch.settlementDecisionSigner;

      const signerKeyId = typeof s.signerKeyId === "string" ? s.signerKeyId.trim() : "";
      if (!signerKeyId) return { ok: false, error: "settlementDecisionSigner.signerKeyId is required" };

      let privateKeyPem = s.privateKeyPem;
      if (privateKeyPem === undefined && cur && typeof cur.privateKeyPem === "string") privateKeyPem = cur.privateKeyPem;
      if (privateKeyPem !== null && privateKeyPem !== undefined && typeof privateKeyPem !== "string") return { ok: false, error: "settlementDecisionSigner.privateKeyPem must be string|null" };
      const privateKeyPemNorm = typeof privateKeyPem === "string" && privateKeyPem.trim() ? privateKeyPem : null;

      const remoteSignerUrl = s.remoteSignerUrl;
      if (remoteSignerUrl !== null && remoteSignerUrl !== undefined && typeof remoteSignerUrl !== "string") return { ok: false, error: "settlementDecisionSigner.remoteSignerUrl must be string|null" };
      const remoteSignerUrlNorm = typeof remoteSignerUrl === "string" && remoteSignerUrl.trim() ? remoteSignerUrl.trim() : null;
      if (remoteSignerUrlNorm !== null) {
        try {
          const u = new URL(remoteSignerUrlNorm);
          if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "settlementDecisionSigner.remoteSignerUrl must be http(s)" };
        } catch {
          return { ok: false, error: "settlementDecisionSigner.remoteSignerUrl invalid" };
        }
      }

      let remoteSignerBearerToken = s.remoteSignerBearerToken;
      if (remoteSignerBearerToken === undefined && cur && typeof cur.remoteSignerBearerToken === "string") remoteSignerBearerToken = cur.remoteSignerBearerToken;
      if (remoteSignerBearerToken !== null && remoteSignerBearerToken !== undefined && typeof remoteSignerBearerToken !== "string") {
        return { ok: false, error: "settlementDecisionSigner.remoteSignerBearerToken must be string|null" };
      }
      const remoteSignerBearerTokenNorm = typeof remoteSignerBearerToken === "string" && remoteSignerBearerToken.trim() ? remoteSignerBearerToken : null;

      const modeCount = (privateKeyPemNorm ? 1 : 0) + (remoteSignerUrlNorm ? 1 : 0);
      if (modeCount !== 1) return { ok: false, error: "settlementDecisionSigner must set exactly one of privateKeyPem or remoteSignerUrl" };
      if (privateKeyPemNorm && !privateKeyPemNorm.includes("BEGIN PRIVATE KEY")) return { ok: false, error: "settlementDecisionSigner.privateKeyPem must be a PEM private key" };

      out.settlementDecisionSigner = {
        signerKeyId,
        privateKeyPem: privateKeyPemNorm,
        remoteSignerUrl: remoteSignerUrlNorm,
        remoteSignerBearerToken: remoteSignerUrlNorm ? remoteSignerBearerTokenNorm : null
      };
    }
  }

  return { ok: true, patch: out };
}

export function governanceTrustInfo({ tenantSettings, envValue }) {
  // Tenant settings win when non-null; otherwise fall back to process env.
  const fromTenant = tenantSettings && tenantSettings.governanceTrustRootsJson !== null && tenantSettings.governanceTrustRootsJson !== undefined;
  let roots = fromTenant ? tenantSettings.governanceTrustRootsJson : null;
  if (!fromTenant) {
    const raw = String(envValue ?? "").trim();
    if (!raw) roots = null;
    else {
      try {
        roots = JSON.parse(raw);
      } catch (err) {
        return { configured: false, reason: "invalid", keyIds: [], detail: err?.message ?? String(err ?? "") };
      }
    }
  }

  const parsed = normalizeTrustRootsJson(roots);
  if (!parsed.ok) return { configured: false, reason: "invalid", keyIds: [], detail: parsed.error };
  const obj = parsed.roots;
  if (obj === null || obj === undefined) return { configured: false, reason: "missing", keyIds: [], json: "" };
  const keyIds = Object.keys(obj).filter(Boolean).sort();
  const setHash = trustRootSetHashHex(keyIds);
  const json = JSON.stringify(obj);
  return { configured: keyIds.length > 0, reason: keyIds.length > 0 ? null : "empty", keyIds, setHash, json, source: fromTenant ? "tenant" : "env" };
}

export function pricingSignerTrustInfo({ tenantSettings, envValue }) {
  const fromTenant = tenantSettings && tenantSettings.pricingSignerKeysJson !== null && tenantSettings.pricingSignerKeysJson !== undefined;
  let keys = fromTenant ? tenantSettings.pricingSignerKeysJson : null;
  if (!fromTenant) {
    const raw = String(envValue ?? "").trim();
    if (!raw) keys = null;
    else {
      try {
        keys = JSON.parse(raw);
      } catch (err) {
        return { configured: false, reason: "invalid", keyIds: [], detail: err?.message ?? String(err ?? "") };
      }
    }
  }

  const parsed = normalizePricingSignerKeysJson(keys);
  if (!parsed.ok) return { configured: false, reason: "invalid", keyIds: [], detail: parsed.error };
  let obj = parsed.keys;
  if (obj === null || obj === undefined) return { configured: false, reason: "missing", keyIds: [], json: "" };

  const allow = Array.isArray(tenantSettings?.trustedPricingSignerKeyIds) ? tenantSettings.trustedPricingSignerKeyIds.map(String).filter(Boolean) : [];
  if (allow.length) {
    const allowed = new Set(allow);
    const next = {};
    for (const [k, v] of Object.entries(obj)) {
      if (allowed.has(k)) next[k] = v;
    }
    obj = next;
  }

  const keyIds = Object.keys(obj).filter(Boolean).sort();
  const setHash = trustRootSetHashHex(keyIds);
  const json = JSON.stringify(obj);
  return { configured: keyIds.length > 0, reason: keyIds.length > 0 ? null : "empty", keyIds, setHash, json, source: fromTenant ? "tenant" : "env" };
}

export function sanitizeTenantSettingsForApi(settings) {
  const s = isPlainObject(settings) ? settings : defaultTenantSettings();
  const out = { ...defaultTenantSettings(), ...s };
  try {
    out.plan = normalizeTenantPlan(out.plan, { allowNull: false });
  } catch {
    out.plan = "free";
  }
  out.webhooks = Array.isArray(out.webhooks)
    ? out.webhooks.map((w) => ({
      url: typeof w?.url === "string" ? w.url : null,
      events: Array.isArray(w?.events) ? w.events : [],
      enabled: Boolean(w?.enabled),
      secret: null
    }))
    : [];
  out.vendorPolicies = isPlainObject(out.vendorPolicies) ? out.vendorPolicies : out.vendorPolicies === null ? null : null;
  out.contractPolicies = isPlainObject(out.contractPolicies) ? out.contractPolicies : out.contractPolicies === null ? null : null;
  out.buyerAuthEmailDomains = Array.isArray(out.buyerAuthEmailDomains) ? out.buyerAuthEmailDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean) : [];
  out.buyerUserRoles = isPlainObject(out.buyerUserRoles) ? out.buyerUserRoles : out.buyerUserRoles === null ? null : null;
  out.buyerNotifications = isPlainObject(out.buyerNotifications)
    ? {
      emails: Array.isArray(out.buyerNotifications.emails) ? out.buyerNotifications.emails.map((x) => normalizeEmailLower(x)).filter(Boolean) : [],
      deliveryMode: typeof out.buyerNotifications.deliveryMode === "string" ? out.buyerNotifications.deliveryMode : "smtp",
      webhookUrl: typeof out.buyerNotifications.webhookUrl === "string" ? out.buyerNotifications.webhookUrl : null,
      webhookSecret: null
    }
    : { ...defaultTenantSettings().buyerNotifications, webhookSecret: null };
  out.autoDecision = isPlainObject(out.autoDecision)
    ? {
      enabled: Boolean(out.autoDecision.enabled),
      approveOnGreen: Boolean(out.autoDecision.approveOnGreen),
      approveOnAmber: Boolean(out.autoDecision.approveOnAmber),
      holdOnRed: Boolean(out.autoDecision.holdOnRed),
      templateIds: Array.isArray(out.autoDecision.templateIds) ? out.autoDecision.templateIds.map((x) => String(x ?? "").trim()).filter(Boolean) : null,
      actorName: typeof out.autoDecision.actorName === "string" ? out.autoDecision.actorName : defaultTenantSettings().autoDecision.actorName,
      actorEmail: normalizeEmailLower(out.autoDecision.actorEmail) ?? defaultTenantSettings().autoDecision.actorEmail
    }
    : { ...defaultTenantSettings().autoDecision };
  out.paymentTriggers = isPlainObject(out.paymentTriggers)
    ? {
      enabled: Boolean(out.paymentTriggers.enabled),
      deliveryMode: typeof out.paymentTriggers.deliveryMode === "string" ? out.paymentTriggers.deliveryMode : "record",
      webhookUrl: typeof out.paymentTriggers.webhookUrl === "string" ? out.paymentTriggers.webhookUrl : null,
      webhookSecret: null
    }
    : { ...defaultTenantSettings().paymentTriggers, webhookSecret: null };
  out.rateLimits = isPlainObject(out.rateLimits) ? { ...defaultTenantSettings().rateLimits, ...out.rateLimits } : { ...defaultTenantSettings().rateLimits };
  out.decisionAuthEmailDomains = Array.isArray(out.decisionAuthEmailDomains) ? out.decisionAuthEmailDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean) : [];
  out.trustedPricingSignerKeyIds = Array.isArray(out.trustedPricingSignerKeyIds) ? out.trustedPricingSignerKeyIds.map((k) => String(k ?? "").trim()).filter(Boolean) : out.trustedPricingSignerKeyIds === null ? null : null;
  out.settlementDecisionSigner =
    isPlainObject(out.settlementDecisionSigner) && typeof out.settlementDecisionSigner.signerKeyId === "string"
      ? { signerKeyId: out.settlementDecisionSigner.signerKeyId, privateKeyPem: null, remoteSignerUrl: out.settlementDecisionSigner.remoteSignerUrl ?? null, remoteSignerBearerToken: null }
      : null;
  out.artifactStorage = isPlainObject(out.artifactStorage) ? { ...defaultTenantSettings().artifactStorage, ...out.artifactStorage } : defaultTenantSettings().artifactStorage;
  out.archiveExportSink = isPlainObject(out.archiveExportSink)
    ? {
      type: out.archiveExportSink.type ?? null,
      enabled: Boolean(out.archiveExportSink.enabled),
      endpoint: out.archiveExportSink.endpoint ?? null,
      region: out.archiveExportSink.region ?? null,
      bucket: out.archiveExportSink.bucket ?? null,
      prefix: out.archiveExportSink.prefix ?? null,
      pathStyle: out.archiveExportSink.pathStyle ?? null,
      accessKeyId: out.archiveExportSink.accessKeyId ?? null,
      secretAccessKey: null,
      sessionToken: null,
      sse: out.archiveExportSink.sse ?? "none",
      kmsKeyId: out.archiveExportSink.kmsKeyId ?? null
    }
    : null;
  return out;
}

export async function loadTenantSettings({ dataDir, tenantId }) {
  const fp = path.join(dataDir, "tenants", tenantId, "settings.json");
  try {
    const raw = await fs.readFile(fp, "utf8");
    const j = JSON.parse(raw);
    if (!isPlainObject(j)) return defaultTenantSettings();
    if (j.schemaVersion === "TenantSettings.v2") return { ...defaultTenantSettings(), ...j };
    if (j.schemaVersion === "TenantSettings.v1") {
      const migrated = { ...defaultTenantSettings(), ...j, schemaVersion: "TenantSettings.v2" };
      if (!isPlainObject(migrated.artifactStorage)) migrated.artifactStorage = { ...defaultTenantSettings().artifactStorage };
      if (migrated.archiveExportSink === undefined) migrated.archiveExportSink = null;
      return migrated;
    }
    return defaultTenantSettings();
  } catch {
    return defaultTenantSettings();
  }
}

export async function saveTenantSettings({ dataDir, tenantId, settings, settingsKey }) {
  const fp = path.join(dataDir, "tenants", tenantId, "settings.json");
  await fs.mkdir(path.dirname(fp), { recursive: true });

  const s = { ...defaultTenantSettings(), ...(isPlainObject(settings) ? settings : {}) };
  s.schemaVersion = "TenantSettings.v2";
  const webhooks = Array.isArray(s.webhooks) ? s.webhooks : [];
  s.webhooks = webhooks.map((w) => {
    if (!isPlainObject(w)) return w;
    if (typeof w.secret !== "string" || !w.secret) return { ...w, secret: null };
    if (w.secret.startsWith("enc:v1:")) return w;
    if (!settingsKey) return w;
    return { ...w, secret: encryptStringAes256Gcm({ key: settingsKey, plaintext: w.secret }) };
  });

  if (isPlainObject(s.settlementDecisionSigner)) {
    const next = { ...s.settlementDecisionSigner };
    for (const field of ["privateKeyPem", "remoteSignerBearerToken"]) {
      const v = next[field];
      if (typeof v !== "string" || !v) {
        next[field] = null;
        continue;
      }
      if (v.startsWith("enc:v1:")) continue;
      if (!settingsKey) continue;
      next[field] = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    }
    s.settlementDecisionSigner = next;
  }

  if (isPlainObject(s.buyerNotifications)) {
    const next = { ...defaultTenantSettings().buyerNotifications, ...s.buyerNotifications };
    const v = next.webhookSecret;
    if (typeof v !== "string" || !v) next.webhookSecret = null;
    else if (v.startsWith("enc:v1:")) next.webhookSecret = v;
    else if (settingsKey) next.webhookSecret = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    s.buyerNotifications = next;
  }

  if (isPlainObject(s.paymentTriggers)) {
    const next = { ...defaultTenantSettings().paymentTriggers, ...s.paymentTriggers };
    const v = next.webhookSecret;
    if (typeof v !== "string" || !v) next.webhookSecret = null;
    else if (v.startsWith("enc:v1:")) next.webhookSecret = v;
    else if (settingsKey) next.webhookSecret = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    s.paymentTriggers = next;
  }

  if (isPlainObject(s.archiveExportSink)) {
    const next = { ...s.archiveExportSink };
    for (const field of ["secretAccessKey", "sessionToken"]) {
      const v = next[field];
      if (typeof v !== "string" || !v) {
        next[field] = null;
        continue;
      }
      if (v.startsWith("enc:v1:")) continue;
      if (!settingsKey) continue;
      next[field] = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    }
    s.archiveExportSink = next;
  }

  await fs.writeFile(fp, JSON.stringify(s, null, 2) + "\n", "utf8");
}

export function getSettingsKeyFromEnv() {
  return parseSettingsKeyHex(process.env.MAGIC_LINK_SETTINGS_KEY_HEX ?? "");
}

export function applyTenantSettingsPatch({ currentSettings, patch, settingsKey }) {
  const normalized = normalizeSettingsPatch(patch, { currentSettings });
  if (!normalized.ok) return normalized;

  const next = { ...defaultTenantSettings(), ...(isPlainObject(currentSettings) ? currentSettings : {}), ...normalized.patch };
  next.schemaVersion = "TenantSettings.v2";
  if (Array.isArray(next.webhooks)) {
    next.webhooks = next.webhooks.map((w) => {
      if (!isPlainObject(w)) return w;
      // Normalize + encrypt secret before storing.
      if (typeof w.secret !== "string" || !w.secret) return { ...w, secret: null };
      if (w.secret.startsWith("enc:v1:")) return w;
      if (!settingsKey) return { ...w, secret: w.secret };
      return { ...w, secret: encryptStringAes256Gcm({ key: settingsKey, plaintext: w.secret }) };
    });
  }
  if (isPlainObject(next.settlementDecisionSigner)) {
    const row = { ...next.settlementDecisionSigner };
    for (const field of ["privateKeyPem", "remoteSignerBearerToken"]) {
      const v = row[field];
      if (typeof v !== "string" || !v) {
        row[field] = null;
        continue;
      }
      if (v.startsWith("enc:v1:")) continue;
      if (!settingsKey) continue;
      row[field] = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    }
    next.settlementDecisionSigner = row;
  }
  if (isPlainObject(next.buyerNotifications)) {
    const row = { ...defaultTenantSettings().buyerNotifications, ...next.buyerNotifications };
    const v = row.webhookSecret;
    if (typeof v !== "string" || !v) row.webhookSecret = null;
    else if (v.startsWith("enc:v1:")) row.webhookSecret = v;
    else if (settingsKey) row.webhookSecret = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    next.buyerNotifications = row;
  }
  if (isPlainObject(next.paymentTriggers)) {
    const row = { ...defaultTenantSettings().paymentTriggers, ...next.paymentTriggers };
    const v = row.webhookSecret;
    if (typeof v !== "string" || !v) row.webhookSecret = null;
    else if (v.startsWith("enc:v1:")) row.webhookSecret = v;
    else if (settingsKey) row.webhookSecret = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    next.paymentTriggers = row;
  }
  if (isPlainObject(next.archiveExportSink)) {
    const row = { ...next.archiveExportSink };
    for (const field of ["secretAccessKey", "sessionToken"]) {
      const v = row[field];
      if (typeof v !== "string" || !v) {
        row[field] = null;
        continue;
      }
      if (v.startsWith("enc:v1:")) continue;
      if (!settingsKey) continue;
      row[field] = encryptStringAes256Gcm({ key: settingsKey, plaintext: v });
    }
    next.archiveExportSink = row;
  }
  return { ok: true, settings: next };
}

export function decryptStoredSecret({ settingsKey, storedSecret }) {
  if (storedSecret === null || storedSecret === undefined) return null;
  if (typeof storedSecret !== "string") return null;
  const v = storedSecret;
  if (!v.startsWith("enc:v1:")) return v;
  if (!settingsKey) return null;
  try {
    return decryptStringAes256Gcm({ key: settingsKey, value: v });
  } catch {
    return null;
  }
}

export function decryptWebhookSecret({ settingsKey, storedSecret }) {
  return decryptStoredSecret({ settingsKey, storedSecret });
}
