import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sendSmtpMail } from "./smtp.js";

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

function normalizeEmailLower(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > 320 || /\s/.test(raw)) return null;
  const parts = raw.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return raw;
}

function onboardingEmailSequencePath({ dataDir, tenantId }) {
  return path.join(dataDir, "tenants", tenantId, "onboarding_email_sequence.json");
}

function onboardingEmailOutboxPath({ dataDir, tenantId, stepKey, recipient, sentAt }) {
  const hash = crypto.createHash("sha256").update(`${tenantId}\n${stepKey}\n${recipient}\n${sentAt}`, "utf8").digest("hex").slice(0, 16);
  return path.join(dataDir, "onboarding-email-outbox", tenantId, stepKey, `${sentAt.replaceAll(":", "-")}_${hash}.json`);
}

const ONBOARDING_EMAIL_SEQUENCE_VERSION = "MagicLinkOnboardingEmailSequence.v1";

const ONBOARDING_EMAIL_STEPS = Object.freeze([
  Object.freeze({
    stepKey: "welcome",
    label: "Welcome + launch checklist",
    trigger: (profile) => (typeof profile?.createdAt === "string" && profile.createdAt ? profile.createdAt : null),
    subject: (ctx) => `Welcome to Settld, ${ctx.tenantName}`,
    text: (ctx) =>
      [
        `Welcome to Settld, ${ctx.tenantName}.`,
        "",
        "Your onboarding workspace is ready.",
        `Open: ${ctx.onboardingUrl}`,
        "",
        "Goal for today: complete your first verified live settlement in under 10 minutes.",
        "1) Upload a sample bundle",
        "2) Validate policy",
        "3) Run first live settlement",
        "",
        "If you need examples, use the Python quickstart in docs/QUICKSTART_SDK_PYTHON.md.",
        "",
        "— Settld"
      ].join("\n")
  }),
  Object.freeze({
    stepKey: "sample_verified_nudge",
    label: "Sample verified -> go live nudge",
    trigger: (profile) =>
      profile?.firstSampleVerifiedAt && !profile?.firstUploadAt
        ? String(profile.firstSampleVerifiedAt)
        : null,
    subject: () => "Sample verified. Push your first live settlement now.",
    text: (ctx) =>
      [
        "Your sample verification passed.",
        "",
        "Next step: run your first live settlement now.",
        `Open onboarding: ${ctx.onboardingUrl}`,
        `Pricing reference: ${ctx.pricingUrl}`,
        "",
        "Keep momentum: teams that run live within the same session activate fastest.",
        "",
        "— Settld"
      ].join("\n")
  }),
  Object.freeze({
    stepKey: "first_settlement_completed",
    label: "First settlement completed + referral invite",
    trigger: (profile) => (typeof profile?.firstVerifiedAt === "string" && profile.firstVerifiedAt ? profile.firstVerifiedAt : null),
    subject: () => "First settlement complete. Invite another team.",
    text: (ctx) =>
      [
        "Your first verified settlement is complete.",
        "",
        "Next steps:",
        "1) Add your second endpoint/workflow",
        "2) Enable policy presets for default guardrails",
        "3) Invite one peer team and track referral conversion",
        "",
        `Track referral events via onboarding API: POST /v1/tenants/${ctx.tenantId}/onboarding/events`,
        "eventType values: referral_link_shared, referral_signup",
        "",
        "— Settld"
      ].join("\n")
  })
]);

function defaultSequenceState({ tenantId }) {
  return {
    schemaVersion: ONBOARDING_EMAIL_SEQUENCE_VERSION,
    tenantId,
    steps: {},
    updatedAt: nowIso()
  };
}

