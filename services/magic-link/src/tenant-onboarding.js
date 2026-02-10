import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

function normalizeEmailLower(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > 320) return null;
  if (/\s/.test(raw)) return null;
  const parts = raw.split("@");
  if (parts.length !== 2) return null;
  if (!parts[0] || !parts[1]) return null;
  return raw;
}

function normalizeTenantName(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (v.length > 200) return null;
  if (v.includes("\n") || v.includes("\r")) return null;
  return v;
}

function slugifyTenantName(name) {
  const raw = String(name ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return raw || "tenant";
}

function randomSuffixHex(len = 8) {
  return crypto.randomBytes(Math.max(2, Math.ceil(len / 2))).toString("hex").slice(0, len);
}

function defaultTenantProfile({ tenantId }) {
  return {
    schemaVersion: "MagicLinkTenantProfile.v1",
    tenantId,
    name: null,
    contactEmail: null,
    billingEmail: null,
    status: "pending",
    createdAt: nowIso(),
    activatedAt: null,
    firstUploadAt: null,
    firstVerifiedAt: null,
    firstWizardViewedAt: null,
    firstTemplateSelectedAt: null,
    firstTemplateRenderedAt: null,
    firstSampleUploadAt: null,
    firstSampleVerifiedAt: null,
    firstBuyerLinkSharedAt: null,
    firstBuyerLinkOpenedAt: null,
    firstReferralLinkSharedAt: null,
    firstReferralSignupAt: null,
    onboardingEvents: []
  };
}

function profilePath({ dataDir, tenantId }) {
  return path.join(dataDir, "tenants", tenantId, "profile.json");
}

export async function loadTenantProfileBestEffort({ dataDir, tenantId }) {
  const fp = profilePath({ dataDir, tenantId });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!isPlainObject(raw)) return null;
    const merged = { ...defaultTenantProfile({ tenantId }), ...raw, tenantId };
    return merged;
  } catch {
    return null;
  }
}

async function saveTenantProfile({ dataDir, tenantId, profile }) {
  const fp = profilePath({ dataDir, tenantId });
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(profile, null, 2) + "\n", "utf8");
}

const ONBOARDING_EVENT_TYPE = Object.freeze({
  TENANT_CREATED: "tenant_created",
  WIZARD_VIEWED: "wizard_viewed",
  TEMPLATE_SELECTED: "template_selected",
  TEMPLATE_RENDERED: "template_rendered",
  DEMO_TRUST_ENABLED: "demo_trust_enabled",
  SAMPLE_UPLOAD_GENERATED: "sample_upload_generated",
  SAMPLE_UPLOAD_VERIFIED: "sample_upload_verified",
  SAMPLE_UPLOAD_FAILED: "sample_upload_failed",
  REAL_UPLOAD_GENERATED: "real_upload_generated",
  REAL_UPLOAD_VERIFIED: "real_upload_verified",
  REAL_UPLOAD_FAILED: "real_upload_failed",
  BUYER_LINK_SHARED: "buyer_link_shared",
  BUYER_LINK_OPENED: "buyer_link_opened",
  REFERRAL_LINK_SHARED: "referral_link_shared",
  REFERRAL_SIGNUP: "referral_signup"
});

const ONBOARDING_EVENT_TYPE_SET = new Set(Object.values(ONBOARDING_EVENT_TYPE));