export async function loadOnboardingEmailSequenceStateBestEffort({ dataDir, tenantId }) {
  const fp = onboardingEmailSequencePath({ dataDir, tenantId });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!isPlainObject(raw)) return defaultSequenceState({ tenantId });
    const stepsIn = isPlainObject(raw.steps) ? raw.steps : {};
    const steps = {};
    for (const row of ONBOARDING_EMAIL_STEPS) {
      const step = isPlainObject(stepsIn[row.stepKey]) ? stepsIn[row.stepKey] : null;
      if (!step || typeof step.sentAt !== "string" || step.sentAt.trim() === "") continue;
      steps[row.stepKey] = {
        sentAt: step.sentAt,
        triggerAt: typeof step.triggerAt === "string" ? step.triggerAt : null,
        deliveryMode: typeof step.deliveryMode === "string" ? step.deliveryMode : null,
        recipients: Array.isArray(step.recipients) ? step.recipients.map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean) : []
      };
    }
    return {
      schemaVersion: ONBOARDING_EMAIL_SEQUENCE_VERSION,
      tenantId,
      steps,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
    };
  } catch {
    return defaultSequenceState({ tenantId });
  }
}

async function saveOnboardingEmailSequenceState({ dataDir, tenantId, state }) {
  const fp = onboardingEmailSequencePath({ dataDir, tenantId });
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const next = {
    ...defaultSequenceState({ tenantId }),
    ...(isPlainObject(state) ? state : {}),
    tenantId,
    updatedAt: nowIso()
  };
  await fs.writeFile(fp, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function normalizeDeliveryMode(rawMode, { smtpConfigured }) {
  const raw = String(rawMode ?? "").trim().toLowerCase();
  if (!raw) return smtpConfigured ? "smtp" : "record";
  if (raw === "record" || raw === "log" || raw === "smtp") return raw;
  throw new Error("MAGIC_LINK_ONBOARDING_EMAIL_DELIVERY_MODE must be record|log|smtp");
}

function recipientsFromProfile(profile) {
  const out = [];
  const seen = new Set();
  const add = (emailRaw) => {
    const email = normalizeEmailLower(emailRaw);
    if (!email) return;
    if (seen.has(email)) return;
    seen.add(email);
    out.push(email);
  };
  add(profile?.contactEmail ?? null);
  add(profile?.billingEmail ?? null);
  return out;
}

function evaluateSteps({ profile }) {
  const list = [];
  for (const step of ONBOARDING_EMAIL_STEPS) {
    const triggerAt = step.trigger(profile);
    list.push({
      stepKey: step.stepKey,
      label: step.label,
      triggerAt: triggerAt && String(triggerAt).trim() !== "" ? String(triggerAt).trim() : null
    });
  }
  return list;
}

export function buildOnboardingEmailSequenceStatus({ tenantId, profile, state, enabled, deliveryMode }) {
  const evaluated = evaluateSteps({ profile });
  const stepsState = isPlainObject(state?.steps) ? state.steps : {};
  const steps = evaluated.map((row) => {
    const sent = isPlainObject(stepsState[row.stepKey]) ? stepsState[row.stepKey] : null;
    return {
      stepKey: row.stepKey,
      label: row.label,
      eligible: Boolean(row.triggerAt),
      triggerAt: row.triggerAt,
      sentAt: sent && typeof sent.sentAt === "string" ? sent.sentAt : null
    };
  });
  const totalSteps = steps.length;
  const sentSteps = steps.filter((row) => typeof row.sentAt === "string" && row.sentAt).length;
  const nextStep = steps.find((row) => row.eligible && !row.sentAt) ?? null;
  return {
    schemaVersion: "MagicLinkOnboardingEmailSequenceStatus.v1",
    tenantId,
    enabled: Boolean(enabled),
    deliveryMode: deliveryMode ?? null,
    totalSteps,
    sentSteps,
    completionPct: totalSteps > 0 ? Math.round((sentSteps / totalSteps) * 10000) / 100 : 0,
    nextStepKey: nextStep ? nextStep.stepKey : null,
    steps
  };
}

export async function dispatchOnboardingEmailSequenceBestEffort({
  dataDir,
  tenantId,
  profile,
  enabled = true,
  deliveryMode = null,
  smtpConfig = null,
  publicBaseUrl = null
} = {}) {
  if (!enabled) return { ok: true, skipped: true, reason: "disabled" };
  if (!isPlainObject(profile)) return { ok: true, skipped: true, reason: "missing_profile" };
  const t = String(tenantId ?? profile.tenantId ?? "").trim();
  if (!t) return { ok: true, skipped: true, reason: "missing_tenant" };

  const resolvedMode = normalizeDeliveryMode(deliveryMode, { smtpConfigured: Boolean(smtpConfig?.host && smtpConfig?.from) });
  const recipients = recipientsFromProfile(profile);
  if (recipients.length === 0) return { ok: true, skipped: true, reason: "no_recipients" };

  const onboardingUrl = publicBaseUrl
    ? `${String(publicBaseUrl).replace(/\/+$/, "")}/v1/tenants/${encodeURIComponent(t)}/onboarding`
    : `/v1/tenants/${encodeURIComponent(t)}/onboarding`;
  const pricingUrl = publicBaseUrl ? `${String(publicBaseUrl).replace(/\/+$/, "")}/pricing` : "/pricing";
  const tenantName = typeof profile?.name === "string" && profile.name.trim() ? profile.name.trim() : t;

  const state = await loadOnboardingEmailSequenceStateBestEffort({ dataDir, tenantId: t });
  const nextState = {
    schemaVersion: ONBOARDING_EMAIL_SEQUENCE_VERSION,
    tenantId: t,
    steps: isPlainObject(state.steps) ? { ...state.steps } : {},
    updatedAt: nowIso()
  };
  const dispatched = [];

  for (const step of ONBOARDING_EMAIL_STEPS) {
    const triggerAt = step.trigger(profile);
    if (!triggerAt) continue;
    const existing = isPlainObject(nextState.steps[step.stepKey]) ? nextState.steps[step.stepKey] : null;
    if (existing && typeof existing.sentAt === "string" && existing.sentAt.trim() !== "") continue;

    const sentAt = nowIso();
    const subject = step.subject({ tenantId: t, tenantName, onboardingUrl, pricingUrl });
    const text = step.text({ tenantId: t, tenantName, onboardingUrl, pricingUrl });
    const deliveries = [];

    for (const recipient of recipients) {
      if (resolvedMode === "record") {
        const fp = onboardingEmailOutboxPath({ dataDir, tenantId: t, stepKey: step.stepKey, recipient, sentAt });
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(
          fp,
          JSON.stringify(
            {
              schemaVersion: "MagicLinkOnboardingEmailOutbox.v1",
              tenantId: t,
              stepKey: step.stepKey,
              label: step.label,
              triggerAt,
              sentAt,
              recipient,
              subject,
              text
            },
            null,
            2
          ) + "\n",
          "utf8"
        );
        deliveries.push({ ok: true, recipient, mode: "record", outboxPath: fp });
        continue;
      }
      if (resolvedMode === "log") {
        // eslint-disable-next-line no-console
        console.log(`onboarding-sequence tenant=${t} step=${step.stepKey} recipient=${recipient} subject=${subject}`);
        deliveries.push({ ok: true, recipient, mode: "log" });
        continue;
      }
      try {
        await sendSmtpMail({
          host: smtpConfig?.host,
          port: smtpConfig?.port,
          secure: Boolean(smtpConfig?.secure),
          starttls: smtpConfig?.starttls === undefined ? true : Boolean(smtpConfig?.starttls),
          auth: smtpConfig?.user && smtpConfig?.pass ? { user: smtpConfig.user, pass: smtpConfig.pass } : null,
          from: smtpConfig?.from,
          to: recipient,
          subject,
          text
        });
        deliveries.push({ ok: true, recipient, mode: "smtp" });
      } catch (err) {
        deliveries.push({ ok: false, recipient, mode: "smtp", error: err?.message ?? String(err ?? "smtp failed") });
      }
    }

    if (!deliveries.some((row) => row.ok === true)) continue;
    nextState.steps[step.stepKey] = {
      sentAt,
      triggerAt,
      deliveryMode: resolvedMode,
      recipients: deliveries.filter((row) => row.ok).map((row) => row.recipient)
    };
    dispatched.push({
      stepKey: step.stepKey,
      triggerAt,
      sentAt,
      deliveries
    });
  }

  const saved = await saveOnboardingEmailSequenceState({ dataDir, tenantId: t, state: nextState });
  return {
    ok: true,
    tenantId: t,
    deliveryMode: resolvedMode,
    dispatched,
    state: saved
  };
}