function normalizeOnboardingEventType(value, { allowNull = false, fieldName = "eventType" } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldName} is required`);
  }
  const normalized = String(value).trim().toLowerCase();
  if (!ONBOARDING_EVENT_TYPE_SET.has(normalized)) {
    throw new TypeError(`${fieldName} must be one of: ${[...ONBOARDING_EVENT_TYPE_SET].join("|")}`);
  }
  return normalized;
}

function normalizeOnboardingEventMetadata(input) {
  if (!isPlainObject(input)) return null;
  const out = {};
  const entries = Object.entries(input).slice(0, 20);
  for (const [keyRaw, value] of entries) {
    const key = String(keyRaw ?? "").trim();
    if (!key || key.length > 64) continue;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof value === "string") {
      out[key] = value.length > 200 ? value.slice(0, 200) : value;
      continue;
    }
    if (typeof value === "number") {
      out[key] = Number.isFinite(value) ? value : null;
      continue;
    }
    if (typeof value === "boolean") {
      out[key] = value;
      continue;
    }
  }
  return Object.keys(out).length ? out : null;
}

function appendOnboardingEvent(profile, { eventType, at, source = null, metadata = null }) {
  const eventAt = typeof at === "string" && at.trim() !== "" ? at.trim() : nowIso();
  const nextEvents = Array.isArray(profile?.onboardingEvents) ? [...profile.onboardingEvents] : [];
  nextEvents.push({
    eventType,
    at: eventAt,
    source: typeof source === "string" && source.trim() !== "" ? source.trim() : null,
    metadata: normalizeOnboardingEventMetadata(metadata)
  });
  if (nextEvents.length > 200) nextEvents.splice(0, nextEvents.length - 200);

  const next = { ...profile, onboardingEvents: nextEvents };
  if (eventType === ONBOARDING_EVENT_TYPE.WIZARD_VIEWED && !next.firstWizardViewedAt) next.firstWizardViewedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.TEMPLATE_SELECTED && !next.firstTemplateSelectedAt) next.firstTemplateSelectedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.TEMPLATE_RENDERED && !next.firstTemplateRenderedAt) next.firstTemplateRenderedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.SAMPLE_UPLOAD_GENERATED && !next.firstSampleUploadAt) next.firstSampleUploadAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.SAMPLE_UPLOAD_VERIFIED && !next.firstSampleVerifiedAt) next.firstSampleVerifiedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.BUYER_LINK_SHARED && !next.firstBuyerLinkSharedAt) next.firstBuyerLinkSharedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.BUYER_LINK_OPENED && !next.firstBuyerLinkOpenedAt) next.firstBuyerLinkOpenedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.REFERRAL_LINK_SHARED && !next.firstReferralLinkSharedAt) next.firstReferralLinkSharedAt = eventAt;
  if (eventType === ONBOARDING_EVENT_TYPE.REFERRAL_SIGNUP && !next.firstReferralSignupAt) next.firstReferralSignupAt = eventAt;
  return next;
}

function monthKeyFromIso(value) {
  const ms = Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function pct(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.round((p / t) * 10000) / 100;
}

function medianMs(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return Math.round((nums[mid - 1] + nums[mid]) / 2);
}

export async function createTenantProfile({ dataDir, tenantId, name, contactEmail, billingEmail } = {}) {
  const t = String(tenantId ?? "").trim();
  if (!t || !/^[a-zA-Z0-9_-]{1,64}$/.test(t)) return { ok: false, error: "tenantId invalid (allowed: [A-Za-z0-9_-]{1,64})" };

  const profileName = normalizeTenantName(name);
  if (!profileName) return { ok: false, error: "name is required" };
  const contact = normalizeEmailLower(contactEmail);
  if (!contact) return { ok: false, error: "contactEmail is required and must be valid" };
  const billing = normalizeEmailLower(billingEmail);
  if (!billing) return { ok: false, error: "billingEmail is required and must be valid" };

  const existing = await loadTenantProfileBestEffort({ dataDir, tenantId: t });
  if (existing) return { ok: false, error: "tenant already exists", code: "TENANT_EXISTS" };

  const profile = {
    ...defaultTenantProfile({ tenantId: t }),
    name: profileName,
    contactEmail: contact,
    billingEmail: billing
  };
  const withCreatedEvent = appendOnboardingEvent(profile, {
    eventType: ONBOARDING_EVENT_TYPE.TENANT_CREATED,
    at: profile.createdAt,
    source: "tenant_create",
    metadata: null
  });
  await saveTenantProfile({ dataDir, tenantId: t, profile: withCreatedEvent });
  return { ok: true, profile: withCreatedEvent };
}

export function generateTenantIdFromName(name) {
  const base = slugifyTenantName(name);
  const capped = base.slice(0, 52).replaceAll(/^_+|_+$/g, "") || "tenant";
  return `${capped}_${randomSuffixHex(8)}`;
}

export async function markTenantOnboardingProgress({ dataDir, tenantId, isSample = false, verificationOk = false, at = null } = {}) {
  const t = String(tenantId ?? "").trim();
  if (!t) return { ok: false, error: "tenantId required" };

  const now = typeof at === "string" && at.trim() ? at.trim() : nowIso();
  const existing = (await loadTenantProfileBestEffort({ dataDir, tenantId: t })) ?? defaultTenantProfile({ tenantId: t });
  let next = { ...existing };

  if (isSample) {
    next = appendOnboardingEvent(next, {
      eventType: ONBOARDING_EVENT_TYPE.SAMPLE_UPLOAD_GENERATED,
      at: now,
      source: "sample_upload",
      metadata: { verificationOk: Boolean(verificationOk) }
    });
    next = appendOnboardingEvent(next, {
      eventType: verificationOk ? ONBOARDING_EVENT_TYPE.SAMPLE_UPLOAD_VERIFIED : ONBOARDING_EVENT_TYPE.SAMPLE_UPLOAD_FAILED,
      at: now,
      source: "sample_upload",
      metadata: null
    });
  } else {
    next = appendOnboardingEvent(next, {
      eventType: ONBOARDING_EVENT_TYPE.REAL_UPLOAD_GENERATED,
      at: now,
      source: "real_upload",
      metadata: { verificationOk: Boolean(verificationOk) }
    });
    if (!next.firstUploadAt) next.firstUploadAt = now;
    if (!next.activatedAt) next.activatedAt = now;
    next.status = "active";
    if (verificationOk && !next.firstVerifiedAt) next.firstVerifiedAt = now;
    next = appendOnboardingEvent(next, {
      eventType: verificationOk ? ONBOARDING_EVENT_TYPE.REAL_UPLOAD_VERIFIED : ONBOARDING_EVENT_TYPE.REAL_UPLOAD_FAILED,
      at: now,
      source: "real_upload",
      metadata: null
    });
  }

  await saveTenantProfile({ dataDir, tenantId: t, profile: next });
  return { ok: true, profile: next };
}

export async function recordTenantOnboardingEvent({
  dataDir,
  tenantId,
  eventType,
  at = null,
  source = null,
  metadata = null
} = {}) {
  const t = String(tenantId ?? "").trim();
  if (!t) return { ok: false, error: "tenantId required" };
  let normalizedEventType;
  try {
    normalizedEventType = normalizeOnboardingEventType(eventType, { allowNull: false, fieldName: "eventType" });
  } catch (err) {
    return { ok: false, error: err?.message ?? "invalid eventType" };
  }
  const eventAt = typeof at === "string" && at.trim() !== "" ? at.trim() : nowIso();
  let next = (await loadTenantProfileBestEffort({ dataDir, tenantId: t })) ?? defaultTenantProfile({ tenantId: t });
  next = appendOnboardingEvent(next, {
    eventType: normalizedEventType,
    at: eventAt,
    source,
    metadata
  });
  await saveTenantProfile({ dataDir, tenantId: t, profile: next });
  return { ok: true, profile: next };
}

export function onboardingMetricsFromProfile(profile) {
  if (!isPlainObject(profile)) return null;
  const onboardingEvents = Array.isArray(profile.onboardingEvents) ? profile.onboardingEvents : [];
  const referralSharedCount = onboardingEvents.filter((row) => row?.eventType === ONBOARDING_EVENT_TYPE.REFERRAL_LINK_SHARED).length;
  const referralSignupCount = onboardingEvents.filter((row) => row?.eventType === ONBOARDING_EVENT_TYPE.REFERRAL_SIGNUP).length;
  const firstVerifiedMs = profile.firstVerifiedAt ? Date.parse(String(profile.firstVerifiedAt)) : NaN;
  const createdMs = profile.createdAt ? Date.parse(String(profile.createdAt)) : NaN;
  const timeToFirstVerifiedMs = Number.isFinite(firstVerifiedMs) && Number.isFinite(createdMs) ? Math.max(0, firstVerifiedMs - createdMs) : null;
  const firstArtifactGeneratedAt = (() => {
    const sampleMs = profile.firstSampleUploadAt ? Date.parse(String(profile.firstSampleUploadAt)) : NaN;
    const realMs = profile.firstUploadAt ? Date.parse(String(profile.firstUploadAt)) : NaN;
    if (Number.isFinite(sampleMs) && Number.isFinite(realMs)) return new Date(Math.min(sampleMs, realMs)).toISOString();
    if (Number.isFinite(sampleMs)) return String(profile.firstSampleUploadAt);
    if (Number.isFinite(realMs)) return String(profile.firstUploadAt);
    return null;
  })();
  const stages = [
    { stageKey: "tenant_created", label: "Tenant created", at: typeof profile.createdAt === "string" ? profile.createdAt : null },
    { stageKey: "wizard_viewed", label: "Wizard viewed", at: typeof profile.firstWizardViewedAt === "string" ? profile.firstWizardViewedAt : null },
    { stageKey: "template_selected", label: "Template selected", at: typeof profile.firstTemplateSelectedAt === "string" ? profile.firstTemplateSelectedAt : null },
    { stageKey: "template_validated", label: "Template validated", at: typeof profile.firstTemplateRenderedAt === "string" ? profile.firstTemplateRenderedAt : null },
    { stageKey: "artifact_generated", label: "Artifact generated", at: firstArtifactGeneratedAt },
    { stageKey: "real_upload_generated", label: "Real upload generated", at: typeof profile.firstUploadAt === "string" ? profile.firstUploadAt : null },
    { stageKey: "first_verified", label: "First verified", at: typeof profile.firstVerifiedAt === "string" ? profile.firstVerifiedAt : null },
    { stageKey: "buyer_link_shared", label: "Buyer link shared", at: typeof profile.firstBuyerLinkSharedAt === "string" ? profile.firstBuyerLinkSharedAt : null },
    { stageKey: "referral_signup", label: "Referral signup", at: typeof profile.firstReferralSignupAt === "string" ? profile.firstReferralSignupAt : null }
  ].map((row) => ({ ...row, reached: Boolean(row.at) }));
  const reachedCount = stages.filter((row) => row.reached).length;
  const totalCount = stages.length;
  const nextStage = stages.find((row) => !row.reached) ?? null;
  const latestEvent =
    onboardingEvents.length
      ? onboardingEvents[onboardingEvents.length - 1]
      : null;
  return {
    schemaVersion: "MagicLinkTenantOnboardingMetrics.v1",
    tenantId: typeof profile.tenantId === "string" ? profile.tenantId : null,
    status: typeof profile.status === "string" ? profile.status : "pending",
    createdAt: typeof profile.createdAt === "string" ? profile.createdAt : null,
    activatedAt: typeof profile.activatedAt === "string" ? profile.activatedAt : null,
    firstUploadAt: typeof profile.firstUploadAt === "string" ? profile.firstUploadAt : null,
    firstVerifiedAt: typeof profile.firstVerifiedAt === "string" ? profile.firstVerifiedAt : null,
    firstSampleUploadAt: typeof profile.firstSampleUploadAt === "string" ? profile.firstSampleUploadAt : null,
    firstSampleVerifiedAt: typeof profile.firstSampleVerifiedAt === "string" ? profile.firstSampleVerifiedAt : null,
    firstBuyerLinkSharedAt: typeof profile.firstBuyerLinkSharedAt === "string" ? profile.firstBuyerLinkSharedAt : null,
    firstBuyerLinkOpenedAt: typeof profile.firstBuyerLinkOpenedAt === "string" ? profile.firstBuyerLinkOpenedAt : null,
    firstReferralLinkSharedAt: typeof profile.firstReferralLinkSharedAt === "string" ? profile.firstReferralLinkSharedAt : null,
    firstReferralSignupAt: typeof profile.firstReferralSignupAt === "string" ? profile.firstReferralSignupAt : null,
    timeToFirstVerifiedMs,
    referral: {
      linkSharedCount: referralSharedCount,
      signupCount: referralSignupCount,
      conversionRatePct: pct(referralSignupCount, referralSharedCount)
    },
    funnel: {
      reachedStages: reachedCount,
      totalStages: totalCount,
      completionPct: pct(reachedCount, totalCount),
      nextStageKey: nextStage ? nextStage.stageKey : null,
      droppedOffStageKey: nextStage ? nextStage.stageKey : null,
      stages
    },
    events: {
      count: onboardingEvents.length,
      latestEvent:
        latestEvent && isPlainObject(latestEvent)
          ? {
              eventType: typeof latestEvent.eventType === "string" ? latestEvent.eventType : null,
              at: typeof latestEvent.at === "string" ? latestEvent.at : null,
              source: typeof latestEvent.source === "string" ? latestEvent.source : null
            }
          : null
    }
  };
}

export async function listTenantProfilesBestEffort({ dataDir, limit = 5000 } = {}) {
  const out = [];
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(10_000, limit) : 5000;
  const root = path.join(dataDir, "tenants");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (out.length >= safeLimit) break;
      const tenantId = String(entry.name ?? "").trim();
      if (!tenantId) continue;
      // eslint-disable-next-line no-await-in-loop
      const profile = await loadTenantProfileBestEffort({ dataDir, tenantId });
      if (profile) out.push(profile);
    }
  } catch {
    return [];
  }
  out.sort((a, b) => String(a?.tenantId ?? "").localeCompare(String(b?.tenantId ?? "")));
  return out;
}

export function onboardingCohortMetricsFromProfiles(profiles, { limit = 24 } = {}) {
  const rows = Array.isArray(profiles) ? profiles : [];
  const byMonth = new Map();
  for (const profile of rows) {
    if (!isPlainObject(profile)) continue;
    const cohortMonth = monthKeyFromIso(profile.createdAt);
    if (!cohortMonth) continue;
    if (!byMonth.has(cohortMonth)) {
      byMonth.set(cohortMonth, {
        cohortMonth,
        tenants: 0,
        wizardViewed: 0,
        templateValidated: 0,
        artifactGenerated: 0,
        realUpload: 0,
        verified: 0,
        buyerLinkShared: 0,
        referralLinkShared: 0,
        referralSignup: 0,
        timeToFirstVerifiedMs: []
      });
    }
    const row = byMonth.get(cohortMonth);
    row.tenants += 1;
    if (profile.firstWizardViewedAt) row.wizardViewed += 1;
    if (profile.firstTemplateRenderedAt) row.templateValidated += 1;
    if (profile.firstSampleUploadAt || profile.firstUploadAt) row.artifactGenerated += 1;
    if (profile.firstUploadAt) row.realUpload += 1;
    if (profile.firstVerifiedAt) row.verified += 1;
    if (profile.firstBuyerLinkSharedAt) row.buyerLinkShared += 1;
    if (profile.firstReferralLinkSharedAt) row.referralLinkShared += 1;
    if (profile.firstReferralSignupAt) row.referralSignup += 1;
    const metrics = onboardingMetricsFromProfile(profile);
    if (Number.isFinite(Number(metrics?.timeToFirstVerifiedMs))) {
      row.timeToFirstVerifiedMs.push(Number(metrics.timeToFirstVerifiedMs));
    }
  }
  const cohortRows = [...byMonth.values()]
    .map((row) => ({
      cohortMonth: row.cohortMonth,
      tenants: row.tenants,
      wizardViewed: row.wizardViewed,
      templateValidated: row.templateValidated,
      artifactGenerated: row.artifactGenerated,
      realUpload: row.realUpload,
      verified: row.verified,
      buyerLinkShared: row.buyerLinkShared,
      referralLinkShared: row.referralLinkShared,
      referralSignup: row.referralSignup,
      wizardViewedRatePct: pct(row.wizardViewed, row.tenants),
      templateValidatedRatePct: pct(row.templateValidated, row.tenants),
      artifactGeneratedRatePct: pct(row.artifactGenerated, row.tenants),
      realUploadRatePct: pct(row.realUpload, row.tenants),
      verifiedRatePct: pct(row.verified, row.tenants),
      buyerLinkSharedRatePct: pct(row.buyerLinkShared, row.tenants),
      referralLinkSharedRatePct: pct(row.referralLinkShared, row.tenants),
      referralSignupRatePct: pct(row.referralSignup, row.tenants),
      medianTimeToFirstVerifiedMs: medianMs(row.timeToFirstVerifiedMs)
    }))
    .sort((a, b) => String(b.cohortMonth).localeCompare(String(a.cohortMonth)));
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(120, limit) : 24;
  return cohortRows.slice(0, safeLimit);
}
