#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { unzipToTempSafe } from "../../../packages/artifact-verify/src/safe-unzip.js";
import { computeSettlementDecisionReportHashV1 } from "../../../packages/artifact-verify/src/settlement-decision-report.js";
import { readToolCommitBestEffort, readToolVersionBestEffort } from "../../../packages/artifact-verify/src/tool-provenance.js";
import { buildInvoiceSummaryPdf, buildInvoiceSummaryPdfFromClaim } from "./pdf.js";
import { buildDeterministicZipStore } from "../../../src/core/deterministic-zip.js";
import { createMetrics } from "../../../src/core/metrics.js";
import { signHashHexEd25519 } from "../../../src/core/crypto.js";
import { SLA_POLICY_TEMPLATE_CATALOG_VERSION, listSlaPolicyTemplates, renderSlaPolicyTemplate } from "../../../src/core/sla-policy-templates.js";
import {
  computeSettlementPolicyHash,
  computeVerificationMethodHash,
  evaluateSettlementPolicy,
  normalizeSettlementPolicy,
  normalizeVerificationMethod
} from "../../../src/core/settlement-policy.js";
import { createRemoteSignerClient } from "../../../packages/artifact-produce/src/signer/remote-client.js";
import { readToolCommitBestEffort as readServiceCommitBestEffort, readToolVersionBestEffort as readServiceVersionBestEffort } from "../../../src/core/tool-provenance.js";
import {
  applyTenantSettingsPatch,
  decryptStoredSecret,
  getSettingsKeyFromEnv,
  governanceTrustInfo,
  loadTenantSettings,
  normalizeTenantPlan,
  TENANT_PLAN_CATALOG,
  pricingSignerTrustInfo,
  resolveTenantEntitlements,
  sanitizeTenantSettingsForApi,
  saveTenantSettings
} from "./tenant-settings.js";
import { appendUsageRecord, loadUsageRecords, loadUsageSummary, monthKeyUtcNow } from "./usage.js";
import { buildWebhookPayload, deliverTenantWebhooks } from "./webhooks.js";
import { appendSettlementDecisionReport, listSettlementDecisionReportFiles, loadLatestSettlementDecisionReport } from "./settlement-decisions.js";
import { appendAuditRecord } from "./audit-log.js";
import { authenticateIngestKey, createIngestKey, revokeIngestKey } from "./ingest-keys.js";
import { issueDecisionOtp, verifyAndConsumeDecisionOtp } from "./decision-otp.js";
import { createBuyerSessionToken, issueBuyerOtp, verifyAndConsumeBuyerOtp, verifyBuyerSessionToken } from "./buyer-auth.js";
import { listBuyerUsers, upsertBuyerUser } from "./buyer-users.js";
import { checkAndMigrateDataDir, MAGIC_LINK_DATA_FORMAT_VERSION_CURRENT } from "./storage-format.js";
import { effectiveRetentionDaysForRun, normalizePolicyProfileForEnforcement, policyHashHex, resolvePolicyForRun } from "./policy.js";
import { garbageCollectTenantByRetention } from "./retention-gc.js";
import { safeTruncate } from "./redaction.js";
import { MAGIC_LINK_RENDER_MODEL_ALLOWLIST_V1, buildPublicInvoiceClaimFromClaimJson, sampleRenderModelInvoiceClaimV1 } from "./render-model.js";
import { listTenantRunRecordRowsBestEffort, readRunRecordBestEffort, runStoreModeInfo, updateRunRecordDecisionBestEffort, writeRunRecordV1 } from "./run-records.js";
import { buildS3ObjectUrl, s3PutObject } from "./s3.js";
import { loadLatestBuyerNotificationStatusBestEffort, sendBuyerVerificationNotifications } from "./buyer-notifications.js";
import {
  createTenantProfile,
  generateTenantIdFromName,
  loadTenantProfileBestEffort,
  markTenantOnboardingProgress,
  onboardingMetricsFromProfile,
  recordTenantOnboardingEvent,
  listTenantProfilesBestEffort,
  onboardingCohortMetricsFromProfiles
} from "./tenant-onboarding.js";
import {
  buildOnboardingEmailSequenceStatus,
  dispatchOnboardingEmailSequenceBestEffort,
  loadOnboardingEmailSequenceStateBestEffort
} from "./onboarding-email-sequence.js";
import { createVerifyQueue } from "./verify-queue.js";
import {
  getTenantIdByStripeCustomerId,
  isStripeEventProcessed,
  loadTenantBillingStateBestEffort,
  markStripeEventProcessed,
  patchTenantBillingState,
  setStripeCustomerTenantMap
} from "./tenant-billing.js";
import {
  listPaymentTriggerRetryJobs,
  processPaymentTriggerRetryQueueOnce,
  replayPaymentTriggerDeadLetterJob,
  sendPaymentTriggerOnApproval,
  startPaymentTriggerRetryWorker
} from "./payment-triggers.js";
import {
  enqueueWebhookRetryJobs,
  listWebhookRetryJobs,
  processWebhookRetryQueueOnce,
  replayWebhookDeadLetterJob,
  startWebhookRetryWorker,
  webhookRetryQueueDepth
} from "./webhook-retries.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function nowIso() {
  return new Date().toISOString();
}

async function readBody(req, { maxBytes }) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function streamBodyToFileAndHash(req, { outPath, maxBytes }) {
  if (!outPath || typeof outPath !== "string") throw new TypeError("outPath is required");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");

  await ensureDir(outPath);
  const hash = crypto.createHash("sha256");
  let bytes = 0;

  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const err = Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" });
        cb(err);
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    }
  });

  try {
    await pipeline(req, limiter, fsSync.createWriteStream(outPath, { flags: "wx" }));
  } catch (err) {
    try {
      await fs.rm(outPath, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }

  return { ok: true, bytes, sha256: hash.digest("hex") };
}

async function moveFileReplace(fromPath, toPath) {
  await ensureDir(toPath);
  try {
    await fs.rename(fromPath, toPath);
    return { ok: true };
  } catch (err) {
    // Cross-device or Windows semantics: fall back to copy+unlink.
    if (err?.code !== "EXDEV" && err?.code !== "EPERM") throw err;
    await fs.copyFile(fromPath, toPath);
    await fs.rm(fromPath, { force: true });
    return { ok: true, copied: true };
  }
}

async function readJsonBody(req, { maxBytes = 200_000 } = {}) {
  const buf = await readBody(req, { maxBytes });
  const raw = buf.toString("utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error("invalid JSON"), { code: "INVALID_JSON", cause: err });
  }
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body ?? {});
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(data);
}

function sendText(res, statusCode, text, headers = null) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(String(text ?? ""));
}

function htmlEscape(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function normalizeFinding(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { code: "UNKNOWN", path: null, message: null, detail: item ?? null };
  }
  const code =
    typeof item.code === "string" && item.code.trim()
      ? item.code
      : typeof item.warning === "string" && item.warning.trim()
        ? item.warning
        : "UNKNOWN";
  const out = { code, path: null, message: null, detail: null };
  if (typeof item.path === "string" && item.path.trim()) out.path = item.path.replaceAll("\\", "/");
  if (typeof item.name === "string" && item.name.trim() && !out.path) out.path = item.name.replaceAll("\\", "/");
  if (typeof item.message === "string" && item.message.trim()) out.message = item.message;
  if (item.detail !== undefined) out.detail = item.detail;
  else if (item.warning !== undefined || item.code !== undefined) {
    const { warning: _w, code: _c, path: _p, name: _n, message: _m, ...rest } = item;
    if (Object.keys(rest).length) out.detail = rest;
  } else {
    out.detail = item;
  }
  return out;
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

function cmpString(a, b) {
  const aa = String(a ?? "");
  const bb = String(b ?? "");
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function normalizeFindings(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = arr.map(normalizeFinding);
  out.sort((a, b) => cmpString(a.path ?? "", b.path ?? "") || cmpString(a.code ?? "", b.code ?? ""));
  return out;
}

function formatMoneyFromCentsString({ currency, cents }) {
  const cur = String(currency ?? "").trim() || "UNK";
  const raw = String(cents ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return `${cur} ${raw}`;
  if (cur === "USD") {
    const padded = raw.padStart(3, "0");
    const dollars = padded.slice(0, -2);
    const centsPart = padded.slice(-2);
    return `$${dollars}.${centsPart}`;
  }
  return `${cur} ${raw} cents`;
}

function formatUsdFromCents(cents) {
  const n = Number.isFinite(Number(cents)) ? Number(cents) : 0;
  const rounded = Math.round(n * 1000) / 1000;
  const sign = n < 0 ? "-" : "";
  const dollars = Math.abs(rounded) / 100;
  let out = dollars.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (!out.includes(".")) out += ".00";
  else if (out.split(".")[1].length === 1) out += "0";
  return `${sign}$${out}`;
}

function statusFromCliOutput(cliOut) {
  const ok = Boolean(cliOut?.ok);
  const warnings = Array.isArray(cliOut?.warnings) ? cliOut.warnings : [];
  if (!ok) return "red";
  if (warnings.length) return "amber";
  return "green";
}

function resolveAutoDecisionPolicy({ tenantSettings, status, templateId }) {
  const cfg = tenantSettings && typeof tenantSettings.autoDecision === "object" && !Array.isArray(tenantSettings.autoDecision) ? tenantSettings.autoDecision : null;
  if (!cfg || !cfg.enabled) return { ok: true, apply: false, reason: "AUTO_DECISION_DISABLED" };

  const filters = Array.isArray(cfg.templateIds) ? cfg.templateIds.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  if (filters.length) {
    const tid = typeof templateId === "string" ? templateId.trim() : "";
    if (!tid || !filters.includes(tid)) return { ok: true, apply: false, reason: "AUTO_DECISION_TEMPLATE_FILTER_MISS" };
  }

  let decision = null;
  if (status === "green" && cfg.approveOnGreen) decision = "approve";
  if (status === "amber" && cfg.approveOnAmber) decision = "approve";
  if (status === "red" && cfg.holdOnRed) decision = "hold";
  if (!decision) return { ok: true, apply: false, reason: "AUTO_DECISION_ACTION_NOT_CONFIGURED" };

  const actorName =
    typeof cfg.actorName === "string" && cfg.actorName.trim() ? safeTruncate(cfg.actorName.trim(), { max: 200 }) : "Settld AutoDecision";
  const actorEmail = normalizeEmailLower(cfg.actorEmail) ?? "automation@settld.local";
  return { ok: true, apply: true, decision, actorName, actorEmail };
}

function summarizeAutoDecisionResult(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ok: Boolean(row.ok),
    skipped: Boolean(row.skipped),
    applied: Boolean(row.applied),
    decision: typeof row.decision === "string" ? row.decision : null,
    status: typeof row.status === "string" ? row.status : null,
    reason: typeof row.reason === "string" ? row.reason : null
  };
}

async function runAutoDecisionBestEffort({ token, tenantId, tenantSettings, cliOut, templateId }) {
  const status = statusFromCliOutput(cliOut);
  const policy = resolveAutoDecisionPolicy({ tenantSettings, status, templateId });
  if (!policy.ok) return { ok: false, skipped: true, applied: false, status, reason: policy.error ?? "AUTO_DECISION_POLICY_INVALID" };
  if (!policy.apply) return { ok: true, skipped: true, applied: false, status, reason: policy.reason ?? "AUTO_DECISION_SKIPPED" };

  const bodyJson = {
    decision: policy.decision,
    actorName: policy.actorName,
    actorEmail: policy.actorEmail,
    note: `Auto decision via tenant policy for verification status=${status}`
  };
  const body = Buffer.from(JSON.stringify(bodyJson), "utf8");

  const req = Readable.from([body]);
  req.method = "POST";
  req.url = `/r/${encodeURIComponent(token)}/decision`;
  req.headers = {
    "content-type": "application/json",
    "content-length": String(body.length),
    "user-agent": "settld-magic-link/internal-auto-decision"
  };
  req.socket = { remoteAddress: "127.0.0.1" };

  const res = makeInternalRes();
  await handleDecision(req, res, token, { internalAutoDecision: true });

  const raw = res._body().toString("utf8");
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (res.statusCode === 200 && parsed && typeof parsed === "object" && parsed.ok) {
    return { ok: true, skipped: false, applied: true, decision: policy.decision, status, reason: null };
  }
  if (res.statusCode === 409 && parsed && typeof parsed === "object" && parsed.code === "DECISION_ALREADY_RECORDED") {
    return { ok: true, skipped: true, applied: false, decision: policy.decision, status, reason: "DECISION_ALREADY_RECORDED" };
  }
  return {
    ok: false,
    skipped: false,
    applied: false,
    decision: policy.decision,
    status,
    reason: parsed && typeof parsed.code === "string" ? parsed.code : "AUTO_DECISION_FAILED",
    detail: parsed ?? safeTruncate(raw, { max: 2000 })
  };
}

function hostedTargetKindFromBundleType(bundleType) {
  if (bundleType === "ClosePack.v1") return "close-pack";
  return "invoice-bundle";
}

function invoiceRootDirForBundleType({ bundleDir, bundleType } = {}) {
  if (bundleType === "ClosePack.v1") return path.join(bundleDir, "payload", "invoice_bundle");
  return bundleDir;
}

function classifySubresults(cliOut) {
  const errorCodes = Array.isArray(cliOut?.errors) ? cliOut.errors.map((e) => String(e?.code ?? "")).filter(Boolean) : [];
  const verificationOk = Boolean(cliOut?.verificationOk);

  const workFail = errorCodes.some((c) => c.includes("job proof") || c.includes("metering evidenceRef") || c.includes("meteringReport jobProof") || c.includes("jobProof"));
  const mathFail = errorCodes.some((c) => c.includes("invoiceClaim") || c.startsWith("invoice pricing"));

  const workProofVerified = verificationOk ? true : workFail ? false : mathFail ? true : null;
  const invoiceMathVerified = verificationOk ? true : mathFail ? false : workFail ? null : null;

  return { workProofVerified, invoiceMathVerified };
}

function primaryErrorFromResult(result) {
  if (!result || typeof result !== "object") return [];
  if (result.ok === false && typeof result.error === "string" && result.error.trim()) {
    const code = result.error;
    const detailValue = result.detail !== undefined ? result.detail : result;
    const pathValue = typeof result.name === "string" ? result.name : typeof result.path === "string" ? result.path : null;
    return [{ code, path: pathValue, message: null, detail: detailValue }];
  }
  return [];
}

function formatVerifyCliOutput({ input, resolved, dir, strict, failOnWarnings, result, toolVersion, toolCommit, hosted }) {
  const warnings = normalizeFindings(result?.warnings ?? []);
  const errors = [...primaryErrorFromResult(result)];
  if (failOnWarnings && (result?.ok === true || result?.ok === undefined) && warnings.length) {
    errors.push({ code: "FAIL_ON_WARNINGS", path: null, message: "warnings treated as errors", detail: { warningsCount: warnings.length } });
  }
  errors.sort((a, b) => cmpString(a.path ?? "", b.path ?? "") || cmpString(a.code ?? "", b.code ?? ""));
  const verificationOk = Boolean(result && result.ok === true);
  const ok = errors.length === 0 && verificationOk;
  return {
    schemaVersion: "VerifyCliOutput.v1",
    tool: { name: "settld-verify-hosted", version: toolVersion ?? null, commit: toolCommit ?? null },
    mode: { strict, failOnWarnings },
    // Hosted outputs should not leak server filesystem paths or temp dirs.
    target: { kind: hostedTargetKindFromBundleType(hosted?.bundleType ?? null), input: null, resolved: null, dir: null },
    ok,
    verificationOk,
    errors,
    warnings,
    summary: {
      tenantId: result?.tenantId ?? null,
      period: result?.period ?? null,
      type: result?.type ?? result?.kind ?? null,
      manifestHash: result?.manifestHash ?? null
    },
    hosted: hosted ?? null
  };
}

async function ensureDir(fp) {
  await fs.mkdir(path.dirname(fp), { recursive: true });
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(cur) {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(cur, e.name);
      if (e.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(fp);
      } else if (e.isFile()) {
        out.push(fp);
      }
    }
  }
  await walk(dir);
  out.sort();
  return out;
}

async function addDirToZipFiles({ files, dir, prefix }) {
  const root = path.resolve(String(dir ?? ""));
  const pfx = String(prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  const fps = await listFilesRecursive(root);
  for (const fp of fps) {
    const rel = path.relative(root, fp).split(path.sep).join("/");
    const name = pfx ? `${pfx}/${rel}` : rel;
    // eslint-disable-next-line no-await-in-loop
    const bytes = await fs.readFile(fp);
    files.set(name, bytes);
  }
}

async function loadSampleZipBytes({ kind, sample }) {
  const k = `${kind}:${sample}`;
  const cached = sampleZipCache.get(k);
  if (cached) return cached;

  const dir = path.join(samplesDir, String(kind ?? ""), String(sample ?? ""));
  const files = new Map();
  await addDirToZipFiles({ files, dir, prefix: "" });
  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  const buf = Buffer.from(zip);
  sampleZipCache.set(k, buf);
  return buf;
}

function randomToken() {
  return "ml_" + crypto.randomBytes(24).toString("hex");
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function signHashHexWithSettlementDecisionSigner({ signer, hashHex, context } = {}) {
  if (!signer || typeof signer !== "object" || Array.isArray(signer)) return { ok: false, error: "DECISION_SIGNER_NOT_CONFIGURED" };
  const signerKeyId = typeof signer.signerKeyId === "string" && signer.signerKeyId.trim() ? signer.signerKeyId.trim() : null;
  if (!signerKeyId) return { ok: false, error: "DECISION_SIGNER_NOT_CONFIGURED" };
  const hh = typeof hashHex === "string" && /^[0-9a-f]{64}$/.test(hashHex) ? hashHex : null;
  if (!hh) return { ok: false, error: "INVALID_REPORT_HASH" };

  const privateKeyPemRaw = typeof signer.privateKeyPem === "string" && signer.privateKeyPem.trim() ? signer.privateKeyPem : null;
  const remoteSignerUrl = typeof signer.remoteSignerUrl === "string" && signer.remoteSignerUrl.trim() ? signer.remoteSignerUrl.trim() : null;

  if (privateKeyPemRaw) {
    const privateKeyPem = decryptStoredSecret({ settingsKey, storedSecret: privateKeyPemRaw }) ?? privateKeyPemRaw;
    if (!privateKeyPem || !privateKeyPem.includes("BEGIN PRIVATE KEY")) return { ok: false, error: "DECISION_SIGNER_PRIVATE_KEY_INVALID" };
    try {
      const signatureBase64 = signHashHexEd25519(hh, privateKeyPem);
      return { ok: true, signerKeyId, signatureBase64, signerReceipt: null };
    } catch (err) {
      return { ok: false, error: "DECISION_SIGNER_FAILED", detail: { message: err?.message ?? String(err ?? "") } };
    }
  }

  if (remoteSignerUrl) {
    const bearerTokenRaw = typeof signer.remoteSignerBearerToken === "string" && signer.remoteSignerBearerToken.trim() ? signer.remoteSignerBearerToken : null;
    const bearerToken = bearerTokenRaw ? decryptStoredSecret({ settingsKey, storedSecret: bearerTokenRaw }) ?? bearerTokenRaw : null;
    const headers = bearerToken ? [`authorization: Bearer ${bearerToken}`] : [];
    const client = createRemoteSignerClient({ url: remoteSignerUrl, timeoutMs: 30_000, auth: "none", headers });
    try {
      const messageBytes = Buffer.from(hh, "hex");
      const signed = await client.sign({
        keyId: signerKeyId,
        algorithm: "ed25519",
        messageBytes,
        purpose: "settlement_decision_report",
        context: isPlainObject(context) ? context : null
      });
      return { ok: true, signerKeyId, signatureBase64: signed.signatureBase64, signerReceipt: signed.signerReceipt ?? null };
    } catch (err) {
      return { ok: false, error: "DECISION_SIGNER_FAILED", detail: { code: err?.code ?? null, message: err?.message ?? String(err ?? "") } };
    }
  }

  return { ok: false, error: "DECISION_SIGNER_NOT_CONFIGURED" };
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

function domainFromEmail(email) {
  const at = String(email ?? "").lastIndexOf("@");
  if (at < 0) return null;
  const domain = String(email ?? "").slice(at + 1).trim().toLowerCase();
  return domain || null;
}

function isEmailAllowedByDomains({ email, allowedDomains }) {
  const domain = domainFromEmail(email);
  if (!domain) return false;
  const list = Array.isArray(allowedDomains) ? allowedDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean) : [];
  for (const allowed of list) {
    if (domain === allowed) return true;
    if (domain.endsWith("." + allowed)) return true;
  }
  return false;
}

const WEBHOOK_EVENT_NAMES = ["verification.completed", "verification.failed", "decision.approved", "decision.held"];
const WEBHOOK_EVENT_NAME_SET = new Set(WEBHOOK_EVENT_NAMES);
const INTEGRATION_PROVIDER_NAMES = ["slack", "zapier"];
const INTEGRATION_PROVIDER_NAME_SET = new Set(INTEGRATION_PROVIDER_NAMES);
const WEBHOOK_RETRY_PROVIDER_NAMES = ["slack", "zapier", "defaultRelay", "webhook"];
const WEBHOOK_RETRY_PROVIDER_NAME_SET = new Set(WEBHOOK_RETRY_PROVIDER_NAMES);
const WEBHOOK_RETRY_ALERT_EVENT = "ops.webhook_retry.dead_letter_threshold";
const BILLING_USAGE_ALERT_THRESHOLD_PCTS = [80, 100];

function normalizeWebhookEvents(rawEvents) {
  const rows = Array.isArray(rawEvents) ? rawEvents : [];
  const out = [];
  for (const row of rows) {
    const eventName = String(row ?? "").trim();
    if (!eventName) continue;
    if (!WEBHOOK_EVENT_NAME_SET.has(eventName)) continue;
    out.push(eventName);
  }
  return [...new Set(out)].sort();
}

function parseWebhookEventsCsv(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [...WEBHOOK_EVENT_NAMES];
  const rows = input.split(",").map((x) => String(x ?? "").trim()).filter(Boolean);
  const normalized = normalizeWebhookEvents(rows);
  return normalized.length ? normalized : [...WEBHOOK_EVENT_NAMES];
}

function parseCsvList(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [];
  return [...new Set(input.split(",").map((x) => String(x ?? "").trim()).filter(Boolean))];
}

function parseWebhookRetryProviderFilter(raw, { allowAll = true } = {}) {
  const value = String(raw ?? "").trim();
  if (!value || (allowAll && value === "all")) return { ok: true, provider: null };
  if (!WEBHOOK_RETRY_PROVIDER_NAME_SET.has(value)) {
    return { ok: false, error: `provider must be one of ${allowAll ? "all|" : ""}${WEBHOOK_RETRY_PROVIDER_NAMES.join("|")}` };
  }
  return { ok: true, provider: value };
}

function parseWebhookDeadLetterAlertTargets(rawList) {
  const rows = Array.isArray(rawList) ? rawList : [];
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    const value = String(item ?? "").trim();
    if (!value) continue;
    const url = normalizeHttpUrl(value);
    if (url) {
      const key = `url:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "url", url });
      continue;
    }
    const lower = value.toLowerCase();
    if (lower === "slack" || lower === "zapier" || lower === "defaultrelay" || lower === "default_relay" || lower === "default-relay") {
      const normalized = lower.startsWith("default") ? "defaultRelay" : lower;
      const key = `provider:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: normalized });
      continue;
    }
    if (lower === "internal") {
      const key = "internal";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "internal" });
      continue;
    }
    throw new Error(`MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_TARGETS contains unsupported target "${value}"`);
  }
  return out;
}

function normalizeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function maskWebhookUrl(rawUrl) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    if (!u.pathname || u.pathname === "/") return `${u.origin}/…`;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length <= 1) return `${u.origin}/${parts[0]}/…`;
    const head = parts.slice(0, Math.max(1, parts.length - 1)).join("/");
    return `${u.origin}/${head}/…`;
  } catch {
    return null;
  }
}

function providerFromWebhookUrl(rawUrl) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    const host = String(u.hostname ?? "").toLowerCase();
    if (host === "hooks.slack.com") return "slack";
    if (host === "hooks.zapier.com") return "zapier";
  } catch {
    return null;
  }
  return null;
}

function retryProviderFromWebhookUrl(rawUrl) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return "webhook";
  if (defaultEventRelayUrl && normalized === defaultEventRelayUrl) return "defaultRelay";
  const provider = providerFromWebhookUrl(normalized);
  if (provider === "slack" || provider === "zapier") return provider;
  return "webhook";
}

function randomWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString("hex")}`;
}

function trustRootSetHashHex(keyIds) {
  const list = Array.isArray(keyIds) ? keyIds.map(String).filter(Boolean).sort() : [];
  const data = JSON.stringify(list);
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

async function readJsonIfExists(fp) {
  try {
    const raw = await fs.readFile(fp, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const port = Number(process.env.MAGIC_LINK_PORT ?? "8787");
const host = process.env.MAGIC_LINK_HOST ? String(process.env.MAGIC_LINK_HOST) : "127.0.0.1";
const socketPath = process.env.MAGIC_LINK_SOCKET_PATH ? path.resolve(String(process.env.MAGIC_LINK_SOCKET_PATH)) : null;
const apiKey = process.env.MAGIC_LINK_API_KEY ?? null;
const dataDir = process.env.MAGIC_LINK_DATA_DIR ? path.resolve(process.env.MAGIC_LINK_DATA_DIR) : path.join(os.tmpdir(), "settld-magic-link");
const maxUploadBytes = Number(process.env.MAGIC_LINK_MAX_UPLOAD_BYTES ?? String(50 * 1024 * 1024));
const tokenTtlSeconds = Number(process.env.MAGIC_LINK_TOKEN_TTL_SECONDS ?? String(7 * 24 * 3600));
const verifyTimeoutMs = Number(process.env.MAGIC_LINK_VERIFY_TIMEOUT_MS ?? String(60_000));
const uploadsPerMinuteLegacyRaw = process.env.MAGIC_LINK_RATE_LIMIT_UPLOADS_PER_MINUTE;
const uploadsPerMinuteLegacy = uploadsPerMinuteLegacyRaw === undefined ? null : Number(uploadsPerMinuteLegacyRaw);
const uploadsPerHourDefault = Number(
  process.env.MAGIC_LINK_RATE_LIMIT_UPLOADS_PER_HOUR ??
    (uploadsPerMinuteLegacy !== null && Number.isFinite(uploadsPerMinuteLegacy) ? String(Math.max(0, Math.trunc(uploadsPerMinuteLegacy * 60))) : "100")
);
const maxConcurrentJobs = Number(process.env.MAGIC_LINK_MAX_CONCURRENT_JOBS ?? String(8));
const maxConcurrentJobsPerTenant = Number(process.env.MAGIC_LINK_MAX_CONCURRENT_JOBS_PER_TENANT ?? String(2));
const verifyQueueWorkers = Number.parseInt(String(process.env.MAGIC_LINK_VERIFY_QUEUE_WORKERS ?? String(Math.max(1, maxConcurrentJobsPerTenant || 1))), 10);
const verifyQueueMaxAttempts = Number.parseInt(String(process.env.MAGIC_LINK_VERIFY_QUEUE_MAX_ATTEMPTS ?? "3"), 10);
const verifyQueueRetryBackoffMs = Number.parseInt(String(process.env.MAGIC_LINK_VERIFY_QUEUE_RETRY_BACKOFF_MS ?? "250"), 10);
const webhookDeliveryMode = String(process.env.MAGIC_LINK_WEBHOOK_DELIVERY_MODE ?? "http").trim().toLowerCase();
const webhookTimeoutMs = Number(process.env.MAGIC_LINK_WEBHOOK_TIMEOUT_MS ?? String(5_000));
const webhookMaxAttempts = Number.parseInt(String(process.env.MAGIC_LINK_WEBHOOK_MAX_ATTEMPTS ?? "3"), 10);
const webhookRetryBackoffMs = Number.parseInt(String(process.env.MAGIC_LINK_WEBHOOK_RETRY_BACKOFF_MS ?? "250"), 10);
const webhookRetryIntervalMs = Number.parseInt(String(process.env.MAGIC_LINK_WEBHOOK_RETRY_INTERVAL_MS ?? "2000"), 10);
const webhookDeadLetterAlertThreshold = Number.parseInt(String(process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_THRESHOLD ?? "0"), 10);
const webhookDeadLetterAlertTargetsRaw = parseCsvList(process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_TARGETS ?? "");
const webhookDeadLetterAlertWebhookUrlRaw = process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL
  ? String(process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL).trim()
  : "";
const webhookDeadLetterAlertWebhookUrl = webhookDeadLetterAlertWebhookUrlRaw ? normalizeHttpUrl(webhookDeadLetterAlertWebhookUrlRaw) : null;
const webhookDeadLetterAlertWebhookSecret = process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_SECRET
  ? String(process.env.MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_SECRET).trim()
  : "";
const webhookDeadLetterAlertTargets = parseWebhookDeadLetterAlertTargets(webhookDeadLetterAlertTargetsRaw);
const publicBaseUrl = process.env.MAGIC_LINK_PUBLIC_BASE_URL ? String(process.env.MAGIC_LINK_PUBLIC_BASE_URL).trim() : null;
const defaultEventRelayUrlRaw = process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_URL ? String(process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_URL).trim() : "";
const defaultEventRelayUrl = defaultEventRelayUrlRaw ? normalizeHttpUrl(defaultEventRelayUrlRaw) : null;
const defaultEventRelaySecret = process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_SECRET ? String(process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_SECRET).trim() : "";
const defaultEventRelayEvents = parseWebhookEventsCsv(process.env.MAGIC_LINK_DEFAULT_EVENT_RELAY_EVENTS ?? "");
const integrationOauthStateTtlSeconds = Number.parseInt(String(process.env.MAGIC_LINK_INTEGRATION_OAUTH_STATE_TTL_SECONDS ?? "900"), 10);
const integrationOauthHttpTimeoutMs = Number.parseInt(String(process.env.MAGIC_LINK_INTEGRATION_OAUTH_HTTP_TIMEOUT_MS ?? "10000"), 10);
const slackOauthClientId = process.env.MAGIC_LINK_SLACK_OAUTH_CLIENT_ID ? String(process.env.MAGIC_LINK_SLACK_OAUTH_CLIENT_ID).trim() : "";
const slackOauthClientSecret = process.env.MAGIC_LINK_SLACK_OAUTH_CLIENT_SECRET ? String(process.env.MAGIC_LINK_SLACK_OAUTH_CLIENT_SECRET).trim() : "";
const slackOauthAuthorizeUrl = normalizeHttpUrl(process.env.MAGIC_LINK_SLACK_OAUTH_AUTHORIZE_URL ?? "https://slack.com/oauth/v2/authorize");
const slackOauthTokenUrl = normalizeHttpUrl(process.env.MAGIC_LINK_SLACK_OAUTH_TOKEN_URL ?? "https://slack.com/api/oauth.v2.access");
const slackOauthScopes = parseCsvList(process.env.MAGIC_LINK_SLACK_OAUTH_SCOPES ?? "incoming-webhook");
const slackOauthUserScopes = parseCsvList(process.env.MAGIC_LINK_SLACK_OAUTH_USER_SCOPES ?? "");
const zapierOauthClientId = process.env.MAGIC_LINK_ZAPIER_OAUTH_CLIENT_ID ? String(process.env.MAGIC_LINK_ZAPIER_OAUTH_CLIENT_ID).trim() : "";
const zapierOauthClientSecret = process.env.MAGIC_LINK_ZAPIER_OAUTH_CLIENT_SECRET ? String(process.env.MAGIC_LINK_ZAPIER_OAUTH_CLIENT_SECRET).trim() : "";
const zapierOauthAuthorizeUrl = normalizeHttpUrl(process.env.MAGIC_LINK_ZAPIER_OAUTH_AUTHORIZE_URL ?? "");
const zapierOauthTokenUrl = normalizeHttpUrl(process.env.MAGIC_LINK_ZAPIER_OAUTH_TOKEN_URL ?? "");
const zapierOauthScopes = parseCsvList(process.env.MAGIC_LINK_ZAPIER_OAUTH_SCOPES ?? "");
const zapierOauthWebhookField = String(process.env.MAGIC_LINK_ZAPIER_OAUTH_WEBHOOK_FIELD ?? "webhookUrl").trim() || "webhookUrl";
const zapierOauthClientAuth = String(process.env.MAGIC_LINK_ZAPIER_OAUTH_CLIENT_AUTH ?? "body").trim().toLowerCase();
const billingCurrency = process.env.MAGIC_LINK_BILLING_CURRENCY ? String(process.env.MAGIC_LINK_BILLING_CURRENCY).trim() : "USD";
const billingSubscriptionCents = Number.parseInt(String(process.env.MAGIC_LINK_BILLING_SUBSCRIPTION_CENTS ?? "0"), 10);
const billingPricePerVerificationCents = Number.parseInt(String(process.env.MAGIC_LINK_BILLING_PRICE_PER_VERIFICATION_CENTS ?? "0"), 10);
const billingProvider = String(process.env.MAGIC_LINK_BILLING_PROVIDER ?? "stripe").trim().toLowerCase();
const stripeApiBaseUrl = String(process.env.MAGIC_LINK_BILLING_STRIPE_API_BASE_URL ?? "https://api.stripe.com").trim().replace(/\/+$/, "");
const stripeSecretKey = process.env.MAGIC_LINK_BILLING_STRIPE_SECRET_KEY ? String(process.env.MAGIC_LINK_BILLING_STRIPE_SECRET_KEY).trim() : "";
const stripeWebhookSecret = process.env.MAGIC_LINK_BILLING_STRIPE_WEBHOOK_SECRET ? String(process.env.MAGIC_LINK_BILLING_STRIPE_WEBHOOK_SECRET).trim() : "";
const stripePriceIdBuilder = process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_BUILDER ? String(process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_BUILDER).trim() : "";
const stripePriceIdGrowth = process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_GROWTH ? String(process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_GROWTH).trim() : "";
const stripePriceIdEnterprise = process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_ENTERPRISE
  ? String(process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_ENTERPRISE).trim()
  : process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_SCALE
    ? String(process.env.MAGIC_LINK_BILLING_STRIPE_PRICE_ID_SCALE).trim()
    : "";
const billingCheckoutSuccessUrlDefault = process.env.MAGIC_LINK_BILLING_CHECKOUT_SUCCESS_URL
  ? String(process.env.MAGIC_LINK_BILLING_CHECKOUT_SUCCESS_URL).trim()
  : "https://example.invalid/billing/success";
const billingCheckoutCancelUrlDefault = process.env.MAGIC_LINK_BILLING_CHECKOUT_CANCEL_URL
  ? String(process.env.MAGIC_LINK_BILLING_CHECKOUT_CANCEL_URL).trim()
  : "https://example.invalid/billing/cancel";
const billingPortalReturnUrlDefault = process.env.MAGIC_LINK_BILLING_PORTAL_RETURN_URL
  ? String(process.env.MAGIC_LINK_BILLING_PORTAL_RETURN_URL).trim()
  : "https://example.invalid/billing";
const decisionOtpTtlSeconds = Number.parseInt(String(process.env.MAGIC_LINK_DECISION_OTP_TTL_SECONDS ?? "900"), 10);
const decisionOtpMaxAttempts = Number.parseInt(String(process.env.MAGIC_LINK_DECISION_OTP_MAX_ATTEMPTS ?? "10"), 10);
const decisionOtpDeliveryMode = String(process.env.MAGIC_LINK_DECISION_OTP_DELIVERY_MODE ?? "record").trim().toLowerCase();
const buyerOtpTtlSeconds = Number.parseInt(String(process.env.MAGIC_LINK_BUYER_OTP_TTL_SECONDS ?? "900"), 10);
const buyerOtpMaxAttempts = Number.parseInt(String(process.env.MAGIC_LINK_BUYER_OTP_MAX_ATTEMPTS ?? "10"), 10);
const buyerOtpDeliveryMode = String(process.env.MAGIC_LINK_BUYER_OTP_DELIVERY_MODE ?? "record").trim().toLowerCase();
const buyerSessionTtlSeconds = Number.parseInt(String(process.env.MAGIC_LINK_BUYER_SESSION_TTL_SECONDS ?? String(24 * 3600)), 10);
const publicSignupEnabled = String(process.env.MAGIC_LINK_PUBLIC_SIGNUP_ENABLED ?? "0").trim() === "1";
const onboardingEmailSequenceEnabled = String(process.env.MAGIC_LINK_ONBOARDING_EMAIL_SEQUENCE_ENABLED ?? "1").trim() !== "0";
const onboardingEmailSequenceDeliveryModeRaw = String(process.env.MAGIC_LINK_ONBOARDING_EMAIL_DELIVERY_MODE ?? "").trim().toLowerCase();
const paymentTriggerRetryIntervalMs = Number.parseInt(String(process.env.MAGIC_LINK_PAYMENT_TRIGGER_RETRY_INTERVAL_MS ?? "2000"), 10);
const paymentTriggerMaxAttempts = Number.parseInt(String(process.env.MAGIC_LINK_PAYMENT_TRIGGER_MAX_ATTEMPTS ?? "5"), 10);
const paymentTriggerRetryBackoffMs = Number.parseInt(String(process.env.MAGIC_LINK_PAYMENT_TRIGGER_RETRY_BACKOFF_MS ?? "5000"), 10);
const settingsKey = getSettingsKeyFromEnv();
const migrateOnStartup = String(process.env.MAGIC_LINK_MIGRATE_ON_STARTUP ?? "1").trim() !== "0";
const settldApiBaseUrlRaw = process.env.MAGIC_LINK_SETTLD_API_BASE_URL ? String(process.env.MAGIC_LINK_SETTLD_API_BASE_URL).trim() : "";
const settldApiBaseUrl = settldApiBaseUrlRaw ? normalizeHttpUrl(settldApiBaseUrlRaw) : null;
const settldOpsToken = process.env.MAGIC_LINK_SETTLD_OPS_TOKEN ? String(process.env.MAGIC_LINK_SETTLD_OPS_TOKEN).trim() : "";
const settldProtocol = String(process.env.MAGIC_LINK_SETTLD_PROTOCOL ?? "1.0").trim() || "1.0";

const smtpHost = process.env.MAGIC_LINK_SMTP_HOST ? String(process.env.MAGIC_LINK_SMTP_HOST).trim() : "";
const smtpPort = Number.parseInt(String(process.env.MAGIC_LINK_SMTP_PORT ?? "587"), 10);
const smtpSecure = String(process.env.MAGIC_LINK_SMTP_SECURE ?? "0").trim() === "1";
const smtpStarttls = String(process.env.MAGIC_LINK_SMTP_STARTTLS ?? "1").trim() !== "0";
const smtpUser = process.env.MAGIC_LINK_SMTP_USER ? String(process.env.MAGIC_LINK_SMTP_USER) : "";
const smtpPass = process.env.MAGIC_LINK_SMTP_PASS ? String(process.env.MAGIC_LINK_SMTP_PASS) : "";
const smtpFrom = process.env.MAGIC_LINK_SMTP_FROM ? String(process.env.MAGIC_LINK_SMTP_FROM).trim() : "";
const smtpConfig = smtpHost && smtpFrom ? { host: smtpHost, port: smtpPort, secure: smtpSecure, starttls: smtpStarttls, user: smtpUser, pass: smtpPass, from: smtpFrom } : null;
const onboardingEmailSequenceDeliveryMode =
  onboardingEmailSequenceDeliveryModeRaw || (smtpConfig ? "smtp" : "record");

if (!Number.isInteger(port) || port < 0) throw new Error("MAGIC_LINK_PORT must be an integer >= 0");
if (!host || typeof host !== "string") throw new Error("MAGIC_LINK_HOST must be a string");
if (socketPath !== null) assertNonEmptyString(socketPath, "MAGIC_LINK_SOCKET_PATH");
if (apiKey !== null) assertNonEmptyString(apiKey, "MAGIC_LINK_API_KEY");
if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) throw new Error("MAGIC_LINK_MAX_UPLOAD_BYTES must be positive");
if (!Number.isFinite(tokenTtlSeconds) || tokenTtlSeconds <= 0) throw new Error("MAGIC_LINK_TOKEN_TTL_SECONDS must be positive");
if (!Number.isFinite(verifyTimeoutMs) || verifyTimeoutMs <= 0) throw new Error("MAGIC_LINK_VERIFY_TIMEOUT_MS must be positive");
if (uploadsPerMinuteLegacy !== null && (!Number.isFinite(uploadsPerMinuteLegacy) || uploadsPerMinuteLegacy < 0)) {
  throw new Error("MAGIC_LINK_RATE_LIMIT_UPLOADS_PER_MINUTE must be a number >= 0");
}
if (!Number.isFinite(uploadsPerHourDefault) || uploadsPerHourDefault < 0) throw new Error("MAGIC_LINK_RATE_LIMIT_UPLOADS_PER_HOUR must be a number >= 0");
if (!Number.isFinite(maxConcurrentJobs) || maxConcurrentJobs < 0) throw new Error("MAGIC_LINK_MAX_CONCURRENT_JOBS must be a number >= 0");
if (!Number.isFinite(maxConcurrentJobsPerTenant) || maxConcurrentJobsPerTenant < 0) throw new Error("MAGIC_LINK_MAX_CONCURRENT_JOBS_PER_TENANT must be a number >= 0");
if (!Number.isInteger(verifyQueueWorkers) || verifyQueueWorkers < 1) throw new Error("MAGIC_LINK_VERIFY_QUEUE_WORKERS must be an integer >= 1");
if (!Number.isInteger(verifyQueueMaxAttempts) || verifyQueueMaxAttempts < 1) throw new Error("MAGIC_LINK_VERIFY_QUEUE_MAX_ATTEMPTS must be an integer >= 1");
if (!Number.isInteger(verifyQueueRetryBackoffMs) || verifyQueueRetryBackoffMs < 0) throw new Error("MAGIC_LINK_VERIFY_QUEUE_RETRY_BACKOFF_MS must be an integer >= 0");
if (webhookDeliveryMode !== "http" && webhookDeliveryMode !== "record") throw new Error("MAGIC_LINK_WEBHOOK_DELIVERY_MODE must be http|record");
if (!Number.isFinite(webhookTimeoutMs) || webhookTimeoutMs <= 0) throw new Error("MAGIC_LINK_WEBHOOK_TIMEOUT_MS must be positive");
if (!Number.isInteger(webhookMaxAttempts) || webhookMaxAttempts < 1) throw new Error("MAGIC_LINK_WEBHOOK_MAX_ATTEMPTS must be an integer >= 1");
if (!Number.isInteger(webhookRetryBackoffMs) || webhookRetryBackoffMs < 0) throw new Error("MAGIC_LINK_WEBHOOK_RETRY_BACKOFF_MS must be an integer >= 0");
if (!Number.isInteger(webhookRetryIntervalMs) || webhookRetryIntervalMs < 100) throw new Error("MAGIC_LINK_WEBHOOK_RETRY_INTERVAL_MS must be an integer >= 100");
if (!Number.isInteger(webhookDeadLetterAlertThreshold) || webhookDeadLetterAlertThreshold < 0) {
  throw new Error("MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_THRESHOLD must be an integer >= 0");
}
if (webhookDeadLetterAlertWebhookUrlRaw && !webhookDeadLetterAlertWebhookUrl) {
  throw new Error("MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL must be a valid http(s) URL");
}
if ((webhookDeadLetterAlertWebhookUrl && !webhookDeadLetterAlertWebhookSecret) || (!webhookDeadLetterAlertWebhookUrl && webhookDeadLetterAlertWebhookSecret)) {
  throw new Error("MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL and MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_SECRET must be set together");
}
if (webhookDeadLetterAlertTargets.some((t) => t.kind === "internal") && (!webhookDeadLetterAlertWebhookUrl || !webhookDeadLetterAlertWebhookSecret)) {
  throw new Error(
    "MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_TARGETS includes internal, but MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_URL/SECRET are not configured"
  );
}
if (webhookDeadLetterAlertTargets.some((t) => t.kind === "url") && !webhookDeadLetterAlertWebhookSecret) {
  throw new Error(
    "MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_TARGETS includes webhook URLs, but MAGIC_LINK_WEBHOOK_DEAD_LETTER_ALERT_WEBHOOK_SECRET is not configured"
  );
}
if (defaultEventRelayUrlRaw && !defaultEventRelayUrl) throw new Error("MAGIC_LINK_DEFAULT_EVENT_RELAY_URL must be a valid http(s) URL");
if (!defaultEventRelayUrl && defaultEventRelaySecret) throw new Error("MAGIC_LINK_DEFAULT_EVENT_RELAY_SECRET requires MAGIC_LINK_DEFAULT_EVENT_RELAY_URL");
if (!Number.isInteger(integrationOauthStateTtlSeconds) || integrationOauthStateTtlSeconds < 60 || integrationOauthStateTtlSeconds > 86_400) {
  throw new Error("MAGIC_LINK_INTEGRATION_OAUTH_STATE_TTL_SECONDS must be an integer 60..86400");
}
if (!Number.isInteger(integrationOauthHttpTimeoutMs) || integrationOauthHttpTimeoutMs < 1_000 || integrationOauthHttpTimeoutMs > 120_000) {
  throw new Error("MAGIC_LINK_INTEGRATION_OAUTH_HTTP_TIMEOUT_MS must be an integer 1000..120000");
}
if ((slackOauthClientId && !slackOauthClientSecret) || (!slackOauthClientId && slackOauthClientSecret)) {
  throw new Error("MAGIC_LINK_SLACK_OAUTH_CLIENT_ID and MAGIC_LINK_SLACK_OAUTH_CLIENT_SECRET must be set together");
}
if ((slackOauthClientId || slackOauthClientSecret) && (!slackOauthAuthorizeUrl || !slackOauthTokenUrl)) {
  throw new Error("MAGIC_LINK_SLACK_OAUTH_AUTHORIZE_URL and MAGIC_LINK_SLACK_OAUTH_TOKEN_URL must be valid http(s) URLs");
}
if (zapierOauthClientAuth !== "body" && zapierOauthClientAuth !== "basic") {
  throw new Error("MAGIC_LINK_ZAPIER_OAUTH_CLIENT_AUTH must be body|basic");
}
const hasAnyZapierOauthSetting = Boolean(
  zapierOauthClientId ||
    zapierOauthClientSecret ||
    zapierOauthAuthorizeUrl ||
    zapierOauthTokenUrl ||
    zapierOauthScopes.length
);
if (hasAnyZapierOauthSetting) {
  if (!zapierOauthClientId || !zapierOauthClientSecret || !zapierOauthAuthorizeUrl || !zapierOauthTokenUrl) {
    throw new Error(
      "Zapier OAuth requires MAGIC_LINK_ZAPIER_OAUTH_CLIENT_ID, MAGIC_LINK_ZAPIER_OAUTH_CLIENT_SECRET, MAGIC_LINK_ZAPIER_OAUTH_AUTHORIZE_URL, and MAGIC_LINK_ZAPIER_OAUTH_TOKEN_URL"
    );
  }
}
if (!billingCurrency || typeof billingCurrency !== "string") throw new Error("MAGIC_LINK_BILLING_CURRENCY must be a string");
if (!Number.isInteger(billingSubscriptionCents) || billingSubscriptionCents < 0) throw new Error("MAGIC_LINK_BILLING_SUBSCRIPTION_CENTS must be an integer >= 0");
if (!Number.isInteger(billingPricePerVerificationCents) || billingPricePerVerificationCents < 0) throw new Error("MAGIC_LINK_BILLING_PRICE_PER_VERIFICATION_CENTS must be an integer >= 0");
if (billingProvider !== "stripe" && billingProvider !== "none") throw new Error("MAGIC_LINK_BILLING_PROVIDER must be stripe|none");
if (billingProvider === "stripe" && stripeSecretKey && !stripePriceIdBuilder && !stripePriceIdGrowth && !stripePriceIdEnterprise) {
  throw new Error(
    "Stripe billing enabled but no price IDs configured (set one of MAGIC_LINK_BILLING_STRIPE_PRICE_ID_BUILDER, MAGIC_LINK_BILLING_STRIPE_PRICE_ID_GROWTH, MAGIC_LINK_BILLING_STRIPE_PRICE_ID_ENTERPRISE)"
  );
}
if (billingProvider === "stripe" && stripeWebhookSecret && !stripeWebhookSecret.startsWith("whsec_")) {
  throw new Error("MAGIC_LINK_BILLING_STRIPE_WEBHOOK_SECRET should be a Stripe webhook secret (whsec_...)");
}
if (!Number.isInteger(decisionOtpTtlSeconds) || decisionOtpTtlSeconds <= 0) throw new Error("MAGIC_LINK_DECISION_OTP_TTL_SECONDS must be a positive integer");
if (!Number.isInteger(decisionOtpMaxAttempts) || decisionOtpMaxAttempts < 1) throw new Error("MAGIC_LINK_DECISION_OTP_MAX_ATTEMPTS must be an integer >= 1");
if (decisionOtpDeliveryMode !== "record" && decisionOtpDeliveryMode !== "log" && decisionOtpDeliveryMode !== "smtp") throw new Error("MAGIC_LINK_DECISION_OTP_DELIVERY_MODE must be record|log|smtp");
if (!Number.isInteger(buyerOtpTtlSeconds) || buyerOtpTtlSeconds <= 0) throw new Error("MAGIC_LINK_BUYER_OTP_TTL_SECONDS must be a positive integer");
if (!Number.isInteger(buyerOtpMaxAttempts) || buyerOtpMaxAttempts < 1) throw new Error("MAGIC_LINK_BUYER_OTP_MAX_ATTEMPTS must be an integer >= 1");
if (buyerOtpDeliveryMode !== "record" && buyerOtpDeliveryMode !== "log" && buyerOtpDeliveryMode !== "smtp") throw new Error("MAGIC_LINK_BUYER_OTP_DELIVERY_MODE must be record|log|smtp");
if (!Number.isInteger(buyerSessionTtlSeconds) || buyerSessionTtlSeconds <= 0) throw new Error("MAGIC_LINK_BUYER_SESSION_TTL_SECONDS must be a positive integer");
if (
  onboardingEmailSequenceDeliveryMode !== "record" &&
  onboardingEmailSequenceDeliveryMode !== "log" &&
  onboardingEmailSequenceDeliveryMode !== "smtp"
) {
  throw new Error("MAGIC_LINK_ONBOARDING_EMAIL_DELIVERY_MODE must be record|log|smtp");
}
if (!Number.isInteger(paymentTriggerRetryIntervalMs) || paymentTriggerRetryIntervalMs < 100) throw new Error("MAGIC_LINK_PAYMENT_TRIGGER_RETRY_INTERVAL_MS must be an integer >= 100");
if (!Number.isInteger(paymentTriggerMaxAttempts) || paymentTriggerMaxAttempts < 1) throw new Error("MAGIC_LINK_PAYMENT_TRIGGER_MAX_ATTEMPTS must be an integer >= 1");
if (!Number.isInteger(paymentTriggerRetryBackoffMs) || paymentTriggerRetryBackoffMs < 0) throw new Error("MAGIC_LINK_PAYMENT_TRIGGER_RETRY_BACKOFF_MS must be an integer >= 0");
if (typeof migrateOnStartup !== "boolean") throw new Error("MAGIC_LINK_MIGRATE_ON_STARTUP must be 1|0");
if (smtpHost) {
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error("MAGIC_LINK_SMTP_PORT must be 1..65535");
  if (!smtpFrom) throw new Error("MAGIC_LINK_SMTP_FROM is required when MAGIC_LINK_SMTP_HOST is set");
}
if (publicBaseUrl !== null && publicBaseUrl !== "") {
  // Minimal validation; URL constructor will throw on invalid.
  // eslint-disable-next-line no-new
  new URL(publicBaseUrl);
}
if (settldApiBaseUrlRaw && !settldApiBaseUrl) throw new Error("MAGIC_LINK_SETTLD_API_BASE_URL must be a valid http(s) URL");
if ((settldApiBaseUrl && !settldOpsToken) || (!settldApiBaseUrl && settldOpsToken)) {
  throw new Error("MAGIC_LINK_SETTLD_API_BASE_URL and MAGIC_LINK_SETTLD_OPS_TOKEN must be set together");
}
if (!settldProtocol) throw new Error("MAGIC_LINK_SETTLD_PROTOCOL must be a non-empty string");

function parseSessionKeyHex(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error("MAGIC_LINK_SESSION_KEY_HEX must be 64 hex chars (32 bytes)");
  return Buffer.from(s, "hex");
}

const sessionKey = parseSessionKeyHex(process.env.MAGIC_LINK_SESSION_KEY_HEX ?? "") ?? settingsKey ?? crypto.randomBytes(32);
const buyerSessionCookieName = "ml_buyer_session";
const cookieSecure = publicBaseUrl ? new URL(publicBaseUrl).protocol === "https:" : false;

const metrics = createMetrics();
metrics.declareGauge("magic_link_data_dir_writable_gauge", null);
metrics.declareGauge("magic_link_inflight_total_gauge", null);
metrics.declareGauge("verify_queue_depth_gauge", null);
metrics.declareGauge("verify_duration_ms_p50_gauge", null);
metrics.declareGauge("verify_duration_ms_p95_gauge", null);
metrics.declareGauge("verify_duration_ms_p99_gauge", null);
metrics.declareCounter("uploads_total", null);
metrics.declareCounter("verifications_total", null);
metrics.declareCounter("unzip_rejects_total", null);
metrics.declareCounter("quota_rejects_total", null);
metrics.declareCounter("rate_limit_events_total", null);
metrics.declareCounter("webhook_deliveries_total", null);
metrics.declareGauge("webhook_retry_queue_depth_gauge", null);
metrics.declareCounter("webhook_retry_jobs_enqueued_total", null);
metrics.declareCounter("webhook_retry_retries_total", null);
metrics.declareCounter("webhook_retry_dead_letter_total", null);
metrics.declareCounter("webhook_retry_deliveries_total", null);
metrics.declareCounter("webhook_retry_dead_letter_alerts_total", null);
metrics.declareCounter("billing_usage_threshold_alerts_total", null);
metrics.declareCounter("login_otp_requests_total", null);
metrics.declareCounter("decision_otp_requests_total", null);
metrics.declareCounter("buyer_notification_deliveries_total", null);
metrics.declareCounter("verify_queue_retries_total", null);
metrics.declareCounter("verify_queue_dead_letter_total", null);
metrics.declareCounter("payment_trigger_deliveries_total", null);
metrics.declareCounter("payment_trigger_retries_total", null);
metrics.declareCounter("payment_trigger_dead_letter_total", null);
metrics.declareCounter("payment_trigger_retry_deliveries_total", null);
const verifyDurationsMs = [];
const verifyDurationsWindow = 500;

await fs.mkdir(dataDir, { recursive: true });
const dataDirFormat = await checkAndMigrateDataDir({ dataDir, migrateOnStartup });
if (!dataDirFormat.ok) throw new Error(`magic-link data dir check failed: ${dataDirFormat.code ?? "UNKNOWN"}`);

function recordVerifyDurationMs(ms) {
  const n = Math.max(0, Number(ms));
  if (!Number.isFinite(n)) return;
  verifyDurationsMs.push(n);
  while (verifyDurationsMs.length > verifyDurationsWindow) verifyDurationsMs.shift();

  const sorted = [...verifyDurationsMs].sort((a, b) => a - b);
  function q(p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
  }
  metrics.setGauge("verify_duration_ms_p50_gauge", null, q(0.5));
  metrics.setGauge("verify_duration_ms_p95_gauge", null, q(0.95));
  metrics.setGauge("verify_duration_ms_p99_gauge", null, q(0.99));
}

async function readinessSignals() {
  const tmpFp = path.join(dataDir, ".healthz_write_test");
  let dataDirWritable = false;
  try {
    await fs.writeFile(tmpFp, "ok\n", "utf8");
    await fs.rm(tmpFp, { force: true });
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }
  metrics.setGauge("magic_link_data_dir_writable_gauge", null, dataDirWritable ? 1 : 0);
  return {
    dataDir,
    dataDirWritable,
    dataFormatVersion: MAGIC_LINK_DATA_FORMAT_VERSION_CURRENT,
    migrateOnStartup,
    settingsKeyConfigured: Boolean(settingsKey && Buffer.isBuffer(settingsKey) && settingsKey.length >= 16)
  };
}

const rateState = new Map();
const inflight = { total: 0, perTenant: new Map() };
const verifyWorkerPath = fileURLToPath(new URL("./verify-worker.js", import.meta.url));
const samplesDir = fileURLToPath(new URL("../assets/samples/", import.meta.url));
const sampleZipCache = new Map(); // key -> Buffer
const repoRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mcpServerScriptPath = path.join(repoRootDir, "scripts", "mcp", "settld-mcp-server.mjs");

async function readRepoFileUtf8BestEffort(relPath) {
  try {
    const fp = path.join(repoRootDir, relPath);
    return await fs.readFile(fp, "utf8");
  } catch {
    return null;
  }
}

function clientIpFromReq(req) {
  const xff = req?.headers?.["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]) : "";
  if (xff.trim()) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const xri = req?.headers?.["x-real-ip"] ? String(req.headers["x-real-ip"]).trim() : "";
  if (xri) return xri;
  if (req?.socket?.remoteAddress) return String(req.socket.remoteAddress);
  return "unknown";
}

function allowRateLimitWindow({ key, limitPerHour }) {
  const limit = Number.parseInt(String(limitPerHour ?? ""), 10);
  if (!Number.isInteger(limit) || limit < 0) return { ok: true };
  if (limit === 0) return { ok: true };

  const now = Date.now();
  const windowMs = 3_600_000;
  const row = rateState.get(key) ?? { startMs: now, count: 0 };
  if (now - row.startMs >= windowMs) {
    row.startMs = now;
    row.count = 0;
  }
  row.count += 1;
  rateState.set(key, row);
  if (row.count > limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((row.startMs + windowMs - now) / 1000)) };
  }
  return { ok: true };
}

function tenantRateLimits(tenantSettings) {
  const ts = tenantSettings && typeof tenantSettings === "object" && !Array.isArray(tenantSettings) ? tenantSettings : {};
  const defaults = {
    uploadsPerHour: uploadsPerHourDefault,
    verificationViewsPerHour: 1000,
    decisionsPerHour: 300,
    otpRequestsPerHour: 300,
    conformanceRunsPerHour: 12
  };
  const cfg = ts?.rateLimits && typeof ts.rateLimits === "object" && !Array.isArray(ts.rateLimits) ? ts.rateLimits : {};
  const pick = (field) => {
    const v = Number.parseInt(String(cfg[field] ?? defaults[field]), 10);
    return Number.isInteger(v) && v >= 0 ? v : defaults[field];
  };
  return {
    uploadsPerHour: pick("uploadsPerHour"),
    verificationViewsPerHour: pick("verificationViewsPerHour"),
    decisionsPerHour: pick("decisionsPerHour"),
    otpRequestsPerHour: pick("otpRequestsPerHour"),
    conformanceRunsPerHour: pick("conformanceRunsPerHour")
  };
}

function applyRateLimit({ req, tenantId, tenantSettings, category, limitPerHour }) {
  const limit = Number.parseInt(String(limitPerHour ?? ""), 10);
  if (!Number.isInteger(limit) || limit < 0 || limit === 0) return { ok: true };
  const ip = clientIpFromReq(req);

  const tenantCheck = allowRateLimitWindow({ key: `${category}:tenant:${tenantId}`, limitPerHour: limit });
  if (!tenantCheck.ok) return { ok: false, scope: "tenant", retryAfterSeconds: tenantCheck.retryAfterSeconds, ip };
  const ipCheck = allowRateLimitWindow({ key: `${category}:ip:${tenantId}:${ip}`, limitPerHour: limit });
  if (!ipCheck.ok) return { ok: false, scope: "ip", retryAfterSeconds: ipCheck.retryAfterSeconds, ip };
  return { ok: true, ip, tenantSettings };
}

function tryAcquireVerificationSlot(tenantId) {
  const totalLimited = maxConcurrentJobs > 0;
  const tenantLimited = maxConcurrentJobsPerTenant > 0;
  const tenantCount = inflight.perTenant.get(tenantId) ?? 0;

  if (tenantLimited && tenantCount >= maxConcurrentJobsPerTenant) return { ok: false, scope: "tenant" };
  if (totalLimited && inflight.total >= maxConcurrentJobs) return { ok: false, scope: "global" };

  inflight.total += 1;
  inflight.perTenant.set(tenantId, tenantCount + 1);
  metrics.setGauge("magic_link_inflight_total_gauge", null, inflight.total);
  metrics.setGauge("magic_link_inflight_tenant_gauge", { tenantId }, tenantCount + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inflight.total = Math.max(0, inflight.total - 1);
    const cur = inflight.perTenant.get(tenantId) ?? 0;
    const next = Math.max(0, cur - 1);
    if (next === 0) inflight.perTenant.delete(tenantId);
    else inflight.perTenant.set(tenantId, next);
    metrics.setGauge("magic_link_inflight_total_gauge", null, inflight.total);
    metrics.setGauge("magic_link_inflight_tenant_gauge", { tenantId }, next);
  };
  return { ok: true, release };
}

function checkAuth(req) {
  if (apiKey === null) return { ok: true, method: "disabled" };
  const header = req.headers["x-api-key"] ? String(req.headers["x-api-key"]) : "";
  return { ok: header === apiKey, method: "x-api-key" };
}

function billingDefaultsFromEnv() {
  return {
    subscriptionCents: billingSubscriptionCents,
    pricePerVerificationCents: billingPricePerVerificationCents
  };
}

function resolveTenantEntitlementsFromSettings(tenantSettings) {
  return resolveTenantEntitlements({
    settings: tenantSettings,
    defaultBilling: billingDefaultsFromEnv()
  });
}

function normalizeEntitlementLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function summarizeEntitlementLimitUsage({ limit, used }) {
  const normalizedUsed = Number.isInteger(used) && used >= 0 ? used : 0;
  const normalizedLimit = normalizeEntitlementLimit(limit);
  if (normalizedLimit === null) {
    return {
      limit: null,
      used: normalizedUsed,
      remaining: null,
      unlimited: true,
      atLimit: false,
      canCreate: true
    };
  }
  const remaining = Math.max(0, normalizedLimit - normalizedUsed);
  return {
    limit: normalizedLimit,
    used: normalizedUsed,
    remaining,
    unlimited: false,
    atLimit: normalizedUsed >= normalizedLimit,
    canCreate: normalizedUsed < normalizedLimit
  };
}

function countConfiguredIntegrations(settings) {
  const rows = Array.isArray(settings?.webhooks) ? settings.webhooks : [];
  const urls = new Set();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const normalized = normalizeHttpUrl(row.url);
    if (!normalized) continue;
    if (defaultEventRelayUrl && normalized === defaultEventRelayUrl) continue;
    urls.add(normalized);
  }
  return urls.size;
}

function suggestPlanUpgradesForFeatureLimit({ currentPlan, featureKey, used }) {
  const order = ["free", "builder", "growth", "enterprise"];
  const plan = normalizeTenantPlan(currentPlan, { allowNull: false });
  const currentIndex = Math.max(0, order.indexOf(plan));
  const normalizedUsed = Number.isInteger(used) && used >= 0 ? used : 0;
  const out = [];
  for (let idx = currentIndex + 1; idx < order.length; idx += 1) {
    const candidate = order[idx];
    const featureLimit = TENANT_PLAN_CATALOG?.[candidate]?.limits?.[featureKey];
    if (featureLimit === null || (Number.isInteger(featureLimit) && featureLimit > normalizedUsed)) out.push(candidate);
  }
  return out;
}

function buildEntitlementLimitExceededResponse({ tenantId, entitlements, featureKey, limit, used, message }) {
  const normalizedLimit = normalizeEntitlementLimit(limit);
  const normalizedUsed = Number.isInteger(used) && used >= 0 ? used : 0;
  const plans = suggestPlanUpgradesForFeatureLimit({
    currentPlan: entitlements?.plan ?? "free",
    featureKey,
    used: normalizedUsed
  });
  return {
    ok: false,
    code: "ENTITLEMENT_LIMIT_EXCEEDED",
    message: message ?? `${featureKey} limit reached for plan ${entitlements?.plan ?? "free"}`,
    detail: {
      tenantId,
      feature: featureKey,
      limit: normalizedLimit,
      used: normalizedUsed,
      remaining: normalizedLimit === null ? null : Math.max(0, normalizedLimit - normalizedUsed),
      plan: entitlements?.plan ?? "free"
    },
    upgradeHint: {
      suggestedPlans: plans,
      checkoutPath: `/v1/tenants/${encodeURIComponent(tenantId)}/billing/checkout`,
      billingStatePath: `/v1/tenants/${encodeURIComponent(tenantId)}/billing/state`
    }
  };
}

function billingPriceIdForPlan(plan) {
  if (plan === "builder") return stripePriceIdBuilder || null;
  if (plan === "growth") return stripePriceIdGrowth || null;
  if (plan === "enterprise") return stripePriceIdEnterprise || null;
  return null;
}

function billingPlanFromStripePriceId(priceId) {
  const id = String(priceId ?? "").trim();
  if (!id) return null;
  if (stripePriceIdBuilder && id === stripePriceIdBuilder) return "builder";
  if (stripePriceIdGrowth && id === stripePriceIdGrowth) return "growth";
  if (stripePriceIdEnterprise && id === stripePriceIdEnterprise) return "enterprise";
  return null;
}

function parseStripeSignatureHeader(headerValue) {
  const raw = String(headerValue ?? "").trim();
  if (!raw) return { ok: false, error: "missing stripe-signature header" };
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  let timestamp = null;
  const v1 = [];
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === "t") {
      const n = Number.parseInt(v, 10);
      if (Number.isInteger(n) && n > 0) timestamp = n;
    }
    if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(v)) v1.push(v.toLowerCase());
  }
  if (!Number.isInteger(timestamp)) return { ok: false, error: "invalid stripe-signature timestamp" };
  if (!v1.length) return { ok: false, error: "missing stripe-signature v1 digest" };
  return { ok: true, timestamp, v1 };
}

function verifyStripeWebhookSignature({ payloadBuffer, signatureHeader, secret, toleranceSeconds = 300 }) {
  if (!secret) return { ok: true, skipped: true };
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed.ok) return parsed;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.timestamp) > toleranceSeconds) {
    return { ok: false, error: "stripe signature timestamp outside tolerance" };
  }
  const signedPayload = `${parsed.timestamp}.${Buffer.from(payloadBuffer).toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex").toLowerCase();
  for (const candidate of parsed.v1) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"))) return { ok: true };
    } catch {
      // ignore
    }
  }
  return { ok: false, error: "stripe signature mismatch" };
}

async function stripeApiPostJson({ endpoint, formData }) {
  if (!stripeSecretKey) throw new Error("Stripe secret key is not configured");
  const body = new URLSearchParams(formData ?? {});
  const target = `${stripeApiBaseUrl}${endpoint}`;
  const resp = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stripeSecretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const msg = (json && typeof json.error?.message === "string" && json.error.message) || text || `Stripe API request failed (${resp.status})`;
    throw new Error(msg);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Stripe API returned invalid JSON");
  return json;
}

async function callSettldTenantBootstrap({ tenantId, payload, idempotencyKey = null } = {}) {
  if (!settldApiBaseUrl || !settldOpsToken) {
    return {
      ok: false,
      statusCode: 503,
      code: "RUNTIME_BOOTSTRAP_UNCONFIGURED",
      message: "runtime bootstrap is not configured on this control plane"
    };
  }
  const target = new URL("/ops/tenants/bootstrap", `${settldApiBaseUrl}/`);
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": String(tenantId),
    "x-proxy-ops-token": settldOpsToken,
    "x-settld-protocol": settldProtocol
  };
  if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);

  let response = null;
  let text = "";
  try {
    response = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(payload ?? {})
    });
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      statusCode: 502,
      code: "RUNTIME_BOOTSTRAP_UPSTREAM_UNREACHABLE",
      message: err?.message ?? "unable to reach Settld API"
    };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message =
      (json && typeof json?.message === "string" && json.message) ||
      (json && typeof json?.error === "string" && json.error) ||
      safeTruncate(text, { max: 800 }) ||
      `Settld bootstrap failed (${response.status})`;
    return {
      ok: false,
      statusCode: response.status,
      code: (json && typeof json?.code === "string" && json.code) || "RUNTIME_BOOTSTRAP_FAILED",
      message
    };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return {
      ok: false,
      statusCode: 502,
      code: "RUNTIME_BOOTSTRAP_INVALID_RESPONSE",
      message: "Settld bootstrap returned invalid JSON"
    };
  }
  return { ok: true, response: json };
}

async function callSettldTenantApi({
  apiBaseUrl = settldApiBaseUrl,
  tenantId,
  apiKey,
  method,
  pathname,
  body = undefined,
  idempotencyKey = null,
  expectedPrevChainHash = null
} = {}) {
  if (!apiBaseUrl || !apiKey) {
    return {
      ok: false,
      statusCode: 503,
      code: "SETTLD_API_UNCONFIGURED",
      message: "Settld API base URL or API key is missing"
    };
  }

  const target = new URL(pathname, `${apiBaseUrl}/`);
  const headers = {
    "x-proxy-tenant-id": String(tenantId),
    "x-settld-protocol": settldProtocol,
    authorization: `Bearer ${String(apiKey)}`
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["x-idempotency-key"] = String(idempotencyKey);
  if (expectedPrevChainHash) headers["x-proxy-expected-prev-chain-hash"] = String(expectedPrevChainHash);

  let response = null;
  let text = "";
  try {
    response = await fetch(target, {
      method: String(method || "GET").toUpperCase(),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      statusCode: 502,
      code: "SETTLD_API_UNREACHABLE",
      message: err?.message ?? "unable to reach Settld API"
    };
  }

  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      (json && typeof json?.message === "string" && json.message) ||
      (json && typeof json?.error === "string" && json.error) ||
      safeTruncate(text, { max: 800 }) ||
      `Settld API call failed (${response.status})`;
    return {
      ok: false,
      statusCode: response.status,
      code: (json && typeof json?.code === "string" && json.code) || "SETTLD_API_CALL_FAILED",
      message,
      response: json
    };
  }

  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return {
      ok: false,
      statusCode: 502,
      code: "SETTLD_API_INVALID_RESPONSE",
      message: "Settld API returned invalid JSON"
    };
  }

  return { ok: true, response: json };
}

async function setTenantPlanBySystem({ tenantId, plan, actorMethod = "system", reason = null, eventId = null } = {}) {
  const normalizedPlan = normalizeTenantPlan(plan, { allowNull: false });
  const current = await loadTenantSettings({ dataDir, tenantId });
  const beforePlan = normalizeTenantPlan(current?.plan, { allowNull: false });
  if (beforePlan === normalizedPlan) return { changed: false, plan: normalizedPlan, settings: current };

  const patched = applyTenantSettingsPatch({ currentSettings: current, patch: { plan: normalizedPlan }, settingsKey });
  if (!patched.ok) throw new Error(patched.error ?? "invalid plan");
  await saveTenantSettings({ dataDir, tenantId, settings: patched.settings, settingsKey });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_PLAN_SET",
        actor: { method: actorMethod, email: null, role: "admin" },
        targetType: "tenant_settings",
        targetId: tenantId,
        details: { beforePlan, plan: normalizedPlan, reason: reason ?? null, sourceEventId: eventId ?? null }
      }
    });
  } catch {
    // ignore
  }

  return { changed: true, plan: normalizedPlan, settings: patched.settings };
}

async function enqueueWebhookRetriesBestEffort({ tenantId, token, event, payload, webhooks, deliveryResults }) {
  try {
    const queued = await enqueueWebhookRetryJobs({
      dataDir,
      tenantId,
      token,
      event,
      payload,
      webhooks,
      deliveryResults,
      maxAttempts: webhookMaxAttempts,
      backoffMs: webhookRetryBackoffMs
    });
    if (queued?.ok) {
      if (queued.enqueued > 0) metrics.incCounter("webhook_retry_jobs_enqueued_total", null, queued.enqueued);
      if (queued.deadLettered > 0) metrics.incCounter("webhook_retry_dead_letter_total", null, queued.deadLettered);
      const depth = await webhookRetryQueueDepth({ dataDir });
      metrics.setGauge("webhook_retry_queue_depth_gauge", null, Number.isFinite(Number(depth)) ? Number(depth) : 0);
    }
  } catch {
    // ignore enqueue failures; webhook retries are best-effort.
  }
}

function normalizeWebhookRetryRowsForApi(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => ({ ...row, provider: retryProviderFromWebhookUrl(row?.webhookUrl) }));
}

function filterWebhookRetryRowsByProvider(rows, provider) {
  const list = Array.isArray(rows) ? rows : [];
  if (!provider) return [...list];
  return list.filter((row) => retryProviderFromWebhookUrl(row?.webhookUrl) === provider);
}

const webhookDeadLetterAlertState = new Map();

function deadLetterAlertStateKey({ tenantId, provider }) {
  return `${String(tenantId ?? "")}:${String(provider ?? "")}`;
}

function buildWebhookDeadLetterAlertPayload({
  tenantId,
  provider,
  deadLetterCount,
  pendingCount,
  threshold,
  latestDeadLetter = null,
  reason = "worker"
} = {}) {
  return {
    schemaVersion: "MagicLinkWebhookRetryAlert.v1",
    event: WEBHOOK_RETRY_ALERT_EVENT,
    generatedAt: nowIso(),
    tenantId,
    provider,
    reason,
    threshold,
    deadLetterCount,
    pendingCount,
    latestDeadLetter: isPlainObject(latestDeadLetter) ? latestDeadLetter : null
  };
}

function resolveWebhookDeadLetterAlertTargets({ tenantSettings }) {
  const settings = isPlainObject(tenantSettings) ? tenantSettings : {};
  const out = [];
  const seen = new Set();
  const append = ({ url, secret }) => {
    const normalized = normalizeHttpUrl(url);
    if (!normalized || !secret) return;
    const key = `${normalized}\n${String(secret)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      url: normalized,
      events: [WEBHOOK_RETRY_ALERT_EVENT],
      enabled: true,
      secret
    });
  };

  for (const target of webhookDeadLetterAlertTargets) {
    if (!isPlainObject(target)) continue;
    if (target.kind === "internal") {
      append({ url: webhookDeadLetterAlertWebhookUrl, secret: webhookDeadLetterAlertWebhookSecret });
      continue;
    }
    if (target.kind === "url") {
      append({ url: target.url, secret: webhookDeadLetterAlertWebhookSecret });
      continue;
    }
    if (target.kind === "slack" || target.kind === "zapier") {
      const integration = integrationWebhookFromSettings({ settings, provider: target.kind });
      if (isPlainObject(integration) && integration.enabled !== false) append({ url: integration.url, secret: integration.secret });
      continue;
    }
    if (target.kind === "defaultRelay" && defaultEventRelayUrl) {
      const webhooks = Array.isArray(settings.webhooks) ? settings.webhooks : [];
      const relay = webhooks.find((row) => isPlainObject(row) && row.enabled && normalizeHttpUrl(row.url) === defaultEventRelayUrl);
      if (isPlainObject(relay)) append({ url: relay.url, secret: relay.secret });
    }
  }

  return out;
}

async function evaluateWebhookDeadLetterAlerts({ tenantIdFilter = null, reason = "worker", initializeOnly = false } = {}) {
  if (webhookDeadLetterAlertThreshold < 1) return { checked: 0, alertsSent: 0 };

  const deadRaw = await listWebhookRetryJobs({ dataDir, state: "dead-letter", limit: 5_000 });
  const pendingRaw = await listWebhookRetryJobs({ dataDir, state: "pending", limit: 5_000 });
  const deadRows = deadRaw.filter((row) => row?.event !== WEBHOOK_RETRY_ALERT_EVENT);
  const pendingRows = pendingRaw.filter((row) => row?.event !== WEBHOOK_RETRY_ALERT_EVENT);

  const groups = new Map();
  const ensureGroup = ({ tenantId, provider }) => {
    const key = deadLetterAlertStateKey({ tenantId, provider });
    const current = groups.get(key);
    if (current) return current;
    const next = {
      key,
      tenantId,
      provider,
      deadLetterCount: 0,
      pendingCount: 0,
      latestDeadLetter: null
    };
    groups.set(key, next);
    return next;
  };

  for (const row of deadRows) {
    const tenantId = typeof row?.tenantId === "string" ? row.tenantId : "";
    if (!tenantId) continue;
    if (tenantIdFilter && tenantId !== tenantIdFilter) continue;
    const provider = retryProviderFromWebhookUrl(row?.webhookUrl);
    const group = ensureGroup({ tenantId, provider });
    group.deadLetterCount += 1;
    const rowMs = Date.parse(String(row?.updatedAt ?? row?.deadLetteredAt ?? ""));
    const groupMs = Date.parse(String(group.latestDeadLetter?.updatedAt ?? group.latestDeadLetter?.deadLetteredAt ?? ""));
    if (!group.latestDeadLetter || (Number.isFinite(rowMs) && (!Number.isFinite(groupMs) || rowMs > groupMs))) {
      group.latestDeadLetter = row;
    }
  }

  for (const row of pendingRows) {
    const tenantId = typeof row?.tenantId === "string" ? row.tenantId : "";
    if (!tenantId) continue;
    if (tenantIdFilter && tenantId !== tenantIdFilter) continue;
    const provider = retryProviderFromWebhookUrl(row?.webhookUrl);
    const group = ensureGroup({ tenantId, provider });
    group.pendingCount += 1;
  }

  const keys = new Set([...groups.keys()]);
  for (const key of webhookDeadLetterAlertState.keys()) {
    if (!tenantIdFilter || key.startsWith(`${tenantIdFilter}:`)) keys.add(key);
  }

  let alertsSent = 0;
  for (const key of keys) {
    const current = groups.get(key) ?? {
      key,
      tenantId: key.split(":")[0] ?? "",
      provider: key.split(":")[1] ?? "webhook",
      deadLetterCount: 0,
      pendingCount: 0,
      latestDeadLetter: null
    };
    const prior = webhookDeadLetterAlertState.get(key);
    const prevDeadLetterCount = Number.isInteger(prior?.deadLetterCount) ? prior.deadLetterCount : 0;
    const crossedThreshold = !initializeOnly && prevDeadLetterCount < webhookDeadLetterAlertThreshold && current.deadLetterCount >= webhookDeadLetterAlertThreshold;

    if (crossedThreshold) {
      const tenantSettings = await loadTenantSettings({ dataDir, tenantId: current.tenantId });
      const targets = resolveWebhookDeadLetterAlertTargets({ tenantSettings });
      if (targets.length > 0) {
        const tokenSeed = `${current.tenantId}\n${current.provider}\n${Date.now()}\n${current.deadLetterCount}`;
        const token = `ml_alert_${sha256Hex(tokenSeed).slice(0, 48)}`;
        const payload = buildWebhookDeadLetterAlertPayload({
          tenantId: current.tenantId,
          provider: current.provider,
          deadLetterCount: current.deadLetterCount,
          pendingCount: current.pendingCount,
          threshold: webhookDeadLetterAlertThreshold,
          latestDeadLetter: current.latestDeadLetter,
          reason
        });
        const deliveryRows = await deliverTenantWebhooks({
          dataDir,
          tenantId: current.tenantId,
          token,
          event: WEBHOOK_RETRY_ALERT_EVENT,
          payload,
          webhooks: targets,
          settingsKey,
          deliveryMode: webhookDeliveryMode,
          timeoutMs: webhookTimeoutMs,
          maxAttempts: webhookMaxAttempts,
          retryBackoffMs: webhookRetryBackoffMs
        });
        for (const row of deliveryRows) {
          metrics.incCounter(
            "webhook_deliveries_total",
            { tenantId: current.tenantId, event: WEBHOOK_RETRY_ALERT_EVENT, ok: row?.ok ? "true" : "false" },
            1
          );
        }
        await enqueueWebhookRetriesBestEffort({
          tenantId: current.tenantId,
          token,
          event: WEBHOOK_RETRY_ALERT_EVENT,
          payload,
          webhooks: targets,
          deliveryResults: deliveryRows
        });
        alertsSent += 1;
        metrics.incCounter("webhook_retry_dead_letter_alerts_total", { tenantId: current.tenantId, provider: current.provider }, 1);
      }
    }

    webhookDeadLetterAlertState.set(key, {
      deadLetterCount: current.deadLetterCount,
      pendingCount: current.pendingCount,
      updatedAt: nowIso()
    });
  }

  return { checked: keys.size, alertsSent };
}

function isExpired(createdAtIso) {
  const createdMs = Date.parse(String(createdAtIso ?? ""));
  if (!Number.isFinite(createdMs)) return true;
  return Date.now() > createdMs + tokenTtlSeconds * 1000;
}

function isPastRetention(createdAtIso, retentionDays) {
  const createdMs = Date.parse(String(createdAtIso ?? ""));
  if (!Number.isFinite(createdMs)) return true;
  const days = Number.isInteger(retentionDays) ? retentionDays : 30;
  return Date.now() > createdMs + days * 24 * 3600 * 1000;
}

async function loadMeta(token) {
  const fp = path.join(dataDir, "meta", `${token}.json`);
  const raw = await fs.readFile(fp, "utf8");
  return JSON.parse(raw);
}

async function runVerifyWorker({ dir, strict, hashConcurrency, timeoutMs, env }) {
  const args = [verifyWorkerPath, "--dir", dir, strict ? "--strict" : "--nonstrict", "--hash-concurrency", String(hashConcurrency)];
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
  const stdout = [];
  const stderr = [];
  proc.stdout.on("data", (d) => stdout.push(d));
  proc.stderr.on("data", (d) => stderr.push(d));

  const timeout = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timedOut: true, code: null }), timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(t);
      resolve({ timedOut: false, code: code ?? 1 });
    });
  });
  if (timeout.timedOut) {
    proc.kill("SIGKILL");
    return { ok: false, error: "HOSTED_VERIFY_TIMEOUT", detail: { timeoutMs } };
  }
  const outText = Buffer.concat(stdout).toString("utf8");
  if (timeout.code !== 0) {
    const errText = Buffer.concat(stderr).toString("utf8");
    return { ok: false, error: "HOSTED_VERIFY_FAILED", detail: { exitCode: timeout.code, stderr: safeTruncate(errText, { max: 10_000 }) } };
  }
  try {
    const parsed = JSON.parse(outText);
    return { ok: true, result: parsed };
  } catch (err) {
    return { ok: false, error: "HOSTED_VERIFY_INVALID_JSON", detail: { message: err?.message ?? String(err ?? ""), stdout: safeTruncate(outText, { max: 10_000 }) } };
  }
}

async function runMcpInitializeToolsListSmoke({ env, timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [mcpServerScriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(env ?? {}) }
  });
  let spawnError = null;
  child.on("error", (err) => {
    spawnError = err;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const pending = new Map();
  let stdoutBuf = "";
  let stderrBuf = "";
  const onStdout = (chunk) => {
    stdoutBuf += String(chunk);
    for (;;) {
      const idx = stdoutBuf.indexOf("\n");
      if (idx === -1) break;
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (!msg || msg.id === undefined || msg.id === null) continue;
      const key = String(msg.id);
      const item = pending.get(key);
      if (!item) continue;
      pending.delete(key);
      clearTimeout(item.timeout);
      item.resolve(msg);
    }
  };
  const onStderr = (chunk) => {
    stderrBuf += String(chunk);
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);

  const rpc = async (method, params = {}) => {
    if (spawnError) throw spawnError;
    const id = `ml_mcp_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    const payload = { jsonrpc: "2.0", id, method, params };
    child.stdin.write(JSON.stringify(payload) + "\n");
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs).unref?.();
      pending.set(id, { resolve, reject, timeout });
    });
  };

  const closeChild = async () => {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => resolve(), 500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  try {
    const init = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "magic-link-onboarding", version: "1" },
      capabilities: {}
    });
    if (init?.error) {
      return {
        ok: false,
        error: "MCP_INITIALIZE_FAILED",
        detail: {
          code: init.error?.code ?? null,
          message: init.error?.message ?? "initialize failed"
        }
      };
    }
    const list = await rpc("tools/list", {});
    if (list?.error) {
      return {
        ok: false,
        error: "MCP_TOOLS_LIST_FAILED",
        detail: {
          code: list.error?.code ?? null,
          message: list.error?.message ?? "tools/list failed"
        }
      };
    }
    const tools = Array.isArray(list?.result?.tools) ? list.result.tools : [];
    const toolNames = tools
      .map((t) => (t && typeof t.name === "string" ? t.name.trim() : ""))
      .filter(Boolean)
      .slice(0, 25);
    return {
      ok: true,
      smoke: {
        initialized: true,
        serverInfo: init?.result?.serverInfo ?? null,
        toolsCount: tools.length,
        sampleTools: toolNames
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: "MCP_SMOKE_TEST_FAILED",
      detail: {
        message: err?.message ?? "mcp smoke test failed",
        stderr: safeTruncate(stderrBuf, { max: 4_000 })
      }
    };
  } finally {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      try {
        item.reject(new Error("mcp process closed"));
      } catch {
        // ignore
      }
    }
    pending.clear();
    await closeChild();
  }
}

const verifyQueue = createVerifyQueue({
  workerCount: verifyQueueWorkers,
  maxAttempts: verifyQueueMaxAttempts,
  retryBackoffMs: verifyQueueRetryBackoffMs,
  handler: async (payload) =>
    await runVerifyWorker({
      dir: payload?.dir,
      strict: Boolean(payload?.strict),
      hashConcurrency: Number.isInteger(payload?.hashConcurrency) ? payload.hashConcurrency : 16,
      timeoutMs: Number.isInteger(payload?.timeoutMs) ? payload.timeoutMs : verifyTimeoutMs,
      env: payload?.env ?? process.env
    }),
  onDepthChange: (depth) => {
    metrics.setGauge("verify_queue_depth_gauge", null, Number.isFinite(Number(depth)) ? Number(depth) : 0);
  },
  onRetry: () => {
    metrics.incCounter("verify_queue_retries_total", null, 1);
  },
  onDeadLetter: () => {
    metrics.incCounter("verify_queue_dead_letter_total", null, 1);
  }
});

const paymentTriggerRetryWorker = startPaymentTriggerRetryWorker({
  dataDir,
  settingsKey,
  timeoutMs: webhookTimeoutMs,
  intervalMs: paymentTriggerRetryIntervalMs,
  onRetry: (count) => {
    metrics.incCounter("payment_trigger_retries_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
  },
  onDeadLetter: (count) => {
    metrics.incCounter("payment_trigger_dead_letter_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
  },
  onDelivered: (count) => {
    metrics.incCounter("payment_trigger_retry_deliveries_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
  }
});

void paymentTriggerRetryWorker;

const webhookRetryWorker = startWebhookRetryWorker({
  dataDir,
  settingsKey,
  timeoutMs: webhookTimeoutMs,
  intervalMs: webhookRetryIntervalMs,
  onRetry: (count) => {
    metrics.incCounter("webhook_retry_retries_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
  },
  onDeadLetter: (count) => {
    metrics.incCounter("webhook_retry_dead_letter_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
    void evaluateWebhookDeadLetterAlerts({ reason: "worker_dead_letter" });
  },
  onDelivered: (count) => {
    metrics.incCounter("webhook_retry_deliveries_total", null, Number.isFinite(Number(count)) ? Number(count) : 1);
  },
  onDepth: (depth) => {
    metrics.setGauge("webhook_retry_queue_depth_gauge", null, Number.isFinite(Number(depth)) ? Number(depth) : 0);
  }
});

void webhookRetryWorker;
metrics.setGauge("webhook_retry_queue_depth_gauge", null, await webhookRetryQueueDepth({ dataDir }));
await evaluateWebhookDeadLetterAlerts({ reason: "startup", initializeOnly: true });

function parseTenantId(req) {
  const raw = req.headers["x-tenant-id"] ? String(req.headers["x-tenant-id"]) : "default";
  const v = raw.trim();
  if (!v) return { ok: false, error: "tenantId empty" };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(v)) return { ok: false, error: "tenantId invalid (allowed: [A-Za-z0-9_-]{1,64})" };
  return { ok: true, tenantId: v };
}

function parseTenantIdParam(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: "tenantId empty" };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(v)) return { ok: false, error: "tenantId invalid (allowed: [A-Za-z0-9_-]{1,64})" };
  return { ok: true, tenantId: v };
}

function normalizeBaseUrl(rawUrl) {
  const normalized = normalizeHttpUrl(rawUrl);
  if (!normalized) return null;
  try {
    const u = new URL(normalized);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function requestBaseUrl(req) {
  if (publicBaseUrl) return normalizeBaseUrl(publicBaseUrl);
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  const proto = forwardedProto === "https" ? "https" : "http";
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] ?? "").split(",")[0].trim();
  const hostValue = forwardedHost || String(req?.headers?.host ?? "").trim();
  if (!hostValue) return null;
  return normalizeBaseUrl(`${proto}://${hostValue}`);
}

function integrationOauthCallbackPath(provider) {
  return `/v1/integrations/${provider}/oauth/callback`;
}

function integrationOauthStartPath({ tenantId, provider }) {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/integrations/${provider}/oauth/start`;
}

function integrationOauthProviderConfig(provider) {
  if (provider === "slack") {
    const enabled = Boolean(slackOauthClientId && slackOauthClientSecret && slackOauthAuthorizeUrl && slackOauthTokenUrl);
    return {
      provider,
      enabled,
      clientId: slackOauthClientId,
      clientSecret: slackOauthClientSecret,
      authorizeUrl: slackOauthAuthorizeUrl,
      tokenUrl: slackOauthTokenUrl,
      scopes: [...slackOauthScopes],
      userScopes: [...slackOauthUserScopes],
      clientAuth: "body",
      webhookFieldPath: "incoming_webhook.url"
    };
  }
  if (provider === "zapier") {
    const enabled = Boolean(zapierOauthClientId && zapierOauthClientSecret && zapierOauthAuthorizeUrl && zapierOauthTokenUrl);
    return {
      provider,
      enabled,
      clientId: zapierOauthClientId,
      clientSecret: zapierOauthClientSecret,
      authorizeUrl: zapierOauthAuthorizeUrl,
      tokenUrl: zapierOauthTokenUrl,
      scopes: [...zapierOauthScopes],
      userScopes: [],
      clientAuth: zapierOauthClientAuth,
      webhookFieldPath: zapierOauthWebhookField
    };
  }
  return { provider, enabled: false };
}

function integrationOauthStateId() {
  return crypto.randomBytes(18).toString("base64url");
}

function integrationOauthStatePath(stateId) {
  return path.join(dataDir, "oauth", "states", `${stateId}.json`);
}

function parseOauthStateId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(s)) return null;
  return s;
}

async function createIntegrationOauthState({ provider, tenantId, redirectUri }) {
  const stateId = integrationOauthStateId();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + integrationOauthStateTtlSeconds * 1000).toISOString();
  const fp = integrationOauthStatePath(stateId);
  const row = {
    schemaVersion: "MagicLinkIntegrationOauthState.v1",
    stateId,
    provider,
    tenantId,
    redirectUri,
    createdAt,
    expiresAt
  };
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(row, null, 2) + "\n", "utf8");
  return { stateId, state: row };
}

async function consumeIntegrationOauthState({ provider, stateId }) {
  const id = parseOauthStateId(stateId);
  if (!id) return { ok: false, error: "OAUTH_STATE_INVALID" };
  const fp = integrationOauthStatePath(id);
  let row;
  try {
    row = JSON.parse(await fs.readFile(fp, "utf8"));
  } catch {
    return { ok: false, error: "OAUTH_STATE_NOT_FOUND" };
  }
  try {
    await fs.rm(fp, { force: true });
  } catch {
    // ignore
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, error: "OAUTH_STATE_INVALID" };
  if (String(row.schemaVersion ?? "") !== "MagicLinkIntegrationOauthState.v1") return { ok: false, error: "OAUTH_STATE_INVALID" };
  if (String(row.provider ?? "") !== provider) return { ok: false, error: "OAUTH_STATE_PROVIDER_MISMATCH" };
  const expiresAtMs = Date.parse(String(row.expiresAt ?? ""));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return { ok: false, error: "OAUTH_STATE_EXPIRED" };
  return { ok: true, state: row };
}

function readPathValue(obj, rawPath) {
  const pathStr = String(rawPath ?? "").trim();
  if (!pathStr) return undefined;
  const parts = pathStr.split(".").map((p) => p.trim()).filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

async function exchangeIntegrationOauthCode({ providerConfig, code, redirectUri }) {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", String(code ?? ""));
  params.set("redirect_uri", String(redirectUri ?? ""));
  if (providerConfig.clientAuth === "body") {
    params.set("client_id", providerConfig.clientId);
    params.set("client_secret", providerConfig.clientSecret);
  }

  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json"
  };
  if (providerConfig.clientAuth === "basic") {
    const basic = Buffer.from(`${providerConfig.clientId}:${providerConfig.clientSecret}`, "utf8").toString("base64");
    headers.authorization = `Basic ${basic}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), integrationOauthHttpTimeoutMs);
  try {
    const response = await fetch(providerConfig.tokenUrl, {
      method: "POST",
      headers,
      body: params.toString(),
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        error: "OAUTH_TOKEN_EXCHANGE_FAILED",
        detail: { statusCode: response.status, body: safeTruncate(text, { max: 2_000 }) }
      };
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { ok: false, error: "OAUTH_TOKEN_RESPONSE_INVALID" };
    }
    return { ok: true, tokenResponse: json };
  } catch (err) {
    return { ok: false, error: "OAUTH_TOKEN_REQUEST_ERROR", detail: { message: err?.message ?? String(err ?? "") } };
  } finally {
    clearTimeout(timeout);
  }
}

function integrationWebhookUrlFromOauthToken({ provider, tokenResponse, providerConfig }) {
  if (provider === "slack" && tokenResponse?.ok === false) {
    return { ok: false, error: `Slack OAuth failed (${String(tokenResponse?.error ?? "unknown")})` };
  }
  const pathValue = readPathValue(tokenResponse, providerConfig?.webhookFieldPath ?? "");
  const candidate =
    (typeof pathValue === "string" ? pathValue : null) ??
    (typeof tokenResponse?.webhookUrl === "string" ? tokenResponse.webhookUrl : null) ??
    (typeof tokenResponse?.incoming_webhook?.url === "string" ? tokenResponse.incoming_webhook.url : null);
  const parsed = validateIntegrationWebhookUrl({ provider, webhookUrl: candidate });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, webhookUrl: parsed.webhookUrl };
}

function integrationOauthCapability({ provider, tenantId }) {
  const cfg = integrationOauthProviderConfig(provider);
  return {
    provider,
    enabled: Boolean(cfg.enabled),
    startPath: cfg.enabled ? integrationOauthStartPath({ tenantId, provider }) : null
  };
}

function oauthResultRedirectPath({ tenantId, provider, status, message = null }) {
  const params = new URLSearchParams();
  params.set("oauth", status);
  params.set("provider", provider);
  if (message) params.set("message", safeTruncate(message, { max: 300 }));
  return `/v1/tenants/${encodeURIComponent(tenantId)}/integrations?${params.toString()}`;
}

function ensureDefaultEventRelayWebhook({ settings, tenantId }) {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const webhooks = Array.isArray(base.webhooks) ? base.webhooks.filter((w) => isPlainObject(w)) : [];
  if (!defaultEventRelayUrl) return { changed: false, settings: { ...base, webhooks } };

  const relayEvents = normalizeWebhookEvents(defaultEventRelayEvents);
  const relayUrl = defaultEventRelayUrl;
  let changed = false;
  let found = false;
  const nextWebhooks = webhooks.map((row) => {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (url !== relayUrl) return row;
    found = true;
    const events = normalizeWebhookEvents(row.events);
    const mergedEvents = normalizeWebhookEvents([...events, ...relayEvents]);
    let secret = typeof row.secret === "string" && row.secret.trim() ? row.secret : null;
    if (!secret) {
      secret = defaultEventRelaySecret || randomWebhookSecret();
      changed = true;
    }
    const enabled = row.enabled !== true ? true : row.enabled;
    if (!changed && (enabled !== row.enabled || JSON.stringify(mergedEvents) !== JSON.stringify(events))) changed = true;
    return { ...row, url: relayUrl, events: mergedEvents, enabled: true, secret };
  });

  if (!found) {
    nextWebhooks.push({
      url: relayUrl,
      events: relayEvents,
      enabled: true,
      secret: defaultEventRelaySecret || randomWebhookSecret()
    });
    changed = true;
  }

  return { changed, settings: { ...base, webhooks: nextWebhooks } };
}

function integrationWebhookFromSettings({ settings, provider }) {
  const webhooks = Array.isArray(settings?.webhooks) ? settings.webhooks : [];
  for (const row of webhooks) {
    if (!isPlainObject(row)) continue;
    const p = providerFromWebhookUrl(row.url);
    if (p === provider) return row;
  }
  return null;
}

function replaceIntegrationWebhook({ settings, provider, webhook }) {
  const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const webhooks = Array.isArray(base.webhooks) ? base.webhooks.filter((w) => isPlainObject(w) && providerFromWebhookUrl(w.url) !== provider) : [];
  if (webhook) webhooks.push(webhook);
  return { ...base, webhooks };
}

function validateIntegrationWebhookUrl({ provider, webhookUrl }) {
  const normalized = normalizeHttpUrl(webhookUrl);
  if (!normalized) return { ok: false, error: "webhookUrl must be a valid http(s) URL" };
  const detected = providerFromWebhookUrl(normalized);
  if (detected !== provider) {
    if (provider === "slack") return { ok: false, error: "webhookUrl must be a Slack Incoming Webhook URL (hooks.slack.com)" };
    if (provider === "zapier") return { ok: false, error: "webhookUrl must be a Zapier Catch Hook URL (hooks.zapier.com)" };
    return { ok: false, error: "webhookUrl does not match provider" };
  }
  return { ok: true, webhookUrl: normalized };
}

async function listRecentWebhookDeliveryRowsBestEffort({ tenantId, maxFilesPerBucket = 400, maxRows = 800 } = {}) {
  const tenant = String(tenantId ?? "").trim();
  if (!tenant) return [];

  const rows = [];
  for (const sub of ["attempts", "record"]) {
    const dir = path.join(dataDir, "webhooks", sub);
    let names = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      names = await fs.readdir(dir);
    } catch {
      names = [];
    }
    names = names.filter((name) => String(name).endsWith(".json")).sort().reverse().slice(0, maxFilesPerBucket);
    for (const name of names) {
      const fp = path.join(dir, name);
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(fp, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (String(parsed.tenantId ?? "") !== tenant) continue;
        rows.push({ ...parsed, _store: sub, _file: name });
      } catch {
        // ignore malformed row
      }
      if (rows.length >= maxRows) break;
    }
    if (rows.length >= maxRows) break;
  }

  rows.sort((a, b) => {
    const aMs = Date.parse(String(a?.sentAt ?? ""));
    const bMs = Date.parse(String(b?.sentAt ?? ""));
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
  return rows.slice(0, maxRows);
}

function webhookHealthFromRows({ rows, webhookUrl }) {
  const normalized = normalizeHttpUrl(webhookUrl);
  const base = {
    lastAttemptAt: null,
    lastOk: null,
    lastStatusCode: null,
    lastError: null,
    lastDeliveryMode: null,
    attempts24h: 0,
    successes24h: 0,
    failures24h: 0
  };
  if (!normalized) return base;
  const list = Array.isArray(rows) ? rows : [];
  const dayAgoMs = Date.now() - 24 * 3600 * 1000;
  for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (String(row.url ?? "") !== normalized) continue;
    const sentAt = typeof row.sentAt === "string" && row.sentAt.trim() ? row.sentAt.trim() : null;
    const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : null;
    const rowMode = typeof row.deliveryMode === "string" ? row.deliveryMode : row._store === "record" ? "record" : "http";
    const rowOk = result ? Boolean(result.ok) : rowMode === "record" ? true : null;
    const rowStatusCode = result && Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : null;
    const rowError = result && typeof result.error === "string" && result.error.trim() ? result.error : null;

    if (!base.lastAttemptAt) {
      base.lastAttemptAt = sentAt;
      base.lastOk = rowOk;
      base.lastStatusCode = rowStatusCode;
      base.lastError = rowError;
      base.lastDeliveryMode = rowMode;
    }

    const sentAtMs = Date.parse(String(sentAt ?? ""));
    if (Number.isFinite(sentAtMs) && sentAtMs >= dayAgoMs) {
      base.attempts24h += 1;
      if (rowOk === true) base.successes24h += 1;
      if (rowOk === false) base.failures24h += 1;
    }
  }
  return base;
}

function retryQueueHealthFromJobs({ pendingJobs, deadJobs, webhookUrl }) {
  const normalized = normalizeHttpUrl(webhookUrl);
  const base = {
    pendingCount: 0,
    deadLetterCount: 0,
    nextAttemptAt: null,
    latestDeadLetter: null
  };
  if (!normalized) return base;

  const pending = Array.isArray(pendingJobs) ? pendingJobs : [];
  const dead = Array.isArray(deadJobs) ? deadJobs : [];

  let nextAttemptMs = null;
  for (const row of pending) {
    if (!isPlainObject(row)) continue;
    if (row.event === WEBHOOK_RETRY_ALERT_EVENT) continue;
    if (String(row.webhookUrl ?? "") !== normalized) continue;
    base.pendingCount += 1;
    const ms = Date.parse(String(row.nextAttemptAt ?? ""));
    if (!Number.isFinite(ms)) continue;
    if (nextAttemptMs === null || ms < nextAttemptMs) {
      nextAttemptMs = ms;
      base.nextAttemptAt = row.nextAttemptAt;
    }
  }

  let latestDeadMs = null;
  for (const row of dead) {
    if (!isPlainObject(row)) continue;
    if (row.event === WEBHOOK_RETRY_ALERT_EVENT) continue;
    if (String(row.webhookUrl ?? "") !== normalized) continue;
    base.deadLetterCount += 1;
    const ms = Date.parse(String(row.updatedAt ?? row.deadLetteredAt ?? ""));
    if (!Number.isFinite(ms)) continue;
    if (latestDeadMs === null || ms > latestDeadMs) {
      latestDeadMs = ms;
      base.latestDeadLetter = {
        token: typeof row.token === "string" ? row.token : null,
        idempotencyKey: typeof row.idempotencyKey === "string" ? row.idempotencyKey : null,
        event: typeof row.event === "string" ? row.event : null,
        lastError: typeof row.lastError === "string" ? row.lastError : null,
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : typeof row.deadLetteredAt === "string" ? row.deadLetteredAt : null
      };
    }
  }

  return base;
}

function summarizeTenantWebhookRetryQueue({ pendingJobs, deadJobs }) {
  const pending = Array.isArray(pendingJobs) ? pendingJobs : [];
  const dead = Array.isArray(deadJobs) ? deadJobs : [];

  const summary = {
    pendingCount: 0,
    deadLetterCount: 0,
    latestDeadLetter: null,
    byProvider: {},
    latestDeadLetterByProvider: {}
  };

  for (const provider of WEBHOOK_RETRY_PROVIDER_NAMES) {
    summary.byProvider[provider] = { pendingCount: 0, deadLetterCount: 0 };
    summary.latestDeadLetterByProvider[provider] = null;
  }

  for (const row of pending) {
    if (!isPlainObject(row)) continue;
    if (row.event === WEBHOOK_RETRY_ALERT_EVENT) continue;
    const provider = retryProviderFromWebhookUrl(row.webhookUrl);
    summary.pendingCount += 1;
    summary.byProvider[provider].pendingCount += 1;
  }

  let latestMs = null;
  for (const row of dead) {
    if (!isPlainObject(row)) continue;
    if (row.event === WEBHOOK_RETRY_ALERT_EVENT) continue;
    const provider = retryProviderFromWebhookUrl(row.webhookUrl);
    summary.deadLetterCount += 1;
    summary.byProvider[provider].deadLetterCount += 1;
    const ms = Date.parse(String(row.updatedAt ?? row.deadLetteredAt ?? ""));
    const providerLatest = summary.latestDeadLetterByProvider[provider];
    const providerLatestMs = Date.parse(String(providerLatest?.updatedAt ?? providerLatest?.deadLetteredAt ?? ""));
    if (!providerLatest || (Number.isFinite(ms) && (!Number.isFinite(providerLatestMs) || ms > providerLatestMs))) {
      summary.latestDeadLetterByProvider[provider] = {
        token: typeof row.token === "string" ? row.token : null,
        idempotencyKey: typeof row.idempotencyKey === "string" ? row.idempotencyKey : null,
        event: typeof row.event === "string" ? row.event : null,
        webhookUrl: typeof row.webhookUrl === "string" ? row.webhookUrl : null,
        provider,
        lastError: typeof row.lastError === "string" ? row.lastError : null,
        updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : typeof row.deadLetteredAt === "string" ? row.deadLetteredAt : null
      };
    }
    if (!Number.isFinite(ms)) continue;
    if (latestMs !== null && ms <= latestMs) continue;
    latestMs = ms;
    summary.latestDeadLetter = {
      token: typeof row.token === "string" ? row.token : null,
      idempotencyKey: typeof row.idempotencyKey === "string" ? row.idempotencyKey : null,
      event: typeof row.event === "string" ? row.event : null,
      webhookUrl: typeof row.webhookUrl === "string" ? row.webhookUrl : null,
      provider,
      lastError: typeof row.lastError === "string" ? row.lastError : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : typeof row.deadLetteredAt === "string" ? row.deadLetteredAt : null
    };
  }
  return summary;
}

async function readTenantIntegrationsState({ tenantId, tenantSettings = null } = {}) {
  const settings = tenantSettings ?? (await loadTenantSettings({ dataDir, tenantId }));
  const entitlements = resolveTenantEntitlementsFromSettings(settings);
  const integrationQuota = summarizeEntitlementLimitUsage({
    limit: entitlements?.limits?.maxIntegrations,
    used: countConfiguredIntegrations(settings)
  });
  const rows = await listRecentWebhookDeliveryRowsBestEffort({ tenantId });
  const pendingRetryRows = await listWebhookRetryJobs({ dataDir, tenantId, state: "pending", limit: 5_000 });
  const deadRetryRows = await listWebhookRetryJobs({ dataDir, tenantId, state: "dead-letter", limit: 5_000 });
  const slackWebhook = integrationWebhookFromSettings({ settings, provider: "slack" });
  const zapierWebhook = integrationWebhookFromSettings({ settings, provider: "zapier" });
  const slackOauth = integrationOauthCapability({ provider: "slack", tenantId });
  const zapierOauth = integrationOauthCapability({ provider: "zapier", tenantId });
  const relayWebhook =
    defaultEventRelayUrl && Array.isArray(settings?.webhooks)
      ? settings.webhooks.find((row) => isPlainObject(row) && String(row.url ?? "") === defaultEventRelayUrl) ?? null
      : null;
  return {
    schemaVersion: "MagicLinkIntegrationsState.v1",
    tenantId,
    generatedAt: nowIso(),
    entitlements,
    quota: {
      maxIntegrations: integrationQuota
    },
    oauth: {
      slack: slackOauth,
      zapier: zapierOauth
    },
    retryQueue: summarizeTenantWebhookRetryQueue({ pendingJobs: pendingRetryRows, deadJobs: deadRetryRows }),
    integrations: {
      defaultRelay: {
        provider: "defaultRelay",
        configuredInEnv: Boolean(defaultEventRelayUrl),
        connected: Boolean(relayWebhook),
        enabled: Boolean(relayWebhook?.enabled),
        webhookUrl: relayWebhook?.url ?? defaultEventRelayUrl ?? null,
        webhookUrlMasked: maskWebhookUrl(relayWebhook?.url ?? defaultEventRelayUrl ?? null),
        events: Array.isArray(relayWebhook?.events) ? normalizeWebhookEvents(relayWebhook.events) : [...defaultEventRelayEvents],
        deliveryHealth: webhookHealthFromRows({ rows, webhookUrl: relayWebhook?.url ?? defaultEventRelayUrl ?? null }),
        retryQueue: retryQueueHealthFromJobs({ pendingJobs: pendingRetryRows, deadJobs: deadRetryRows, webhookUrl: relayWebhook?.url ?? defaultEventRelayUrl ?? null })
      },
      slack: {
        provider: "slack",
        oauthEnabled: slackOauth.enabled,
        oauthStartPath: slackOauth.startPath,
        connected: Boolean(slackWebhook),
        enabled: Boolean(slackWebhook?.enabled),
        webhookUrl: slackWebhook?.url ?? null,
        webhookUrlMasked: maskWebhookUrl(slackWebhook?.url ?? null),
        events: Array.isArray(slackWebhook?.events) ? normalizeWebhookEvents(slackWebhook.events) : [],
        deliveryHealth: webhookHealthFromRows({ rows, webhookUrl: slackWebhook?.url ?? null }),
        retryQueue: retryQueueHealthFromJobs({ pendingJobs: pendingRetryRows, deadJobs: deadRetryRows, webhookUrl: slackWebhook?.url ?? null })
      },
      zapier: {
        provider: "zapier",
        oauthEnabled: zapierOauth.enabled,
        oauthStartPath: zapierOauth.startPath,
        connected: Boolean(zapierWebhook),
        enabled: Boolean(zapierWebhook?.enabled),
        webhookUrl: zapierWebhook?.url ?? null,
        webhookUrlMasked: maskWebhookUrl(zapierWebhook?.url ?? null),
        events: Array.isArray(zapierWebhook?.events) ? normalizeWebhookEvents(zapierWebhook.events) : [],
        deliveryHealth: webhookHealthFromRows({ rows, webhookUrl: zapierWebhook?.url ?? null }),
        retryQueue: retryQueueHealthFromJobs({ pendingJobs: pendingRetryRows, deadJobs: deadRetryRows, webhookUrl: zapierWebhook?.url ?? null })
      }
    }
  };
}

function parseMode(req, url) {
  const q = url.searchParams.get("mode");
  const h = req.headers["x-verify-mode"] ? String(req.headers["x-verify-mode"]) : null;
  if (q === null && h === null) return { ok: true, mode: null };
  const raw = (q ?? h ?? "").trim().toLowerCase();
  if (raw === "auto" || raw === "strict" || raw === "compat") return { ok: true, mode: raw };
  return { ok: false, error: "invalid mode (expected strict|compat|auto)" };
}

function parseAuthorizationBearerToken(req) {
  const raw = req.headers["authorization"] ? String(req.headers["authorization"]) : "";
  const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(raw);
  if (!m) return null;
  const token = String(m[1] ?? "").trim();
  return token || null;
}

function parseCookies(req) {
  const raw = req.headers["cookie"] ? String(req.headers["cookie"]) : "";
  const out = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

function getCookie(req, name) {
  const cookies = parseCookies(req);
  const raw = cookies[String(name ?? "")];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function buildCookie({ name, value, maxAgeSeconds, httpOnly = true, sameSite = "Strict", secure = false } = {}) {
  const n = String(name ?? "").trim();
  const v = value === null ? "" : encodeURIComponent(String(value ?? ""));
  const parts = [`${n}=${v}`, "Path=/"];
  const maxAge = Number.parseInt(String(maxAgeSeconds ?? ""), 10);
  if (Number.isInteger(maxAge) && maxAge >= 0) parts.push(`Max-Age=${maxAge}`);
  if (httpOnly) parts.push("HttpOnly");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function setBuyerSessionCookie(res, token) {
  const cookie = buildCookie({ name: buyerSessionCookieName, value: token, maxAgeSeconds: buyerSessionTtlSeconds, secure: cookieSecure });
  res.setHeader("set-cookie", cookie);
}

function clearBuyerSessionCookie(res) {
  const cookie = buildCookie({ name: buyerSessionCookieName, value: "", maxAgeSeconds: 0, secure: cookieSecure });
  res.setHeader("set-cookie", cookie);
}

function buyerRoleRank(role) {
  const r = String(role ?? "").trim().toLowerCase();
  if (r === "admin") return 3;
  if (r === "approver") return 2;
  if (r === "viewer") return 1;
  return 0;
}

function buyerRoleAtLeast(role, minRole) {
  return buyerRoleRank(role) >= buyerRoleRank(minRole);
}

function resolveBuyerRole({ tenantSettings, email }) {
  const e = normalizeEmailLower(email);
  if (!e) return "viewer";
  const map = isPlainObject(tenantSettings?.buyerUserRoles) ? tenantSettings.buyerUserRoles : null;
  const rawRole = map && typeof map[e] === "string" ? map[e] : null;
  const role = String(rawRole ?? "").trim().toLowerCase();
  if (role === "admin" || role === "approver" || role === "viewer") return role;
  return "viewer";
}

async function authenticateBuyerSession(req, { expectedTenantId = null } = {}) {
  const token = getCookie(req, buyerSessionCookieName);
  if (!token) return { ok: false, error: "SESSION_MISSING" };

  const verified = verifyBuyerSessionToken({ sessionKey, token });
  if (!verified.ok) return { ok: false, error: verified.error ?? "SESSION_INVALID" };

  const tenantId = typeof verified.payload?.tenantId === "string" ? verified.payload.tenantId : "";
  const email = typeof verified.payload?.email === "string" ? verified.payload.email : "";
  if (expectedTenantId && tenantId !== expectedTenantId) return { ok: false, error: "SESSION_TENANT_MISMATCH" };

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const allowedDomains = Array.isArray(tenantSettings?.buyerAuthEmailDomains) ? tenantSettings.buyerAuthEmailDomains : [];
  if (!allowedDomains.length) return { ok: false, error: "BUYER_AUTH_DISABLED" };
  if (!isEmailAllowedByDomains({ email, allowedDomains })) return { ok: false, error: "BUYER_EMAIL_DOMAIN_FORBIDDEN" };

  const role = resolveBuyerRole({ tenantSettings, email });
  return { ok: true, principal: { method: "buyer_session", tenantId, email, role }, tenantSettings };
}

async function requireTenantPrincipal(req, res, { tenantId, minBuyerRole }) {
  const api = checkAuth(req);
  if (api.ok) return { ok: true, principal: { method: api.method, tenantId, email: null, role: "admin" }, tenantSettings: null };

  const buyer = await authenticateBuyerSession(req, { expectedTenantId: tenantId });
  if (!buyer.ok) {
    sendJson(res, 403, { ok: false, code: "FORBIDDEN" });
    return { ok: false };
  }
  if (minBuyerRole && !buyerRoleAtLeast(buyer.principal.role, minBuyerRole)) {
    sendJson(res, 403, { ok: false, code: "FORBIDDEN" });
    return { ok: false };
  }
  return buyer;
}

function assertSafeId(raw, { name, maxLen = 64 } = {}) {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, error: `${name} empty` };
  if (v.length > maxLen) return { ok: false, error: `${name} too long` };
  if (!/^[a-zA-Z0-9_-]+$/.test(v)) return { ok: false, error: `${name} invalid (allowed: [A-Za-z0-9_-])` };
  return { ok: true, value: v };
}

function decodeBase64UrlUtf8(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64UrlUtf8(raw) {
  const text = String(raw ?? "");
  if (!text) return "";
  return Buffer.from(text, "utf8").toString("base64url");
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort(cmpString);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function templateConfigHashHex(value) {
  return sha256Hex(Buffer.from(stableStringify(value), "utf8"));
}

function parseTemplateConfigFromUrlParam(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null, encoded: null };
  const encoded = String(raw ?? "").trim();
  if (!encoded) return { ok: true, value: null, encoded: null };
  if (encoded.length > 16_000) return { ok: false, error: "templateConfig too long" };
  let decoded = "";
  try {
    decoded = decodeBase64UrlUtf8(encoded);
  } catch {
    return { ok: false, error: "templateConfig is not valid base64url" };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "templateConfig is not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "templateConfig must be a JSON object" };
  return { ok: true, value: parsed, encoded };
}

function parseUploadRunMetadataFromUrl(url) {
  const vendorIdRaw = url.searchParams.get("vendorId");
  const vendorNameRaw = url.searchParams.get("vendorName");
  const contractIdRaw = url.searchParams.get("contractId");
  const templateIdRaw = url.searchParams.get("templateId");
  const runIdRaw = url.searchParams.get("runId");
  const templateConfigRaw = url.searchParams.get("templateConfig");

  let vendorId = null;
  if (vendorIdRaw !== null) {
    const v = assertSafeId(vendorIdRaw, { name: "vendorId", maxLen: 64 });
    if (!v.ok) return { ok: false, error: v.error };
    vendorId = v.value;
  }
  let contractId = null;
  if (contractIdRaw !== null) {
    const v = assertSafeId(contractIdRaw, { name: "contractId", maxLen: 128 });
    if (!v.ok) return { ok: false, error: v.error };
    contractId = v.value;
  }

  let vendorName = null;
  if (vendorNameRaw !== null) {
    const v = String(vendorNameRaw ?? "").trim();
    if (v.length > 200) return { ok: false, error: "vendorName too long" };
    if (v.includes("\n") || v.includes("\r")) return { ok: false, error: "vendorName must not contain newlines" };
    vendorName = v || null;
  }

  let templateId = null;
  if (templateIdRaw !== null) {
    const v = assertSafeId(templateIdRaw, { name: "templateId", maxLen: 128 });
    if (!v.ok) return { ok: false, error: v.error };
    templateId = v.value;
  }

  let runId = null;
  if (runIdRaw !== null) {
    const v = assertSafeId(runIdRaw, { name: "runId", maxLen: 128 });
    if (!v.ok) return { ok: false, error: v.error };
    runId = v.value;
  }

  const templateConfigParsed = parseTemplateConfigFromUrlParam(templateConfigRaw);
  if (!templateConfigParsed.ok) return { ok: false, error: templateConfigParsed.error };

  return { ok: true, vendorId, vendorName, contractId, templateId, runId, templateConfig: templateConfigParsed.value, templateConfigEncoded: templateConfigParsed.encoded };
}

function applyHostedPolicyChecksToCliOut({ cliOut, policyEffective, policySource, verifyResult, receiptJson }) {
  if (!cliOut || typeof cliOut !== "object" || Array.isArray(cliOut)) return cliOut;
  if (!cliOut.verificationOk) return cliOut;
  const eff = policyEffective && typeof policyEffective === "object" ? policyEffective : {};

  const errors = Array.isArray(cliOut.errors) ? [...cliOut.errors] : [];
  const hasCode = (code) => errors.some((e) => e && typeof e === "object" && String(e.code ?? "") === String(code));

  if (eff.requireProducerReceiptPresent && !receiptJson) {
    const code = "missing verify/verification_report.json";
    if (!hasCode(code)) {
      errors.push({
        code,
        path: "verify/verification_report.json",
        message: "producer receipt required by hosted policy",
        detail: { policySource: policySource ?? null }
      });
    }
  }

  const requiredSignerKeyIds = Array.isArray(eff.requiredSignerKeyIds) ? eff.requiredSignerKeyIds : [];
  if (requiredSignerKeyIds.length) {
    const pricingMatrixSigners = Array.isArray(verifyResult?.pricingMatrixSignatures?.signerKeyIds)
      ? verifyResult.pricingMatrixSignatures.signerKeyIds.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const uniquePricingSigners = [...new Set(pricingMatrixSigners)].sort(cmpString);
    if (uniquePricingSigners.length === 0) {
      const code = "HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_MISSING";
      if (!hasCode(code)) {
        errors.push({
          code,
          path: "pricing/pricing_matrix_signatures.json",
          message: "pricing matrix signerKeyId required by hosted policy",
          detail: { requiredKeyIds: requiredSignerKeyIds, policySource: policySource ?? null, present: Boolean(verifyResult?.pricingMatrixSignatures?.present) }
        });
      }
    } else if (!uniquePricingSigners.some((kid) => requiredSignerKeyIds.includes(kid))) {
      const code = "HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_NOT_ALLOWED";
      if (!hasCode(code)) {
        errors.push({
          code,
          path: "pricing/pricing_matrix_signatures.json",
          message: "pricing matrix signerKeyId not allowed by hosted policy",
          detail: { signerKeyIds: uniquePricingSigners, requiredKeyIds: requiredSignerKeyIds, policySource: policySource ?? null, present: Boolean(verifyResult?.pricingMatrixSignatures?.present) }
        });
      }
    }
  }

  if (errors.length === (Array.isArray(cliOut.errors) ? cliOut.errors.length : 0)) return cliOut;
  errors.sort((a, b) => cmpString(a.path ?? "", b.path ?? "") || cmpString(a.code ?? "", b.code ?? ""));
  cliOut.errors = errors;
  cliOut.ok = errors.length === 0 && Boolean(cliOut.verificationOk);
  return cliOut;
}

function indexPath({ tenantId, zipSha256 }) {
  return path.join(dataDir, "index", tenantId, `${zipSha256}.json`);
}

async function loadIndex({ tenantId, zipSha256 }) {
  const fp = indexPath({ tenantId, zipSha256 });
  try {
    return JSON.parse(await fs.readFile(fp, "utf8"));
  } catch {
    return null;
  }
}

async function writeIndex({ tenantId, zipSha256, token }) {
  const fp = indexPath({ tenantId, zipSha256 });
  await ensureDir(fp);
  await fs.writeFile(fp, JSON.stringify({ schemaVersion: "MagicLinkIndex.v1", tenantId, zipSha256, token }, null, 2) + "\n", "utf8");
}

async function notifyBuyersForRunBestEffort({ tenantId, token, runId = null, tenantSettings, publicSummary, cliOut }) {
  const base = publicBaseUrl ? String(publicBaseUrl).replace(/\/+$/, "") : "";
  const magicLinkUrl = base ? `${base}/r/${token}` : `/r/${token}`;
  try {
    const sent = await sendBuyerVerificationNotifications({
      dataDir,
      tenantId,
      token,
      runId,
      tenantSettings,
      publicSummary,
      cliOut,
      magicLinkUrl,
      smtpConfig,
      settingsKey,
      timeoutMs: webhookTimeoutMs
    });
    if (Array.isArray(sent?.results)) {
      for (const row of sent.results) {
        metrics.incCounter("buyer_notification_deliveries_total", { tenantId, ok: row?.ok ? "true" : "false", mode: row?.mode ? String(row.mode) : "unknown" }, 1);
      }
    }
    if (sent && sent.ok === false) {
      try {
        await appendAuditRecord({
          dataDir,
          tenantId,
          record: {
            at: nowIso(),
            action: "BUYER_NOTIFICATION_FAILED",
            actor: { method: "system", email: null, role: null },
            targetType: "artifact",
            targetId: token,
            details: {
              deliveryMode: sent.deliveryMode ?? null,
              failures: Array.isArray(sent.results) ? sent.results.filter((x) => !x?.ok).slice(0, 10) : []
            }
          }
        });
      } catch {
        // ignore
      }
    }
    return sent;
  } catch (err) {
    try {
      await appendAuditRecord({
        dataDir,
        tenantId,
        record: {
          at: nowIso(),
          action: "BUYER_NOTIFICATION_FAILED",
          actor: { method: "system", email: null, role: null },
          targetType: "artifact",
          targetId: token,
          details: { error: err?.message ?? String(err ?? "unknown") }
        }
      });
    } catch {
      // ignore
    }
    return { ok: false, error: err?.message ?? String(err ?? "unknown") };
  }
}

async function handleUploadToTenant(req, res, { url, tenantId, vendorMeta, authMethod, vendorMetaLocked = false } = {}) {
  if (!url) url = new URL(req.url ?? "/v1/upload", "http://localhost");
  if (!tenantId || typeof tenantId !== "string") return sendJson(res, 400, { ok: false, code: "INVALID_TENANT", message: "tenantId is required" });

  const vendorIdRequested = vendorMeta && typeof vendorMeta.vendorId === "string" ? vendorMeta.vendorId : null;
  const vendorNameRequested = vendorMeta && typeof vendorMeta.vendorName === "string" ? vendorMeta.vendorName : null;
  const contractIdRequested = vendorMeta && typeof vendorMeta.contractId === "string" ? vendorMeta.contractId : null;
  const templateIdRequested = vendorMeta && typeof vendorMeta.templateId === "string" ? vendorMeta.templateId : null;
  const runIdRequested = vendorMeta && typeof vendorMeta.runId === "string" ? vendorMeta.runId : null;
  const templateConfigRequested = vendorMeta && isPlainObject(vendorMeta.templateConfig) ? vendorMeta.templateConfig : null;
  const templateConfigEncodedRequested = vendorMeta && typeof vendorMeta.templateConfigEncoded === "string" ? vendorMeta.templateConfigEncoded : null;
  const templateConfigHashRequested = templateConfigRequested ? templateConfigHashHex(templateConfigRequested) : null;

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const tenantEntitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const maxUploadBytesEffective =
    Number.isInteger(tenantSettings?.maxUploadBytesOverride) && tenantSettings.maxUploadBytesOverride > 0 ? tenantSettings.maxUploadBytesOverride : maxUploadBytes;
  const artifactStorage = isPlainObject(tenantSettings?.artifactStorage) ? tenantSettings.artifactStorage : null;
  const storeBundleZip = !(artifactStorage && artifactStorage.storeBundleZip === false);
  const storePdf = !(artifactStorage && artifactStorage.storePdf === false);
  const mode = parseMode(req, url);
  if (!mode.ok) return sendJson(res, 400, { ok: false, code: "INVALID_MODE", message: mode.error });
  const modeRequestedRaw = mode.mode ?? (typeof tenantSettings?.defaultMode === "string" ? tenantSettings.defaultMode : "auto");
  const modeRequested = modeRequestedRaw === "auto" || modeRequestedRaw === "strict" || modeRequestedRaw === "compat" ? modeRequestedRaw : "auto";

  const policySel = resolvePolicyForRun({ tenantSettings, vendorId: vendorIdRequested, contractId: contractIdRequested });
  const policyEffective = normalizePolicyProfileForEnforcement(policySel.policy);
  const modeRequiredByPolicy = policyEffective.requiredMode;
  const modeForVerification = modeRequiredByPolicy ?? modeRequested;
  const failOnWarnings = Boolean(policyEffective.failOnWarnings);
  const policySetHash = policyHashHex(policyEffective);

  const trustInfo = governanceTrustInfo({ tenantSettings, envValue: process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON ?? "" });
  const pricingTrustInfo = pricingSignerTrustInfo({ tenantSettings, envValue: process.env.SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON ?? "" });
  const strictResolved = modeForVerification === "strict" ? true : modeForVerification === "compat" ? false : Boolean(trustInfo?.configured);
  const modeResolved = strictResolved ? "strict" : "compat";
  const trustSetHash = typeof trustInfo?.setHash === "string" ? trustInfo.setHash : null;
  const pricingTrustSetHash = typeof pricingTrustInfo?.setHash === "string" ? pricingTrustInfo.setHash : null;

  const contentLengthHeader = req.headers["content-length"] ? String(req.headers["content-length"]) : "";
  if (!contentLengthHeader.trim()) return sendJson(res, 411, { ok: false, code: "LENGTH_REQUIRED", message: "Content-Length is required" });
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isInteger(contentLength) || contentLength < 0) return sendJson(res, 400, { ok: false, code: "INVALID_CONTENT_LENGTH", message: "invalid Content-Length" });
  if (contentLength > maxUploadBytesEffective) return sendJson(res, 413, { ok: false, code: "UPLOAD_TOO_LARGE", message: "upload too large" });

  const limits = tenantRateLimits(tenantSettings);
  const rl = applyRateLimit({ req, tenantId, tenantSettings, category: "upload", limitPerHour: limits.uploadsPerHour });
  if (!rl.ok) {
    metrics.incCounter("quota_rejects_total", { tenantId, reason: "rate_limit" }, 1);
    metrics.incCounter("rate_limit_events_total", { tenantId, category: "upload", scope: rl.scope ?? "tenant" }, 1);
    res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
    return sendJson(res, 429, {
      ok: false,
      code: "RATE_LIMITED",
      message: "rate limit exceeded",
      retryAfterSeconds: rl.retryAfterSeconds ?? null,
      scope: rl.scope ?? null
    });
  }

  let body;
  try {
    const uploadId = crypto.randomBytes(16).toString("hex");
    const incomingZipPath = path.join(dataDir, "zips", "tmp", `upload_${uploadId}.zip`);
    body = { incomingZipPath, streamed: await streamBodyToFileAndHash(req, { outPath: incomingZipPath, maxBytes: maxUploadBytesEffective }) };
  } catch (err) {
    return sendJson(res, err?.code === "BODY_TOO_LARGE" ? 413 : 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || !body.streamed || body.streamed.bytes === 0) {
    try {
      if (body?.incomingZipPath) await fs.rm(body.incomingZipPath, { force: true });
    } catch {
      // ignore
    }
    return sendJson(res, 400, { ok: false, code: "EMPTY_BODY", message: "zip body is required" });
  }

  const zipSha256 = body.streamed.sha256;
  const zipBytes = body.streamed.bytes;
  const incomingZipPath = body.incomingZipPath;
  const cleanupIncomingZipBestEffort = async () => {
    try {
      await fs.rm(incomingZipPath, { force: true });
    } catch {
      // ignore
    }
  };

  const existing = await loadIndex({ tenantId, zipSha256 });
  const existingToken = existing && typeof existing.token === "string" && /^ml_[0-9a-f]{48}$/.test(existing.token) ? existing.token : null;

  let token = null;
  let createdAt = null;
  let rerun = false;

  if (existingToken) {
    try {
      const meta = await loadMeta(existingToken);
      const metaTrustSetHash = typeof meta?.trustSetHash === "string" ? meta.trustSetHash : null;
      const metaPricingTrustSetHash = typeof meta?.pricingTrustSetHash === "string" ? meta.pricingTrustSetHash : null;
      const metaPolicySetHash = typeof meta?.policySetHash === "string" ? meta.policySetHash : null;
      const configMatches =
        String(meta?.modeResolved ?? "") === modeResolved &&
        metaTrustSetHash === trustSetHash &&
        metaPricingTrustSetHash === pricingTrustSetHash &&
        metaPolicySetHash === policySetHash;

      if (vendorIdRequested && meta?.vendorId && String(meta.vendorId) !== vendorIdRequested) {
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 409, { ok: false, code: "VENDOR_MISMATCH", message: "bundle already associated with a different vendorId", detail: { existingVendorId: meta.vendorId } });
      }
      if (vendorMetaLocked && !vendorIdRequested && meta?.vendorId) {
        // Ingest-key uploads always stamp vendorId from the key; absence here is a bug in caller.
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 500, { ok: false, code: "INTERNAL", message: "vendorId missing for locked vendor upload" });
      }
      if (contractIdRequested && meta?.contractId && String(meta.contractId) !== contractIdRequested) {
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 409, { ok: false, code: "CONTRACT_MISMATCH", message: "bundle already associated with a different contractId", detail: { existingContractId: meta.contractId } });
      }
      if (templateIdRequested && meta?.templateId && String(meta.templateId) !== templateIdRequested) {
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 409, { ok: false, code: "TEMPLATE_MISMATCH", message: "bundle already associated with a different templateId", detail: { existingTemplateId: meta.templateId } });
      }
      if (templateConfigHashRequested && meta?.templateConfigHash && String(meta.templateConfigHash) !== templateConfigHashRequested) {
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 409, {
          ok: false,
          code: "TEMPLATE_CONFIG_MISMATCH",
          message: "bundle already associated with a different templateConfig",
          detail: { existingTemplateConfigHash: meta.templateConfigHash }
        });
      }
      if (runIdRequested && meta?.runId && String(meta.runId) !== runIdRequested) {
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 409, { ok: false, code: "RUN_MISMATCH", message: "bundle already associated with a different runId", detail: { existingRunId: meta.runId } });
      }

      const retentionDaysForExisting = effectiveRetentionDaysForRun({
        tenantSettings,
        vendorId: typeof meta?.vendorId === "string" ? meta.vendorId : vendorIdRequested,
        contractId: typeof meta?.contractId === "string" ? meta.contractId : contractIdRequested
      });

      if (!meta?.revokedAt && !isPastRetention(meta?.createdAt, retentionDaysForExisting) && configMatches && !isExpired(meta?.createdAt)) {
        // Best-effort metadata enrichment (does not rerun verification).
        try {
          const metaPath = path.join(dataDir, "meta", `${existingToken}.json`);
          const next = { ...meta };
          let changed = false;
          if (vendorIdRequested && !next.vendorId) {
            next.vendorId = vendorIdRequested;
            changed = true;
          }
          if (contractIdRequested && !next.contractId) {
            next.contractId = contractIdRequested;
            changed = true;
          }
          if (vendorNameRequested && String(next.vendorName ?? "") !== vendorNameRequested) {
            next.vendorName = vendorNameRequested;
            changed = true;
          }
          if (templateIdRequested && !next.templateId) {
            next.templateId = templateIdRequested;
            changed = true;
          }
          if (runIdRequested && !next.runId) {
            next.runId = runIdRequested;
            changed = true;
          }
          if (templateConfigRequested && !next.templateConfigHash) {
            next.templateConfig = templateConfigRequested;
            next.templateConfigHash = templateConfigHashRequested;
            next.templateConfigEncoded = templateConfigEncodedRequested;
            changed = true;
          }
          if (changed) {
            await fs.writeFile(metaPath, JSON.stringify(next, null, 2) + "\n", "utf8");
            const pubPath = typeof next.publicJsonPath === "string" ? next.publicJsonPath : path.join(dataDir, "public", `${existingToken}.json`);
            try {
              const pub = JSON.parse(await fs.readFile(pubPath, "utf8"));
              if (pub && typeof pub === "object" && !Array.isArray(pub)) {
                pub.vendorId = pub.vendorId ?? vendorIdRequested ?? null;
                pub.vendorName = vendorNameRequested ?? pub.vendorName ?? null;
                pub.contractId = pub.contractId ?? contractIdRequested ?? null;
                pub.templateId = pub.templateId ?? templateIdRequested ?? null;
                pub.runId = pub.runId ?? runIdRequested ?? null;
                pub.templateConfigHash = pub.templateConfigHash ?? templateConfigHashRequested ?? null;
                await fs.writeFile(pubPath, JSON.stringify(pub, null, 2) + "\n", "utf8");
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
        metrics.incCounter(
          "uploads_total",
          { tenantId, mode: modeResolved, kind: meta?.closePackDir ? "close-pack" : "unknown", deduped: "true" },
          1
        );
        await cleanupIncomingZipBestEffort();
        return sendJson(res, 200, { ok: true, token: existingToken, url: `/r/${existingToken}`, verifyOk: Boolean(meta.verifyOk), modeResolved, deduped: true, zipSha256, zipBytes });
      }

      if (!meta?.revokedAt && !isPastRetention(meta?.createdAt, retentionDaysForExisting) && !isExpired(meta?.createdAt)) {
        token = existingToken;
        createdAt = String(meta.createdAt);
        rerun = true;
      }
    } catch {
      // Ignore broken index entries; we will overwrite.
    }
  }

  if (!token) {
    token = randomToken();
    createdAt = nowIso();
  }
  const startedAt = nowIso();

  // Quotas are enforced for new verification runs (not for pure idempotent returns).
  const monthKey = monthKeyUtcNow();
  const usage = await loadUsageSummary({ dataDir, tenantId, monthKey });
  const maxPerMonth = Number.isInteger(tenantEntitlements?.limits?.maxVerificationsPerMonth) ? tenantEntitlements.limits.maxVerificationsPerMonth : null;
  if (maxPerMonth !== null && usage.verificationRuns >= maxPerMonth) {
    await cleanupIncomingZipBestEffort();
    metrics.incCounter("quota_rejects_total", { tenantId, reason: "max_verifications_per_month" }, 1);
    return sendJson(res, 429, {
      ok: false,
      code: "QUOTA_EXCEEDED",
      message: "maxVerificationsPerMonth exceeded",
      detail: { tenantId, month: monthKey, limit: maxPerMonth, used: usage.verificationRuns }
    });
  }

  const maxStoredBundles = Number.isInteger(tenantEntitlements?.limits?.maxStoredBundles) ? tenantEntitlements.limits.maxStoredBundles : null;
  await garbageCollectTenantByRetention({ dataDir, tenantId, tenantSettings });
  if (!existingToken && maxStoredBundles !== null) {
    try {
      const idxDir = path.join(dataDir, "index", tenantId);
      const count = (await fs.readdir(idxDir)).filter((n) => n.endsWith(".json")).length;
      if (count >= maxStoredBundles) {
        await cleanupIncomingZipBestEffort();
        metrics.incCounter("quota_rejects_total", { tenantId, reason: "max_stored_bundles" }, 1);
        return sendJson(res, 429, {
          ok: false,
          code: "QUOTA_EXCEEDED",
          message: "maxStoredBundles exceeded",
          detail: { tenantId, limit: maxStoredBundles, used: count }
        });
      }
    } catch {
      // ignore
    }
  }

  const slot = tryAcquireVerificationSlot(tenantId);
  if (!slot.ok) {
    await cleanupIncomingZipBestEffort();
    metrics.incCounter("quota_rejects_total", { tenantId, reason: slot.scope === "tenant" ? "concurrency_tenant" : "concurrency_global" }, 1);
    return sendJson(res, 429, { ok: false, code: "TOO_MANY_IN_FLIGHT", message: "too many concurrent verifications", scope: slot.scope });
  }

  let unzipDir = null;
  let zipPathForRun = null;
  try {
    const zipPath = path.join(dataDir, "zips", `${token}.zip`);
    const outJsonPath = path.join(dataDir, "verify", `${token}.json`);
    const metaPath = path.join(dataDir, "meta", `${token}.json`);
    const publicJsonPath = path.join(dataDir, "public", `${token}.json`);
    const receiptJsonPath = path.join(dataDir, "receipt", `${token}.json`);
    const summaryPdfPath = path.join(dataDir, "pdf", `${token}.pdf`);

    await ensureDir(zipPath);
    await ensureDir(outJsonPath);
    await ensureDir(metaPath);
    await ensureDir(publicJsonPath);
    await ensureDir(receiptJsonPath);
    if (storePdf) await ensureDir(summaryPdfPath);
    await moveFileReplace(incomingZipPath, zipPath);
    zipPathForRun = zipPath;

    // Hostile zip handling: safe unzip with tight budgets for hosted ingestion.
    const unzip = await unzipToTempSafe({
      zipPath,
      budgets: {
        maxEntries: 20_000,
        maxPathBytes: 512,
        maxFileBytes: 50 * 1024 * 1024,
        maxTotalBytes: 200 * 1024 * 1024,
        maxCompressionRatio: 200
      }
    });
    if (!unzip.ok) {
      metrics.incCounter("unzip_rejects_total", { tenantId, code: String(unzip.error ?? "UNKNOWN") }, 1);
      const toolVersion = await readToolVersionBestEffort();
      const toolCommit = readToolCommitBestEffort();
      let fail = formatVerifyCliOutput({
        input: zipPath,
        resolved: zipPath,
        dir: "<unzip-failed>",
        strict: strictResolved,
        failOnWarnings,
        result: { ok: false, error: unzip.error, detail: unzip.detail, warnings: [] },
        toolVersion,
        toolCommit,
        hosted: {
          token,
          modeRequested,
          modeRequiredByPolicy: modeRequiredByPolicy ?? null,
          modeForVerification,
          modeResolved,
          tenantId,
          createdAt,
          zipSha256,
          zipBytes,
          trust: trustInfo,
          vendorId: vendorIdRequested,
          vendorName: vendorNameRequested,
          contractId: contractIdRequested,
          templateId: templateIdRequested,
          runId: runIdRequested,
          templateConfigHash: templateConfigHashRequested,
          authMethod: authMethod ?? null,
          policySource: policySel.source ?? null,
          policySetHash
        }
      });
      fail = applyHostedPolicyChecksToCliOut({ cliOut: fail, policyEffective, policySource: policySel.source, verifyResult: null, receiptJson: null });
      await fs.writeFile(outJsonPath, JSON.stringify(fail, null, 2) + "\n", "utf8");
      const publicSummary = {
        schemaVersion: "MagicLinkPublicSummary.v1",
        token,
        tenantId,
        vendorId: vendorIdRequested,
        vendorName: vendorNameRequested,
        contractId: contractIdRequested,
        templateId: templateIdRequested,
        runId: runIdRequested,
        templateConfigHash: templateConfigHashRequested,
        zipSha256,
        zipBytes,
        createdAt,
        modeRequested,
        modeRequiredByPolicy: modeRequiredByPolicy ?? null,
        modeForVerification,
        modeResolved,
        failOnWarnings,
        policySource: policySel.source ?? null,
        policySetHash,
        bundle: { manifestHash: null, headAttestationHash: null },
        verification: {
          ok: Boolean(fail.ok),
          verificationOk: Boolean(fail.verificationOk),
          errorCodes: Array.isArray(fail.errors) ? fail.errors.map((e) => e.code) : [],
          warningCodes: Array.isArray(fail.warnings) ? fail.warnings.map((w) => w.code) : []
        },
        pricingMatrixSignatures: null,
        invoiceClaim: null,
        metering: null,
        receiptPresent: false
      };
      await fs.writeFile(publicJsonPath, JSON.stringify(publicSummary, null, 2) + "\n", "utf8");
      const finishedAt = nowIso();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
      recordVerifyDurationMs(durationMs);
      const meta = {
        schemaVersion: "MagicLinkMeta.v1",
        token,
        tenantId,
        vendorId: vendorIdRequested,
        vendorName: vendorNameRequested,
        contractId: contractIdRequested,
        templateId: templateIdRequested,
        runId: runIdRequested,
        templateConfig: templateConfigRequested,
        templateConfigHash: templateConfigHashRequested,
        templateConfigEncoded: templateConfigEncodedRequested,
        createdAt,
        startedAt,
        finishedAt,
        durationMs,
        modeRequested,
        modeRequiredByPolicy: modeRequiredByPolicy ?? null,
        modeForVerification,
        modeResolved,
        strict: strictResolved,
        failOnWarnings,
        policySource: policySel.source ?? null,
        policySetHash,
        trustSetHash,
        pricingTrustSetHash,
        zipPath: storeBundleZip ? zipPath : null,
        zipSha256,
        zipBytes,
        verifyOk: Boolean(fail.verificationOk),
        verifyJsonPath: outJsonPath,
        publicJsonPath,
        receiptJsonPath: null,
        summaryPdfPath: null,
        revokedAt: null,
        revokedReason: null
      };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
      await writeIndex({ tenantId, zipSha256, token });
      const retentionDaysEffective = effectiveRetentionDaysForRun({ tenantSettings, vendorId: vendorIdRequested, contractId: contractIdRequested });
      await writeRunRecordV1({ dataDir, tenantId, token, meta, publicSummary, cliOut: fail, retentionDaysEffective });

      const usageRecord = {
        schemaVersion: "MagicLinkUsageRecord.v1",
        tenantId,
        token,
        zipSha256,
        zipBytes,
        modeRequested,
        modeResolved,
        strict: strictResolved,
        startedAt,
        finishedAt,
        durationMs,
        templateId: templateIdRequested,
        ok: Boolean(fail.ok),
        verificationOk: Boolean(fail.verificationOk),
        errorsCount: Array.isArray(fail.errors) ? fail.errors.length : 0,
        warningsCount: Array.isArray(fail.warnings) ? fail.warnings.length : 0
      };
      const usageSummary = await appendUsageRecord({ dataDir, tenantId, monthKey, record: usageRecord });
      await emitBillingUsageThresholdAlertsBestEffort({
        tenantId,
        monthKey,
        usageSummary,
        entitlements: resolveTenantEntitlementsFromSettings(tenantSettings)
      });

      const event = Boolean(fail.verificationOk) ? "verification.completed" : "verification.failed";
      const payload = buildWebhookPayload({ event, tenantId, token, zipSha256, zipBytes, modeResolved, modeRequested, cliOut: fail, publicBaseUrl });
      const webhooksForTenant = Array.isArray(tenantSettings?.webhooks) ? tenantSettings.webhooks : [];
      const webhookResults = await deliverTenantWebhooks({
        dataDir,
        tenantId,
        token,
        event,
        payload,
        webhooks: webhooksForTenant,
        settingsKey,
        deliveryMode: webhookDeliveryMode,
        timeoutMs: webhookTimeoutMs,
        maxAttempts: webhookMaxAttempts,
        retryBackoffMs: webhookRetryBackoffMs
      });
      for (const r of webhookResults) {
        const ok = Boolean(r && r.ok);
        metrics.incCounter("webhook_deliveries_total", { tenantId, event, ok: ok ? "true" : "false" }, 1);
      }
      await enqueueWebhookRetriesBestEffort({
        tenantId,
        token,
        event,
        payload,
        webhooks: webhooksForTenant,
        deliveryResults: webhookResults
      });
      const buyerNotifications = await notifyBuyersForRunBestEffort({ tenantId, token, runId: runIdRequested, tenantSettings, publicSummary, cliOut: fail });
      const onboardingProgress = await markTenantOnboardingProgress({
        dataDir,
        tenantId,
        isSample: authMethod === "onboarding-sample",
        verificationOk: Boolean(fail.verificationOk),
        at: finishedAt
      });
      await dispatchOnboardingEmailSequenceBestEffort({
        dataDir,
        tenantId,
        profile: onboardingProgress?.profile ?? null,
        enabled: onboardingEmailSequenceEnabled,
        deliveryMode: onboardingEmailSequenceDeliveryMode,
        smtpConfig,
        publicBaseUrl
      });
      const autoDecision = await runAutoDecisionBestEffort({
        token,
        tenantId,
        tenantSettings,
        cliOut: fail,
        templateId: templateIdRequested
      });

      metrics.incCounter("uploads_total", { tenantId, mode: modeResolved, kind: "unknown" }, 1);
      metrics.incCounter("verifications_total", { tenantId, mode: modeResolved, kind: "unknown", outcome: "error" }, 1);

      if (!storeBundleZip) {
        try {
          await fs.rm(zipPath, { force: true });
        } catch {
          // ignore
        }
      }
      return sendJson(res, 200, {
        ok: true,
        token,
        url: `/r/${token}`,
        verifyOk: false,
        modeResolved,
        deduped: false,
        rerun,
        zipSha256,
        zipBytes,
        buyerNotifications: { ok: Boolean(buyerNotifications?.ok), skipped: Boolean(buyerNotifications?.skipped) },
        autoDecision: summarizeAutoDecisionResult(autoDecision)
      });
    }
    unzipDir = unzip.dir;

    const toolVersion = await readToolVersionBestEffort();
    const toolCommit = readToolCommitBestEffort();
    const trustedPricingSignerKeyIdsJson = Array.isArray(tenantSettings?.trustedPricingSignerKeyIds) ? JSON.stringify(tenantSettings.trustedPricingSignerKeyIds) : "";
    const workerEnv = {
      ...process.env,
      SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON: String(trustInfo?.json ?? ""),
      SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON: String(pricingTrustInfo?.json ?? ""),
      SETTLD_TRUSTED_PRICING_SIGNER_KEY_IDS_JSON: trustedPricingSignerKeyIdsJson
    };
    const verifyRun = await verifyQueue.submit({ dir: unzip.dir, strict: strictResolved, hashConcurrency: 16, timeoutMs: verifyTimeoutMs, env: workerEnv });
    const result = verifyRun.ok ? verifyRun.result : { ok: false, error: verifyRun.error, detail: verifyRun.detail, warnings: [] };
    const bundleHeader = await readJsonIfExists(path.join(unzip.dir, "settld.json"));
    const bundleType = typeof bundleHeader?.type === "string" ? bundleHeader.type : null;
    let cliOut = formatVerifyCliOutput({
      input: zipPath,
      resolved: zipPath,
      dir: unzip.dir,
      strict: strictResolved,
      failOnWarnings,
      result,
      toolVersion,
      toolCommit,
        hosted: {
          token,
          bundleType,
        modeRequested,
        modeRequiredByPolicy: modeRequiredByPolicy ?? null,
        modeForVerification,
        modeResolved,
        tenantId,
        createdAt,
        zipSha256,
        zipBytes,
        trust: trustInfo,
          vendorId: vendorIdRequested,
          vendorName: vendorNameRequested,
          contractId: contractIdRequested,
          templateId: templateIdRequested,
          runId: runIdRequested,
          templateConfigHash: templateConfigHashRequested,
          authMethod: authMethod ?? null,
          policySource: policySel.source ?? null,
          policySetHash
        }
      });

    const invoiceRoot = invoiceRootDirForBundleType({ bundleDir: unzip.dir, bundleType });
    const claimJson = await readJsonIfExists(path.join(invoiceRoot, "invoice", "invoice_claim.json"));
    const meteringJson = await readJsonIfExists(path.join(invoiceRoot, "metering", "metering_report.json"));
    const receiptJson = await readJsonIfExists(path.join(unzip.dir, "verify", "verification_report.json"));
    cliOut = applyHostedPolicyChecksToCliOut({ cliOut, policyEffective, policySource: policySel.source, verifyResult: result, receiptJson });

    const pricingSigJson = await readJsonIfExists(path.join(invoiceRoot, "pricing", "pricing_matrix_signatures.json"));
    const pricingMatrixSignatures =
      result && typeof result === "object" && !Array.isArray(result) && result.pricingMatrixSignatures && typeof result.pricingMatrixSignatures === "object" && !Array.isArray(result.pricingMatrixSignatures)
        ? {
            present: Boolean(result.pricingMatrixSignatures.present),
            pricingMatrixHash: typeof result.pricingMatrixSignatures.pricingMatrixHash === "string" ? result.pricingMatrixSignatures.pricingMatrixHash : null,
            signerKeyIds: Array.isArray(result.pricingMatrixSignatures.signerKeyIds) ? result.pricingMatrixSignatures.signerKeyIds.map((x) => String(x ?? "").trim()).filter(Boolean).sort(cmpString) : []
          }
        : pricingSigJson && typeof pricingSigJson === "object" && !Array.isArray(pricingSigJson)
          ? {
              present: true,
              pricingMatrixHash:
                typeof pricingSigJson.pricingMatrixCanonicalHash === "string"
                  ? pricingSigJson.pricingMatrixCanonicalHash
                  : typeof pricingSigJson.pricingMatrixHash === "string"
                    ? pricingSigJson.pricingMatrixHash
                    : null,
              signerKeyIds: Array.isArray(pricingSigJson.signatures)
                ? pricingSigJson.signatures
                    .map((s) => (s && typeof s === "object" && !Array.isArray(s) && typeof s.signerKeyId === "string" ? s.signerKeyId.trim() : null))
                    .filter(Boolean)
                    .sort(cmpString)
                : []
            }
          : null;

    const closePackSummaryV1 =
      bundleType === "ClosePack.v1" && result && typeof result === "object" && !Array.isArray(result) && result.closepackSummaryV1 && typeof result.closepackSummaryV1 === "object" && !Array.isArray(result.closepackSummaryV1)
        ? result.closepackSummaryV1
        : null;

    const bundleManifestHash =
      result && typeof result === "object" && !Array.isArray(result) && typeof result.manifestHash === "string" && result.manifestHash
        ? result.manifestHash
        : typeof cliOut?.summary?.manifestHash === "string" && cliOut.summary.manifestHash
          ? cliOut.summary.manifestHash
          : null;
    const bundleHeadAttestationHash =
      result && typeof result === "object" && !Array.isArray(result) && result.headAttestation && typeof result.headAttestation === "object" && !Array.isArray(result.headAttestation) && typeof result.headAttestation.attestationHash === "string"
        ? result.headAttestation.attestationHash
        : null;

    const publicSummary = {
      schemaVersion: "MagicLinkPublicSummary.v1",
      token,
      tenantId,
      vendorId: vendorIdRequested,
      vendorName: vendorNameRequested,
      contractId: contractIdRequested,
      templateId: templateIdRequested,
      runId: runIdRequested,
      templateConfigHash: templateConfigHashRequested,
      zipSha256,
      zipBytes,
      createdAt,
      modeRequested,
      modeRequiredByPolicy: modeRequiredByPolicy ?? null,
      modeForVerification,
      modeResolved,
      failOnWarnings,
      policySource: policySel.source ?? null,
      policySetHash,
      bundle: { manifestHash: bundleManifestHash, headAttestationHash: bundleHeadAttestationHash },
      verification: {
        ok: Boolean(cliOut.ok),
        verificationOk: Boolean(cliOut.verificationOk),
        errorCodes: Array.isArray(cliOut.errors) ? cliOut.errors.map((e) => e.code) : [],
        warningCodes: Array.isArray(cliOut.warnings) ? cliOut.warnings.map((w) => w.code) : []
      },
      pricingMatrixSignatures,
      closePackSummaryV1,
      invoiceClaim: buildPublicInvoiceClaimFromClaimJson(claimJson),
      metering: meteringJson && typeof meteringJson === "object" && !Array.isArray(meteringJson) ? { itemsCount: Array.isArray(meteringJson.items) ? meteringJson.items.length : null, evidenceRefsCount: Array.isArray(meteringJson.evidenceRefs) ? meteringJson.evidenceRefs.length : null } : null,
      receiptPresent: Boolean(receiptJson)
    };

    await fs.writeFile(outJsonPath, JSON.stringify(cliOut, null, 2) + "\n", "utf8");
    await fs.writeFile(publicJsonPath, JSON.stringify(publicSummary, null, 2) + "\n", "utf8");
    if (receiptJson) await fs.writeFile(receiptJsonPath, JSON.stringify(receiptJson, null, 2) + "\n", "utf8");

    let closePackDir = null;
    let closePackSummaryPath = null;
    if (bundleType === "ClosePack.v1" && closePackSummaryV1 && publicSummary.verification.verificationOk) {
      closePackDir = path.join(dataDir, "closepack", token);
      closePackSummaryPath = path.join(closePackDir, "closepack_summary_v1.json");
      await ensureDir(closePackSummaryPath);
      await fs.writeFile(closePackSummaryPath, JSON.stringify(closePackSummaryV1, null, 2) + "\n", "utf8");

      const copyJsonIfPresent = async (srcRel, dstRel) => {
        const j = await readJsonIfExists(path.join(unzip.dir, ...srcRel.split("/")));
        if (j === null || j === undefined) return;
        const dst = path.join(closePackDir, ...dstRel.split("/"));
        await ensureDir(dst);
        await fs.writeFile(dst, JSON.stringify(j, null, 2) + "\n", "utf8");
      };

      // Persist the ClosePack evaluation/index surfaces as separate downloads (without requiring full bundle ZIP download).
      await copyJsonIfPresent("evidence/evidence_index.json", "evidence_index.json");
      await copyJsonIfPresent("sla/sla_definition.json", "sla_definition.json");
      await copyJsonIfPresent("sla/sla_evaluation.json", "sla_evaluation.json");
      await copyJsonIfPresent("acceptance/acceptance_criteria.json", "acceptance_criteria.json");
      await copyJsonIfPresent("acceptance/acceptance_evaluation.json", "acceptance_evaluation.json");
    }
    if (storePdf && publicSummary.invoiceClaim) {
      const status = cliOut.ok ? (publicSummary.verification.warningCodes.length ? "amber" : "green") : "red";
      const pdf = buildInvoiceSummaryPdfFromClaim({
        claim: publicSummary.invoiceClaim,
        verification: { status, zipSha256, manifestHash: cliOut?.summary?.manifestHash ?? null, mode: modeResolved },
        trust: trustInfo
      });
      await fs.writeFile(summaryPdfPath, pdf);
    }
    const finishedAt = nowIso();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    recordVerifyDurationMs(durationMs);
    const meta = {
      schemaVersion: "MagicLinkMeta.v1",
      token,
      tenantId,
      vendorId: vendorIdRequested,
      vendorName: vendorNameRequested,
      contractId: contractIdRequested,
      templateId: templateIdRequested,
      runId: runIdRequested,
      templateConfig: templateConfigRequested,
      templateConfigHash: templateConfigHashRequested,
      templateConfigEncoded: templateConfigEncodedRequested,
      createdAt,
      startedAt,
      finishedAt,
      durationMs,
      modeRequested,
      modeRequiredByPolicy: modeRequiredByPolicy ?? null,
      modeForVerification,
      modeResolved,
      strict: strictResolved,
      failOnWarnings,
      policySource: policySel.source ?? null,
      policySetHash,
      trustSetHash,
      pricingTrustSetHash,
      zipPath,
      zipSha256,
      zipBytes,
      verifyOk: Boolean(cliOut.verificationOk),
      verifyJsonPath: outJsonPath,
      publicJsonPath,
      receiptJsonPath: receiptJson ? receiptJsonPath : null,
      summaryPdfPath: storePdf && publicSummary.invoiceClaim ? summaryPdfPath : null,
      closePackDir,
      closePackSummaryPath,
      revokedAt: null,
      revokedReason: null
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    await writeIndex({ tenantId, zipSha256, token });
    const retentionDaysEffective = effectiveRetentionDaysForRun({ tenantSettings, vendorId: vendorIdRequested, contractId: contractIdRequested });
    await writeRunRecordV1({ dataDir, tenantId, token, meta, publicSummary, cliOut, retentionDaysEffective });

    const usageRecord = {
      schemaVersion: "MagicLinkUsageRecord.v1",
      tenantId,
      token,
      zipSha256,
      zipBytes,
      modeRequested,
      modeResolved,
      strict: strictResolved,
      startedAt,
      finishedAt,
      durationMs,
      templateId: templateIdRequested,
      ok: Boolean(cliOut.ok),
      verificationOk: Boolean(cliOut.verificationOk),
      errorsCount: Array.isArray(cliOut.errors) ? cliOut.errors.length : 0,
      warningsCount: Array.isArray(cliOut.warnings) ? cliOut.warnings.length : 0
    };
    const usageSummary = await appendUsageRecord({ dataDir, tenantId, monthKey, record: usageRecord });
    await emitBillingUsageThresholdAlertsBestEffort({
      tenantId,
      monthKey,
      usageSummary,
      entitlements: resolveTenantEntitlementsFromSettings(tenantSettings)
    });

    const event = Boolean(cliOut.verificationOk) ? "verification.completed" : "verification.failed";
    const payload = buildWebhookPayload({ event, tenantId, token, zipSha256, zipBytes, modeResolved, modeRequested, cliOut, publicBaseUrl });
    const webhooksForTenant = Array.isArray(tenantSettings?.webhooks) ? tenantSettings.webhooks : [];
    const webhookResults = await deliverTenantWebhooks({
      dataDir,
      tenantId,
      token,
      event,
      payload,
      webhooks: webhooksForTenant,
      settingsKey,
      deliveryMode: webhookDeliveryMode,
      timeoutMs: webhookTimeoutMs,
      maxAttempts: webhookMaxAttempts,
      retryBackoffMs: webhookRetryBackoffMs
    });
    for (const r of webhookResults) {
      const ok = Boolean(r && r.ok);
      metrics.incCounter("webhook_deliveries_total", { tenantId, event, ok: ok ? "true" : "false" }, 1);
    }
    await enqueueWebhookRetriesBestEffort({
      tenantId,
      token,
      event,
      payload,
      webhooks: webhooksForTenant,
      deliveryResults: webhookResults
    });
    const buyerNotifications = await notifyBuyersForRunBestEffort({ tenantId, token, runId: runIdRequested, tenantSettings, publicSummary, cliOut });
    const onboardingProgress = await markTenantOnboardingProgress({
      dataDir,
      tenantId,
      isSample: authMethod === "onboarding-sample",
      verificationOk: Boolean(cliOut.verificationOk),
      at: finishedAt
    });
    await dispatchOnboardingEmailSequenceBestEffort({
      dataDir,
      tenantId,
      profile: onboardingProgress?.profile ?? null,
      enabled: onboardingEmailSequenceEnabled,
      deliveryMode: onboardingEmailSequenceDeliveryMode,
      smtpConfig,
      publicBaseUrl
    });
    const autoDecision = await runAutoDecisionBestEffort({
      token,
      tenantId,
      tenantSettings,
      cliOut,
      templateId: templateIdRequested
    });

    metrics.incCounter("uploads_total", { tenantId, mode: modeResolved, kind: hostedTargetKindFromBundleType(bundleType) }, 1);
    const warnings = Array.isArray(cliOut?.warnings) ? cliOut.warnings : [];
    const ok = Boolean(cliOut?.ok);
    const outcome = ok && warnings.length === 0 ? "ok" : ok ? "warn" : "error";
    metrics.incCounter("verifications_total", { tenantId, mode: modeResolved, kind: hostedTargetKindFromBundleType(bundleType), outcome }, 1);

    if (!storeBundleZip) {
      try {
        await fs.rm(zipPath, { force: true });
      } catch {
        // ignore
      }
    }
    return sendJson(res, 200, {
      ok: true,
      token,
      url: `/r/${token}`,
      verifyOk: Boolean(cliOut.verificationOk),
      modeResolved,
      deduped: false,
      rerun,
      zipSha256,
      zipBytes,
      buyerNotifications: { ok: Boolean(buyerNotifications?.ok), skipped: Boolean(buyerNotifications?.skipped) },
      autoDecision: summarizeAutoDecisionResult(autoDecision)
    });
  } finally {
    await cleanupIncomingZipBestEffort();
    if (unzipDir) await fs.rm(unzipDir, { recursive: true, force: true });
    if (!storeBundleZip && zipPathForRun) {
      try {
        await fs.rm(zipPathForRun, { force: true });
      } catch {
        // ignore
      }
    }
    slot.release();
  }
}

async function handleUpload(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN" });

  const url = new URL(req.url ?? "/v1/upload", "http://localhost");
  const tenant = parseTenantId(req);
  if (!tenant.ok) return sendJson(res, 400, { ok: false, code: "INVALID_TENANT", message: tenant.error });
  const meta = parseUploadRunMetadataFromUrl(url);
  if (!meta.ok) return sendJson(res, 400, { ok: false, code: "INVALID_METADATA", message: meta.error });

  return await handleUploadToTenant(req, res, { url, tenantId: tenant.tenantId, vendorMeta: meta, authMethod: auth.method });
}

async function handleTenantUpload(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const meta = parseUploadRunMetadataFromUrl(url);
  if (!meta.ok) return sendJson(res, 400, { ok: false, code: "INVALID_METADATA", message: meta.error });
  return await handleUploadToTenant(req, res, { url, tenantId, vendorMeta: meta, authMethod: auth.principal?.method ?? "tenant-upload" });
}

async function handleRevoke(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN" });

  let json;
  try {
    json = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const token = typeof json?.token === "string" ? json.token : null;
  if (!token || !/^ml_[0-9a-f]{48}$/.test(token)) return sendJson(res, 400, { ok: false, code: "INVALID_TOKEN", message: "token is required" });
  const reason = typeof json?.reason === "string" && json.reason.trim() ? json.reason.trim() : null;

  const metaPath = path.join(dataDir, "meta", `${token}.json`);
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });
  }
  if (meta.revokedAt) return sendJson(res, 200, { ok: true, token, revokedAt: meta.revokedAt, alreadyRevoked: true });

  meta.revokedAt = nowIso();
  meta.revokedReason = reason;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return sendJson(res, 200, { ok: true, token, revokedAt: meta.revokedAt });
}

async function handleTenantSettingsGet(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const settings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(settings);
  const trust = governanceTrustInfo({ tenantSettings: settings, envValue: process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON ?? "" });
  const safe = sanitizeTenantSettingsForApi(settings);
  const buyerNotificationsLatest = await loadLatestBuyerNotificationStatusBestEffort({ dataDir, tenantId });
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    settings: safe,
    entitlements,
    buyerNotifications: { latest: buyerNotificationsLatest },
    trust: {
      configured: Boolean(trust?.configured),
      keyIds: Array.isArray(trust?.keyIds) ? trust.keyIds : [],
      setHash: typeof trust?.setHash === "string" ? trust.setHash : null,
      source: typeof trust?.source === "string" ? trust.source : null
    }
  });
}

async function handleTenantSettingsPut(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 200_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};

  const current = await loadTenantSettings({ dataDir, tenantId });
  const patched = applyTenantSettingsPatch({ currentSettings: current, patch: json, settingsKey });
  if (!patched.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_SETTINGS", message: patched.error ?? "invalid settings", detail: patched });
  }

  const currentIntegrationsUsed = countConfiguredIntegrations(current);
  const patchedIntegrationsUsed = countConfiguredIntegrations(patched.settings);
  const patchedEntitlements = resolveTenantEntitlementsFromSettings(patched.settings);
  const patchedIntegrationsLimit = normalizeEntitlementLimit(patchedEntitlements?.limits?.maxIntegrations);
  if (patchedIntegrationsLimit !== null && patchedIntegrationsUsed > patchedIntegrationsLimit && patchedIntegrationsUsed > currentIntegrationsUsed) {
    return sendJson(
      res,
      403,
      buildEntitlementLimitExceededResponse({
        tenantId,
        entitlements: patchedEntitlements,
        featureKey: "maxIntegrations",
        limit: patchedIntegrationsLimit,
        used: patchedIntegrationsUsed,
        message: `maxIntegrations limit reached (${patchedIntegrationsUsed}/${patchedIntegrationsLimit}) for plan ${patchedEntitlements.plan}`
      })
    );
  }

  await saveTenantSettings({ dataDir, tenantId, settings: patched.settings, settingsKey });
  try {
    const redacted = isPlainObject(json) ? { ...json } : {};
    if (Array.isArray(redacted.webhooks)) {
      redacted.webhooks = redacted.webhooks.map((w) => (w && typeof w === "object" && !Array.isArray(w) ? { ...w, secret: null } : w));
    }
    if (isPlainObject(redacted.buyerNotifications)) redacted.buyerNotifications = { ...redacted.buyerNotifications, webhookSecret: null };
    if (isPlainObject(redacted.paymentTriggers)) redacted.paymentTriggers = { ...redacted.paymentTriggers, webhookSecret: null };
    if (isPlainObject(redacted.settlementDecisionSigner)) {
      redacted.settlementDecisionSigner = { ...redacted.settlementDecisionSigner, privateKeyPem: null, remoteSignerBearerToken: null };
    }
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: { at: nowIso(), action: "TENANT_SETTINGS_PUT", actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null }, targetType: "tenant_settings", targetId: tenantId, details: { patch: redacted } }
    });
  } catch {
    // ignore
  }
  return await handleTenantSettingsGet(req, res, tenantId);
}

async function handleTenantEntitlementsGet(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const settings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(settings);
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    entitlements
  });
}

async function handleTenantPlanSet(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 10_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object with plan" });

  const current = await loadTenantSettings({ dataDir, tenantId });
  const patched = applyTenantSettingsPatch({ currentSettings: current, patch: { plan: json.plan }, settingsKey });
  if (!patched.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PLAN", message: patched.error ?? "invalid plan", detail: patched });
  }
  await saveTenantSettings({ dataDir, tenantId, settings: patched.settings, settingsKey });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_PLAN_SET",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_settings",
        targetId: tenantId,
        details: { plan: patched.settings.plan }
      }
    });
  } catch {
    // ignore
  }

  const safeSettings = sanitizeTenantSettingsForApi(patched.settings);
  const entitlements = resolveTenantEntitlementsFromSettings(patched.settings);
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    settings: safeSettings,
    entitlements
  });
}

function readStripeObjectPlanHint(obj) {
  if (!isPlainObject(obj)) return null;
  const metadataPlanRaw = typeof obj?.metadata?.plan === "string" ? obj.metadata.plan : "";
  try {
    if (metadataPlanRaw) return normalizeTenantPlan(metadataPlanRaw, { allowNull: false });
  } catch {
    // ignore
  }
  const priceId =
    typeof obj?.items?.data?.[0]?.price?.id === "string"
      ? obj.items.data[0].price.id
      : typeof obj?.lines?.data?.[0]?.price?.id === "string"
        ? obj.lines.data[0].price.id
        : "";
  return billingPlanFromStripePriceId(priceId) ?? null;
}

function normalizeBillingReturnUrl(value, fallbackUrl) {
  const raw = String(value ?? "").trim();
  const candidate = raw || String(fallbackUrl ?? "").trim();
  if (!candidate) throw new Error("missing return URL");
  const normalized = normalizeHttpUrl(candidate);
  if (!normalized) throw new Error("URL must be a valid http(s) URL");
  return normalized;
}

async function resolveTenantIdForStripeObject(obj) {
  const metaTenantRaw = typeof obj?.metadata?.tenantId === "string" ? obj.metadata.tenantId : "";
  if (metaTenantRaw) {
    const parsed = parseTenantIdParam(metaTenantRaw);
    if (parsed.ok) return parsed.tenantId;
  }
  const clientRefTenantRaw = typeof obj?.client_reference_id === "string" ? obj.client_reference_id : "";
  if (clientRefTenantRaw) {
    const parsed = parseTenantIdParam(clientRefTenantRaw);
    if (parsed.ok) return parsed.tenantId;
  }
  const customerId = typeof obj?.customer === "string" ? obj.customer.trim() : "";
  if (customerId) return await getTenantIdByStripeCustomerId({ dataDir, customerId });
  return null;
}

async function processStripeWebhookEvent({ event }) {
  const eventId = typeof event?.id === "string" ? event.id : null;
  const eventType = typeof event?.type === "string" ? event.type : null;
  const obj = isPlainObject(event?.data?.object) ? event.data.object : null;
  if (!eventType || !obj) return { ignored: true, reason: "invalid_event_shape" };

  const tenantId = await resolveTenantIdForStripeObject(obj);
  if (!tenantId) return { ignored: true, reason: "tenant_not_resolved", eventType };

  const customerId = typeof obj?.customer === "string" ? obj.customer.trim() : "";
  const subscriptionId = typeof obj?.subscription === "string" ? obj.subscription.trim() : typeof obj?.id === "string" && eventType.startsWith("customer.subscription.") ? obj.id.trim() : "";
  const planHint = readStripeObjectPlanHint(obj);
  const now = nowIso();

  if (customerId) await setStripeCustomerTenantMap({ dataDir, customerId, tenantId });

  if (eventType === "checkout.session.completed") {
    if (planHint) {
      await setTenantPlanBySystem({
        tenantId,
        plan: planHint,
        actorMethod: "billing_webhook",
        reason: "stripe_checkout_completed",
        eventId
      });
    }
    await patchTenantBillingState({
      dataDir,
      tenantId,
      patch: {
        provider: "stripe",
        currentPlan: planHint ?? undefined,
        status: "checkout_completed",
        customerId: customerId || null,
        subscriptionId: subscriptionId || null,
        lastCheckoutSessionId: typeof obj?.id === "string" ? obj.id : null,
        paymentDelinquent: false,
        suspended: false,
        lastEvent: { id: eventId, type: eventType, at: now }
      }
    });
    return { handled: true, tenantId, eventType };
  }

  if (eventType === "customer.subscription.created" || eventType === "customer.subscription.updated") {
    const status = typeof obj?.status === "string" ? obj.status : "unknown";
    const lowered = status.toLowerCase();
    const isGood = lowered === "active" || lowered === "trialing";
    const isDelinquent = lowered === "past_due" || lowered === "unpaid" || lowered === "incomplete" || lowered === "incomplete_expired";
    const isCanceled = lowered === "canceled";

    if (isGood && planHint) {
      await setTenantPlanBySystem({
        tenantId,
        plan: planHint,
        actorMethod: "billing_webhook",
        reason: "stripe_subscription_active",
        eventId
      });
    }
    if (isCanceled) {
      await setTenantPlanBySystem({
        tenantId,
        plan: "free",
        actorMethod: "billing_webhook",
        reason: "stripe_subscription_canceled",
        eventId
      });
    }

    await patchTenantBillingState({
      dataDir,
      tenantId,
      patch: {
        provider: "stripe",
        currentPlan: planHint ?? undefined,
        status,
        customerId: customerId || null,
        subscriptionId: subscriptionId || null,
        paymentDelinquent: isDelinquent,
        suspended: isDelinquent,
        lastEvent: { id: eventId, type: eventType, at: now }
      }
    });
    return { handled: true, tenantId, eventType, status };
  }

  if (eventType === "customer.subscription.deleted") {
    await setTenantPlanBySystem({
      tenantId,
      plan: "free",
      actorMethod: "billing_webhook",
      reason: "stripe_subscription_deleted",
      eventId
    });
    await patchTenantBillingState({
      dataDir,
      tenantId,
      patch: {
        provider: "stripe",
        currentPlan: "free",
        status: "canceled",
        customerId: customerId || null,
        subscriptionId: null,
        paymentDelinquent: false,
        suspended: false,
        lastEvent: { id: eventId, type: eventType, at: now }
      }
    });
    return { handled: true, tenantId, eventType };
  }

  if (eventType === "invoice.payment_failed") {
    await setTenantPlanBySystem({
      tenantId,
      plan: "free",
      actorMethod: "billing_webhook",
      reason: "stripe_invoice_payment_failed",
      eventId
    });
    await patchTenantBillingState({
      dataDir,
      tenantId,
      patch: {
        provider: "stripe",
        currentPlan: "free",
        status: "payment_failed",
        customerId: customerId || null,
        paymentDelinquent: true,
        suspended: true,
        lastEvent: { id: eventId, type: eventType, at: now }
      }
    });
    return { handled: true, tenantId, eventType };
  }

  if (eventType === "invoice.paid") {
    await patchTenantBillingState({
      dataDir,
      tenantId,
      patch: {
        provider: "stripe",
        status: "active",
        customerId: customerId || null,
        paymentDelinquent: false,
        suspended: false,
        lastEvent: { id: eventId, type: eventType, at: now }
      }
    });
    return { handled: true, tenantId, eventType };
  }

  return { ignored: true, reason: "event_not_handled", tenantId, eventType };
}

async function handleTenantBillingStateGet(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const profile = await loadTenantProfileBestEffort({ dataDir, tenantId });
  const settings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(settings);
  const state = await loadTenantBillingStateBestEffort({ dataDir, tenantId });
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    profile: profile ? { name: profile.name, billingEmail: profile.billingEmail } : null,
    entitlements,
    state
  });
}

async function handleTenantBillingCheckoutCreate(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (billingProvider !== "stripe") return sendJson(res, 409, { ok: false, code: "BILLING_PROVIDER_DISABLED", message: "billing provider is not stripe" });
  if (!stripeSecretKey) return sendJson(res, 409, { ok: false, code: "BILLING_NOT_CONFIGURED", message: "stripe secret key is not configured" });

  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object with plan" });

  let plan;
  try {
    plan = normalizeTenantPlan(json.plan, { allowNull: false });
  } catch (err) {
    return sendJson(
      res,
      400,
      { ok: false, code: "INVALID_PLAN", message: err?.message ?? "plan must be free|builder|growth|enterprise" }
    );
  }
  if (plan === "free") {
    return sendJson(
      res,
      400,
      { ok: false, code: "INVALID_PLAN", message: "checkout only supports paid plans (builder|growth|enterprise)" }
    );
  }

  const priceId = billingPriceIdForPlan(plan);
  if (!priceId) return sendJson(res, 409, { ok: false, code: "PLAN_NOT_CONFIGURED", message: `no Stripe price ID configured for plan ${plan}` });

  let successUrl;
  let cancelUrl;
  try {
    successUrl = normalizeBillingReturnUrl(json.successUrl, billingCheckoutSuccessUrlDefault);
    cancelUrl = normalizeBillingReturnUrl(json.cancelUrl, billingCheckoutCancelUrlDefault);
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_URL", message: err?.message ?? "invalid billing return URL" });
  }

  const profile = await loadTenantProfileBestEffort({ dataDir, tenantId });
  const billingEmail = typeof profile?.billingEmail === "string" ? profile.billingEmail : "";
  const billingState = await loadTenantBillingStateBestEffort({ dataDir, tenantId });

  let session;
  try {
    session = await stripeApiPostJson({
      endpoint: "/v1/checkout/sessions",
      formData: {
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: tenantId,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[tenantId]": tenantId,
        "metadata[plan]": plan,
        ...(billingEmail ? { customer_email: billingEmail } : {}),
        ...(billingState?.customerId ? { customer: billingState.customerId } : {})
      }
    });
  } catch (err) {
    return sendJson(res, 502, { ok: false, code: "STRIPE_ERROR", message: err?.message ?? "failed to create Stripe checkout session" });
  }

  const sessionId = typeof session?.id === "string" ? session.id : "";
  const checkoutUrl = typeof session?.url === "string" ? session.url : "";
  if (!sessionId || !checkoutUrl) return sendJson(res, 502, { ok: false, code: "STRIPE_INVALID_RESPONSE", message: "Stripe checkout session missing id or url" });

  await patchTenantBillingState({
    dataDir,
    tenantId,
    patch: {
      provider: "stripe",
      status: "checkout_created",
      currentPlan: plan,
      lastCheckoutSessionId: sessionId,
      lastEvent: { id: null, type: "checkout.session.created", at: nowIso() }
    }
  });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "BILLING_CHECKOUT_CREATED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "billing",
        targetId: tenantId,
        details: { plan, sessionId, priceId }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    provider: "stripe",
    plan,
    sessionId,
    checkoutUrl
  });
}

async function handleTenantBillingPortalCreate(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (billingProvider !== "stripe") return sendJson(res, 409, { ok: false, code: "BILLING_PROVIDER_DISABLED", message: "billing provider is not stripe" });
  if (!stripeSecretKey) return sendJson(res, 409, { ok: false, code: "BILLING_NOT_CONFIGURED", message: "stripe secret key is not configured" });

  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};

  const billingState = await loadTenantBillingStateBestEffort({ dataDir, tenantId });
  const customerId = typeof billingState?.customerId === "string" ? billingState.customerId.trim() : "";
  if (!customerId) return sendJson(res, 409, { ok: false, code: "BILLING_CUSTOMER_MISSING", message: "no Stripe customer is linked to this tenant yet" });

  let returnUrl;
  try {
    returnUrl = normalizeBillingReturnUrl(json.returnUrl, billingPortalReturnUrlDefault);
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_URL", message: err?.message ?? "invalid return URL" });
  }

  let portal;
  try {
    portal = await stripeApiPostJson({
      endpoint: "/v1/billing_portal/sessions",
      formData: {
        customer: customerId,
        return_url: returnUrl
      }
    });
  } catch (err) {
    return sendJson(res, 502, { ok: false, code: "STRIPE_ERROR", message: err?.message ?? "failed to create Stripe billing portal session" });
  }

  const portalSessionId = typeof portal?.id === "string" ? portal.id : "";
  const portalUrl = typeof portal?.url === "string" ? portal.url : "";
  if (!portalSessionId || !portalUrl) return sendJson(res, 502, { ok: false, code: "STRIPE_INVALID_RESPONSE", message: "Stripe billing portal response missing id or url" });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "BILLING_PORTAL_CREATED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "billing",
        targetId: tenantId,
        details: { customerId, portalSessionId }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    provider: "stripe",
    customerId,
    portalSessionId,
    portalUrl
  });
}

async function handleStripeBillingWebhook(req, res) {
  if (billingProvider !== "stripe") return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  let payload;
  try {
    payload = await readBody(req, { maxBytes: 1_000_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }

  if (stripeWebhookSecret) {
    const verified = verifyStripeWebhookSignature({
      payloadBuffer: payload,
      signatureHeader: req.headers["stripe-signature"],
      secret: stripeWebhookSecret
    });
    if (!verified.ok) return sendJson(res, 400, { ok: false, code: "INVALID_SIGNATURE", message: verified.error ?? "invalid stripe signature" });
  } else {
    const auth = checkAuth(req);
    if (!auth.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "webhook signature not configured; x-api-key required" });
  }

  let event;
  try {
    event = JSON.parse(payload.toString("utf8"));
  } catch {
    return sendJson(res, 400, { ok: false, code: "INVALID_JSON", message: "invalid JSON payload" });
  }
  if (!isPlainObject(event) || typeof event.id !== "string" || typeof event.type !== "string") {
    return sendJson(res, 400, { ok: false, code: "INVALID_EVENT", message: "invalid stripe event shape" });
  }

  if (await isStripeEventProcessed({ dataDir, eventId: event.id })) {
    return sendJson(res, 200, { ok: true, duplicate: true, eventId: event.id });
  }

  let outcome;
  try {
    outcome = await processStripeWebhookEvent({ event });
  } catch (err) {
    return sendJson(res, 500, { ok: false, code: "WEBHOOK_PROCESSING_FAILED", message: err?.message ?? "failed to process webhook event" });
  }

  await markStripeEventProcessed({
    dataDir,
    eventId: event.id,
    payload: {
      type: event.type,
      outcome
    }
  });

  return sendJson(res, 200, { ok: true, eventId: event.id, eventType: event.type, ...outcome });
}

function makeInternalRes() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 200,
    setHeader(k, v) {
      headers.set(String(k).toLowerCase(), String(v));
    },
    getHeader(k) {
      return headers.get(String(k).toLowerCase()) ?? null;
    },
    end(data) {
      if (data !== undefined && data !== null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      this.ended = true;
    },
    ended: false,
    _headers: headers,
    _body() {
      return Buffer.concat(chunks);
    }
  };
}

async function handleTenantCreate(req, res) {
  const auth = checkAuth(req);
  if (!auth.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN" });

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const name = typeof json.name === "string" ? json.name.trim() : "";
  if (!name) return sendJson(res, 400, { ok: false, code: "INVALID_NAME", message: "name is required" });
  const contactEmail = normalizeEmailLower(json.contactEmail);
  if (!contactEmail) return sendJson(res, 400, { ok: false, code: "INVALID_CONTACT_EMAIL", message: "contactEmail is required" });
  const billingEmail = normalizeEmailLower(json.billingEmail);
  if (!billingEmail) return sendJson(res, 400, { ok: false, code: "INVALID_BILLING_EMAIL", message: "billingEmail is required" });

  let tenantId = null;
  if (json.tenantId !== undefined && json.tenantId !== null) {
    const parsed = parseTenantIdParam(json.tenantId);
    if (!parsed.ok) return sendJson(res, 400, { ok: false, code: "INVALID_TENANT", message: parsed.error });
    tenantId = parsed.tenantId;
  } else {
    let attempts = 0;
    while (attempts < 10 && !tenantId) {
      attempts += 1;
      const candidate = generateTenantIdFromName(name);
      // eslint-disable-next-line no-await-in-loop
      const existing = await loadTenantProfileBestEffort({ dataDir, tenantId: candidate });
      if (!existing) tenantId = candidate;
    }
    if (!tenantId) return sendJson(res, 500, { ok: false, code: "TENANT_ID_GENERATION_FAILED", message: "failed to generate tenantId" });
  }

  const created = await createTenantProfile({ dataDir, tenantId, name, contactEmail, billingEmail });
  if (!created.ok) {
    const status = created.code === "TENANT_EXISTS" ? 409 : 400;
    return sendJson(res, status, { ok: false, code: created.code ?? "INVALID_REQUEST", message: created.error ?? "failed to create tenant" });
  }

  const settingsBase = await loadTenantSettings({ dataDir, tenantId });
  const relay = ensureDefaultEventRelayWebhook({ settings: settingsBase, tenantId });
  await saveTenantSettings({ dataDir, tenantId, settings: relay.settings, settingsKey });

  let onboardingEmailSequence = null;
  try {
    const sequenceDispatch = await dispatchOnboardingEmailSequenceBestEffort({
      dataDir,
      tenantId,
      profile: created.profile,
      enabled: onboardingEmailSequenceEnabled,
      deliveryMode: onboardingEmailSequenceDeliveryMode,
      smtpConfig,
      publicBaseUrl
    });
    onboardingEmailSequence = buildOnboardingEmailSequenceStatus({
      tenantId,
      profile: created.profile,
      state: sequenceDispatch?.state ?? null,
      enabled: onboardingEmailSequenceEnabled,
      deliveryMode: onboardingEmailSequenceDeliveryMode
    });
  } catch {
    onboardingEmailSequence = null;
  }

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_CREATED",
        actor: { method: auth.method, email: null, role: "admin" },
        targetType: "tenant",
        targetId: tenantId,
        details: { name, contactEmail, billingEmail, defaultEventRelayAttached: Boolean(relay.changed && defaultEventRelayUrl) }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 201, {
    ok: true,
    tenantId,
    onboardingUrl: `/v1/tenants/${tenantId}/onboarding`,
    runtimeBootstrapUrl: `/v1/tenants/${tenantId}/onboarding/runtime-bootstrap`,
    integrationsUrl: `/v1/tenants/${tenantId}/integrations`,
    settlementPoliciesUrl: `/v1/tenants/${tenantId}/settlement-policies`,
    metricsUrl: `/v1/tenants/${tenantId}/onboarding-metrics`,
    profile: onboardingMetricsFromProfile(created.profile),
    onboardingEmailSequence
  });
}

async function handleTenantOnboardingMetrics(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const cohortLimitRaw = url?.searchParams?.get("cohortLimit");
  const cohortLimit = cohortLimitRaw === null ? 12 : Number.parseInt(String(cohortLimitRaw), 10);
  if (!Number.isInteger(cohortLimit) || cohortLimit < 1 || cohortLimit > 60) {
    return sendJson(res, 400, { ok: false, code: "INVALID_COHORT_LIMIT", message: "cohortLimit must be 1..60" });
  }

  const profile = await loadTenantProfileBestEffort({ dataDir, tenantId });
  const metricsBody =
    onboardingMetricsFromProfile(profile) ??
    {
      schemaVersion: "MagicLinkTenantOnboardingMetrics.v1",
      tenantId,
      status: "pending",
      createdAt: null,
      activatedAt: null,
      firstUploadAt: null,
      firstVerifiedAt: null,
      firstSampleUploadAt: null,
      firstSampleVerifiedAt: null,
      firstBuyerLinkSharedAt: null,
      firstBuyerLinkOpenedAt: null,
      firstReferralLinkSharedAt: null,
      firstReferralSignupAt: null,
      timeToFirstVerifiedMs: null,
      referral: {
        linkSharedCount: 0,
        signupCount: 0,
        conversionRatePct: 0
      },
      funnel: {
        reachedStages: 0,
        totalStages: 0,
        completionPct: 0,
        nextStageKey: null,
        droppedOffStageKey: null,
        stages: []
      },
      events: {
        count: 0,
        latestEvent: null
      }
    };
  const allProfiles = await listTenantProfilesBestEffort({ dataDir, limit: 5000 });
  const cohortRows = onboardingCohortMetricsFromProfiles(allProfiles, { limit: cohortLimit });
  const cohortMonth = metricsBody?.createdAt && /^[0-9]{4}-[0-9]{2}/.test(String(metricsBody.createdAt))
    ? String(metricsBody.createdAt).slice(0, 7)
    : null;
  const cohortCurrent = cohortMonth ? cohortRows.find((row) => row.cohortMonth === cohortMonth) ?? null : null;
  const sequenceState = await loadOnboardingEmailSequenceStateBestEffort({ dataDir, tenantId });
  const onboardingEmailSequence = buildOnboardingEmailSequenceStatus({
    tenantId,
    profile,
    state: sequenceState,
    enabled: onboardingEmailSequenceEnabled,
    deliveryMode: onboardingEmailSequenceDeliveryMode
  });
  return sendJson(res, 200, {
    ok: true,
    ...metricsBody,
    cohort: {
      cohortMonth,
      current: cohortCurrent,
      rows: cohortRows,
      totalProfiles: allProfiles.length
    },
    onboardingEmailSequence,
    generatedAt: nowIso()
  });
}

async function handleTenantRuntimeBootstrap(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 100_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (json === null) json = {};
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const paidToolsBaseUrlRaw = typeof json.paidToolsBaseUrl === "string" ? json.paidToolsBaseUrl.trim() : "";
  const paidToolsBaseUrl = paidToolsBaseUrlRaw ? normalizeHttpUrl(paidToolsBaseUrlRaw) : null;
  if (paidToolsBaseUrlRaw && !paidToolsBaseUrl) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PAID_TOOLS_BASE_URL", message: "paidToolsBaseUrl must be a valid http(s) URL" });
  }

  const requestPayload = { ...json };
  delete requestPayload.paidToolsBaseUrl;

  const idempotencyKey = req.headers["x-idempotency-key"] ? String(req.headers["x-idempotency-key"]).trim() : "";
  const upstream = await callSettldTenantBootstrap({
    tenantId,
    payload: requestPayload,
    idempotencyKey: idempotencyKey || null
  });
  if (!upstream.ok) return sendJson(res, upstream.statusCode ?? 502, { ok: false, code: upstream.code, message: upstream.message });

  const bootstrap = upstream.response?.bootstrap;
  if (!isPlainObject(bootstrap)) {
    return sendJson(res, 502, {
      ok: false,
      code: "RUNTIME_BOOTSTRAP_INVALID_RESPONSE",
      message: "Settld bootstrap response missing bootstrap payload"
    });
  }

  const apiBaseUrl = typeof bootstrap.apiBaseUrl === "string" && bootstrap.apiBaseUrl.trim() ? bootstrap.apiBaseUrl.trim() : settldApiBaseUrl;
  const apiKeyToken = typeof bootstrap?.apiKey?.token === "string" && bootstrap.apiKey.token.trim() ? bootstrap.apiKey.token.trim() : null;
  const mcpEnv = {};
  if (apiBaseUrl) mcpEnv.SETTLD_BASE_URL = apiBaseUrl;
  mcpEnv.SETTLD_TENANT_ID = tenantId;
  if (apiKeyToken) mcpEnv.SETTLD_API_KEY = apiKeyToken;
  if (paidToolsBaseUrl) mcpEnv.SETTLD_PAID_TOOLS_BASE_URL = paidToolsBaseUrl;
  const mcp = {
    schemaVersion: "SettldMcpServerConfig.v1",
    command: "npx",
    args: ["-y", "settld-mcp"],
    env: mcpEnv
  };
  const mcpConfigJson = {
    mcpServers: {
      settld: {
        command: mcp.command,
        args: mcp.args,
        env: mcp.env
      }
    }
  };

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_RUNTIME_BOOTSTRAP_ISSUED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant",
        targetId: tenantId,
        details: {
          apiBaseUrl: apiBaseUrl ?? null,
          apiKeyId: typeof bootstrap?.apiKey?.keyId === "string" ? bootstrap.apiKey.keyId : null,
          paidToolsBaseUrl: paidToolsBaseUrl ?? null
        }
      }
    });
  } catch {
    // ignore audit write failures for bootstrap convenience endpoint
  }

  return sendJson(res, 201, {
    ok: true,
    schemaVersion: "MagicLinkRuntimeBootstrap.v1",
    tenantId,
    bootstrap,
    mcp,
    mcpConfigJson
  });
}

async function handleTenantRuntimeBootstrapSmokeTest(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 100_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (json === null) json = {};
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const envRaw = isPlainObject(json?.env) ? json.env : isPlainObject(json?.mcp?.env) ? json.mcp.env : null;
  if (!envRaw) return sendJson(res, 400, { ok: false, code: "ENV_REQUIRED", message: "env object is required" });

  const required = ["SETTLD_BASE_URL", "SETTLD_TENANT_ID", "SETTLD_API_KEY"];
  const env = {};
  for (const key of required) {
    const value = typeof envRaw[key] === "string" ? envRaw[key].trim() : "";
    if (!value) return sendJson(res, 400, { ok: false, code: "ENV_INVALID", message: `${key} is required` });
    env[key] = value;
  }
  if (!normalizeHttpUrl(env.SETTLD_BASE_URL)) {
    return sendJson(res, 400, { ok: false, code: "ENV_INVALID", message: "SETTLD_BASE_URL must be a valid http(s) URL" });
  }
  if (env.SETTLD_TENANT_ID !== tenantId) {
    return sendJson(res, 400, { ok: false, code: "ENV_INVALID", message: "SETTLD_TENANT_ID must match tenant path" });
  }
  const paidToolsBaseUrl = typeof envRaw.SETTLD_PAID_TOOLS_BASE_URL === "string" ? envRaw.SETTLD_PAID_TOOLS_BASE_URL.trim() : "";
  if (paidToolsBaseUrl) {
    const normalized = normalizeHttpUrl(paidToolsBaseUrl);
    if (!normalized) return sendJson(res, 400, { ok: false, code: "ENV_INVALID", message: "SETTLD_PAID_TOOLS_BASE_URL must be a valid http(s) URL" });
    env.SETTLD_PAID_TOOLS_BASE_URL = normalized;
  }
  env.SETTLD_PROTOCOL = settldProtocol;

  const timeoutMsRaw = Number.parseInt(String(json.timeoutMs ?? "10000"), 10);
  const timeoutMs = Number.isInteger(timeoutMsRaw) && timeoutMsRaw >= 1000 && timeoutMsRaw <= 30000 ? timeoutMsRaw : 10000;
  const smoke = await runMcpInitializeToolsListSmoke({ env, timeoutMs });
  if (!smoke.ok) {
    return sendJson(res, 502, {
      ok: false,
      code: smoke.error ?? "MCP_SMOKE_TEST_FAILED",
      message: smoke?.detail?.message ?? "mcp smoke test failed",
      detail: smoke.detail ?? null
    });
  }

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_RUNTIME_MCP_SMOKE_TESTED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant",
        targetId: tenantId,
        details: {
          toolsCount: Number.isInteger(smoke.smoke?.toolsCount) ? smoke.smoke.toolsCount : null,
          initialized: Boolean(smoke.smoke?.initialized)
        }
      }
    });
  } catch {
    // ignore audit write failures for smoke-test helper endpoint
  }

  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkRuntimeBootstrapSmokeTest.v1",
    tenantId,
    smoke: smoke.smoke
  });
}

function firstPaidCallStepId(prefix, step) {
  return `${String(prefix)}_${String(step)}`;
}

function tenantFirstPaidCallHistoryPath({ tenantId }) {
  return path.join(dataDir, "tenants", tenantId, "onboarding_first_paid_calls.json");
}

function defaultTenantFirstPaidCallHistory({ tenantId }) {
  return {
    schemaVersion: "MagicLinkFirstPaidCallHistory.v1",
    tenantId,
    updatedAt: null,
    attempts: []
  };
}

function normalizeFirstPaidCallAttemptRow(input) {
  if (!isPlainObject(input)) return null;
  const attemptId = typeof input.attemptId === "string" && input.attemptId.trim() ? safeTruncate(input.attemptId.trim(), { max: 120 }) : null;
  if (!attemptId) return null;
  const normalizeIso = (value) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  };
  const startedAt = normalizeIso(input.startedAt) ?? nowIso();
  const completedAt = normalizeIso(input.completedAt);
  const status = (() => {
    const raw = typeof input.status === "string" ? input.status.trim().toLowerCase() : "";
    if (raw === "passed" || raw === "completed" || raw === "degraded" || raw === "failed") return raw;
    return "completed";
  })();
  const ids = isPlainObject(input.ids) ? {
    posterAgentId: typeof input.ids.posterAgentId === "string" ? input.ids.posterAgentId : null,
    bidderAgentId: typeof input.ids.bidderAgentId === "string" ? input.ids.bidderAgentId : null,
    rfqId: typeof input.ids.rfqId === "string" ? input.ids.rfqId : null,
    bidId: typeof input.ids.bidId === "string" ? input.ids.bidId : null,
    runId: typeof input.ids.runId === "string" ? input.ids.runId : null
  } : null;
  const verificationStatus =
    typeof input.verificationStatus === "string" && input.verificationStatus.trim()
      ? input.verificationStatus.trim().toLowerCase()
      : null;
  const settlementStatus =
    typeof input.settlementStatus === "string" && input.settlementStatus.trim()
      ? input.settlementStatus.trim().toLowerCase()
      : null;
  const config = isPlainObject(input.config) ? {
    payerCreditAmountCents: Number.isSafeInteger(Number(input.config.payerCreditAmountCents))
      ? Number(input.config.payerCreditAmountCents)
      : null,
    budgetCents: Number.isSafeInteger(Number(input.config.budgetCents))
      ? Number(input.config.budgetCents)
      : null,
    bidAmountCents: Number.isSafeInteger(Number(input.config.bidAmountCents))
      ? Number(input.config.bidAmountCents)
      : null,
    currency:
      typeof input.config.currency === "string" && input.config.currency.trim()
        ? input.config.currency.trim().toUpperCase()
        : null,
    source:
      typeof input.config.source === "string" && input.config.source.trim()
        ? safeTruncate(input.config.source.trim(), { max: 64 })
        : "manual"
  } : null;
  const error = isPlainObject(input.error)
    ? {
        code: typeof input.error.code === "string" ? safeTruncate(input.error.code, { max: 80 }) : null,
        step: typeof input.error.step === "string" ? safeTruncate(input.error.step, { max: 80 }) : null,
        message: typeof input.error.message === "string" ? safeTruncate(input.error.message, { max: 500 }) : null
      }
    : null;
  return {
    schemaVersion: "MagicLinkFirstPaidCallAttempt.v1",
    attemptId,
    startedAt,
    completedAt,
    status,
    ids,
    verificationStatus,
    settlementStatus,
    config,
    error
  };
}

async function loadTenantFirstPaidCallHistoryBestEffort({ tenantId }) {
  const fp = tenantFirstPaidCallHistoryPath({ tenantId });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!isPlainObject(raw)) return defaultTenantFirstPaidCallHistory({ tenantId });
    const rows = Array.isArray(raw.attempts) ? raw.attempts : [];
    const attempts = rows.map((row) => normalizeFirstPaidCallAttemptRow(row)).filter(Boolean).slice(-100);
    const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null;
    return {
      schemaVersion: "MagicLinkFirstPaidCallHistory.v1",
      tenantId,
      updatedAt,
      attempts
    };
  } catch {
    return defaultTenantFirstPaidCallHistory({ tenantId });
  }
}

async function saveTenantFirstPaidCallHistory({ tenantId, history }) {
  const fp = tenantFirstPaidCallHistoryPath({ tenantId });
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(history, null, 2) + "\n", "utf8");
}

async function appendTenantFirstPaidCallAttempt({ tenantId, attempt }) {
  const history = await loadTenantFirstPaidCallHistoryBestEffort({ tenantId });
  const normalized = normalizeFirstPaidCallAttemptRow(attempt);
  if (!normalized) return history;
  const attempts = [...history.attempts, normalized].slice(-100);
  const next = {
    schemaVersion: "MagicLinkFirstPaidCallHistory.v1",
    tenantId,
    updatedAt: nowIso(),
    attempts
  };
  await saveTenantFirstPaidCallHistory({ tenantId, history: next });
  return next;
}

function tenantConformanceIdempotencyPath({ tenantId, idempotencyKey }) {
  const keyHash = sha256Hex(String(idempotencyKey ?? ""));
  return path.join(dataDir, "tenants", tenantId, "onboarding_conformance_idempotency", `${keyHash}.json`);
}

async function loadTenantConformanceIdempotentResultBestEffort({ tenantId, idempotencyKey }) {
  const fp = tenantConformanceIdempotencyPath({ tenantId, idempotencyKey });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!isPlainObject(raw)) return null;
    return {
      schemaVersion: "MagicLinkRuntimeConformanceIdempotency.v1",
      tenantId,
      idempotencyKeyHash: typeof raw.idempotencyKeyHash === "string" ? raw.idempotencyKeyHash : null,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
      statusCode: Number.isInteger(raw.statusCode) ? raw.statusCode : 200,
      response: isPlainObject(raw.response) ? raw.response : null
    };
  } catch {
    return null;
  }
}

async function saveTenantConformanceIdempotentResult({ tenantId, idempotencyKey, statusCode = 200, response }) {
  const fp = tenantConformanceIdempotencyPath({ tenantId, idempotencyKey });
  await fs.mkdir(path.dirname(fp), { recursive: true });
  const record = {
    schemaVersion: "MagicLinkRuntimeConformanceIdempotency.v1",
    tenantId,
    idempotencyKeyHash: sha256Hex(String(idempotencyKey ?? "")),
    createdAt: nowIso(),
    statusCode: Number.isInteger(statusCode) ? statusCode : 200,
    response: isPlainObject(response) ? response : null
  };
  await fs.writeFile(fp, JSON.stringify(record, null, 2) + "\n", "utf8");
  return record;
}

function firstPaidCallExtractVerificationStatus(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.verificationStatus === "string" && payload.verificationStatus.trim()) return payload.verificationStatus.trim().toLowerCase();
  if (
    payload.verification &&
    typeof payload.verification === "object" &&
    !Array.isArray(payload.verification) &&
    typeof payload.verification.verificationStatus === "string" &&
    payload.verification.verificationStatus.trim()
  ) {
    return payload.verification.verificationStatus.trim().toLowerCase();
  }
  return null;
}

function firstPaidCallExtractSettlementStatus(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.status === "string" && payload.status.trim()) return payload.status.trim().toLowerCase();
  if (
    payload.settlement &&
    typeof payload.settlement === "object" &&
    !Array.isArray(payload.settlement) &&
    typeof payload.settlement.status === "string" &&
    payload.settlement.status.trim()
  ) {
    return payload.settlement.status.trim().toLowerCase();
  }
  return null;
}

async function runTenantFirstPaidCallFlow({
  tenantId,
  runtimeApiKey,
  payerCreditAmountCents,
  budgetCents,
  bidAmountCents,
  currency,
  flowPrefix = null
} = {}) {
  const prefix = flowPrefix && String(flowPrefix).trim()
    ? String(flowPrefix).trim()
    : `ml_first_paid_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  const agentSuffix = prefix.slice(-16);
  const runRequest = async ({ step, method, pathname, body = undefined, expectedPrevChainHash = null }) => {
    const result = await callSettldTenantApi({
      apiBaseUrl: settldApiBaseUrl,
      tenantId,
      apiKey: runtimeApiKey,
      method,
      pathname,
      body,
      idempotencyKey: firstPaidCallStepId(prefix, step),
      expectedPrevChainHash
    });
    if (!result.ok) {
      return {
        ok: false,
        statusCode: result.statusCode ?? 502,
        code: result.code ?? "SETTLD_API_CALL_FAILED",
        step,
        message: `step ${step} failed: ${result.message ?? "request failed"}`
      };
    }
    return { ok: true, response: result.response };
  };

  const posterKeypair = crypto.generateKeyPairSync("ed25519");
  const bidderKeypair = crypto.generateKeyPairSync("ed25519");
  const posterPublicKeyPem = posterKeypair.publicKey.export({ type: "spki", format: "pem" }).toString("utf8");
  const bidderPublicKeyPem = bidderKeypair.publicKey.export({ type: "spki", format: "pem" }).toString("utf8");
  const posterAgentId = `agt_ml_poster_${agentSuffix}`;
  const bidderAgentId = `agt_ml_bidder_${agentSuffix}`;
  const rfqId = `rfq_ml_${agentSuffix}`;
  const bidId = `bid_ml_${agentSuffix}`;

  const posterRegistration = await runRequest({
    step: "register_poster",
    method: "POST",
    pathname: "/agents/register",
    body: {
      agentId: posterAgentId,
      displayName: "Magic Link Poster Agent",
      owner: { ownerType: "service", ownerId: "svc_magic_link_onboarding" },
      capabilities: ["request"],
      publicKeyPem: posterPublicKeyPem
    }
  });
  if (!posterRegistration.ok) return posterRegistration;

  const bidderRegistration = await runRequest({
    step: "register_bidder",
    method: "POST",
    pathname: "/agents/register",
    body: {
      agentId: bidderAgentId,
      displayName: "Magic Link Bidder Agent",
      owner: { ownerType: "service", ownerId: "svc_magic_link_onboarding" },
      capabilities: ["execute", "deliver"],
      publicKeyPem: bidderPublicKeyPem
    }
  });
  if (!bidderRegistration.ok) return bidderRegistration;

  const credit = await runRequest({
    step: "credit_wallet",
    method: "POST",
    pathname: `/agents/${encodeURIComponent(posterAgentId)}/wallet/credit`,
    body: {
      amountCents: payerCreditAmountCents,
      currency
    }
  });
  if (!credit.ok) return credit;

  const rfq = await runRequest({
    step: "create_rfq",
    method: "POST",
    pathname: "/marketplace/rfqs",
    body: {
      rfqId,
      title: "Magic Link first paid call",
      capability: "general",
      posterAgentId,
      budgetCents,
      currency
    }
  });
  if (!rfq.ok) return rfq;

  const bid = await runRequest({
    step: "submit_bid",
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/bids`,
    body: {
      bidId,
      bidderAgentId,
      amountCents: bidAmountCents,
      currency,
      etaSeconds: 600
    }
  });
  if (!bid.ok) return bid;

  const accepted = await runRequest({
    step: "accept_bid",
    method: "POST",
    pathname: `/marketplace/rfqs/${encodeURIComponent(rfqId)}/accept`,
    body: {
      bidId,
      acceptedByAgentId: posterAgentId,
      settlement: {
        payerAgentId: posterAgentId,
        amountCents: bidAmountCents,
        currency
      }
    }
  });
  if (!accepted.ok) return accepted;

  const runId = typeof accepted.response?.run?.runId === "string" ? accepted.response.run.runId.trim() : "";
  const lastChainHash = typeof accepted.response?.run?.lastChainHash === "string" ? accepted.response.run.lastChainHash.trim() : "";
  if (!runId || !lastChainHash) {
    return {
      ok: false,
      code: "SETTLD_API_INVALID_RESPONSE",
      statusCode: 502,
      step: "accept_bid",
      message: "accept response missing runId or lastChainHash"
    };
  }

  const runCompleted = await runRequest({
    step: "run_completed",
    method: "POST",
    pathname: `/agents/${encodeURIComponent(bidderAgentId)}/runs/${encodeURIComponent(runId)}/events`,
    expectedPrevChainHash: lastChainHash,
    body: {
      type: "RUN_COMPLETED",
      actor: { type: "agent", id: bidderAgentId },
      payload: {
        outputRef: `evidence://${runId}/result.json`,
        metrics: { settlementReleaseRatePct: 100, latencyMs: 350 }
      }
    }
  });
  if (!runCompleted.ok) return runCompleted;

  const verification = await callSettldTenantApi({
    apiBaseUrl: settldApiBaseUrl,
    tenantId,
    apiKey: runtimeApiKey,
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/verification`
  });
  if (!verification.ok) {
    return {
      ok: false,
      step: "verification",
      statusCode: verification.statusCode ?? 502,
      code: verification.code ?? "SETTLD_API_CALL_FAILED",
      message: `step verification failed: ${verification.message ?? "request failed"}`
    };
  }

  const settlement = await callSettldTenantApi({
    apiBaseUrl: settldApiBaseUrl,
    tenantId,
    apiKey: runtimeApiKey,
    method: "GET",
    pathname: `/runs/${encodeURIComponent(runId)}/settlement`
  });
  if (!settlement.ok) {
    return {
      ok: false,
      step: "settlement",
      statusCode: settlement.statusCode ?? 502,
      code: settlement.code ?? "SETTLD_API_CALL_FAILED",
      message: `step settlement failed: ${settlement.message ?? "request failed"}`
    };
  }

  const verificationStatus = firstPaidCallExtractVerificationStatus(verification.response);
  const settlementStatus = firstPaidCallExtractSettlementStatus(settlement.response);

  return {
    ok: true,
    ids: {
      posterAgentId,
      bidderAgentId,
      rfqId,
      bidId,
      runId
    },
    verificationStatus,
    settlementStatus,
    verification: verification.response,
    settlement: settlement.response
  };
}

async function handleTenantFirstPaidCallHistory(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const history = await loadTenantFirstPaidCallHistoryBestEffort({ tenantId });
  return sendJson(res, 200, { ok: true, ...history });
}

async function handleTenantFirstPaidCall(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 40_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (json === null) json = {};
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const replayAttemptId =
    typeof json.replayAttemptId === "string" && json.replayAttemptId.trim()
      ? json.replayAttemptId.trim()
      : null;
  if (replayAttemptId) {
    const history = await loadTenantFirstPaidCallHistoryBestEffort({ tenantId });
    const attempt = history.attempts.find((row) => row.attemptId === replayAttemptId) ?? null;
    if (!attempt) return sendJson(res, 404, { ok: false, code: "ATTEMPT_NOT_FOUND", message: "first paid call attempt not found" });
    return sendJson(res, 200, {
      ok: true,
      schemaVersion: "MagicLinkFirstPaidCall.v1",
      tenantId,
      replayed: true,
      attemptId: attempt.attemptId,
      ids: attempt.ids ?? null,
      verificationStatus: attempt.verificationStatus ?? null,
      settlementStatus: attempt.settlementStatus ?? null,
      attempt
    });
  }

  const toPositiveInt = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  };

  const payerCreditAmountCents = toPositiveInt(json.payerCreditAmountCents, 2_500);
  const budgetCents = toPositiveInt(json.budgetCents, 1_200);
  const bidAmountCents = toPositiveInt(json.bidAmountCents, 1_100);
  if (!payerCreditAmountCents || !budgetCents || !bidAmountCents) {
    return sendJson(res, 400, {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "payerCreditAmountCents, budgetCents, and bidAmountCents must be positive integers"
    });
  }
  if (bidAmountCents > budgetCents) {
    return sendJson(res, 400, { ok: false, code: "INVALID_AMOUNT", message: "bidAmountCents must be <= budgetCents" });
  }

  const currencyRaw = typeof json.currency === "string" ? json.currency.trim().toUpperCase() : "USD";
  const currency = currencyRaw || "USD";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_CURRENCY", message: "currency must be a 3-letter ISO code" });
  }

  const attemptId = `fpc_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  const startedAt = nowIso();
  const config = { payerCreditAmountCents, budgetCents, bidAmountCents, currency, source: "manual" };

  const bootstrap = await callSettldTenantBootstrap({
    tenantId,
    payload: {
      apiKey: {
        create: true,
        description: "magic-link first paid call runtime key"
      }
    }
  });
  if (!bootstrap.ok) {
    await appendTenantFirstPaidCallAttempt({
      tenantId,
      attempt: {
        attemptId,
        startedAt,
        completedAt: nowIso(),
        status: "failed",
        config,
        error: { code: bootstrap.code ?? "RUNTIME_BOOTSTRAP_FAILED", step: "bootstrap", message: bootstrap.message ?? "bootstrap failed" }
      }
    });
    return sendJson(res, bootstrap.statusCode ?? 502, { ok: false, code: bootstrap.code, message: bootstrap.message, attemptId });
  }

  const runtimeApiKey = typeof bootstrap.response?.bootstrap?.apiKey?.token === "string"
    ? bootstrap.response.bootstrap.apiKey.token.trim()
    : "";
  if (!runtimeApiKey) {
    await appendTenantFirstPaidCallAttempt({
      tenantId,
      attempt: {
        attemptId,
        startedAt,
        completedAt: nowIso(),
        status: "failed",
        config,
        error: {
          code: "RUNTIME_BOOTSTRAP_INVALID_RESPONSE",
          step: "bootstrap",
          message: "Settld bootstrap response missing runtime API key token"
        }
      }
    });
    return sendJson(res, 502, {
      ok: false,
      code: "RUNTIME_BOOTSTRAP_INVALID_RESPONSE",
      message: "Settld bootstrap response missing runtime API key token",
      attemptId
    });
  }

  const flow = await runTenantFirstPaidCallFlow({
    tenantId,
    runtimeApiKey,
    payerCreditAmountCents,
    budgetCents,
    bidAmountCents,
    currency,
    flowPrefix: attemptId
  });

  if (!flow.ok) {
    await appendTenantFirstPaidCallAttempt({
      tenantId,
      attempt: {
        attemptId,
        startedAt,
        completedAt: nowIso(),
        status: "failed",
        config,
        error: { code: flow.code ?? "SETTLD_API_CALL_FAILED", step: flow.step ?? null, message: flow.message ?? "flow failed" }
      }
    });
    try {
      await appendAuditRecord({
        dataDir,
        tenantId,
        record: {
          at: nowIso(),
          action: "TENANT_RUNTIME_FIRST_PAID_CALL_FAILED",
          actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
          targetType: "tenant",
          targetId: tenantId,
          details: { attemptId, code: flow.code ?? null, step: flow.step ?? null, message: flow.message ?? null }
        }
      });
    } catch {
      // ignore
    }
    return sendJson(res, flow.statusCode ?? 502, { ok: false, code: flow.code, message: flow.message, attemptId });
  }

  const verificationPassed = flow.verificationStatus === "green";
  await markTenantOnboardingProgress({
    dataDir,
    tenantId,
    isSample: false,
    verificationOk: verificationPassed
  });

  const status = verificationPassed && flow.settlementStatus === "released" ? "passed" : "degraded";
  const history = await appendTenantFirstPaidCallAttempt({
    tenantId,
    attempt: {
      attemptId,
      startedAt,
      completedAt: nowIso(),
      status,
      ids: flow.ids,
      verificationStatus: flow.verificationStatus,
      settlementStatus: flow.settlementStatus,
      config,
      error: null
    }
  });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_RUNTIME_FIRST_PAID_CALL_COMPLETED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "run",
        targetId: flow.ids.runId,
        details: {
          attemptId,
          posterAgentId: flow.ids.posterAgentId,
          bidderAgentId: flow.ids.bidderAgentId,
          rfqId: flow.ids.rfqId,
          bidId: flow.ids.bidId,
          verificationStatus: flow.verificationStatus ?? null,
          settlementStatus: flow.settlementStatus ?? null
        }
      }
    });
  } catch {
    // ignore audit write failures for onboarding convenience endpoint
  }

  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkFirstPaidCall.v1",
    tenantId,
    replayed: false,
    attemptId,
    ids: flow.ids,
    verificationStatus: flow.verificationStatus,
    settlementStatus: flow.settlementStatus,
    verification: flow.verification,
    settlement: flow.settlement,
    history: {
      updatedAt: history.updatedAt,
      count: Array.isArray(history.attempts) ? history.attempts.length : 0
    }
  });
}

async function handleTenantRuntimeConformanceMatrix(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 40_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (json === null) json = {};
  if (!isPlainObject(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const idempotencyHeader = req.headers["x-idempotency-key"] ? String(req.headers["x-idempotency-key"]).trim() : "";
  const idempotencyBody = typeof json.idempotencyKey === "string" ? json.idempotencyKey.trim() : "";
  const idempotencyKey = idempotencyHeader || idempotencyBody || null;
  if (idempotencyKey && (idempotencyKey.length > 160 || /[\r\n]/.test(idempotencyKey))) {
    return sendJson(res, 400, { ok: false, code: "INVALID_IDEMPOTENCY_KEY", message: "idempotencyKey must be <= 160 chars and single-line" });
  }
  if (idempotencyKey) {
    const existing = await loadTenantConformanceIdempotentResultBestEffort({ tenantId, idempotencyKey });
    if (existing?.response) {
      const cached = {
        ...existing.response,
        idempotency: {
          keyHash: existing.idempotencyKeyHash,
          reused: true,
          createdAt: existing.createdAt
        }
      };
      return sendJson(res, Number.isInteger(existing.statusCode) ? existing.statusCode : 200, cached);
    }
  }

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const limits = tenantRateLimits(tenantSettings);
  const rl = applyRateLimit({ req, tenantId, tenantSettings, category: "conformance", limitPerHour: limits.conformanceRunsPerHour });
  if (!rl.ok) {
    metrics.incCounter("quota_rejects_total", { tenantId, reason: "rate_limit" }, 1);
    metrics.incCounter("rate_limit_events_total", { tenantId, category: "conformance", scope: rl.scope ?? "tenant" }, 1);
    res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
    return sendJson(res, 429, {
      ok: false,
      code: "RATE_LIMITED",
      message: "rate limit exceeded",
      retryAfterSeconds: rl.retryAfterSeconds ?? null,
      scope: rl.scope ?? null
    });
  }

  const targetsRaw = Array.isArray(json.targets) ? json.targets : ["codex", "claude", "cursor", "openclaw"];
  const targets = [...new Set(
    targetsRaw
      .map((row) => String(row ?? "").trim().toLowerCase())
      .filter((row) => row === "codex" || row === "claude" || row === "cursor" || row === "openclaw" || row === "openhands")
  )];
  if (!targets.length) {
    return sendJson(res, 400, {
      ok: false,
      code: "INVALID_TARGETS",
      message: "targets must include codex|claude|cursor|openclaw|openhands"
    });
  }

  const matrixRunId = `mx_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  const checks = [];
  let mcpEnv = null;
  let runtimeApiKey = null;
  let paidFlow = null;

  const bootstrap = await callSettldTenantBootstrap({
    tenantId,
    payload: {
      apiKey: {
        create: true,
        description: "magic-link conformance matrix runtime key"
      }
    }
  });
  if (bootstrap.ok) {
    const apiBaseUrl = typeof bootstrap.response?.bootstrap?.apiBaseUrl === "string" && bootstrap.response.bootstrap.apiBaseUrl.trim()
      ? bootstrap.response.bootstrap.apiBaseUrl.trim()
      : settldApiBaseUrl;
    runtimeApiKey = typeof bootstrap.response?.bootstrap?.apiKey?.token === "string" ? bootstrap.response.bootstrap.apiKey.token.trim() : "";
    mcpEnv = {
      SETTLD_BASE_URL: apiBaseUrl,
      SETTLD_TENANT_ID: tenantId,
      SETTLD_API_KEY: runtimeApiKey,
      SETTLD_PROTOCOL: settldProtocol
    };
    checks.push({
      checkId: "runtime_bootstrap",
      status: runtimeApiKey ? "pass" : "fail",
      detail: {
        apiKeyId: typeof bootstrap.response?.bootstrap?.apiKey?.keyId === "string" ? bootstrap.response.bootstrap.apiKey.keyId : null
      }
    });
  } else {
    checks.push({
      checkId: "runtime_bootstrap",
      status: "fail",
      detail: { code: bootstrap.code ?? null, message: bootstrap.message ?? null }
    });
  }

  let smoke = null;
  if (runtimeApiKey && mcpEnv) {
    smoke = await runMcpInitializeToolsListSmoke({ env: mcpEnv, timeoutMs: 10_000 });
    checks.push({
      checkId: "mcp_smoke",
      status: smoke.ok ? "pass" : "fail",
      detail: smoke.ok
        ? { toolsCount: smoke.smoke?.toolsCount ?? null, sampleTools: smoke.smoke?.sampleTools ?? [] }
        : { code: smoke.error ?? null, message: smoke?.detail?.message ?? null }
    });
  } else {
    checks.push({
      checkId: "mcp_smoke",
      status: "fail",
      detail: { code: "RUNTIME_NOT_READY", message: "runtime bootstrap did not return API key" }
    });
  }

  if (runtimeApiKey && smoke?.ok) {
    const flow = await runTenantFirstPaidCallFlow({
      tenantId,
      runtimeApiKey,
      payerCreditAmountCents: 2_500,
      budgetCents: 1_200,
      bidAmountCents: 1_100,
      currency: "USD",
      flowPrefix: matrixRunId
    });
    if (flow.ok) {
      paidFlow = flow;
      const verificationPassed = flow.verificationStatus === "green";
      const settlementReleased = flow.settlementStatus === "released";
      checks.push({
        checkId: "first_paid_call",
        status: verificationPassed && settlementReleased ? "pass" : "fail",
        detail: {
          runId: flow.ids?.runId ?? null,
          verificationStatus: flow.verificationStatus ?? null,
          settlementStatus: flow.settlementStatus ?? null
        }
      });
      await markTenantOnboardingProgress({
        dataDir,
        tenantId,
        isSample: false,
        verificationOk: verificationPassed
      });
      await appendTenantFirstPaidCallAttempt({
        tenantId,
        attempt: {
          attemptId: matrixRunId,
          startedAt: nowIso(),
          completedAt: nowIso(),
          status: verificationPassed && settlementReleased ? "passed" : "degraded",
          ids: flow.ids,
          verificationStatus: flow.verificationStatus,
          settlementStatus: flow.settlementStatus,
          config: {
            payerCreditAmountCents: 2_500,
            budgetCents: 1_200,
            bidAmountCents: 1_100,
            currency: "USD",
            source: "conformance_matrix"
          }
        }
      });
    } else {
      checks.push({
        checkId: "first_paid_call",
        status: "fail",
        detail: { code: flow.code ?? null, step: flow.step ?? null, message: flow.message ?? null }
      });
    }
  } else {
    checks.push({
      checkId: "first_paid_call",
      status: "fail",
      detail: { code: "RUNTIME_NOT_READY", message: "MCP smoke must pass before first paid call check" }
    });
  }

  const checkById = new Map(checks.map((row) => [row.checkId, row]));
  const bootstrapOk = checkById.get("runtime_bootstrap")?.status === "pass";
  const smokeOk = checkById.get("mcp_smoke")?.status === "pass";
  const paidOk = checkById.get("first_paid_call")?.status === "pass";
  const targetRows = targets.map((target) => {
    const serverConfig = mcpEnv ? { command: "npx", args: ["-y", "settld-mcp"], env: mcpEnv } : null;
    let config;
    if (target === "openhands") {
      config = {
        env: mcpEnv
          ? Object.entries(mcpEnv).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join("\n")
          : null
      };
    } else if (target === "openclaw") {
      config = {
        mcpServer: serverConfig,
        mcpServers: serverConfig ? { settld: serverConfig } : null
      };
    } else {
      config = {
        mcpServers: serverConfig ? { settld: serverConfig } : null
      };
    }
    return {
      target,
      status: bootstrapOk && smokeOk && paidOk ? "pass" : "fail",
      config
    };
  });

  const matrix = {
    schemaVersion: "MagicLinkRuntimeConformanceMatrix.v1",
    tenantId,
    runId: matrixRunId,
    generatedAt: nowIso(),
    checks,
    targets: targetRows,
    ready: bootstrapOk && smokeOk && paidOk,
    firstPaidCall: paidFlow
      ? {
          ids: paidFlow.ids,
          verificationStatus: paidFlow.verificationStatus,
          settlementStatus: paidFlow.settlementStatus
        }
      : null
  };

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_RUNTIME_CONFORMANCE_MATRIX_RUN",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant",
        targetId: tenantId,
        details: {
          runId: matrixRunId,
          ready: matrix.ready,
          checks: checks.map((row) => ({ checkId: row.checkId, status: row.status }))
        }
      }
    });
  } catch {
    // ignore audit write failures for conformance helper endpoint
  }

  const responseBody = {
    ok: true,
    matrix,
    idempotency: {
      keyHash: idempotencyKey ? sha256Hex(String(idempotencyKey)) : null,
      reused: false,
      createdAt: nowIso()
    }
  };
  if (idempotencyKey) {
    try {
      await saveTenantConformanceIdempotentResult({
        tenantId,
        idempotencyKey,
        statusCode: 200,
        response: responseBody
      });
    } catch {
      // ignore idempotency persistence failures
    }
  }

  return sendJson(res, 200, responseBody);
}

async function handleTenantOnboardingEvent(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  }

  const eventType = typeof json.eventType === "string" ? json.eventType.trim() : "";
  if (!eventType) return sendJson(res, 400, { ok: false, code: "EVENT_TYPE_REQUIRED", message: "eventType is required" });
  const at = json.at === undefined || json.at === null || String(json.at).trim() === "" ? null : String(json.at).trim();
  if (at !== null && !Number.isFinite(Date.parse(at))) {
    return sendJson(res, 400, { ok: false, code: "INVALID_AT", message: "at must be an ISO date-time" });
  }
  const source = typeof json.source === "string" && json.source.trim() !== "" ? json.source.trim() : null;
  const metadata = json.metadata === undefined ? null : json.metadata;
  if (metadata !== null && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    return sendJson(res, 400, { ok: false, code: "INVALID_METADATA", message: "metadata must be an object" });
  }

  const recorded = await recordTenantOnboardingEvent({
    dataDir,
    tenantId,
    eventType,
    at,
    source,
    metadata
  });
  if (!recorded.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_EVENT", message: recorded.error ?? "invalid onboarding event" });
  }

  const metrics = onboardingMetricsFromProfile(recorded.profile);
  let onboardingEmailSequence = null;
  try {
    const sequenceDispatch = await dispatchOnboardingEmailSequenceBestEffort({
      dataDir,
      tenantId,
      profile: recorded.profile,
      enabled: onboardingEmailSequenceEnabled,
      deliveryMode: onboardingEmailSequenceDeliveryMode,
      smtpConfig,
      publicBaseUrl
    });
    onboardingEmailSequence = buildOnboardingEmailSequenceStatus({
      tenantId,
      profile: recorded.profile,
      state: sequenceDispatch?.state ?? null,
      enabled: onboardingEmailSequenceEnabled,
      deliveryMode: onboardingEmailSequenceDeliveryMode
    });
  } catch {
    onboardingEmailSequence = null;
  }
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    eventType,
    at: metrics?.events?.latestEvent?.at ?? nowIso(),
    metrics,
    onboardingEmailSequence
  });
}

const TENANT_SETTLEMENT_POLICY_SCHEMA_VERSION = "TenantSettlementPolicy.v1";
const TENANT_SETTLEMENT_POLICY_REGISTRY_SCHEMA_VERSION = "TenantSettlementPolicyRegistry.v1";
const MARKETPLACE_SETTLEMENT_POLICY_REF_SCHEMA_VERSION = "MarketplaceSettlementPolicyRef.v1";
const TENANT_SETTLEMENT_POLICY_ROLLOUT_SCHEMA_VERSION = "TenantSettlementPolicyRollout.v1";
const SETTLEMENT_POLICY_ROLLOUT_STAGE = Object.freeze({
  DRAFT: "draft",
  CANARY: "canary",
  ACTIVE: "active"
});
const SETTLEMENT_POLICY_ROLLOUT_HISTORY_LIMIT = 200;
const SETTLEMENT_POLICY_PRESET_SCHEMA_VERSION = "TenantSettlementPolicyPreset.v1";

const TENANT_SETTLEMENT_POLICY_PRESET_PACKS = Object.freeze([
  Object.freeze({
    presetId: "balanced_guardrails_v1",
    schemaVersion: SETTLEMENT_POLICY_PRESET_SCHEMA_VERSION,
    presetVersion: 1,
    name: "Balanced Guardrails",
    description: "Production default with moderate holdbacks and a standard dispute window.",
    policyId: "market.preset.balanced-v1",
    verificationMethod: Object.freeze({ mode: "deterministic" }),
    controls: Object.freeze({
      maxAutoReleaseAmountCents: 150_000,
      holdbackRatePct: Object.freeze({ green: 10, amber: 60, red: 100 }),
      disputeWindowHours: 72
    }),
    policy: Object.freeze({
      mode: "automatic",
      rules: Object.freeze({
        requireDeterministicVerification: true,
        autoReleaseOnGreen: true,
        autoReleaseOnAmber: true,
        autoReleaseOnRed: false,
        greenReleaseRatePct: 90,
        amberReleaseRatePct: 40,
        redReleaseRatePct: 0,
        maxAutoReleaseAmountCents: 150_000,
        disputeWindowHours: 72,
        manualReason: "Escalate unresolved disagreements after dispute window."
      })
    })
  }),
  Object.freeze({
    presetId: "high_autonomy_low_risk_v1",
    schemaVersion: SETTLEMENT_POLICY_PRESET_SCHEMA_VERSION,
    presetVersion: 1,
    name: "High Autonomy (Low Risk)",
    description: "Fast auto-settlement with larger spend caps and short dispute windows.",
    policyId: "market.preset.high-autonomy-v1",
    verificationMethod: Object.freeze({ mode: "deterministic" }),
    controls: Object.freeze({
      maxAutoReleaseAmountCents: 300_000,
      holdbackRatePct: Object.freeze({ green: 0, amber: 40, red: 100 }),
      disputeWindowHours: 24
    }),
    policy: Object.freeze({
      mode: "automatic",
      rules: Object.freeze({
        requireDeterministicVerification: true,
        autoReleaseOnGreen: true,
        autoReleaseOnAmber: true,
        autoReleaseOnRed: false,
        greenReleaseRatePct: 100,
        amberReleaseRatePct: 60,
        redReleaseRatePct: 0,
        maxAutoReleaseAmountCents: 300_000,
        disputeWindowHours: 24,
        manualReason: "Escalate only when automated checks fail."
      })
    })
  }),
  Object.freeze({
    presetId: "manual_review_high_risk_v1",
    schemaVersion: SETTLEMENT_POLICY_PRESET_SCHEMA_VERSION,
    presetVersion: 1,
    name: "Manual Review (High Risk)",
    description: "Conservative controls with strict holdbacks and long dispute windows.",
    policyId: "market.preset.manual-review-v1",
    verificationMethod: Object.freeze({ mode: "deterministic" }),
    controls: Object.freeze({
      maxAutoReleaseAmountCents: 50_000,
      holdbackRatePct: Object.freeze({ green: 30, amber: 100, red: 100 }),
      disputeWindowHours: 168
    }),
    policy: Object.freeze({
      mode: "manual-review",
      rules: Object.freeze({
        requireDeterministicVerification: true,
        autoReleaseOnGreen: false,
        autoReleaseOnAmber: false,
        autoReleaseOnRed: false,
        greenReleaseRatePct: 70,
        amberReleaseRatePct: 0,
        redReleaseRatePct: 0,
        maxAutoReleaseAmountCents: 50_000,
        disputeWindowHours: 168,
        manualReason: "High-risk workflow requires operator review."
      })
    })
  })
]);

function parseSettlementPolicyPresetId(rawValue, { fieldPath = "presetId" } = {}) {
  const value = String(rawValue ?? "").trim();
  if (!value) throw new TypeError(`${fieldPath} is required`);
  if (value.length > 128) throw new TypeError(`${fieldPath} must be <= 128 chars`);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new TypeError(`${fieldPath} must match [A-Za-z0-9._:-]+`);
  return value;
}

function listTenantSettlementPolicyPresetPacks() {
  return TENANT_SETTLEMENT_POLICY_PRESET_PACKS.map((row) => ({
    presetId: row.presetId,
    schemaVersion: row.schemaVersion,
    presetVersion: row.presetVersion,
    name: row.name,
    description: row.description,
    policyId: row.policyId,
    verificationMethod: row.verificationMethod,
    controls: row.controls,
    policy: row.policy
  }));
}

function getTenantSettlementPolicyPresetPackById(presetId) {
  const id = String(presetId ?? "").trim();
  return TENANT_SETTLEMENT_POLICY_PRESET_PACKS.find((row) => row.presetId === id) ?? null;
}

function parseSettlementPolicyRegistryId(rawValue, { fieldPath = "policyId" } = {}) {
  const value = String(rawValue ?? "").trim();
  if (!value) throw new TypeError(`${fieldPath} is required`);
  if (value.length > 128) throw new TypeError(`${fieldPath} must be <= 128 chars`);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new TypeError(`${fieldPath} must match [A-Za-z0-9._:-]+`);
  return value;
}

function parseSettlementPolicyVersion(rawValue, { fieldPath = "policyVersion" } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${fieldPath} must be a positive safe integer`);
  return parsed;
}

function parseSettlementStatus(rawValue, { fieldPath = "verificationStatus", allowNull = false } = {}) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  const status = String(rawValue).trim().toLowerCase();
  if (status !== "green" && status !== "amber" && status !== "red") {
    throw new TypeError(`${fieldPath} must be green|amber|red`);
  }
  return status;
}

function parseSettlementRunStatus(rawValue, { fieldPath = "runStatus", allowNull = false } = {}) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  const status = String(rawValue).trim().toLowerCase();
  if (status !== "completed" && status !== "failed") throw new TypeError(`${fieldPath} must be completed|failed`);
  return status;
}

function parseSettlementPolicyRolloutStage(rawValue, { fieldPath = "stage", allowNull = false } = {}) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  const stage = String(rawValue).trim().toLowerCase();
  if (
    stage !== SETTLEMENT_POLICY_ROLLOUT_STAGE.DRAFT &&
    stage !== SETTLEMENT_POLICY_ROLLOUT_STAGE.CANARY &&
    stage !== SETTLEMENT_POLICY_ROLLOUT_STAGE.ACTIVE
  ) {
    throw new TypeError(`${fieldPath} must be draft|canary|active`);
  }
  return stage;
}

function parseSettlementPolicyRolloutPercent(rawValue, { fieldPath = "rolloutPercent", allowNull = false } = {}) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new TypeError(`${fieldPath} must be an integer within 0..100`);
  }
  return parsed;
}

function tenantSettlementPolicyRegistryPath({ tenantId }) {
  return path.join(dataDir, "tenants", tenantId, "settlement_policies.json");
}

function settlementPolicyRecordSort(a, b) {
  const idCmp = cmpString(a?.policyId ?? "", b?.policyId ?? "");
  if (idCmp !== 0) return idCmp;
  return Number(b?.policyVersion ?? 0) - Number(a?.policyVersion ?? 0);
}

function defaultTenantSettlementPolicyRegistry({ tenantId }) {
  return {
    schemaVersion: TENANT_SETTLEMENT_POLICY_REGISTRY_SCHEMA_VERSION,
    tenantId,
    defaultPolicyRef: null,
    rollout: defaultTenantSettlementPolicyRollout({ activePolicyRef: null }),
    policies: []
  };
}

function normalizeTenantSettlementPolicyRecord(record, { tenantId }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  let policyId;
  let policyVersion;
  let policy = null;
  let verificationMethod = null;
  let policyHash;
  let verificationMethodHash;
  try {
    policyId = parseSettlementPolicyRegistryId(record.policyId, { fieldPath: "policyId" });
    policyVersion = parseSettlementPolicyVersion(record.policyVersion, { fieldPath: "policyVersion" });
    verificationMethod = normalizeVerificationMethod(record.verificationMethod ?? null);
    policy = normalizeSettlementPolicy({
      ...(record.policy && typeof record.policy === "object" && !Array.isArray(record.policy) ? record.policy : {}),
      policyVersion
    });
    policyHash = computeSettlementPolicyHash(policy);
    verificationMethodHash = computeVerificationMethodHash(verificationMethod);
  } catch {
    return null;
  }

  const description =
    record.description === null || record.description === undefined || String(record.description).trim() === ""
      ? null
      : safeTruncate(String(record.description).trim(), { max: 500 });
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? { ...record.metadata } : null;

  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : nowIso();
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : createdAt;
  return {
    schemaVersion: TENANT_SETTLEMENT_POLICY_SCHEMA_VERSION,
    tenantId,
    policyId,
    policyVersion,
    policyHash,
    verificationMethodHash,
    verificationMethod,
    policy,
    description,
    metadata,
    createdAt,
    updatedAt
  };
}

function normalizeTenantSettlementPolicyRef(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return {
    schemaVersion: MARKETPLACE_SETTLEMENT_POLICY_REF_SCHEMA_VERSION,
    source: "tenant_registry",
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    policyHash: record.policyHash,
    verificationMethodHash: record.verificationMethodHash
  };
}

function parseTenantSettlementPolicyRefInput(input, { fieldPath = "policyRef", allowNull = false } = {}) {
  if (input === null || input === undefined || input === "") {
    if (allowNull) return null;
    throw new TypeError(`${fieldPath} is required`);
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${fieldPath} must be an object`);
  }
  const policyId = parseSettlementPolicyRegistryId(input.policyId, { fieldPath: `${fieldPath}.policyId` });
  const policyVersion = parseSettlementPolicyVersion(input.policyVersion, { fieldPath: `${fieldPath}.policyVersion` });
  return { policyId, policyVersion };
}

function cloneTenantSettlementPolicyRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const parsed = parseTenantSettlementPolicyRefInput(ref, { allowNull: true });
  if (!parsed) return null;
  return {
    schemaVersion: MARKETPLACE_SETTLEMENT_POLICY_REF_SCHEMA_VERSION,
    source: "tenant_registry",
    policyId: parsed.policyId,
    policyVersion: parsed.policyVersion,
    policyHash:
      typeof ref.policyHash === "string" && ref.policyHash.trim() !== ""
        ? String(ref.policyHash).trim().toLowerCase()
        : null,
    verificationMethodHash:
      typeof ref.verificationMethodHash === "string" && ref.verificationMethodHash.trim() !== ""
        ? String(ref.verificationMethodHash).trim().toLowerCase()
        : null
  };
}

function settlementPolicyRefEquals(a, b) {
  const left = cloneTenantSettlementPolicyRef(a);
  const right = cloneTenantSettlementPolicyRef(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return String(left.policyId) === String(right.policyId) && Number(left.policyVersion) === Number(right.policyVersion);
}

function defaultTenantSettlementPolicyRollout({ activePolicyRef = null } = {}) {
  return {
    schemaVersion: TENANT_SETTLEMENT_POLICY_ROLLOUT_SCHEMA_VERSION,
    stages: {
      draft: null,
      canary: { policyRef: null, rolloutPercent: 0 },
      active: cloneTenantSettlementPolicyRef(activePolicyRef)
    },
    history: []
  };
}

function getRolloutPolicyRecordFromRef({ registry, ref }) {
  const parsed = cloneTenantSettlementPolicyRef(ref);
  if (!parsed) return null;
  return getTenantSettlementPolicyRecord({
    registry,
    policyId: parsed.policyId,
    policyVersion: parsed.policyVersion
  });
}

function rolloutRefFromRegistryOrNull({ registry, ref }) {
  const record = getRolloutPolicyRecordFromRef({ registry, ref });
  return record ? normalizeTenantSettlementPolicyRef(record) : null;
}

function normalizeTenantSettlementPolicyRollout({ rollout, registry, activeFallbackRef = null } = {}) {
  const out = defaultTenantSettlementPolicyRollout({ activePolicyRef: activeFallbackRef });
  const source = rollout && typeof rollout === "object" && !Array.isArray(rollout) ? rollout : {};
  const stages = source.stages && typeof source.stages === "object" && !Array.isArray(source.stages) ? source.stages : {};

  out.stages.draft = rolloutRefFromRegistryOrNull({ registry, ref: stages.draft });

  const canarySource = stages.canary && typeof stages.canary === "object" && !Array.isArray(stages.canary) ? stages.canary : {};
  const canaryRef = rolloutRefFromRegistryOrNull({ registry, ref: canarySource.policyRef ?? null });
  let canaryPercent = 0;
  try {
    canaryPercent = parseSettlementPolicyRolloutPercent(canarySource.rolloutPercent, { allowNull: true }) ?? 0;
  } catch {
    canaryPercent = 0;
  }
  out.stages.canary = {
    policyRef: canaryRef,
    rolloutPercent: canaryRef ? Math.max(1, canaryPercent || 10) : 0
  };

  out.stages.active = rolloutRefFromRegistryOrNull({ registry, ref: stages.active ?? activeFallbackRef ?? null });
  if (!out.stages.active && activeFallbackRef) {
    out.stages.active = rolloutRefFromRegistryOrNull({ registry, ref: activeFallbackRef }) ?? null;
  }

  const historyRows = Array.isArray(source.history) ? source.history : [];
  const normalizedHistory = [];
  for (const row of historyRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    let stage = null;
    try {
      stage = parseSettlementPolicyRolloutStage(row.stage ?? null, { allowNull: true });
    } catch {
      stage = null;
    }
    let rolloutPercent = null;
    try {
      rolloutPercent = parseSettlementPolicyRolloutPercent(row.rolloutPercent ?? null, { allowNull: true });
    } catch {
      rolloutPercent = null;
    }
    const at = typeof row.at === "string" && row.at.trim() !== "" && Number.isFinite(Date.parse(row.at)) ? row.at : nowIso();
    const action = typeof row.action === "string" && row.action.trim() !== "" ? safeTruncate(row.action.trim(), { max: 80 }) : "update";
    const note =
      typeof row.note === "string" && row.note.trim() !== ""
        ? safeTruncate(row.note.trim(), { max: 500 })
        : null;
    const actorEmail =
      typeof row.actorEmail === "string" && row.actorEmail.trim() !== ""
        ? safeTruncate(row.actorEmail.trim(), { max: 320 })
        : null;
    normalizedHistory.push({
      at,
      action,
      stage,
      fromPolicyRef: cloneTenantSettlementPolicyRef(row.fromPolicyRef ?? null),
      toPolicyRef: cloneTenantSettlementPolicyRef(row.toPolicyRef ?? null),
      rolloutPercent,
      note,
      actorEmail
    });
  }
  out.history = normalizedHistory.slice(-SETTLEMENT_POLICY_ROLLOUT_HISTORY_LIMIT);
  return out;
}

function appendSettlementPolicyRolloutHistory({ rollout, entry }) {
  if (!rollout || typeof rollout !== "object" || Array.isArray(rollout)) return;
  if (!Array.isArray(rollout.history)) rollout.history = [];
  rollout.history.push({
    at:
      typeof entry?.at === "string" && Number.isFinite(Date.parse(entry.at))
        ? entry.at
        : nowIso(),
    action:
      typeof entry?.action === "string" && entry.action.trim() !== ""
        ? safeTruncate(entry.action.trim(), { max: 80 })
        : "update",
    stage: (() => {
      try {
        return parseSettlementPolicyRolloutStage(entry?.stage ?? null, { allowNull: true });
      } catch {
        return null;
      }
    })(),
    fromPolicyRef: cloneTenantSettlementPolicyRef(entry?.fromPolicyRef ?? null),
    toPolicyRef: cloneTenantSettlementPolicyRef(entry?.toPolicyRef ?? null),
    rolloutPercent: (() => {
      try {
        return parseSettlementPolicyRolloutPercent(entry?.rolloutPercent ?? null, { allowNull: true });
      } catch {
        return null;
      }
    })(),
    note:
      typeof entry?.note === "string" && entry.note.trim() !== ""
        ? safeTruncate(entry.note.trim(), { max: 500 })
        : null,
    actorEmail:
      typeof entry?.actorEmail === "string" && entry.actorEmail.trim() !== ""
        ? safeTruncate(entry.actorEmail.trim(), { max: 320 })
        : null
  });
  if (rollout.history.length > SETTLEMENT_POLICY_ROLLOUT_HISTORY_LIMIT) {
    rollout.history = rollout.history.slice(-SETTLEMENT_POLICY_ROLLOUT_HISTORY_LIMIT);
  }
}

function settlementPolicyRefToKey(ref) {
  const parsed = cloneTenantSettlementPolicyRef(ref);
  if (!parsed) return null;
  return `${parsed.policyId}@${parsed.policyVersion}`;
}

function normalizeSettlementPolicyRolloutNote(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  return safeTruncate(value, { max: 500 });
}

function parseTenantSettlementPolicyRefFromBody(body, { fieldPath = "policyRef", allowNull = false } = {}) {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const directRef = obj.policyRef && typeof obj.policyRef === "object" && !Array.isArray(obj.policyRef) ? obj.policyRef : null;
  const input =
    directRef ??
    (obj.policyId !== undefined || obj.policyVersion !== undefined
      ? { policyId: obj.policyId, policyVersion: obj.policyVersion }
      : null);
  return parseTenantSettlementPolicyRefInput(input, { fieldPath, allowNull });
}

function flattenSettlementPolicyDiffObject(value, { pathPrefix = "", out = new Map() } = {}) {
  if (value === null || value === undefined) {
    out.set(pathPrefix || "$", null);
    return out;
  }
  if (Array.isArray(value)) {
    out.set(pathPrefix || "$", value);
    return out;
  }
  if (typeof value !== "object") {
    out.set(pathPrefix || "$", value);
    return out;
  }
  const keys = Object.keys(value).sort(cmpString);
  if (!keys.length) {
    out.set(pathPrefix || "$", {});
    return out;
  }
  for (const key of keys) {
    const next = pathPrefix ? `${pathPrefix}.${key}` : key;
    flattenSettlementPolicyDiffObject(value[key], { pathPrefix: next, out });
  }
  return out;
}

function settlementPolicyDiffValueEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildTenantSettlementPolicyDiff({ fromPolicy, toPolicy, includeUnchanged = false, limit = 200 } = {}) {
  const left = fromPolicy && typeof fromPolicy === "object" && !Array.isArray(fromPolicy) ? fromPolicy : {};
  const right = toPolicy && typeof toPolicy === "object" && !Array.isArray(toPolicy) ? toPolicy : {};
  const leftMap = flattenSettlementPolicyDiffObject(left);
  const rightMap = flattenSettlementPolicyDiffObject(right);
  const paths = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort(cmpString);

  const changes = [];
  let changedCount = 0;
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  for (const pathName of paths) {
    const hasBefore = leftMap.has(pathName);
    const hasAfter = rightMap.has(pathName);
    const beforeValue = hasBefore ? leftMap.get(pathName) : null;
    const afterValue = hasAfter ? rightMap.get(pathName) : null;
    const equal = hasBefore === hasAfter && settlementPolicyDiffValueEquals(beforeValue, afterValue);
    if (equal) {
      unchangedCount += 1;
      if (!includeUnchanged) continue;
      changes.push({ path: pathName, kind: "unchanged", fromValue: beforeValue, toValue: afterValue });
      continue;
    }
    if (!hasBefore && hasAfter) {
      addedCount += 1;
      changes.push({ path: pathName, kind: "added", fromValue: null, toValue: afterValue });
      continue;
    }
    if (hasBefore && !hasAfter) {
      removedCount += 1;
      changes.push({ path: pathName, kind: "removed", fromValue: beforeValue, toValue: null });
      continue;
    }
    changedCount += 1;
    changes.push({ path: pathName, kind: "changed", fromValue: beforeValue, toValue: afterValue });
  }

  return {
    summary: {
      totalPaths: paths.length,
      changed: changedCount,
      added: addedCount,
      removed: removedCount,
      unchanged: unchangedCount,
      includeUnchanged: Boolean(includeUnchanged)
    },
    changes: changes.slice(0, Math.max(1, limit)),
    limited: changes.length > Math.max(1, limit)
  };
}

function findSettlementPolicyRollbackTargetRef({ rollout, currentActiveRef }) {
  const historyRows = Array.isArray(rollout?.history) ? [...rollout.history] : [];
  for (let idx = historyRows.length - 1; idx >= 0; idx -= 1) {
    const row = historyRows[idx];
    if (!row || row.stage !== SETTLEMENT_POLICY_ROLLOUT_STAGE.ACTIVE) continue;
    const fromRef = cloneTenantSettlementPolicyRef(row.fromPolicyRef ?? null);
    if (!fromRef) continue;
    if (settlementPolicyRefEquals(fromRef, currentActiveRef)) continue;
    return fromRef;
  }
  return null;
}

async function loadTenantSettlementPolicyRegistry({ tenantId }) {
  const fp = tenantSettlementPolicyRegistryPath({ tenantId });
  try {
    const raw = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultTenantSettlementPolicyRegistry({ tenantId });
    const policiesRaw = Array.isArray(parsed.policies) ? parsed.policies : [];
    const normalizedPolicies = [];
    for (const row of policiesRaw) {
      const normalized = normalizeTenantSettlementPolicyRecord(row, { tenantId });
      if (normalized) normalizedPolicies.push(normalized);
    }
    normalizedPolicies.sort(settlementPolicyRecordSort);
    const defaultRef = parsed.defaultPolicyRef && typeof parsed.defaultPolicyRef === "object" && !Array.isArray(parsed.defaultPolicyRef) ? parsed.defaultPolicyRef : null;
    const defaultRecord =
      defaultRef &&
      normalizedPolicies.find((row) => row.policyId === String(defaultRef.policyId ?? "") && Number(row.policyVersion) === Number(defaultRef.policyVersion)) ||
      null;
    const activeFallbackRef = defaultRecord ? normalizeTenantSettlementPolicyRef(defaultRecord) : null;
    const rollout = normalizeTenantSettlementPolicyRollout({
      rollout: parsed.rollout,
      registry: { policies: normalizedPolicies },
      activeFallbackRef
    });
    const activeRecord = rollout.stages.active
      ? normalizedPolicies.find(
          (row) =>
            row.policyId === String(rollout.stages.active.policyId ?? "") &&
            Number(row.policyVersion) === Number(rollout.stages.active.policyVersion)
        ) ?? null
      : null;
    return {
      schemaVersion: TENANT_SETTLEMENT_POLICY_REGISTRY_SCHEMA_VERSION,
      tenantId,
      defaultPolicyRef: activeRecord ? normalizeTenantSettlementPolicyRef(activeRecord) : activeFallbackRef,
      rollout,
      policies: normalizedPolicies
    };
  } catch {
    return defaultTenantSettlementPolicyRegistry({ tenantId });
  }
}

async function saveTenantSettlementPolicyRegistry({ tenantId, registry }) {
  const fp = tenantSettlementPolicyRegistryPath({ tenantId });
  const policiesRaw = Array.isArray(registry?.policies) ? registry.policies : [];
  const normalizedPolicies = [];
  for (const row of policiesRaw) {
    const normalized = normalizeTenantSettlementPolicyRecord(row, { tenantId });
    if (normalized) normalizedPolicies.push(normalized);
  }
  normalizedPolicies.sort(settlementPolicyRecordSort);
  const defaultRef = registry?.defaultPolicyRef && typeof registry.defaultPolicyRef === "object" && !Array.isArray(registry.defaultPolicyRef) ? registry.defaultPolicyRef : null;
  const fallbackDefaultRecord =
    defaultRef &&
    normalizedPolicies.find((row) => row.policyId === String(defaultRef.policyId ?? "") && Number(row.policyVersion) === Number(defaultRef.policyVersion)) ||
    null;
  const rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry?.rollout,
    registry: { policies: normalizedPolicies },
    activeFallbackRef: fallbackDefaultRecord ? normalizeTenantSettlementPolicyRef(fallbackDefaultRecord) : null
  });
  const defaultRecord = rollout.stages.active
    ? normalizedPolicies.find(
        (row) =>
          row.policyId === String(rollout.stages.active.policyId ?? "") &&
          Number(row.policyVersion) === Number(rollout.stages.active.policyVersion)
      ) ?? null
    : fallbackDefaultRecord;
  const out = {
    schemaVersion: TENANT_SETTLEMENT_POLICY_REGISTRY_SCHEMA_VERSION,
    tenantId,
    defaultPolicyRef: defaultRecord ? normalizeTenantSettlementPolicyRef(defaultRecord) : null,
    rollout,
    policies: normalizedPolicies
  };
  await ensureDir(fp);
  await fs.writeFile(fp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

function listTenantSettlementPolicyRecords({ registry, policyId = null } = {}) {
  const rows = Array.isArray(registry?.policies) ? registry.policies : [];
  if (!policyId) return rows;
  const id = String(policyId).trim();
  return rows.filter((row) => row.policyId === id);
}

function getTenantSettlementPolicyRecord({ registry, policyId, policyVersion }) {
  const id = String(policyId ?? "").trim();
  const version = Number(policyVersion);
  if (!id || !Number.isSafeInteger(version) || version < 1) return null;
  const rows = Array.isArray(registry?.policies) ? registry.policies : [];
  return rows.find((row) => row.policyId === id && Number(row.policyVersion) === version) ?? null;
}

async function inferVerificationStatusFromToken(token) {
  if (typeof token !== "string" || !/^ml_[0-9a-f]{48}$/.test(token)) {
    return { ok: false, code: "INVALID_TOKEN", message: "token must match ml_[0-9a-f]{48}" };
  }
  let meta = null;
  try {
    meta = await loadMeta(token);
  } catch {
    return { ok: false, code: "TOKEN_NOT_FOUND", message: "token not found" };
  }
  if (!meta?.verifyJsonPath) return { ok: false, code: "TOKEN_VERIFY_NOT_FOUND", message: "verify output not found for token" };
  let verify = null;
  try {
    const raw = await fs.readFile(meta.verifyJsonPath, "utf8");
    verify = JSON.parse(raw);
  } catch {
    return { ok: false, code: "TOKEN_VERIFY_INVALID", message: "verify output for token is unreadable" };
  }
  const verificationStatus = statusFromCliOutput(verify);
  return {
    ok: true,
    verificationStatus,
    runStatus: "completed",
    token
  };
}

async function handleTenantSettlementPoliciesState(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const policyIdRaw = url.searchParams.get("policyId");
  let policyId = null;
  if (policyIdRaw !== null && String(policyIdRaw).trim() !== "") {
    try {
      policyId = parseSettlementPolicyRegistryId(policyIdRaw, { fieldPath: "policyId" });
    } catch (err) {
      return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_ID", message: err?.message ?? "invalid policyId" });
    }
  }

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const policyVersionQuota = summarizeEntitlementLimitUsage({
    limit: entitlements?.limits?.maxPolicyVersions,
    used: Array.isArray(registry?.policies) ? registry.policies.length : 0
  });
  const policies = listTenantSettlementPolicyRecords({ registry, policyId });
  const rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry?.rollout,
    registry,
    activeFallbackRef: registry?.defaultPolicyRef ?? null
  });
  registry.rollout = rollout;
  registry.defaultPolicyRef = rollout.stages.active ?? registry.defaultPolicyRef ?? null;
  const policyIds = [...new Set((registry.policies ?? []).map((row) => String(row.policyId ?? "")))].filter(Boolean).sort(cmpString);
  const selected =
    (rollout.stages.active && getTenantSettlementPolicyRecord({
      registry,
      policyId: rollout.stages.active.policyId,
      policyVersion: rollout.stages.active.policyVersion
    })) ||
    policies[0] ||
    null;
  const draftPolicy = rollout.stages.draft
    ? getTenantSettlementPolicyRecord({
        registry,
        policyId: rollout.stages.draft.policyId,
        policyVersion: rollout.stages.draft.policyVersion
      })
    : null;
  const canaryPolicy = rollout.stages.canary?.policyRef
    ? getTenantSettlementPolicyRecord({
        registry,
        policyId: rollout.stages.canary.policyRef.policyId,
        policyVersion: rollout.stages.canary.policyRef.policyVersion
      })
    : null;
  const activePolicy = rollout.stages.active
    ? getTenantSettlementPolicyRecord({
        registry,
        policyId: rollout.stages.active.policyId,
        policyVersion: rollout.stages.active.policyVersion
      })
    : null;
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    schemaVersion: TENANT_SETTLEMENT_POLICY_REGISTRY_SCHEMA_VERSION,
    generatedAt: nowIso(),
    entitlements,
    quota: {
      maxPolicyVersions: policyVersionQuota
    },
    defaultPolicyRef: registry.defaultPolicyRef ?? null,
    rollout,
    rolloutStagePolicies: {
      draft: draftPolicy,
      canary: canaryPolicy,
      active: activePolicy
    },
    rolloutHistory: Array.isArray(rollout.history) ? rollout.history.slice(-50).reverse() : [],
    selectedPolicy: selected,
    policyIds,
    policies
  });
}

async function handleTenantSettlementPolicyPresets(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const presets = listTenantSettlementPolicyPresetPacks();
  return sendJson(res, 200, {
    ok: true,
    tenantId,
    schemaVersion: "TenantSettlementPolicyPresetCatalog.v1",
    generatedAt: nowIso(),
    presets
  });
}

async function handleTenantSettlementPolicyPresetApply(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  }

  let presetId = null;
  try {
    presetId = parseSettlementPolicyPresetId(body.presetId, { fieldPath: "presetId" });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PRESET_ID", message: err?.message ?? "invalid presetId" });
  }
  const preset = getTenantSettlementPolicyPresetPackById(presetId);
  if (!preset) return sendJson(res, 404, { ok: false, code: "PRESET_NOT_FOUND", message: "preset not found" });

  const setAsDefault = body.setAsDefault === undefined ? true : body.setAsDefault === true;
  const policyIdRaw = body.policyId === undefined || body.policyId === null || String(body.policyId).trim() === "" ? preset.policyId : body.policyId;
  const descriptionRaw = body.description === undefined ? preset.description : body.description;
  const metadataMerged = {
    presetId: preset.presetId,
    presetVersion: preset.presetVersion,
    presetName: preset.name,
    controls: preset.controls
  };
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    Object.assign(metadataMerged, body.metadata);
  }

  const applyBody = {
    policyId: policyIdRaw,
    policyVersion: body.policyVersion ?? undefined,
    description: descriptionRaw,
    setAsDefault,
    verificationMethod: preset.verificationMethod,
    policy: preset.policy,
    metadata: metadataMerged
  };
  const result = await upsertTenantSettlementPolicyRecord({
    tenantId,
    body: applyBody,
    principal: auth.principal,
    auditActionOverride: "TENANT_SETTLEMENT_POLICY_PRESET_APPLIED",
    historyNoteOverride: `preset applied: ${preset.presetId}`,
    source: "preset_apply"
  });
  if (!result.ok) return sendJson(res, result.statusCode, result.payload);

  return sendJson(res, result.statusCode, {
    ...result.payload,
    preset: {
      presetId: preset.presetId,
      presetVersion: preset.presetVersion,
      name: preset.name
    }
  });
}

async function upsertTenantSettlementPolicyRecord({
  tenantId,
  body,
  principal = null,
  auditActionOverride = null,
  historyNoteOverride = null,
  source = "manual_upsert"
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, statusCode: 400, payload: { ok: false, code: "INVALID_REQUEST", message: "body must be an object" } };
  }

  let policyId = null;
  try {
    policyId = parseSettlementPolicyRegistryId(body.policyId, { fieldPath: "policyId" });
  } catch (err) {
    return { ok: false, statusCode: 400, payload: { ok: false, code: "INVALID_POLICY_ID", message: err?.message ?? "invalid policyId" } };
  }

  const rawPolicy = body.policy;
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    return { ok: false, statusCode: 400, payload: { ok: false, code: "INVALID_POLICY", message: "policy is required" } };
  }

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const currentRows = listTenantSettlementPolicyRecords({ registry, policyId });
  const maxVersion = currentRows.reduce((max, row) => Math.max(max, Number(row?.policyVersion ?? 0)), 0);

  const explicitVersionInput =
    body.policyVersion !== undefined
      ? body.policyVersion
      : rawPolicy.policyVersion !== undefined
        ? rawPolicy.policyVersion
        : rawPolicy.version;
  let nextVersion = null;
  try {
    if (explicitVersionInput === undefined || explicitVersionInput === null || explicitVersionInput === "") {
      nextVersion = maxVersion + 1 || 1;
    } else {
      nextVersion = parseSettlementPolicyVersion(explicitVersionInput, { fieldPath: "policyVersion" });
    }
  } catch (err) {
    return { ok: false, statusCode: 400, payload: { ok: false, code: "INVALID_POLICY_VERSION", message: err?.message ?? "invalid policyVersion" } };
  }

  let verificationMethod = null;
  let policy = null;
  let policyHash = null;
  let verificationMethodHash = null;
  try {
    verificationMethod = normalizeVerificationMethod(body.verificationMethod ?? null);
    policy = normalizeSettlementPolicy({
      ...rawPolicy,
      policyVersion: nextVersion
    });
    policyHash = computeSettlementPolicyHash(policy);
    verificationMethodHash = computeVerificationMethodHash(verificationMethod);
  } catch (err) {
    return { ok: false, statusCode: 400, payload: { ok: false, code: "INVALID_SETTLEMENT_POLICY", message: err?.message ?? "invalid policy" } };
  }

  const description =
    body.description === null || body.description === undefined || String(body.description).trim() === ""
      ? null
      : safeTruncate(String(body.description).trim(), { max: 500 });
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? { ...body.metadata } : null;

  const existing = getTenantSettlementPolicyRecord({ registry, policyId, policyVersion: nextVersion });
  if (
    existing &&
    (String(existing.policyHash ?? "") !== String(policyHash ?? "") ||
      String(existing.verificationMethodHash ?? "") !== String(verificationMethodHash ?? ""))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { ok: false, code: "POLICY_VERSION_CONFLICT", message: "policy version already exists with different hashes" }
    };
  }

  const policyVersionsUsed = Array.isArray(registry?.policies) ? registry.policies.length : 0;
  const policyVersionLimit = normalizeEntitlementLimit(entitlements?.limits?.maxPolicyVersions);
  if (!existing && policyVersionLimit !== null && policyVersionsUsed >= policyVersionLimit) {
    return {
      ok: false,
      statusCode: 403,
      payload: buildEntitlementLimitExceededResponse({
        tenantId,
        entitlements,
        featureKey: "maxPolicyVersions",
        limit: policyVersionLimit,
        used: policyVersionsUsed,
        message: `maxPolicyVersions limit reached (${policyVersionsUsed}/${policyVersionLimit}) for plan ${entitlements.plan}`
      })
    };
  }

  const nowAt = nowIso();
  const record = {
    schemaVersion: TENANT_SETTLEMENT_POLICY_SCHEMA_VERSION,
    tenantId,
    policyId,
    policyVersion: nextVersion,
    policyHash,
    verificationMethodHash,
    verificationMethod,
    policy,
    description,
    metadata,
    createdAt: existing?.createdAt ?? nowAt,
    updatedAt: nowAt
  };

  const key = `${policyId}:${nextVersion}`;
  const byKey = new Map((registry.policies ?? []).map((row) => [`${row.policyId}:${row.policyVersion}`, row]));
  byKey.set(key, record);
  registry.policies = [...byKey.values()].sort(settlementPolicyRecordSort);
  registry.rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry.rollout,
    registry,
    activeFallbackRef: registry.defaultPolicyRef ?? null
  });
  registry.rollout.stages.draft = normalizeTenantSettlementPolicyRef(record);
  const shouldSetActive = Boolean(body.setAsDefault) || !registry.rollout.stages.active;
  if (shouldSetActive) {
    const beforeActive = cloneTenantSettlementPolicyRef(registry.rollout.stages.active);
    registry.rollout.stages.active = normalizeTenantSettlementPolicyRef(record);
    registry.defaultPolicyRef = normalizeTenantSettlementPolicyRef(record);
    appendSettlementPolicyRolloutHistory({
      rollout: registry.rollout,
      entry: {
        at: nowAt,
        action: beforeActive ? "active_promoted" : "active_initialized",
        stage: SETTLEMENT_POLICY_ROLLOUT_STAGE.ACTIVE,
        fromPolicyRef: beforeActive,
        toPolicyRef: registry.rollout.stages.active,
        note: historyNoteOverride ?? (Boolean(body.setAsDefault) ? "setAsDefault on upsert" : "first active policy"),
        actorEmail: principal?.email ?? null
      }
    });
  } else {
    appendSettlementPolicyRolloutHistory({
      rollout: registry.rollout,
      entry: {
        at: nowAt,
        action: "draft_updated",
        stage: SETTLEMENT_POLICY_ROLLOUT_STAGE.DRAFT,
        fromPolicyRef: null,
        toPolicyRef: registry.rollout.stages.draft,
        note: historyNoteOverride ?? "policy version upserted",
        actorEmail: principal?.email ?? null
      }
    });
  }
  const saved = await saveTenantSettlementPolicyRegistry({ tenantId, registry });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: auditActionOverride ?? (existing ? "TENANT_SETTLEMENT_POLICY_UPDATED" : "TENANT_SETTLEMENT_POLICY_CREATED"),
        actor: { method: principal?.method ?? null, email: principal?.email ?? null, role: principal?.role ?? null },
        targetType: "tenant_settlement_policy",
        targetId: `${policyId}@${nextVersion}`,
        details: {
          policyId,
          policyVersion: nextVersion,
          policyHash,
          verificationMethodHash,
          setAsDefault: Boolean(body.setAsDefault),
          source
        }
      }
    });
  } catch {
    // ignore
  }

  return {
    ok: true,
    statusCode: existing ? 200 : 201,
    payload: {
      ok: true,
      tenantId,
      policy: record,
      defaultPolicyRef: saved.defaultPolicyRef
    }
  };
}

async function handleTenantSettlementPolicyUpsert(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 200_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }

  const result = await upsertTenantSettlementPolicyRecord({
    tenantId,
    body,
    principal: auth.principal,
    source: "manual_upsert"
  });
  return sendJson(res, result.statusCode, result.payload);
}

async function handleTenantSettlementPolicySetDefault(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  }

  let policyId = null;
  let policyVersion = null;
  try {
    policyId = parseSettlementPolicyRegistryId(body.policyId, { fieldPath: "policyId" });
    policyVersion = parseSettlementPolicyVersion(body.policyVersion, { fieldPath: "policyVersion" });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
  }

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  const record = getTenantSettlementPolicyRecord({ registry, policyId, policyVersion });
  if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "policy version not found" });

  registry.rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry.rollout,
    registry,
    activeFallbackRef: registry.defaultPolicyRef ?? null
  });
  const previousActive = cloneTenantSettlementPolicyRef(registry.rollout.stages.active);
  registry.rollout.stages.active = normalizeTenantSettlementPolicyRef(record);
  registry.defaultPolicyRef = normalizeTenantSettlementPolicyRef(record);
  appendSettlementPolicyRolloutHistory({
    rollout: registry.rollout,
    entry: {
      action: "default_set",
      stage: SETTLEMENT_POLICY_ROLLOUT_STAGE.ACTIVE,
      fromPolicyRef: previousActive,
      toPolicyRef: registry.rollout.stages.active,
      actorEmail: auth.principal?.email ?? null
    }
  });
  const saved = await saveTenantSettlementPolicyRegistry({ tenantId, registry });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_SETTLEMENT_POLICY_DEFAULT_SET",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_settlement_policy",
        targetId: `${policyId}@${policyVersion}`,
        details: { policyId, policyVersion }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, { ok: true, tenantId, defaultPolicyRef: saved.defaultPolicyRef, policy: record });
}

async function handleTenantSettlementPolicyRollout(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 30_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  }

  let stage = null;
  try {
    stage = parseSettlementPolicyRolloutStage(body.stage, { fieldPath: "stage" });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_STAGE", message: err?.message ?? "invalid stage" });
  }
  const note = normalizeSettlementPolicyRolloutNote(body.note);
  const clear = Boolean(body.clear);

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  registry.rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry.rollout,
    registry,
    activeFallbackRef: registry.defaultPolicyRef ?? null
  });

  const nowAt = nowIso();
  let fromPolicyRef = null;
  let toPolicyRef = null;
  let action = "rollout_updated";
  let rolloutPercent = null;

  if (stage === SETTLEMENT_POLICY_ROLLOUT_STAGE.DRAFT) {
    fromPolicyRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.draft);
    if (clear) {
      toPolicyRef = null;
      registry.rollout.stages.draft = null;
      action = "draft_cleared";
    } else {
      let policyRef = null;
      try {
        policyRef = parseTenantSettlementPolicyRefFromBody(body, { fieldPath: "policyRef" });
      } catch (err) {
        return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
      }
      const record = getTenantSettlementPolicyRecord({
        registry,
        policyId: policyRef.policyId,
        policyVersion: policyRef.policyVersion
      });
      if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "policy version not found" });
      toPolicyRef = normalizeTenantSettlementPolicyRef(record);
      registry.rollout.stages.draft = toPolicyRef;
      action = "draft_selected";
    }
  } else if (stage === SETTLEMENT_POLICY_ROLLOUT_STAGE.CANARY) {
    fromPolicyRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.canary?.policyRef ?? null);
    if (clear) {
      toPolicyRef = null;
      registry.rollout.stages.canary = { policyRef: null, rolloutPercent: 0 };
      action = "canary_cleared";
      rolloutPercent = 0;
    } else {
      let policyRef = null;
      try {
        policyRef = parseTenantSettlementPolicyRefFromBody(body, { fieldPath: "policyRef" });
      } catch (err) {
        return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
      }
      const record = getTenantSettlementPolicyRecord({
        registry,
        policyId: policyRef.policyId,
        policyVersion: policyRef.policyVersion
      });
      if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "policy version not found" });
      toPolicyRef = normalizeTenantSettlementPolicyRef(record);
      try {
        rolloutPercent = parseSettlementPolicyRolloutPercent(body.rolloutPercent, { allowNull: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, code: "INVALID_ROLLOUT_PERCENT", message: err?.message ?? "invalid rolloutPercent" });
      }
      if (rolloutPercent === null) {
        const existingPercent = Number(registry.rollout.stages.canary?.rolloutPercent ?? 0);
        rolloutPercent = settlementPolicyRefEquals(fromPolicyRef, toPolicyRef) && existingPercent > 0 ? existingPercent : 10;
      }
      rolloutPercent = Math.max(1, Math.min(100, rolloutPercent));
      registry.rollout.stages.canary = { policyRef: toPolicyRef, rolloutPercent };
      action = "canary_updated";
    }
  } else {
    let policyRef = null;
    try {
      policyRef = parseTenantSettlementPolicyRefFromBody(body, { fieldPath: "policyRef" });
    } catch (err) {
      return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
    }
    const record = getTenantSettlementPolicyRecord({
      registry,
      policyId: policyRef.policyId,
      policyVersion: policyRef.policyVersion
    });
    if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "policy version not found" });
    fromPolicyRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.active);
    toPolicyRef = normalizeTenantSettlementPolicyRef(record);
    registry.rollout.stages.active = toPolicyRef;
    registry.defaultPolicyRef = toPolicyRef;
    action = settlementPolicyRefEquals(fromPolicyRef, toPolicyRef) ? "active_confirmed" : "active_promoted";
  }

  appendSettlementPolicyRolloutHistory({
    rollout: registry.rollout,
    entry: {
      at: nowAt,
      action,
      stage,
      fromPolicyRef,
      toPolicyRef,
      rolloutPercent,
      note,
      actorEmail: auth.principal?.email ?? null
    }
  });
  const saved = await saveTenantSettlementPolicyRegistry({ tenantId, registry });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_SETTLEMENT_POLICY_ROLLOUT_UPDATED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_settlement_policy_rollout",
        targetId: stage,
        details: { stage, action, fromPolicyRef, toPolicyRef, rolloutPercent, note }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    stage,
    action,
    rollout: saved.rollout,
    defaultPolicyRef: saved.defaultPolicyRef ?? null,
    rolloutHistory: Array.isArray(saved.rollout?.history) ? saved.rollout.history.slice(-50).reverse() : []
  });
}

async function handleTenantSettlementPolicyRollback(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 30_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};

  const note = normalizeSettlementPolicyRolloutNote(body.note);
  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  registry.rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry.rollout,
    registry,
    activeFallbackRef: registry.defaultPolicyRef ?? null
  });

  const currentActiveRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.active);
  if (!currentActiveRef) {
    return sendJson(res, 409, { ok: false, code: "ACTIVE_POLICY_NOT_SET", message: "active policy is not set" });
  }

  let explicitTargetRef = null;
  try {
    explicitTargetRef = parseTenantSettlementPolicyRefFromBody(body, { fieldPath: "policyRef", allowNull: true });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
  }

  let targetRef = null;
  if (explicitTargetRef) {
    const record = getTenantSettlementPolicyRecord({
      registry,
      policyId: explicitTargetRef.policyId,
      policyVersion: explicitTargetRef.policyVersion
    });
    if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "rollback target not found" });
    targetRef = normalizeTenantSettlementPolicyRef(record);
  } else {
    const inferredRef = findSettlementPolicyRollbackTargetRef({
      rollout: registry.rollout,
      currentActiveRef
    });
    if (inferredRef) {
      const record = getTenantSettlementPolicyRecord({
        registry,
        policyId: inferredRef.policyId,
        policyVersion: inferredRef.policyVersion
      });
      if (record) targetRef = normalizeTenantSettlementPolicyRef(record);
    }
  }

  if (!targetRef) {
    return sendJson(res, 409, {
      ok: false,
      code: "ROLLBACK_TARGET_NOT_FOUND",
      message: "no previous active policy is available for rollback"
    });
  }

  if (settlementPolicyRefEquals(currentActiveRef, targetRef)) {
    return sendJson(res, 200, {
      ok: true,
      tenantId,
      action: "rollback_noop",
      rollbackTargetRef: targetRef,
      rollout: registry.rollout,
      defaultPolicyRef: registry.defaultPolicyRef ?? null,
      rolloutHistory: Array.isArray(registry.rollout?.history) ? registry.rollout.history.slice(-50).reverse() : []
    });
  }

  registry.rollout.stages.active = targetRef;
  registry.defaultPolicyRef = targetRef;
  appendSettlementPolicyRolloutHistory({
    rollout: registry.rollout,
    entry: {
      at: nowIso(),
      action: "active_rollback",
      stage: SETTLEMENT_POLICY_ROLLOUT_STAGE.ACTIVE,
      fromPolicyRef: currentActiveRef,
      toPolicyRef: targetRef,
      note,
      actorEmail: auth.principal?.email ?? null
    }
  });
  const saved = await saveTenantSettlementPolicyRegistry({ tenantId, registry });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_SETTLEMENT_POLICY_ROLLBACK",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_settlement_policy_rollout",
        targetId: "active",
        details: { fromPolicyRef: currentActiveRef, toPolicyRef: targetRef, note }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    action: "active_rollback",
    rollbackTargetRef: targetRef,
    rollout: saved.rollout,
    defaultPolicyRef: saved.defaultPolicyRef ?? null,
    rolloutHistory: Array.isArray(saved.rollout?.history) ? saved.rollout.history.slice(-50).reverse() : []
  });
}

async function handleTenantSettlementPolicyDiff(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 200 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) {
    return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..2000" });
  }
  const includeUnchangedRaw = url.searchParams.get("includeUnchanged");
  const includeUnchanged = includeUnchangedRaw === "1" || includeUnchangedRaw === "true";

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  registry.rollout = normalizeTenantSettlementPolicyRollout({
    rollout: registry.rollout,
    registry,
    activeFallbackRef: registry.defaultPolicyRef ?? null
  });

  const fromPolicyIdRaw = url.searchParams.get("fromPolicyId");
  const fromPolicyVersionRaw = url.searchParams.get("fromPolicyVersion");
  const toPolicyIdRaw = url.searchParams.get("toPolicyId");
  const toPolicyVersionRaw = url.searchParams.get("toPolicyVersion");

  let fromRef = null;
  let toRef = null;
  try {
    const hasFromInput = fromPolicyIdRaw !== null || fromPolicyVersionRaw !== null;
    const hasToInput = toPolicyIdRaw !== null || toPolicyVersionRaw !== null;
    if (hasFromInput) {
      fromRef = parseTenantSettlementPolicyRefInput(
        { policyId: fromPolicyIdRaw, policyVersion: fromPolicyVersionRaw },
        { fieldPath: "fromPolicyRef" }
      );
    } else {
      fromRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.active ?? registry.defaultPolicyRef ?? null);
    }
    if (hasToInput) {
      toRef = parseTenantSettlementPolicyRefInput(
        { policyId: toPolicyIdRaw, policyVersion: toPolicyVersionRaw },
        { fieldPath: "toPolicyRef" }
      );
    } else {
      toRef = cloneTenantSettlementPolicyRef(registry.rollout.stages.draft ?? registry.rollout.stages.active ?? registry.defaultPolicyRef ?? null);
    }
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
  }

  if (!fromRef || !toRef) {
    return sendJson(res, 409, {
      ok: false,
      code: "DIFF_POLICY_REFERENCE_REQUIRED",
      message: "from/to policy references are required (provide query params or configure active/draft stage)"
    });
  }

  const fromRecord = getTenantSettlementPolicyRecord({
    registry,
    policyId: fromRef.policyId,
    policyVersion: fromRef.policyVersion
  });
  if (!fromRecord) return sendJson(res, 404, { ok: false, code: "FROM_POLICY_NOT_FOUND", message: "from policy version not found" });
  const toRecord = getTenantSettlementPolicyRecord({
    registry,
    policyId: toRef.policyId,
    policyVersion: toRef.policyVersion
  });
  if (!toRecord) return sendJson(res, 404, { ok: false, code: "TO_POLICY_NOT_FOUND", message: "to policy version not found" });

  const fromPayload = {
    policyId: fromRecord.policyId,
    policyVersion: fromRecord.policyVersion,
    description: fromRecord.description ?? null,
    verificationMethod: fromRecord.verificationMethod ?? null,
    policy: fromRecord.policy ?? null
  };
  const toPayload = {
    policyId: toRecord.policyId,
    policyVersion: toRecord.policyVersion,
    description: toRecord.description ?? null,
    verificationMethod: toRecord.verificationMethod ?? null,
    policy: toRecord.policy ?? null
  };
  const diff = buildTenantSettlementPolicyDiff({
    fromPolicy: fromPayload,
    toPolicy: toPayload,
    includeUnchanged,
    limit
  });

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    schemaVersion: "TenantSettlementPolicyDiff.v1",
    generatedAt: nowIso(),
    fromPolicyRef: normalizeTenantSettlementPolicyRef(fromRecord),
    toPolicyRef: normalizeTenantSettlementPolicyRef(toRecord),
    summary: diff.summary,
    limited: diff.limited,
    changes: diff.changes
  });
}

async function handleTenantSettlementPolicyTestReplay(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const registry = await loadTenantSettlementPolicyRegistry({ tenantId });
  const refInput = body.policyRef && typeof body.policyRef === "object" && !Array.isArray(body.policyRef) ? body.policyRef : null;
  const refPolicyId = refInput?.policyId ?? body.policyId ?? null;
  const refPolicyVersion = refInput?.policyVersion ?? body.policyVersion ?? null;

  let record = null;
  if (refPolicyId !== null && refPolicyId !== undefined && refPolicyVersion !== null && refPolicyVersion !== undefined) {
    let parsedId = null;
    let parsedVersion = null;
    try {
      parsedId = parseSettlementPolicyRegistryId(refPolicyId, { fieldPath: "policyId" });
      parsedVersion = parseSettlementPolicyVersion(refPolicyVersion, { fieldPath: "policyVersion" });
    } catch (err) {
      return sendJson(res, 400, { ok: false, code: "INVALID_POLICY_REFERENCE", message: err?.message ?? "invalid policy reference" });
    }
    record = getTenantSettlementPolicyRecord({ registry, policyId: parsedId, policyVersion: parsedVersion });
    if (!record) return sendJson(res, 404, { ok: false, code: "POLICY_NOT_FOUND", message: "policy version not found" });
  } else if (registry.defaultPolicyRef) {
    record = getTenantSettlementPolicyRecord({
      registry,
      policyId: registry.defaultPolicyRef.policyId,
      policyVersion: registry.defaultPolicyRef.policyVersion
    });
  }

  let verificationMethod = null;
  let policy = null;
  if (record) {
    verificationMethod = record.verificationMethod;
    policy = record.policy;
  } else {
    try {
      verificationMethod = normalizeVerificationMethod(body.verificationMethod ?? null);
      policy = normalizeSettlementPolicy(body.policy ?? null);
    } catch (err) {
      return sendJson(res, 400, { ok: false, code: "INVALID_SETTLEMENT_POLICY", message: err?.message ?? "invalid policy or verificationMethod" });
    }
  }

  const amountRaw = body.amountCents === undefined || body.amountCents === null || body.amountCents === "" ? 1000 : Number(body.amountCents);
  if (!Number.isSafeInteger(amountRaw) || amountRaw <= 0) {
    return sendJson(res, 400, { ok: false, code: "INVALID_AMOUNT_CENTS", message: "amountCents must be a positive safe integer" });
  }
  const amountCents = amountRaw;

  let inferred = null;
  if ((body.verificationStatus === undefined || body.verificationStatus === null || body.verificationStatus === "") && typeof body.token === "string" && body.token.trim()) {
    inferred = await inferVerificationStatusFromToken(body.token.trim());
    if (!inferred.ok) return sendJson(res, 400, { ok: false, code: inferred.code ?? "INVALID_TOKEN", message: inferred.message ?? "invalid token" });
  }

  let verificationStatus = null;
  let runStatus = null;
  try {
    verificationStatus = parseSettlementStatus(body.verificationStatus, { allowNull: true }) ?? inferred?.verificationStatus ?? "green";
    runStatus = parseSettlementRunStatus(body.runStatus, { allowNull: true }) ?? inferred?.runStatus ?? "completed";
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REPLAY_INPUT", message: err?.message ?? "invalid replay input" });
  }

  let decision = null;
  try {
    decision = evaluateSettlementPolicy({
      policy,
      verificationMethod,
      verificationStatus,
      runStatus,
      amountCents
    });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "POLICY_REPLAY_FAILED", message: err?.message ?? "policy replay failed" });
  }

  return sendJson(res, 200, {
    ok: true,
    tenantId,
    computedAt: nowIso(),
    input: {
      amountCents,
      verificationStatus,
      runStatus,
      token: inferred?.token ?? null
    },
    policyRef: record ? normalizeTenantSettlementPolicyRef(record) : null,
    policy: record ?? { policy, verificationMethod, policyHash: computeSettlementPolicyHash(policy), verificationMethodHash: computeVerificationMethodHash(verificationMethod) },
    replay: decision
  });
}

async function handleTenantIntegrationsState(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const state = await readTenantIntegrationsState({ tenantId, tenantSettings });
  return sendJson(res, 200, { ok: true, ...state });
}

async function handleTenantIntegrationOauthStart(req, res, tenantId, provider) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (!INTEGRATION_PROVIDER_NAME_SET.has(provider)) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const existingIntegration = integrationWebhookFromSettings({ settings: tenantSettings, provider });
  const integrationsUsed = countConfiguredIntegrations(tenantSettings);
  const integrationsLimit = normalizeEntitlementLimit(entitlements?.limits?.maxIntegrations);
  if (!existingIntegration && integrationsLimit !== null && integrationsUsed >= integrationsLimit) {
    return sendJson(
      res,
      403,
      buildEntitlementLimitExceededResponse({
        tenantId,
        entitlements,
        featureKey: "maxIntegrations",
        limit: integrationsLimit,
        used: integrationsUsed,
        message: `maxIntegrations limit reached (${integrationsUsed}/${integrationsLimit}) for plan ${entitlements.plan}`
      })
    );
  }

  const providerConfig = integrationOauthProviderConfig(provider);
  if (!providerConfig.enabled) {
    return sendJson(res, 400, { ok: false, code: "INTEGRATION_OAUTH_NOT_CONFIGURED", message: `${provider} OAuth is not configured` });
  }

  const base = requestBaseUrl(req);
  if (!base) {
    return sendJson(res, 400, {
      ok: false,
      code: "OAUTH_BASE_URL_MISSING",
      message: "set MAGIC_LINK_PUBLIC_BASE_URL or send a Host header so OAuth redirect URI can be built"
    });
  }
  const redirectUri = `${base}${integrationOauthCallbackPath(provider)}`;
  const created = await createIntegrationOauthState({ provider, tenantId, redirectUri });
  const stateId = created.stateId;

  const authUrl = new URL(providerConfig.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", providerConfig.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", stateId);
  if (providerConfig.scopes.length) authUrl.searchParams.set("scope", providerConfig.scopes.join(" "));
  if (provider === "slack" && providerConfig.userScopes.length) authUrl.searchParams.set("user_scope", providerConfig.userScopes.join(","));

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_INTEGRATION_OAUTH_STARTED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_integration",
        targetId: provider,
        details: { provider, redirectUri }
      }
    });
  } catch {
    // ignore
  }

  res.statusCode = 302;
  res.setHeader("location", authUrl.toString());
  res.setHeader("cache-control", "no-store");
  res.end("");
}

async function handleIntegrationOauthCallback(req, res, provider, url) {
  if (!INTEGRATION_PROVIDER_NAME_SET.has(provider)) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  const providerConfig = integrationOauthProviderConfig(provider);
  if (!providerConfig.enabled) {
    return sendJson(res, 400, { ok: false, code: "INTEGRATION_OAUTH_NOT_CONFIGURED", message: `${provider} OAuth is not configured` });
  }

  const code = String(url.searchParams.get("code") ?? "").trim();
  const stateParam = String(url.searchParams.get("state") ?? "").trim();
  if (!code) return sendJson(res, 400, { ok: false, code: "OAUTH_CODE_MISSING", message: "OAuth code is required" });
  if (!stateParam) return sendJson(res, 400, { ok: false, code: "OAUTH_STATE_MISSING", message: "OAuth state is required" });

  const consumed = await consumeIntegrationOauthState({ provider, stateId: stateParam });
  if (!consumed.ok) return sendJson(res, 400, { ok: false, code: consumed.error ?? "OAUTH_STATE_INVALID" });
  const tenantId = String(consumed.state.tenantId ?? "").trim();
  const redirectUri = String(consumed.state.redirectUri ?? "").trim();
  if (!tenantId || !redirectUri) return sendJson(res, 400, { ok: false, code: "OAUTH_STATE_INVALID" });

  const tenantSettingsBeforeConnect = await loadTenantSettings({ dataDir, tenantId });
  const entitlementsBeforeConnect = resolveTenantEntitlementsFromSettings(tenantSettingsBeforeConnect);
  const existingBeforeConnect = integrationWebhookFromSettings({ settings: tenantSettingsBeforeConnect, provider });
  const integrationsUsedBeforeConnect = countConfiguredIntegrations(tenantSettingsBeforeConnect);
  const integrationsLimitBeforeConnect = normalizeEntitlementLimit(entitlementsBeforeConnect?.limits?.maxIntegrations);
  if (!existingBeforeConnect && integrationsLimitBeforeConnect !== null && integrationsUsedBeforeConnect >= integrationsLimitBeforeConnect) {
    const location = oauthResultRedirectPath({
      tenantId,
      provider,
      status: "error",
      message: `maxIntegrations limit reached (${integrationsUsedBeforeConnect}/${integrationsLimitBeforeConnect}) for plan ${entitlementsBeforeConnect.plan}`
    });
    res.statusCode = 303;
    res.setHeader("location", location);
    res.setHeader("cache-control", "no-store");
    res.end("");
    return;
  }

  const tokenExchange = await exchangeIntegrationOauthCode({ providerConfig, code, redirectUri });
  if (!tokenExchange.ok) {
    const location = oauthResultRedirectPath({ tenantId, provider, status: "error", message: tokenExchange.error ?? "OAuth token exchange failed" });
    res.statusCode = 303;
    res.setHeader("location", location);
    res.setHeader("cache-control", "no-store");
    res.end("");
    return;
  }

  const webhookFromToken = integrationWebhookUrlFromOauthToken({ provider, tokenResponse: tokenExchange.tokenResponse, providerConfig });
  if (!webhookFromToken.ok) {
    const location = oauthResultRedirectPath({ tenantId, provider, status: "error", message: webhookFromToken.error ?? "Webhook URL missing from OAuth response" });
    res.statusCode = 303;
    res.setHeader("location", location);
    res.setHeader("cache-control", "no-store");
    res.end("");
    return;
  }

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const existingIntegration = integrationWebhookFromSettings({ settings: tenantSettings, provider });
  const integrationsUsed = countConfiguredIntegrations(tenantSettings);
  const integrationsLimit = normalizeEntitlementLimit(entitlements?.limits?.maxIntegrations);
  if (!existingIntegration && integrationsLimit !== null && integrationsUsed >= integrationsLimit) {
    const location = oauthResultRedirectPath({
      tenantId,
      provider,
      status: "error",
      message: `maxIntegrations limit reached (${integrationsUsed}/${integrationsLimit}) for plan ${entitlements.plan}`
    });
    res.statusCode = 303;
    res.setHeader("location", location);
    res.setHeader("cache-control", "no-store");
    res.end("");
    return;
  }
  const existing = integrationWebhookFromSettings({ settings: tenantSettings, provider });
  const secret = typeof existing?.secret === "string" && existing.secret.trim() ? existing.secret : randomWebhookSecret();
  const events = [...WEBHOOK_EVENT_NAMES];
  const nextSettings = replaceIntegrationWebhook({
    settings: tenantSettings,
    provider,
    webhook: { url: webhookFromToken.webhookUrl, events, enabled: true, secret }
  });
  await saveTenantSettings({ dataDir, tenantId, settings: nextSettings, settingsKey });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_INTEGRATION_CONNECTED_OAUTH",
        actor: { method: "integration_oauth", email: null, role: "admin" },
        targetType: "tenant_integration",
        targetId: provider,
        details: { provider, webhookUrl: webhookFromToken.webhookUrl, events }
      }
    });
  } catch {
    // ignore
  }

  const location = oauthResultRedirectPath({ tenantId, provider, status: "success" });
  res.statusCode = 303;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end("");
}

async function handleTenantIntegrationConnect(req, res, tenantId, provider) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (!INTEGRATION_PROVIDER_NAME_SET.has(provider)) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const parsed = validateIntegrationWebhookUrl({ provider, webhookUrl: json.webhookUrl });
  if (!parsed.ok) return sendJson(res, 400, { ok: false, code: "INVALID_WEBHOOK_URL", message: parsed.error });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const existing = integrationWebhookFromSettings({ settings: tenantSettings, provider });
  const integrationsUsed = countConfiguredIntegrations(tenantSettings);
  const integrationsLimit = normalizeEntitlementLimit(entitlements?.limits?.maxIntegrations);
  if (!existing && integrationsLimit !== null && integrationsUsed >= integrationsLimit) {
    return sendJson(
      res,
      403,
      buildEntitlementLimitExceededResponse({
        tenantId,
        entitlements,
        featureKey: "maxIntegrations",
        limit: integrationsLimit,
        used: integrationsUsed,
        message: `maxIntegrations limit reached (${integrationsUsed}/${integrationsLimit}) for plan ${entitlements.plan}`
      })
    );
  }
  const providedSecret = typeof json.secret === "string" && json.secret.trim() ? json.secret.trim() : null;
  const preservedSecret = typeof existing?.secret === "string" && existing.secret.trim() ? existing.secret : null;
  const secret = providedSecret || preservedSecret || randomWebhookSecret();
  const requestedEvents = normalizeWebhookEvents(json.events);
  const events = requestedEvents.length ? requestedEvents : [...WEBHOOK_EVENT_NAMES];

  const nextSettings = replaceIntegrationWebhook({
    settings: tenantSettings,
    provider,
    webhook: { url: parsed.webhookUrl, events, enabled: true, secret }
  });
  await saveTenantSettings({ dataDir, tenantId, settings: nextSettings, settingsKey });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_INTEGRATION_CONNECTED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_integration",
        targetId: provider,
        details: { provider, webhookUrl: parsed.webhookUrl, events }
      }
    });
  } catch {
    // ignore
  }

  const state = await readTenantIntegrationsState({ tenantId, tenantSettings: nextSettings });
  return sendJson(res, 200, { ok: true, tenantId, provider, integration: state.integrations?.[provider] ?? null, integrations: state.integrations, generatedAt: state.generatedAt });
}

async function handleTenantIntegrationDisconnect(req, res, tenantId, provider) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (!INTEGRATION_PROVIDER_NAME_SET.has(provider)) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const nextSettings = replaceIntegrationWebhook({ settings: tenantSettings, provider, webhook: null });
  await saveTenantSettings({ dataDir, tenantId, settings: nextSettings, settingsKey });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_INTEGRATION_DISCONNECTED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_integration",
        targetId: provider,
        details: { provider }
      }
    });
  } catch {
    // ignore
  }

  const state = await readTenantIntegrationsState({ tenantId, tenantSettings: nextSettings });
  return sendJson(res, 200, { ok: true, tenantId, provider, integration: state.integrations?.[provider] ?? null, integrations: state.integrations, generatedAt: state.generatedAt });
}

async function handleTenantIntegrationTestSend(req, res, tenantId, provider) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  if (!INTEGRATION_PROVIDER_NAME_SET.has(provider)) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  let json = {};
  try {
    json = (await readJsonBody(req, { maxBytes: 30_000 })) ?? {};
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const webhook = integrationWebhookFromSettings({ settings: tenantSettings, provider });
  if (!webhook) return sendJson(res, 404, { ok: false, code: "INTEGRATION_NOT_CONNECTED", message: `${provider} is not connected` });

  const requestedEvent = String(json.event ?? "").trim();
  const webhookEvents = normalizeWebhookEvents(webhook.events);
  const fallbackEvent = webhookEvents.includes("verification.completed") ? "verification.completed" : webhookEvents[0] ?? "verification.completed";
  const event = WEBHOOK_EVENT_NAME_SET.has(requestedEvent) && webhookEvents.includes(requestedEvent) ? requestedEvent : fallbackEvent;

  const token = `ml_test_${crypto.randomBytes(16).toString("hex")}`;
  const zipSha256 = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const payload = buildWebhookPayload({
    event,
    tenantId,
    token,
    zipSha256,
    zipBytes: 0,
    modeResolved: "strict",
    modeRequested: "strict",
    cliOut: { ok: true, verificationOk: true, errors: [], warnings: [] },
    publicBaseUrl
  });
  payload.test = {
    schemaVersion: "MagicLinkIntegrationTest.v1",
    provider,
    generatedAt: nowIso()
  };

  const deliveryRows = await deliverTenantWebhooks({
    dataDir,
    tenantId,
    token,
    event,
    payload,
    webhooks: [webhook],
    settingsKey,
    deliveryMode: webhookDeliveryMode,
    timeoutMs: webhookTimeoutMs,
    maxAttempts: webhookMaxAttempts,
    retryBackoffMs: webhookRetryBackoffMs
  });
  await enqueueWebhookRetriesBestEffort({
    tenantId,
    token,
    event,
    payload,
    webhooks: [webhook],
    deliveryResults: deliveryRows
  });
  const delivery = deliveryRows[0] ?? { ok: false, error: "DELIVERY_SKIPPED" };

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_INTEGRATION_TEST_SENT",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_integration",
        targetId: provider,
        details: { provider, event, webhookUrl: webhook.url, delivery: { ok: Boolean(delivery.ok), statusCode: delivery.statusCode ?? null, error: delivery.error ?? null } }
      }
    });
  } catch {
    // ignore
  }

  const state = await readTenantIntegrationsState({ tenantId, tenantSettings });
  return sendJson(res, 200, {
    ok: Boolean(delivery.ok),
    tenantId,
    provider,
    event,
    delivery,
    integration: state.integrations?.[provider] ?? null,
    integrations: state.integrations,
    generatedAt: state.generatedAt
  });
}

async function handlePricingPage(req, res) {
  const plans = ["free", "builder", "growth", "enterprise"].map((planKey) => TENANT_PLAN_CATALOG[planKey]).filter(Boolean);
  const rows = plans.map((plan) => {
    const maxVerifications = Number.isInteger(plan?.limits?.maxVerificationsPerMonth) ? String(plan.limits.maxVerificationsPerMonth) : "unlimited";
    const maxStoredBundles = Number.isInteger(plan?.limits?.maxStoredBundles) ? String(plan.limits.maxStoredBundles) : "unlimited";
    const maxIntegrations = Number.isInteger(plan?.limits?.maxIntegrations) ? String(plan.limits.maxIntegrations) : "unlimited";
    const retentionDays = Number.isInteger(plan?.limits?.retentionDays) ? String(plan.limits.retentionDays) : "custom";
    const subscription = formatUsdFromCents(Number.isFinite(Number(plan?.billing?.subscriptionCents)) ? Number(plan.billing.subscriptionCents) : 0);
    const perVerification = formatUsdFromCents(
      Number.isFinite(Number(plan?.billing?.pricePerVerificationCents)) ? Number(plan.billing.pricePerVerificationCents) : 0
    );
    return {
      plan: String(plan.plan ?? ""),
      displayName: String(plan.displayName ?? plan.plan ?? "").trim() || "Plan",
      subscription,
      perVerification,
      maxVerifications,
      maxStoredBundles,
      maxIntegrations,
      retentionDays
    };
  });

  const cards = rows
    .map(
      (row) => [
        "<section class=\"card\">",
        `<h2>${htmlEscape(row.displayName)}</h2>`,
        `<div class="price">${htmlEscape(row.subscription)}<span>/month</span></div>`,
        `<div class="muted">Per verified run: <strong>${htmlEscape(row.perVerification)}</strong></div>`,
        "<ul>",
        `<li>Verified runs/month: <code>${htmlEscape(row.maxVerifications)}</code></li>`,
        `<li>Stored bundles: <code>${htmlEscape(row.maxStoredBundles)}</code></li>`,
        `<li>Integrations: <code>${htmlEscape(row.maxIntegrations)}</code></li>`,
        `<li>Retention days: <code>${htmlEscape(row.retentionDays)}</code></li>`,
        "</ul>",
        "</section>"
      ].join("\n")
    )
    .join("\n");

  const body = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<title>Pricing</title>",
    "<style>",
    ":root{--bg:#f8fafc;--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--card:#ffffff;--accent:#0f766e}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(circle at 0 0,#dff8f3 0,#f8fafc 45%),radial-gradient(circle at 100% 100%,#e0ecff 0,#f8fafc 42%);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink)}",
    ".shell{max-width:1080px;margin:0 auto;padding:28px 18px 44px}",
    ".hero{border:1px solid var(--line);background:var(--card);border-radius:16px;padding:20px;box-shadow:0 10px 28px rgba(15,23,42,.06)}",
    ".hero h1{margin:0 0 8px;font-size:30px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:14px}",
    ".card{border:1px solid var(--line);background:var(--card);border-radius:14px;padding:14px}",
    ".card h2{margin:0 0 8px;font-size:20px}",
    ".price{font-size:30px;font-weight:800;line-height:1.1;margin-bottom:6px}",
    ".price span{font-size:14px;color:var(--muted);font-weight:600;margin-left:4px}",
    ".muted{color:var(--muted)}",
    "ul{margin:10px 0 0;padding-left:18px}",
    "li{margin:4px 0}",
    ".foot{margin-top:14px;border:1px dashed var(--line);border-radius:12px;background:#fff;padding:12px}",
    "code{background:#f1f5f9;padding:2px 6px;border-radius:6px}",
    "a.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border-radius:10px;padding:8px 12px;text-decoration:none;font-weight:700}",
    "</style>",
    "</head><body><div class=\"shell\">",
    "<div class=\"hero\">",
    "<h1>Settld Pricing</h1>",
    "<p>Usage-led plans for verified economic transactions. Billing surfaces are plan-aware and enforced in the runtime.</p>",
    "<div style=\"margin-top:10px\"><a class=\"btn\" href=\"/v1/tenants/tenant_a/onboarding\">Start onboarding</a></div>",
    "</div>",
    "<div class=\"grid\">",
    cards,
    "</div>",
    "<div class=\"foot\">",
    "<strong>Value-event pricing details</strong>",
    "<div class=\"muted\" style=\"margin-top:6px\">Invoice drafts and period-close flows meter <code>VERIFIED_RUN</code>, <code>SETTLED_VOLUME</code>, and <code>ARBITRATION_USAGE</code> events. Settled-volume and arbitration fees are policy-configurable and appear as explicit invoice line items.</div>",
    "</div>",
    "</div></body></html>"
  ].join("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function handleTenantIntegrationsPage(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<title>Integrations</title>",
    "<style>",
    ":root{--bg:#f6f8ff;--card:#ffffff;--ink:#0f172a;--muted:#475569;--line:#dbe4ff;--accent:#1d4ed8;--good:#15803d;--warn:#b45309;--bad:#b91c1c}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(circle at 0 0,#e0ecff 0,#f6f8ff 42%),radial-gradient(circle at 100% 100%,#ddf4ff 0,#f6f8ff 38%);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink)}",
    ".shell{max-width:960px;margin:0 auto;padding:24px 18px 40px}",
    ".hero{padding:18px 20px;border:1px solid var(--line);background:#fff;border-radius:16px;box-shadow:0 8px 28px rgba(29,78,216,0.08)}",
    ".hero h1{margin:0 0 8px;font-size:26px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".grid{display:grid;gap:12px;margin-top:12px}",
    ".card{border:1px solid var(--line);border-radius:14px;padding:14px;background:#fff}",
    ".card h2{margin:0 0 8px;font-size:18px}",
    ".muted{color:var(--muted)}",
    ".row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}",
    ".field{flex:1;min-width:240px}",
    "input{width:100%;border:1px solid #c7d2fe;border-radius:10px;padding:8px 10px;font:inherit;background:#fff}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;text-decoration:none}",
    ".btn.ghost{background:#fff;color:var(--accent);border:1px solid #bfdbfe}",
    ".btn.warn{background:#a16207}",
    ".btn:disabled{opacity:.45;cursor:not-allowed}",
    ".status{padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc}",
    ".status.good{border-color:#bbf7d0;background:#f0fdf4;color:var(--good)}",
    ".status.warn{border-color:#fed7aa;background:#fffbeb;color:var(--warn)}",
    ".status.bad{border-color:#fecaca;background:#fef2f2;color:var(--bad)}",
    "code{background:#f1f5f9;padding:2px 6px;border-radius:6px}",
    "</style>",
    "</head><body><div class=\"shell\">",
    "<div class=\"hero\">",
    "<h1>Integrations</h1>",
    `<p>Tenant <code>${htmlEscape(tenantId)}</code>. Connect Slack and Zapier, send test events, and monitor delivery health.</p>`,
    `<div style=\"margin-top:10px\"><a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/onboarding\">Back to onboarding</a> <a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies\">Settlement policies</a></div>`,
    "</div>",
    "<div class=\"grid\">",
    "<section class=\"card\">",
    "<h2>Connection Status</h2>",
    "<div id=\"oauthFlash\" class=\"status\">No recent integration action.</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Plan & Limits</h2>",
    "<div id=\"planStatus\" class=\"status\">Loading…</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"upgradePlan\">Upgrade plan</button>",
    "<button class=\"btn ghost\" id=\"openBillingState\">Open billing state</button>",
    "<span id=\"upgradeHintText\" class=\"muted\"></span>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Webhook Retry Queue</h2>",
    "<div id=\"retryQueueStatus\" class=\"status\">Loading…</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\" style=\"max-width:220px\"><div class=\"muted\">Provider scope</div><select id=\"retryProvider\"><option value=\"all\">all</option><option value=\"defaultRelay\">defaultRelay</option><option value=\"slack\">slack</option><option value=\"zapier\">zapier</option><option value=\"webhook\">webhook</option></select></div>",
    "<button class=\"btn ghost\" id=\"retryRunOnce\">Run retry sweep</button>",
    "<button class=\"btn warn\" id=\"retryReplayLatest\">Replay latest dead-letter</button>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Default Event Relay</h2>",
    "<div id=\"relayStatus\" class=\"status\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Slack</h2>",
    "<div class=\"row\">",
    "<div class=\"field\"><div class=\"muted\">Slack Incoming Webhook URL</div><input id=\"slackUrl\" placeholder=\"https://hooks.slack.com/services/...\"/></div>",
    "<button class=\"btn\" id=\"slackOauth\">Connect with OAuth</button>",
    "<button class=\"btn\" id=\"slackConnect\">Connect Slack</button>",
    "<button class=\"btn ghost\" id=\"slackDisconnect\">Disconnect</button>",
    "<button class=\"btn warn\" id=\"slackTest\">Send test event</button>",
    "</div>",
    "<div id=\"slackStatus\" class=\"status\" style=\"margin-top:8px\">Not connected.</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Zapier</h2>",
    "<div class=\"row\">",
    "<div class=\"field\"><div class=\"muted\">Zapier Catch Hook URL</div><input id=\"zapierUrl\" placeholder=\"https://hooks.zapier.com/hooks/catch/...\"/></div>",
    "<button class=\"btn\" id=\"zapierOauth\">Connect with OAuth</button>",
    "<button class=\"btn\" id=\"zapierConnect\">Connect Zapier</button>",
    "<button class=\"btn ghost\" id=\"zapierDisconnect\">Disconnect</button>",
    "<button class=\"btn warn\" id=\"zapierTest\">Send test event</button>",
    "</div>",
    "<div id=\"zapierStatus\" class=\"status\" style=\"margin-top:8px\">Not connected.</div>",
    "</section>",
    "</div>",
    "</div>",
    "<script>",
    `const tenantId = ${JSON.stringify(tenantId)};`,
    "const qs = new URLSearchParams(window.location.search);",
    "const state = { payload: null, oauthStatus: qs.get('oauth') || '', oauthProvider: qs.get('provider') || '', oauthMessage: qs.get('message') || '', retryProvider: 'all', upgradeMessage: '', upgradeHintApi: null };",
    "function setText(id, text){ const el=document.getElementById(id); if(el) el.textContent=String(text||''); }",
    "function setClass(id, base, tone){ const el=document.getElementById(id); if(!el) return; el.className=base + (tone ? ' '+tone : ''); }",
    "async function getJson(url){ const res=await fetch(url,{credentials:'same-origin'}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "async function postJson(url, body){ const res=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok){ const err=new Error((j&&j.message)||txt||('HTTP '+res.status)); if(j) err.payload=j; throw err; } return j; }",
    "function apiPayloadFromError(err){ return err && typeof err==='object' && err.payload && typeof err.payload==='object' ? err.payload : null; }",
    "function applyUpgradeHintFromApi(err){",
    "  const payload = apiPayloadFromError(err);",
    "  const hint = payload && payload.upgradeHint && typeof payload.upgradeHint==='object' ? payload.upgradeHint : null;",
    "  if(!hint) return false;",
    "  const suggestedPlans = Array.isArray(hint.suggestedPlans) ? hint.suggestedPlans.map((p)=>String(p||'').trim()).filter(Boolean) : [];",
    "  state.upgradeHintApi = { ...hint, suggestedPlans, message: String(payload.message||err.message||'') };",
    "  if(!state.upgradeMessage) state.upgradeMessage = state.upgradeHintApi.message || '';",
    "  render();",
    "  return true;",
    "}",
    "function nextPaidPlan(plan){ const p=String(plan||'').trim().toLowerCase(); if(p==='free') return 'builder'; if(p==='builder') return 'growth'; if(p==='growth') return 'enterprise'; return null; }",
    "async function startUpgradeCheckout(){",
    "  const ent = state.payload && state.payload.entitlements ? state.payload.entitlements : {};",
    "  const hintPlans = state.upgradeHintApi && Array.isArray(state.upgradeHintApi.suggestedPlans) ? state.upgradeHintApi.suggestedPlans : [];",
    "  const plan = hintPlans.length ? hintPlans[0] : nextPaidPlan(ent.plan || 'free');",
    "  if(!plan){ state.upgradeMessage='Top plan is already active.'; render(); return; }",
    "  state.upgradeMessage = `starting ${plan} checkout…`;",
    "  render();",
    "  try{",
    "    const out = await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/checkout`, { plan });",
    "    state.upgradeHintApi = null;",
    "    if(out && out.checkoutUrl){ window.location.assign(out.checkoutUrl); return; }",
    "    state.upgradeMessage = `checkout created for ${plan}`;",
    "    render();",
    "  }catch(e){ if(!applyUpgradeHintFromApi(e)){ state.upgradeMessage = `upgrade failed: ${e.message}`; render(); } }",
    "}",
    "function applyOauthFlash(){",
    "  if(!state.oauthStatus) return;",
    "  const provider = state.oauthProvider ? state.oauthProvider : 'integration';",
    "  const msg = state.oauthMessage ? state.oauthMessage : (state.oauthStatus==='success' ? `${provider} connected.` : `${provider} connection failed.`);",
    "  setText('oauthFlash', msg);",
    "  setClass('oauthFlash', 'status', state.oauthStatus==='success' ? 'good' : 'bad');",
    "  const cleanUrl = window.location.pathname;",
    "  window.history.replaceState({}, '', cleanUrl);",
    "  state.oauthStatus=''; state.oauthProvider=''; state.oauthMessage='';",
    "}",
    "function healthText(row){",
    "  if(!row) return 'No delivery data yet.';",
    "  const h=row.deliveryHealth||{};",
    "  const q=row.retryQueue||{};",
    "  const status=row.connected?(row.enabled?'connected':'disabled'):'not connected';",
    "  const last=h.lastAttemptAt?`last=${h.lastAttemptAt}`:'last=none';",
    "  const result=h.lastOk===true?'ok':h.lastOk===false?('fail'+(h.lastError?` (${h.lastError})`:'')):'n/a';",
    "  const window=`24h attempts=${h.attempts24h||0}, success=${h.successes24h||0}, fail=${h.failures24h||0}`;",
    "  const retry=`retry pending=${q.pendingCount||0}, dead=${q.deadLetterCount||0}`;",
    "  return `${status} | ${last} | result=${result} | ${window} | ${retry}`;",
    "}",
    "function providerStatusId(provider){",
    "  if(provider==='slack') return 'slackStatus';",
    "  if(provider==='zapier') return 'zapierStatus';",
    "  return 'oauthFlash';",
    "}",
    "function setInlineError(targetId, message){",
    "  const id = targetId || 'oauthFlash';",
    "  setText(id, message || 'Request failed');",
    "  setClass(id, 'status', 'bad');",
    "}",
    "function render(){",
    "  const retryQueue = state.payload && state.payload.retryQueue ? state.payload.retryQueue : {};",
    "  const retryByProvider = retryQueue.byProvider || {};",
    "  const retryLatestByProvider = retryQueue.latestDeadLetterByProvider || {};",
    "  const retryProvider = state.retryProvider || 'all';",
    "  const retryScoped = retryProvider === 'all' ? { pendingCount: retryQueue.pendingCount||0, deadLetterCount: retryQueue.deadLetterCount||0 } : (retryByProvider[retryProvider] || { pendingCount: 0, deadLetterCount: 0 });",
    "  const latestDead = retryProvider === 'all' ? (retryQueue.latestDeadLetter || null) : (retryLatestByProvider[retryProvider] || null);",
    "  const latestDeadText = latestDead ? `latest=${latestDead.provider||'webhook'}:${latestDead.token||'unknown'} (${latestDead.lastError||'unknown'})` : 'latest=none';",
    "  setText('retryQueueStatus', `provider=${retryProvider} | pending=${retryScoped.pendingCount||0} | dead-letter=${retryScoped.deadLetterCount||0} | ${latestDeadText}`);",
    "  setClass('retryQueueStatus', 'status', (retryScoped.deadLetterCount||0) > 0 ? 'bad' : ((retryScoped.pendingCount||0) > 0 ? '' : 'good'));",
    "  const retryProviderSelect = document.getElementById('retryProvider');",
    "  if(retryProviderSelect && retryProviderSelect.value !== retryProvider) retryProviderSelect.value = retryProvider;",
    "  const integrations = state.payload && state.payload.integrations ? state.payload.integrations : {};",
    "  const relay = integrations.defaultRelay || {};",
    "  const slack = integrations.slack || {};",
    "  const zapier = integrations.zapier || {};",
    "  const entitlements = state.payload && state.payload.entitlements ? state.payload.entitlements : {};",
    "  const integrationQuota = state.payload && state.payload.quota && state.payload.quota.maxIntegrations ? state.payload.quota.maxIntegrations : null;",
    "  const plan = String(entitlements.plan || 'free');",
    "  const quotaText = !integrationQuota ? 'quota unavailable' : (integrationQuota.unlimited ? `integrations=${integrationQuota.used} (unlimited)` : `integrations=${integrationQuota.used}/${integrationQuota.limit} (remaining=${integrationQuota.remaining})`);",
    "  setText('planStatus', `plan=${plan} | ${quotaText}`);",
    "  setClass('planStatus', 'status', integrationQuota && integrationQuota.atLimit ? 'warn' : 'good');",
    "  const hintedPlans = state.upgradeHintApi && Array.isArray(state.upgradeHintApi.suggestedPlans) ? state.upgradeHintApi.suggestedPlans : [];",
    "  const nextPlan = hintedPlans.length ? hintedPlans[0] : nextPaidPlan(plan);",
    "  const upgradePlanBtn = document.getElementById('upgradePlan');",
    "  if(upgradePlanBtn){",
    "    upgradePlanBtn.disabled = !nextPlan;",
    "    upgradePlanBtn.textContent = nextPlan ? `Upgrade to ${nextPlan}` : 'Top plan active';",
    "  }",
    "  if(state.upgradeHintApi){",
    "    const hintMessage = String(state.upgradeHintApi.message || '').trim();",
    "    if(hintMessage) setText('upgradeHintText', hintMessage);",
    "    else if(nextPlan) setText('upgradeHintText', `Integration limit reached. Upgrade to ${nextPlan} to connect more.`);",
    "    else setText('upgradeHintText', 'Integration limit reached.');",
    "  } else if(state.upgradeMessage){",
    "    setText('upgradeHintText', state.upgradeMessage);",
    "  } else if (integrationQuota && integrationQuota.atLimit && nextPlan){",
    "    setText('upgradeHintText', `Integration limit reached. Upgrade to ${nextPlan} to connect more.`);",
    "  } else if (nextPlan){",
    "    setText('upgradeHintText', `Current plan ${plan}.`);",
    "  } else {",
    "    setText('upgradeHintText', 'Top plan has no integration cap.');",
    "  }",
    "  const oauth = state.payload && state.payload.oauth ? state.payload.oauth : {};",
    "  const slackOauth = oauth.slack || {};",
    "  const zapierOauth = oauth.zapier || {};",
    "  const relayUrl = relay.webhookUrlMasked || relay.webhookUrl || 'not configured';",
    "  const relayState = relay.configuredInEnv ? (relay.connected ? 'configured + attached' : 'configured, pending attach') : 'not configured in env';",
    "  setText('relayStatus', `${relayState} | url=${relayUrl} | ${healthText(relay)}`);",
    "  setClass('relayStatus', 'status', relay.connected ? 'good' : '');",
    "  if (slack.webhookUrl) document.getElementById('slackUrl').value = slack.webhookUrl;",
    "  if (zapier.webhookUrl) document.getElementById('zapierUrl').value = zapier.webhookUrl;",
    "  setText('slackStatus', healthText(slack));",
    "  setClass('slackStatus', 'status', slack.connected ? (slack.deliveryHealth && slack.deliveryHealth.lastOk===false ? 'bad' : 'good') : '');",
    "  setText('zapierStatus', healthText(zapier));",
    "  setClass('zapierStatus', 'status', zapier.connected ? (zapier.deliveryHealth && zapier.deliveryHealth.lastOk===false ? 'bad' : 'good') : '');",
    "  const slackOauthBtn = document.getElementById('slackOauth');",
    "  const slackConnectBtn = document.getElementById('slackConnect');",
    "  const zapierOauthBtn = document.getElementById('zapierOauth');",
    "  const zapierConnectBtn = document.getElementById('zapierConnect');",
    "  const atIntegrationLimit = Boolean(integrationQuota && integrationQuota.atLimit);",
    "  const slackCanCreate = !(atIntegrationLimit && !slack.connected);",
    "  const zapierCanCreate = !(atIntegrationLimit && !zapier.connected);",
    "  if(slackOauthBtn){",
    "    slackOauthBtn.disabled = !slackOauth.enabled || !slackCanCreate;",
    "    if(!slackOauth.enabled) slackOauthBtn.title = 'Slack OAuth is not configured on this server';",
    "    else if(!slackCanCreate) slackOauthBtn.title = 'Integration limit reached. Upgrade plan to connect more integrations.';",
    "    else slackOauthBtn.title = '';",
    "  }",
    "  if(zapierOauthBtn){",
    "    zapierOauthBtn.disabled = !zapierOauth.enabled || !zapierCanCreate;",
    "    if(!zapierOauth.enabled) zapierOauthBtn.title = 'Zapier OAuth is not configured on this server';",
    "    else if(!zapierCanCreate) zapierOauthBtn.title = 'Integration limit reached. Upgrade plan to connect more integrations.';",
    "    else zapierOauthBtn.title = '';",
    "  }",
    "  if(slackConnectBtn){",
    "    slackConnectBtn.disabled = !slackCanCreate;",
    "    slackConnectBtn.title = slackCanCreate ? '' : 'Integration limit reached. Upgrade plan to connect more integrations.';",
    "  }",
    "  if(zapierConnectBtn){",
    "    zapierConnectBtn.disabled = !zapierCanCreate;",
    "    zapierConnectBtn.title = zapierCanCreate ? '' : 'Integration limit reached. Upgrade plan to connect more integrations.';",
    "  }",
    "}",
    "async function refresh(){",
    "  const j = await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/integrations/state`);",
    "  state.payload = j;",
    "  state.upgradeHintApi = null;",
    "  render();",
    "}",
    "async function connect(provider){",
    "  const id = provider==='slack' ? 'slackUrl' : 'zapierUrl';",
    "  const webhookUrl = document.getElementById(id).value.trim();",
    "  if(!webhookUrl){ setInlineError(providerStatusId(provider), 'Webhook URL is required'); return; }",
    "  await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/integrations/${provider}/connect`, { webhookUrl });",
    "  await refresh();",
    "}",
    "async function disconnect(provider){",
    "  await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/integrations/${provider}/disconnect`, {});",
    "  await refresh();",
    "}",
    "function oauthConnect(provider){",
    "  const path = `/v1/tenants/${encodeURIComponent(tenantId)}/integrations/${provider}/oauth/start`;",
    "  window.location.assign(path);",
    "}",
    "async function testSend(provider){",
    "  const outId = provider==='slack' ? 'slackStatus' : 'zapierStatus';",
    "  setText(outId, 'sending test event…');",
    "  await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/integrations/${provider}/test-send`, { event: 'verification.completed' });",
    "  await refresh();",
    "}",
    "async function runWebhookRetrySweep(){",
    "  await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/run-once`, {});",
    "  await refresh();",
    "}",
    "async function replayLatestDeadLetter(){",
    "  const retryQueue = state.payload && state.payload.retryQueue ? state.payload.retryQueue : {};",
    "  const provider = state.retryProvider || 'all';",
    "  const latestByProvider = retryQueue.latestDeadLetterByProvider || {};",
    "  const latestDead = provider === 'all' ? (retryQueue.latestDeadLetter || null) : (latestByProvider[provider] || null);",
    "  if(!latestDead || !latestDead.token || !latestDead.idempotencyKey){ setInlineError('retryQueueStatus', 'No dead-letter webhook job to replay.'); return; }",
    "  const qs = provider === 'all' ? '' : `?provider=${encodeURIComponent(provider)}`;",
    "  const body = { resetAttempts: true, useCurrentSettings: true };",
    "  if(provider !== 'all') body.provider = provider;",
    "  await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/webhook-retries/replay-latest${qs}`, body);",
    "  await refresh();",
    "}",
    "document.getElementById('slackOauth').addEventListener('click', ()=>oauthConnect('slack'));",
    "document.getElementById('slackConnect').addEventListener('click', ()=>connect('slack').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('slackStatus', e.message); }));",
    "document.getElementById('slackDisconnect').addEventListener('click', ()=>disconnect('slack').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('slackStatus', e.message); }));",
    "document.getElementById('slackTest').addEventListener('click', ()=>testSend('slack').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('slackStatus', e.message); }));",
    "document.getElementById('zapierOauth').addEventListener('click', ()=>oauthConnect('zapier'));",
    "document.getElementById('zapierConnect').addEventListener('click', ()=>connect('zapier').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('zapierStatus', e.message); }));",
    "document.getElementById('zapierDisconnect').addEventListener('click', ()=>disconnect('zapier').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('zapierStatus', e.message); }));",
    "document.getElementById('zapierTest').addEventListener('click', ()=>testSend('zapier').catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('zapierStatus', e.message); }));",
    "document.getElementById('retryProvider').addEventListener('change', (e)=>{ state.retryProvider = String(e.target && e.target.value ? e.target.value : 'all'); render(); });",
    "document.getElementById('retryRunOnce').addEventListener('click', ()=>runWebhookRetrySweep().catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('retryQueueStatus', e.message); }));",
    "document.getElementById('retryReplayLatest').addEventListener('click', ()=>replayLatestDeadLetter().catch((e)=>{ applyUpgradeHintFromApi(e); setInlineError('retryQueueStatus', e.message); }));",
    "document.getElementById('upgradePlan').addEventListener('click', ()=>startUpgradeCheckout());",
    "document.getElementById('openBillingState').addEventListener('click', ()=>window.location.assign(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/state`));",
    "refresh().then(()=>applyOauthFlash()).catch((e)=>{ setText('relayStatus','failed to load: '+e.message); setClass('relayStatus','status','bad'); });",
    "</script>",
    "</body></html>"
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

async function handleTenantSettlementPoliciesPage(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<title>Settlement Policies</title>",
    "<style>",
    ":root{--bg:#f6f8ff;--card:#ffffff;--ink:#0f172a;--muted:#475569;--line:#dbe4ff;--accent:#1d4ed8;--good:#15803d;--warn:#b45309;--bad:#b91c1c}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(circle at 0 0,#e0ecff 0,#f6f8ff 42%),radial-gradient(circle at 100% 100%,#ddf4ff 0,#f6f8ff 38%);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink)}",
    ".shell{max-width:1080px;margin:0 auto;padding:24px 18px 40px}",
    ".hero{padding:18px 20px;border:1px solid var(--line);background:#fff;border-radius:16px;box-shadow:0 8px 28px rgba(29,78,216,0.08)}",
    ".hero h1{margin:0 0 8px;font-size:26px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".grid{display:grid;gap:12px;margin-top:12px}",
    ".card{border:1px solid var(--line);border-radius:14px;padding:14px;background:#fff}",
    ".card h2{margin:0 0 8px;font-size:18px}",
    ".muted{color:var(--muted)}",
    ".row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}",
    ".field{flex:1;min-width:180px}",
    ".field.small{max-width:180px;min-width:140px}",
    "input,select,textarea{width:100%;border:1px solid #c7d2fe;border-radius:10px;padding:8px 10px;font:inherit;background:#fff}",
    "input[type='checkbox']{width:auto}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;text-decoration:none}",
    ".btn.ghost{background:#fff;color:var(--accent);border:1px solid #bfdbfe}",
    ".btn.warn{background:#a16207}",
    ".status{padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc}",
    ".status.good{border-color:#bbf7d0;background:#f0fdf4;color:var(--good)}",
    ".status.warn{border-color:#fed7aa;background:#fffbeb;color:var(--warn)}",
    ".status.bad{border-color:#fecaca;background:#fef2f2;color:var(--bad)}",
    "pre{margin:0;white-space:pre-wrap;word-break:break-word;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:340px;overflow:auto}",
    "code{background:#f1f5f9;padding:2px 6px;border-radius:6px}",
    ".pill{display:inline-flex;align-items:center;border:1px solid #bfdbfe;background:#eff6ff;color:#1e3a8a;padding:1px 7px;border-radius:999px;font-size:12px;font-weight:600}",
    "table{width:100%;border-collapse:collapse}",
    "th,td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}",
    "</style>",
    "</head><body><div class=\"shell\">",
    "<div class=\"hero\">",
    "<h1>Settlement Policy Control Plane</h1>",
    `<p>Tenant <code>${htmlEscape(tenantId)}</code>. Publish versioned settlement policies, set defaults, and replay payout outcomes before shipping.</p>`,
    "<div style=\"margin-top:10px\">",
    `<a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/onboarding\">Open onboarding</a>`,
    `<a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/integrations\">Open integrations</a>`,
    `<a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies\">Settlement policies</a>`,
    "</div>",
    "</div>",
    "<div class=\"grid\">",
    "<section class=\"card\">",
    "<h2>Plan & Limits</h2>",
    "<div id=\"policyQuotaStatus\" class=\"status\">Loading…</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"policyUpgradePlan\">Upgrade plan</button>",
    "<button class=\"btn ghost\" id=\"policyOpenBillingState\">Open billing state</button>",
    "<span id=\"policyUpgradeHint\" class=\"muted\"></span>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Registry State</h2>",
    "<div id=\"registryStatus\" class=\"status\">Loading…</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">Select policy version</div><select id=\"policySelect\"></select></div>",
    "<button class=\"btn ghost\" id=\"refreshState\">Refresh</button>",
    "<button class=\"btn warn\" id=\"setDefault\">Set selected as default</button>",
    "</div>",
    "<div class=\"muted\" style=\"margin-top:8px\">Selected policy detail</div>",
    "<pre id=\"policyDetail\">{}</pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Rollout Stages</h2>",
    "<div id=\"rolloutStatus\" class=\"status\">Loading…</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field small\"><div class=\"muted\">Stage</div><select id=\"rolloutStage\"><option value=\"draft\">draft</option><option value=\"canary\">canary</option><option value=\"active\">active</option></select></div>",
    "<div class=\"field\"><div class=\"muted\">Policy version for stage</div><select id=\"rolloutPolicySelect\"></select></div>",
    "<div class=\"field small\"><div class=\"muted\">Canary rollout %</div><input id=\"rolloutPercent\" type=\"number\" min=\"1\" max=\"100\" value=\"10\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"applyRolloutStage\">Apply stage</button>",
    "<button class=\"btn ghost\" id=\"promoteDraft\">Promote draft to active</button>",
    "<button class=\"btn ghost\" id=\"clearCanary\">Clear canary</button>",
    "<button class=\"btn warn\" id=\"rollbackActive\">Rollback active</button>",
    "</div>",
    "<div class=\"muted\" style=\"margin-top:8px\">Recent rollout history</div>",
    "<pre id=\"rolloutHistory\">[]</pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Preset Packs</h2>",
    "<div class=\"muted\">One-click policy packs for spend caps, holdbacks, and dispute windows.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">Preset</div><select id=\"presetSelect\"></select></div>",
    "<label class=\"muted\"><input id=\"presetSetDefault\" type=\"checkbox\" checked/> set as default active policy</label>",
    "<button class=\"btn\" id=\"applyPreset\">Apply preset</button>",
    "</div>",
    "<div id=\"presetStatus\" class=\"status\" style=\"margin-top:8px\">Loading preset catalog…</div>",
    "<pre id=\"presetDetail\" style=\"margin-top:8px\">{}</pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Publish Policy Version</h2>",
    "<div class=\"row\">",
    "<div class=\"field\"><div class=\"muted\">Policy ID</div><input id=\"policyId\" value=\"market.default.auto-v1\"/></div>",
    "<div class=\"field small\"><div class=\"muted\">Policy version (optional)</div><input id=\"policyVersion\" type=\"number\" min=\"1\" placeholder=\"auto\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Description</div><input id=\"policyDescription\" placeholder=\"Default policy for autonomous settlements\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field small\"><div class=\"muted\">Verification mode</div><select id=\"verificationMode\"><option value=\"deterministic\">deterministic</option><option value=\"attested\">attested</option><option value=\"discretionary\">discretionary</option></select></div>",
    "<div class=\"field small\"><div class=\"muted\">Settlement mode</div><select id=\"policyMode\"><option value=\"automatic\">automatic</option><option value=\"manual-review\">manual-review</option></select></div>",
    "<div class=\"field small\"><div class=\"muted\">Max auto-release cents</div><input id=\"maxAutoReleaseAmountCents\" type=\"number\" min=\"1\" placeholder=\"none\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Manual reason</div><input id=\"manualReason\" placeholder=\"Optional manual-review note\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field small\"><div class=\"muted\">Green release %</div><input id=\"greenReleaseRatePct\" type=\"number\" min=\"0\" max=\"100\" value=\"100\"/></div>",
    "<div class=\"field small\"><div class=\"muted\">Amber release %</div><input id=\"amberReleaseRatePct\" type=\"number\" min=\"0\" max=\"100\" value=\"50\"/></div>",
    "<div class=\"field small\"><div class=\"muted\">Red release %</div><input id=\"redReleaseRatePct\" type=\"number\" min=\"0\" max=\"100\" value=\"0\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<label class=\"muted\"><input id=\"requireDeterministicVerification\" type=\"checkbox\"/> require deterministic verification</label>",
    "<label class=\"muted\"><input id=\"autoReleaseOnGreen\" type=\"checkbox\" checked/> auto-release green</label>",
    "<label class=\"muted\"><input id=\"autoReleaseOnAmber\" type=\"checkbox\"/> auto-release amber</label>",
    "<label class=\"muted\"><input id=\"autoReleaseOnRed\" type=\"checkbox\"/> auto-release red</label>",
    "<label class=\"muted\"><input id=\"setAsDefaultOnSave\" type=\"checkbox\" checked/> set as default</label>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"savePolicy\">Save policy version</button>",
    "<span id=\"saveStatus\" class=\"muted\"></span>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Replay Simulator</h2>",
    "<div class=\"muted\">Evaluate the selected policy with synthetic or token-derived verification status before enabling auto-settlement.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field small\"><div class=\"muted\">Amount cents</div><input id=\"replayAmountCents\" type=\"number\" min=\"1\" value=\"1000\"/></div>",
    "<div class=\"field small\"><div class=\"muted\">Verification status</div><select id=\"replayVerificationStatus\"><option value=\"green\">green</option><option value=\"amber\">amber</option><option value=\"red\">red</option></select></div>",
    "<div class=\"field small\"><div class=\"muted\">Run status</div><select id=\"replayRunStatus\"><option value=\"completed\">completed</option><option value=\"failed\">failed</option></select></div>",
    "<div class=\"field\"><div class=\"muted\">Optional token (derive status from /r/:token/verify.json)</div><input id=\"replayToken\" placeholder=\"ml_...\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"runReplay\">Run replay</button>",
    "<span id=\"replayStatus\" class=\"muted\"></span>",
    "</div>",
    "<pre id=\"replayResult\">{}</pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Policy Diff</h2>",
    "<div class=\"muted\">Compare two policy versions to review field-level changes before rollout.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">From policy</div><select id=\"diffFrom\"></select></div>",
    "<div class=\"field\"><div class=\"muted\">To policy</div><select id=\"diffTo\"></select></div>",
    "<div class=\"field small\"><div class=\"muted\">Row limit</div><input id=\"diffLimit\" type=\"number\" min=\"1\" max=\"2000\" value=\"200\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn warn\" id=\"computeDiff\">Compute diff</button>",
    "<span id=\"diffStatus\" class=\"muted\"></span>",
    "</div>",
    "<div id=\"diffSummary\" class=\"status\" style=\"margin-top:8px\">No diff loaded.</div>",
    "<div id=\"diffTable\" style=\"margin-top:8px\"></div>",
    "</section>",
    "</div>",
    "</div>",
    "<script>",
    `const tenantId = ${JSON.stringify(tenantId)};`,
    "const state = { payload: null, selectedKey: '', upgradeMessage: '', upgradeHintApi: null, diff: null, diffFromKey: '', diffToKey: '', presets: [], selectedPresetId: '' };",
    "function setText(id, text){ const el=document.getElementById(id); if(el) el.textContent=String(text||''); }",
    "function setClass(id, base, tone){ const el=document.getElementById(id); if(!el) return; el.className = base + (tone ? ' '+tone : ''); }",
    "function setHtml(id, html){ const el=document.getElementById(id); if(el) el.innerHTML=String(html||''); }",
    "function esc(v){ return String(v===undefined||v===null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll(\"'\",'&#39;'); }",
    "function nextPaidPlan(plan){ const p=String(plan||'').trim().toLowerCase(); if(p==='free') return 'builder'; if(p==='builder') return 'growth'; if(p==='growth') return 'enterprise'; return null; }",
    "async function startUpgradeCheckout(){",
    "  const payload = state.payload || {};",
    "  const ent = payload.entitlements || {};",
    "  const hintedPlans = state.upgradeHintApi && Array.isArray(state.upgradeHintApi.suggestedPlans) ? state.upgradeHintApi.suggestedPlans : [];",
    "  const plan = hintedPlans.length ? hintedPlans[0] : nextPaidPlan(ent.plan || 'free');",
    "  if(!plan){ state.upgradeMessage='Top plan is already active.'; render(); return; }",
    "  state.upgradeMessage = `starting ${plan} checkout…`;",
    "  render();",
    "  try{",
    "    const out = await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/checkout`, { plan });",
    "    state.upgradeHintApi = null;",
    "    if(out && out.checkoutUrl){ window.location.assign(out.checkoutUrl); return; }",
    "    state.upgradeMessage = `checkout created for ${plan}`;",
    "    render();",
    "  }catch(e){ if(!applyUpgradeHintFromApi(e)){ state.upgradeMessage = `upgrade failed: ${e.message}`; render(); } }",
    "}",
    "function parseKey(key){ const t=String(key||''); const i=t.lastIndexOf('@'); if(i<=0) return null; const policyId=t.slice(0,i); const version=Number(t.slice(i+1)); if(!policyId||!Number.isInteger(version)||version<1) return null; return { policyId, policyVersion: version }; }",
    "function keyForRef(ref){ if(!ref||typeof ref!=='object') return ''; const id=String(ref.policyId||'').trim(); const version=Number(ref.policyVersion); if(!id||!Number.isInteger(version)||version<1) return ''; return `${id}@${version}`; }",
    "function selectedPreset(){ const rows = Array.isArray(state.presets) ? state.presets : []; const id = String(state.selectedPresetId||'').trim(); if(!id) return rows[0] || null; return rows.find((row)=>String(row && row.presetId || '')===id) || rows[0] || null; }",
    "function selectedRecord(){",
    "  const rows = state.payload && Array.isArray(state.payload.policies) ? state.payload.policies : [];",
    "  const parsed = parseKey(state.selectedKey);",
    "  if(!parsed) return rows[0] || null;",
    "  return rows.find((row)=>String(row.policyId)===parsed.policyId && Number(row.policyVersion)===parsed.policyVersion) || null;",
    "}",
    "function rowsFromState(){ return state.payload && Array.isArray(state.payload.policies) ? state.payload.policies : []; }",
    "function rowKey(row){ return row ? `${row.policyId}@${row.policyVersion}` : ''; }",
    "async function getJson(url){ const res=await fetch(url,{credentials:'same-origin'}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "async function postJson(url, body){ const res=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok){ const err=new Error((j&&j.message)||txt||('HTTP '+res.status)); if(j) err.payload=j; throw err; } return j; }",
    "function apiPayloadFromError(err){ return err && typeof err==='object' && err.payload && typeof err.payload==='object' ? err.payload : null; }",
    "function applyUpgradeHintFromApi(err){",
    "  const payload = apiPayloadFromError(err);",
    "  const hint = payload && payload.upgradeHint && typeof payload.upgradeHint==='object' ? payload.upgradeHint : null;",
    "  if(!hint) return false;",
    "  const suggestedPlans = Array.isArray(hint.suggestedPlans) ? hint.suggestedPlans.map((p)=>String(p||'').trim()).filter(Boolean) : [];",
    "  state.upgradeHintApi = { ...hint, suggestedPlans, message: String(payload.message||err.message||'') };",
    "  if(!state.upgradeMessage) state.upgradeMessage = state.upgradeHintApi.message || '';",
    "  render();",
    "  return true;",
    "}",
    "function setSelectOptions(selectId, rows, selectedKey, emptyLabel){",
    "  const sel = document.getElementById(selectId);",
    "  if(!sel) return;",
    "  sel.innerHTML='';",
    "  for(const row of rows){",
    "    const opt=document.createElement('option');",
    "    const key=rowKey(row);",
    "    opt.value=key;",
    "    opt.textContent=key;",
    "    sel.appendChild(opt);",
    "  }",
    "  if(!rows.length){ const opt=document.createElement('option'); opt.value=''; opt.textContent=emptyLabel||'(none)'; sel.appendChild(opt); }",
    "  const chosen = selectedKey && rows.some((row)=>rowKey(row)===selectedKey) ? selectedKey : (rows[0] ? rowKey(rows[0]) : '');",
    "  sel.value = chosen;",
    "}",
    "function valueSummary(v){",
    "  if(v===null||v===undefined) return 'null';",
    "  if(typeof v==='string') return v.length>96 ? `${v.slice(0,93)}...` : v;",
    "  const raw = JSON.stringify(v);",
    "  if(typeof raw!=='string') return String(v);",
    "  return raw.length>96 ? `${raw.slice(0,93)}...` : raw;",
    "}",
    "function tableFromRows(columns, rows){",
    "  if(!Array.isArray(rows)||!rows.length) return '<div class=\"muted\">No rows.</div>';",
    "  const head='<tr>'+columns.map((c)=>`<th>${esc(c.label)}</th>`).join('')+'</tr>';",
    "  const body=rows.map((row)=>'<tr>'+columns.map((c)=>`<td>${esc(c.render ? c.render(row) : row[c.key])}</td>`).join('')+'</tr>').join('');",
    "  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;",
    "}",
    "function renderDiff(){",
    "  if(!state.diff){",
    "    setText('diffSummary', 'No diff loaded.');",
    "    setClass('diffSummary', 'status', '');",
    "    setHtml('diffTable', '<div class=\"muted\">Compute a diff between two policy versions.</div>');",
    "    return;",
    "  }",
    "  const diff = state.diff;",
    "  const summary = diff.summary || {};",
    "  const changedTotal = Number(summary.changed||0) + Number(summary.added||0) + Number(summary.removed||0);",
    "  const summaryText = `from=${keyForRef(diff.fromPolicyRef)||'unknown'} -> to=${keyForRef(diff.toPolicyRef)||'unknown'} | changed=${summary.changed||0} added=${summary.added||0} removed=${summary.removed||0} unchanged=${summary.unchanged||0}`;",
    "  setText('diffSummary', summaryText);",
    "  setClass('diffSummary', 'status', changedTotal > 0 ? 'warn' : 'good');",
    "  const rows = Array.isArray(diff.changes) ? diff.changes : [];",
    "  setHtml('diffTable', tableFromRows([",
    "    { key: 'kind', label: 'Kind' },",
    "    { key: 'path', label: 'Path' },",
    "    { key: 'fromValue', label: 'From', render: (row)=>valueSummary(row.fromValue) },",
    "    { key: 'toValue', label: 'To', render: (row)=>valueSummary(row.toValue) }",
    "  ], rows));",
    "}",
    "function render(){",
    "  const payload = state.payload || {};",
    "  const rows = Array.isArray(payload.policies) ? payload.policies : [];",
    "  const ent = payload.entitlements || {};",
    "  const policyQuota = payload.quota && payload.quota.maxPolicyVersions ? payload.quota.maxPolicyVersions : null;",
    "  const plan = String(ent.plan || 'free');",
    "  const quotaText = !policyQuota ? 'quota unavailable' : (policyQuota.unlimited ? `policy versions=${policyQuota.used} (unlimited)` : `policy versions=${policyQuota.used}/${policyQuota.limit} (remaining=${policyQuota.remaining})`);",
    "  setText('policyQuotaStatus', `plan=${plan} | ${quotaText}`);",
    "  setClass('policyQuotaStatus', 'status', policyQuota && policyQuota.atLimit ? 'warn' : 'good');",
    "  const hintedPlans = state.upgradeHintApi && Array.isArray(state.upgradeHintApi.suggestedPlans) ? state.upgradeHintApi.suggestedPlans : [];",
    "  const nextPlan = hintedPlans.length ? hintedPlans[0] : nextPaidPlan(plan);",
    "  const upgradeBtn = document.getElementById('policyUpgradePlan');",
    "  if(upgradeBtn){",
    "    upgradeBtn.disabled = !nextPlan;",
    "    upgradeBtn.textContent = nextPlan ? `Upgrade to ${nextPlan}` : 'Top plan active';",
    "  }",
    "  if(state.upgradeHintApi){",
    "    const hintMessage = String(state.upgradeHintApi.message || '').trim();",
    "    if(hintMessage) setText('policyUpgradeHint', hintMessage);",
    "    else if(nextPlan) setText('policyUpgradeHint', `Policy version limit reached. Upgrade to ${nextPlan} to publish more versions.`);",
    "    else setText('policyUpgradeHint', 'Policy version limit reached.');",
    "  } else if(state.upgradeMessage){",
    "    setText('policyUpgradeHint', state.upgradeMessage);",
    "  } else if(policyQuota && policyQuota.atLimit && nextPlan){",
    "    setText('policyUpgradeHint', `Policy version limit reached. Upgrade to ${nextPlan} to publish more versions.`);",
    "  } else if(nextPlan){",
    "    setText('policyUpgradeHint', `Current plan ${plan}.`);",
    "  } else {",
    "    setText('policyUpgradeHint', 'Top plan has no policy version cap.');",
    "  }",
    "  const rollout = payload.rollout && typeof payload.rollout==='object' ? payload.rollout : {};",
    "  const rolloutStages = rollout.stages && typeof rollout.stages==='object' ? rollout.stages : {};",
    "  const defaultRef = payload.defaultPolicyRef || null;",
    "  const draftRef = rolloutStages.draft || null;",
    "  const activeRef = rolloutStages.active || defaultRef || null;",
    "  const canaryRef = rolloutStages.canary && rolloutStages.canary.policyRef ? rolloutStages.canary.policyRef : null;",
    "  const canaryPercent = rolloutStages.canary && Number.isFinite(Number(rolloutStages.canary.rolloutPercent)) ? Number(rolloutStages.canary.rolloutPercent) : 0;",
    "  const summary = rows.length",
    "    ? `versions=${rows.length} | policyIds=${(payload.policyIds||[]).length} | default=${defaultRef ? `${defaultRef.policyId}@${defaultRef.policyVersion}` : 'none'} | active=${keyForRef(activeRef)||'none'}`",
    "    : 'No policy versions saved yet.';",
    "  setText('registryStatus', summary);",
    "  const registryEl=document.getElementById('registryStatus');",
    "  if(registryEl){ registryEl.className = rows.length ? 'status good' : 'status warn'; }",
    "  const sel = document.getElementById('policySelect');",
    "  if(sel){",
    "    sel.innerHTML='';",
    "    for(const row of rows){",
    "      const key = `${row.policyId}@${row.policyVersion}`;",
    "      const opt = document.createElement('option');",
    "      opt.value = key;",
    "      const tags=[];",
    "      if(defaultRef && defaultRef.policyId===row.policyId && Number(defaultRef.policyVersion)===Number(row.policyVersion)) tags.push('default');",
    "      if(activeRef && activeRef.policyId===row.policyId && Number(activeRef.policyVersion)===Number(row.policyVersion)) tags.push('active');",
    "      if(draftRef && draftRef.policyId===row.policyId && Number(draftRef.policyVersion)===Number(row.policyVersion)) tags.push('draft');",
    "      if(canaryRef && canaryRef.policyId===row.policyId && Number(canaryRef.policyVersion)===Number(row.policyVersion)) tags.push(`canary:${canaryPercent}%`);",
    "      opt.textContent = key + (tags.length ? ` [${tags.join(', ')}]` : '');",
    "      sel.appendChild(opt);",
    "    }",
    "    if(!rows.length){",
    "      const opt=document.createElement('option'); opt.value=''; opt.textContent='(none)'; sel.appendChild(opt);",
    "    }",
    "    const desired = state.selectedKey && rows.some((row)=>`${row.policyId}@${row.policyVersion}`===state.selectedKey) ? state.selectedKey : (rows[0] ? `${rows[0].policyId}@${rows[0].policyVersion}` : '');",
    "    state.selectedKey = desired;",
    "    sel.value = desired;",
    "  }",
    "  const selected = selectedRecord();",
    "  setText('policyDetail', JSON.stringify(selected || {}, null, 2));",
    "  const rolloutStatus = `active=${keyForRef(activeRef)||'none'} | draft=${keyForRef(draftRef)||'none'} | canary=${keyForRef(canaryRef)||'none'}${canaryRef ? ` (${canaryPercent}%)` : ''}`;",
    "  setText('rolloutStatus', rolloutStatus);",
    "  setClass('rolloutStatus', 'status', activeRef ? (canaryRef ? 'warn' : 'good') : 'warn');",
    "  const rolloutHistory = Array.isArray(payload.rolloutHistory) ? payload.rolloutHistory : (Array.isArray(rollout.history) ? rollout.history.slice().reverse() : []);",
    "  setText('rolloutHistory', JSON.stringify(rolloutHistory.slice(0, 30), null, 2));",
    "  const presetRows = Array.isArray(state.presets) ? state.presets : [];",
    "  const presetSelect = document.getElementById('presetSelect');",
    "  if(presetSelect){",
    "    presetSelect.innerHTML='';",
    "    for(const preset of presetRows){",
    "      const id = String(preset && preset.presetId ? preset.presetId : '').trim();",
    "      if(!id) continue;",
    "      const opt = document.createElement('option');",
    "      opt.value = id;",
    "      opt.textContent = `${id} - ${String(preset && preset.name ? preset.name : '')}`;",
    "      presetSelect.appendChild(opt);",
    "    }",
    "    if(!presetRows.length){ const opt=document.createElement('option'); opt.value=''; opt.textContent='(none)'; presetSelect.appendChild(opt); }",
    "    const selectedPresetId = state.selectedPresetId && presetRows.some((row)=>String(row && row.presetId || '')===state.selectedPresetId) ? state.selectedPresetId : (presetRows[0] ? String(presetRows[0].presetId || '') : '');",
    "    state.selectedPresetId = selectedPresetId;",
    "    presetSelect.value = selectedPresetId;",
    "  }",
    "  const preset = selectedPreset();",
    "  const presetStatus = preset ? `Preset ${preset.presetId} ready. One click will publish${document.getElementById('presetSetDefault') && document.getElementById('presetSetDefault').checked ? ' and promote to active' : ' to draft'}.` : 'No preset catalog available.';",
    "  setText('presetStatus', presetStatus);",
    "  setClass('presetStatus', 'status', preset ? 'good' : 'warn');",
    "  setText('presetDetail', JSON.stringify(preset || {}, null, 2));",
    "  const stageSelect = document.getElementById('rolloutStage');",
    "  const stage = stageSelect ? String(stageSelect.value||'draft') : 'draft';",
    "  const stageSelectedKey = stage==='active' ? keyForRef(activeRef) : stage==='canary' ? keyForRef(canaryRef) : keyForRef(draftRef);",
    "  setSelectOptions('rolloutPolicySelect', rows, stageSelectedKey || state.selectedKey, '(select policy)');",
    "  const percentInput = document.getElementById('rolloutPercent');",
    "  if(percentInput && (!percentInput.value || Number(percentInput.value)<=0)) percentInput.value = String(canaryPercent > 0 ? canaryPercent : 10);",
    "  const fallbackFrom = keyForRef(activeRef) || (rows[0] ? rowKey(rows[0]) : '');",
    "  const fallbackTo = keyForRef(draftRef) || keyForRef(canaryRef) || state.selectedKey || fallbackFrom;",
    "  state.diffFromKey = state.diffFromKey && rows.some((row)=>rowKey(row)===state.diffFromKey) ? state.diffFromKey : fallbackFrom;",
    "  state.diffToKey = state.diffToKey && rows.some((row)=>rowKey(row)===state.diffToKey) ? state.diffToKey : fallbackTo;",
    "  setSelectOptions('diffFrom', rows, state.diffFromKey, '(none)');",
    "  setSelectOptions('diffTo', rows, state.diffToKey, '(none)');",
    "  renderDiff();",
    "}",
    "async function refreshState(){",
    "  const j = await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/state`);",
    "  state.payload = j;",
    "  state.upgradeHintApi = null;",
    "  render();",
    "}",
    "async function refreshPresets(){",
    "  const j = await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/presets`);",
    "  state.presets = Array.isArray(j && j.presets) ? j.presets : [];",
    "  render();",
    "}",
    "async function applyRolloutStage(){",
    "  const stage = String(document.getElementById('rolloutStage').value||'draft');",
    "  const selectedKey = String(document.getElementById('rolloutPolicySelect').value||'');",
    "  const parsed = parseKey(selectedKey);",
    "  if(!parsed){ setText('rolloutStatus', `Select a policy for ${stage} stage`); setClass('rolloutStatus','status','bad'); return; }",
    "  const body = { stage, policyId: parsed.policyId, policyVersion: parsed.policyVersion };",
    "  if(stage==='canary'){",
    "    body.rolloutPercent = Number(document.getElementById('rolloutPercent').value||10);",
    "  }",
    "  setText('rolloutStatus', `applying ${stage}...`);",
    "  setClass('rolloutStatus', 'status', '');",
    "  try{",
    "    await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/rollout`, body);",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('rolloutStatus', 'failed: '+e.message); setClass('rolloutStatus','status','bad'); }",
    "}",
    "async function promoteDraft(){",
    "  const payload = state.payload || {};",
    "  const rollout = payload.rollout && payload.rollout.stages ? payload.rollout.stages : {};",
    "  const draftRef = rollout.draft || null;",
    "  if(!draftRef){ setText('rolloutStatus', 'No draft policy available to promote.'); setClass('rolloutStatus', 'status', 'warn'); return; }",
    "  setText('rolloutStatus', 'promoting draft to active...');",
    "  setClass('rolloutStatus', 'status', '');",
    "  try{",
    "    await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/rollout`, { stage: 'active', policyId: draftRef.policyId, policyVersion: draftRef.policyVersion, note: 'promote draft' });",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('rolloutStatus', 'failed: '+e.message); setClass('rolloutStatus', 'status', 'bad'); }",
    "}",
    "async function clearCanary(){",
    "  setText('rolloutStatus', 'clearing canary stage...');",
    "  setClass('rolloutStatus', 'status', '');",
    "  try{",
    "    await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/rollout`, { stage: 'canary', clear: true, note: 'clear canary stage' });",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('rolloutStatus', 'failed: '+e.message); setClass('rolloutStatus', 'status', 'bad'); }",
    "}",
    "async function applyPreset(){",
    "  const presetId = String(document.getElementById('presetSelect').value||'').trim();",
    "  if(!presetId){ setText('presetStatus','select a preset first'); setClass('presetStatus','status','bad'); return; }",
    "  const setAsDefault = Boolean(document.getElementById('presetSetDefault').checked);",
    "  setText('presetStatus', `applying ${presetId}...`);",
    "  setClass('presetStatus', 'status', '');",
    "  try{",
    "    const out = await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/presets/apply`, { presetId, setAsDefault });",
    "    if(out && out.policy && out.policy.policyId && out.policy.policyVersion){ state.selectedKey = `${out.policy.policyId}@${out.policy.policyVersion}`; }",
    "    setText('presetStatus', `applied ${presetId}`);",
    "    setClass('presetStatus', 'status', 'good');",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('presetStatus','failed: '+e.message); setClass('presetStatus','status','bad'); }",
    "}",
    "async function rollbackActive(){",
    "  setText('rolloutStatus', 'rolling back active stage...');",
    "  setClass('rolloutStatus', 'status', '');",
    "  try{",
    "    await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/rollback`, { note: 'rollback via control plane' });",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('rolloutStatus', 'failed: '+e.message); setClass('rolloutStatus', 'status', 'bad'); }",
    "}",
    "async function computeDiff(){",
    "  const fromParsed = parseKey(String(document.getElementById('diffFrom').value||''));",
    "  const toParsed = parseKey(String(document.getElementById('diffTo').value||''));",
    "  if(!fromParsed || !toParsed){ setText('diffStatus','select from/to policies first'); return; }",
    "  const limit = Number(document.getElementById('diffLimit').value||200);",
    "  state.diffFromKey = `${fromParsed.policyId}@${fromParsed.policyVersion}`;",
    "  state.diffToKey = `${toParsed.policyId}@${toParsed.policyVersion}`;",
    "  setText('diffStatus','computing diff...');",
    "  try{",
    "    const qs = new URLSearchParams();",
    "    qs.set('fromPolicyId', fromParsed.policyId);",
    "    qs.set('fromPolicyVersion', String(fromParsed.policyVersion));",
    "    qs.set('toPolicyId', toParsed.policyId);",
    "    qs.set('toPolicyVersion', String(toParsed.policyVersion));",
    "    qs.set('limit', String(Number.isInteger(limit)&&limit>0?limit:200));",
    "    const out = await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/diff?${qs.toString()}`);",
    "    state.diff = out;",
    "    setText('diffStatus','diff loaded');",
    "    renderDiff();",
    "  } catch(e){ setText('diffStatus','failed: '+e.message); }",
    "}",
    "async function savePolicy(){",
    "  const policyId = String(document.getElementById('policyId').value||'').trim();",
    "  if(!policyId){ setText('saveStatus','policyId is required'); return; }",
    "  const policyVersionRaw = String(document.getElementById('policyVersion').value||'').trim();",
    "  const maxAutoRaw = String(document.getElementById('maxAutoReleaseAmountCents').value||'').trim();",
    "  const body = {",
    "    policyId,",
    "    description: String(document.getElementById('policyDescription').value||'').trim() || null,",
    "    setAsDefault: Boolean(document.getElementById('setAsDefaultOnSave').checked),",
    "    verificationMethod: { mode: String(document.getElementById('verificationMode').value||'deterministic').trim() },",
    "    policy: {",
    "      mode: String(document.getElementById('policyMode').value||'automatic').trim(),",
    "      rules: {",
    "        requireDeterministicVerification: Boolean(document.getElementById('requireDeterministicVerification').checked),",
    "        autoReleaseOnGreen: Boolean(document.getElementById('autoReleaseOnGreen').checked),",
    "        autoReleaseOnAmber: Boolean(document.getElementById('autoReleaseOnAmber').checked),",
    "        autoReleaseOnRed: Boolean(document.getElementById('autoReleaseOnRed').checked),",
    "        greenReleaseRatePct: Number(document.getElementById('greenReleaseRatePct').value||100),",
    "        amberReleaseRatePct: Number(document.getElementById('amberReleaseRatePct').value||50),",
    "        redReleaseRatePct: Number(document.getElementById('redReleaseRatePct').value||0),",
    "        manualReason: String(document.getElementById('manualReason').value||'').trim() || null",
    "      }",
    "    }",
    "  };",
    "  if(policyVersionRaw){ body.policyVersion = Number(policyVersionRaw); }",
    "  if(maxAutoRaw){ body.policy.rules.maxAutoReleaseAmountCents = Number(maxAutoRaw); }",
    "  setText('saveStatus','saving…');",
    "  try{",
    "    const out = await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/upsert`, body);",
    "    setText('saveStatus', `saved ${out.policy && out.policy.policyId ? out.policy.policyId : policyId}@${out.policy && out.policy.policyVersion ? out.policy.policyVersion : '?'}`);",
    "    state.selectedKey = out.policy && out.policy.policyId ? `${out.policy.policyId}@${out.policy.policyVersion}` : state.selectedKey;",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('saveStatus','failed: '+e.message); }",
    "}",
    "async function setDefault(){",
    "  const selected = selectedRecord();",
    "  if(!selected){ setText('saveStatus','select a policy first'); return; }",
    "  setText('saveStatus','setting default…');",
    "  try{",
    "    await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/default`, { policyId: selected.policyId, policyVersion: selected.policyVersion });",
    "    setText('saveStatus', `default set to ${selected.policyId}@${selected.policyVersion}`);",
    "    await refreshState();",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('saveStatus','failed: '+e.message); }",
    "}",
    "async function runReplay(){",
    "  const selected = selectedRecord();",
    "  if(!selected){ setText('replayStatus','select a policy first'); return; }",
    "  const token = String(document.getElementById('replayToken').value||'').trim();",
    "  const body = {",
    "    policyId: selected.policyId,",
    "    policyVersion: selected.policyVersion,",
    "    amountCents: Number(document.getElementById('replayAmountCents').value||1000),",
    "    verificationStatus: String(document.getElementById('replayVerificationStatus').value||'green').trim(),",
    "    runStatus: String(document.getElementById('replayRunStatus').value||'completed').trim()",
    "  };",
    "  if(token){ body.token = token; body.verificationStatus = null; body.runStatus = null; }",
    "  setText('replayStatus','running replay…');",
    "  try{",
    "    const out = await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies/test-replay`, body);",
    "    setText('replayStatus','replay complete');",
    "    setText('replayResult', JSON.stringify(out, null, 2));",
    "  } catch(e){ applyUpgradeHintFromApi(e); setText('replayStatus','failed: '+e.message); }",
    "}",
    "document.getElementById('policySelect').addEventListener('change', (e)=>{ state.selectedKey = String(e.target && e.target.value ? e.target.value : ''); render(); });",
    "document.getElementById('presetSelect').addEventListener('change', (e)=>{ state.selectedPresetId = String(e.target && e.target.value ? e.target.value : ''); render(); });",
    "document.getElementById('rolloutStage').addEventListener('change', ()=>render());",
    "document.getElementById('rolloutPolicySelect').addEventListener('change', (e)=>{ state.selectedKey = String(e.target && e.target.value ? e.target.value : state.selectedKey); render(); });",
    "document.getElementById('diffFrom').addEventListener('change', (e)=>{ state.diffFromKey = String(e.target && e.target.value ? e.target.value : ''); });",
    "document.getElementById('diffTo').addEventListener('change', (e)=>{ state.diffToKey = String(e.target && e.target.value ? e.target.value : ''); });",
    "document.getElementById('refreshState').addEventListener('click', ()=>refreshState().catch((e)=>setText('registryStatus','failed: '+e.message)));",
    "document.getElementById('setDefault').addEventListener('click', ()=>setDefault().catch((e)=>setText('saveStatus','failed: '+e.message)));",
    "document.getElementById('applyRolloutStage').addEventListener('click', ()=>applyRolloutStage().catch((e)=>setText('rolloutStatus','failed: '+e.message)));",
    "document.getElementById('promoteDraft').addEventListener('click', ()=>promoteDraft().catch((e)=>setText('rolloutStatus','failed: '+e.message)));",
    "document.getElementById('clearCanary').addEventListener('click', ()=>clearCanary().catch((e)=>setText('rolloutStatus','failed: '+e.message)));",
    "document.getElementById('rollbackActive').addEventListener('click', ()=>rollbackActive().catch((e)=>setText('rolloutStatus','failed: '+e.message)));",
    "document.getElementById('applyPreset').addEventListener('click', ()=>applyPreset().catch((e)=>setText('presetStatus','failed: '+e.message)));",
    "document.getElementById('savePolicy').addEventListener('click', ()=>savePolicy().catch((e)=>setText('saveStatus','failed: '+e.message)));",
    "document.getElementById('runReplay').addEventListener('click', ()=>runReplay().catch((e)=>setText('replayStatus','failed: '+e.message)));",
    "document.getElementById('computeDiff').addEventListener('click', ()=>computeDiff().catch((e)=>setText('diffStatus','failed: '+e.message)));",
    "document.getElementById('policyUpgradePlan').addEventListener('click', ()=>startUpgradeCheckout());",
    "document.getElementById('policyOpenBillingState').addEventListener('click', ()=>window.location.assign(`/v1/tenants/${encodeURIComponent(tenantId)}/billing/state`));",
    "Promise.all([refreshState(), refreshPresets()]).catch((e)=>{ setText('registryStatus','failed: '+e.message); setText('presetStatus','failed: '+e.message); });",
    "</script>",
    "</body></html>"
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

async function handleTenantAnalyticsDashboard(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  const prevMonth = previousMonthKey(month) ?? month;
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<title>Analytics Dashboard</title>",
    "<style>",
    ":root{--bg:#f6f8ff;--card:#ffffff;--ink:#0f172a;--muted:#475569;--line:#dbe4ff;--accent:#1d4ed8;--good:#15803d;--warn:#b45309;--bad:#b91c1c}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(circle at 0 0,#e0ecff 0,#f6f8ff 42%),radial-gradient(circle at 100% 100%,#ddf4ff 0,#f6f8ff 38%);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink)}",
    ".shell{max-width:1080px;margin:0 auto;padding:24px 18px 40px}",
    ".hero{padding:18px 20px;border:1px solid var(--line);background:#fff;border-radius:16px;box-shadow:0 8px 28px rgba(29,78,216,0.08)}",
    ".hero h1{margin:0 0 8px;font-size:26px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".grid{display:grid;gap:12px;margin-top:12px}",
    ".card{border:1px solid var(--line);border-radius:14px;padding:14px;background:#fff}",
    ".card h2{margin:0 0 8px;font-size:18px}",
    ".muted{color:var(--muted)}",
    ".row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}",
    ".field{flex:1;min-width:160px}",
    "input,select{width:100%;border:1px solid #c7d2fe;border-radius:10px;padding:8px 10px;font:inherit;background:#fff}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer;text-decoration:none}",
    ".btn.ghost{background:#fff;color:var(--accent);border:1px solid #bfdbfe}",
    ".btn.warn{background:#a16207}",
    ".status{padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc}",
    ".status.good{border-color:#bbf7d0;background:#f0fdf4;color:var(--good)}",
    ".status.warn{border-color:#fed7aa;background:#fffbeb;color:var(--warn)}",
    ".status.bad{border-color:#fecaca;background:#fef2f2;color:var(--bad)}",
    "table{width:100%;border-collapse:collapse}",
    "th,td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}",
    "code{background:#f1f5f9;padding:2px 6px;border-radius:6px}",
    ".mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}",
    "</style>",
    "</head><body><div class=\"shell\">",
    "<div class=\"hero\">",
    "<h1>Analytics Dashboard</h1>",
    `<p>Tenant <code>${htmlEscape(tenantId)}</code>. Monitor verification quality, buyer decisions, and trust graph movement.</p>`,
    "<div style=\"margin-top:10px\">",
    `<a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/onboarding\">Open onboarding</a>`,
    `<a class=\"btn ghost\" href=\"/v1/tenants/${encodeURIComponent(tenantId)}/integrations\">Open integrations</a>`,
    "</div>",
    "</div>",
    "<div class=\"grid\">",
    "<section class=\"card\">",
    "<h2>Filters</h2>",
    "<div class=\"row\">",
    `<div class="field"><div class="muted">Month (YYYY-MM)</div><input id="month" value="${htmlEscape(month)}"/></div>`,
    "<div class=\"field\"><div class=\"muted\">Trend bucket</div><select id=\"bucket\"><option value=\"day\">day</option><option value=\"week\">week</option><option value=\"month\">month</option></select></div>",
    "<div class=\"field\"><div class=\"muted\">Group limit</div><input id=\"limit\" type=\"number\" min=\"1\" max=\"200\" value=\"20\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Trust minRuns</div><input id=\"minRuns\" type=\"number\" min=\"1\" max=\"100000\" value=\"1\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Trust maxEdges</div><input id=\"maxEdges\" type=\"number\" min=\"1\" max=\"2000\" value=\"200\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"refreshBtn\">Refresh</button>",
    "<button class=\"btn ghost\" id=\"snapshotBtn\">Save trust snapshot</button>",
    "<div id=\"filterStatus\" class=\"status\" style=\"min-width:220px\">Idle.</div>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Snapshot Diff</h2>",
    "<div class=\"row\">",
    `<div class="field"><div class="muted">Base month</div><input id="baseMonth" value="${htmlEscape(prevMonth)}"/></div>`,
    `<div class="field"><div class="muted">Compare month</div><input id="compareMonth" value="${htmlEscape(month)}"/></div>`,
    "<div class=\"field\"><div class=\"muted\">Change limit</div><input id=\"diffLimit\" type=\"number\" min=\"1\" max=\"500\" value=\"50\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn warn\" id=\"diffBtn\">Compute diff</button>",
    "<div id=\"diffStatus\" class=\"status\" style=\"min-width:220px\">Idle.</div>",
    "</div>",
    "<div id=\"diffSummary\" class=\"status\" style=\"margin-top:8px\">No diff yet.</div>",
    "<div id=\"diffChanges\" style=\"margin-top:8px\"></div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Topline</h2>",
    "<div id=\"topline\" class=\"status\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Trend</h2>",
    "<div id=\"trendTable\" class=\"muted\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Top Vendors</h2>",
    "<div id=\"vendorTable\" class=\"muted\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Top Contracts</h2>",
    "<div id=\"contractTable\" class=\"muted\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Top Failure/Warning Codes</h2>",
    "<div id=\"codesTable\" class=\"muted\">Loading…</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Trust Graph</h2>",
    "<div id=\"trustSummary\" class=\"status\">Loading…</div>",
    "<div id=\"trustEdges\" style=\"margin-top:8px\"></div>",
    "</section>",
    "</div>",
    "</div>",
    "<script>",
    `const tenantId = ${JSON.stringify(tenantId)};`,
    "function setText(id, text){ const el=document.getElementById(id); if(el) el.textContent=String(text||''); }",
    "function setClass(id, base, tone){ const el=document.getElementById(id); if(!el) return; el.className = base + (tone ? ' '+tone : ''); }",
    "function setStatus(id, text, tone){ setText(id, text); setClass(id, 'status', tone || ''); }",
    "function setHtml(id, html){ const el=document.getElementById(id); if(el) el.innerHTML=String(html||''); }",
    "function esc(v){ return String(v===undefined||v===null?'':v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\"','&quot;').replaceAll(\"'\",'&#39;'); }",
    "async function getJson(url){ const res=await fetch(url,{credentials:'same-origin'}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "async function postJson(url, body){ const res=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "function value(id){ const el=document.getElementById(id); return el?String(el.value||'').trim():''; }",
    "function tableFromRows(columns, rows){",
    "  if(!Array.isArray(rows)||!rows.length) return '<div class=\"muted\">No data.</div>';",
    "  const head = '<tr>'+columns.map((c)=>`<th>${esc(c.label)}</th>`).join('')+'</tr>';",
    "  const body = rows.map((row)=>'<tr>'+columns.map((c)=>`<td>${esc(c.render?c.render(row):row[c.key])}</td>`).join('')+'</tr>').join('');",
    "  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;",
    "}",
    "function renderAnalytics(report){",
    "  if(!report){ setText('topline','No analytics report.'); return; }",
    "  const t=report.totals||{};",
    "  const money = report.moneyByCurrency||{};",
    "  const moneyText = Object.entries(money).map(([k,v])=>`${k}: processed=${v.processedCents||'0'} held=${v.heldCents||'0'}`).join(' | ') || 'none';",
    "  setHtml('topline', `<strong>runs=${esc(t.runs)}</strong> | green=${esc(t.green)} amber=${esc(t.amber)} red=${esc(t.red)} | approved=${esc(t.approved)} held=${esc(t.held)} | greenRate=${esc(t.greenRatePct)}% approvalRate=${esc(t.approvalRatePct)}%<br/><span class='muted'>verificationMedianMs=${esc(t.verificationDurationMedianMs)} approvalMedianMs=${esc(t.approvalDurationMedianMs)} | money: ${esc(moneyText)}</span>`);",
    "  setHtml('trendTable', tableFromRows([",
    "    {key:'bucketLabel', label:'Bucket'},",
    "    {key:'runs', label:'Runs'},",
    "    {key:'green', label:'Green'},",
    "    {key:'red', label:'Red'},",
    "    {key:'approved', label:'Approved'},",
    "    {key:'greenRatePct', label:'Green %'},",
    "    {key:'approvalRatePct', label:'Approve %'}",
    "  ], report.trends||[]));",
    "  setHtml('vendorTable', tableFromRows([",
    "    {key:'vendorId', label:'Vendor'},",
    "    {key:'runs', label:'Runs'},",
    "    {key:'greenRatePct', label:'Green %'},",
    "    {key:'approvalRatePct', label:'Approve %'},",
    "    {key:'holdRatePct', label:'Hold %'}",
    "  ], report.byVendor||[]));",
    "  setHtml('contractTable', tableFromRows([",
    "    {key:'contractId', label:'Contract'},",
    "    {key:'runs', label:'Runs'},",
    "    {key:'greenRatePct', label:'Green %'},",
    "    {key:'approvalRatePct', label:'Approve %'},",
    "    {key:'holdRatePct', label:'Hold %'}",
    "  ], report.byContract||[]));",
    "  const codes = [];",
    "  for(const row of (report.topErrorCodes||[])) codes.push({kind:'error', code:row.code, count:row.count});",
    "  for(const row of (report.topWarningCodes||[])) codes.push({kind:'warning', code:row.code, count:row.count});",
    "  setHtml('codesTable', tableFromRows([",
    "    {key:'kind', label:'Kind'},",
    "    {key:'code', label:'Code'},",
    "    {key:'count', label:'Count'}",
    "  ], codes));",
    "}",
    "function renderGraph(graph){",
    "  if(!graph){ setText('trustSummary','No graph data.'); return; }",
    "  const s=graph.summary||{};",
    "  setHtml('trustSummary', `<strong>nodes:</strong> vendors=${esc(s.vendorNodes)} contracts=${esc(s.contractNodes)} | <strong>edges:</strong> ${esc(s.edges)} | <span class='muted'>runs=${esc(s.runs)}</span>`);",
    "  setHtml('trustEdges', tableFromRows([",
    "    {key:'kind', label:'Kind'},",
    "    {key:'source', label:'Source'},",
    "    {key:'target', label:'Target'},",
    "    {key:'runs', label:'Runs'},",
    "    {key:'score', label:'Score'},",
    "    {key:'tier', label:'Tier'}",
    "  ], (graph.edges||[]).slice(0,50)));",
    "}",
    "function renderDiff(diff){",
    "  if(!diff){ setText('diffSummary','No diff yet.'); setHtml('diffChanges',''); return; }",
    "  const s=diff.summary||{};",
    "  setText('diffSummary', `nodeChanges=${s.nodeChanges||0} edgeChanges=${s.edgeChanges||0} added=${s.added||0} removed=${s.removed||0} changed=${s.changed||0}`);",
    "  setClass('diffSummary', 'status', (Number(s.edgeChanges||0) > 0 || Number(s.nodeChanges||0) > 0) ? 'warn' : 'good');",
    "  const rows=[];",
    "  for(const row of (diff.nodeChanges||[])) rows.push({type:'node', id:row.id, status:row.status, beforeScore:row.beforeScore, afterScore:row.afterScore, deltaScore:row.deltaScore, deltaRuns:row.deltaRuns});",
    "  for(const row of (diff.edgeChanges||[])) rows.push({type:'edge', id:row.id, status:row.status, beforeScore:row.beforeScore, afterScore:row.afterScore, deltaScore:row.deltaScore, deltaRuns:row.deltaRuns});",
    "  setHtml('diffChanges', tableFromRows([",
    "    {key:'type', label:'Type'},",
    "    {key:'id', label:'ID'},",
    "    {key:'status', label:'Status'},",
    "    {key:'beforeScore', label:'Before score'},",
    "    {key:'afterScore', label:'After score'},",
    "    {key:'deltaScore', label:'Delta score'},",
    "    {key:'deltaRuns', label:'Delta runs'}",
    "  ], rows));",
    "}",
    "async function refreshAll(){",
    "  setStatus('filterStatus','Loading analytics…','warn');",
    "  try{",
    "    const month=value('month')||new Date().toISOString().slice(0,7);",
    "    const bucket=value('bucket')||'day';",
    "    const limit=value('limit')||'20';",
    "    const minRuns=value('minRuns')||'1';",
    "    const maxEdges=value('maxEdges')||'200';",
    "    const analytics=await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/analytics?month=${encodeURIComponent(month)}&bucket=${encodeURIComponent(bucket)}&limit=${encodeURIComponent(limit)}`);",
    "    const graph=await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph?month=${encodeURIComponent(month)}&minRuns=${encodeURIComponent(minRuns)}&maxEdges=${encodeURIComponent(maxEdges)}`);",
    "    renderAnalytics(analytics.report||null);",
    "    renderGraph(graph.graph||null);",
    "    setStatus('filterStatus','Loaded analytics','good');",
    "  } catch(e){ setStatus('filterStatus','Failed: '+e.message,'bad'); }",
    "}",
    "async function saveSnapshot(){",
    "  setStatus('filterStatus','Saving trust snapshot…','warn');",
    "  try{",
    "    const month=value('month')||new Date().toISOString().slice(0,7);",
    "    const minRuns=value('minRuns')||'1';",
    "    const maxEdges=value('maxEdges')||'200';",
    "    const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/snapshots`, { month, minRuns:Number(minRuns), maxEdges:Number(maxEdges) });",
    "    setStatus('filterStatus', `Snapshot saved for ${out.snapshot&&out.snapshot.month?out.snapshot.month:month}`,'good');",
    "  } catch(e){ setStatus('filterStatus','Snapshot failed: '+e.message,'bad'); }",
    "}",
    "async function computeDiff(){",
    "  setStatus('diffStatus','Loading diff…','warn');",
    "  try{",
    "    const base=value('baseMonth');",
    "    const compare=value('compareMonth')||value('month');",
    "    const limit=value('diffLimit')||'50';",
    "    const u=`/v1/tenants/${encodeURIComponent(tenantId)}/trust-graph/diff?baseMonth=${encodeURIComponent(base)}&compareMonth=${encodeURIComponent(compare)}&limit=${encodeURIComponent(limit)}`;",
    "    const out=await getJson(u);",
    "    renderDiff(out.diff||null);",
    "    setStatus('diffStatus','Diff loaded','good');",
    "  } catch(e){ setStatus('diffStatus','Failed: '+e.message,'bad'); }",
    "}",
    "document.getElementById('refreshBtn').addEventListener('click', ()=>refreshAll().catch((e)=>setStatus('filterStatus','Failed: '+e.message,'bad')));",
    "document.getElementById('snapshotBtn').addEventListener('click', ()=>saveSnapshot().catch((e)=>setStatus('filterStatus','Failed: '+e.message,'bad')));",
    "document.getElementById('diffBtn').addEventListener('click', ()=>computeDiff().catch((e)=>setStatus('diffStatus','Failed: '+e.message,'bad')));",
    "refreshAll().catch((e)=>setStatus('filterStatus','Failed: '+e.message,'bad'));",
    "</script>",
    "</body></html>"
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

async function handleTenantOnboardingEnableDemoTrust(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let trust = null;
  try {
    trust = JSON.parse(await fs.readFile(path.join(samplesDir, "trust.json"), "utf8"));
  } catch {
    trust = null;
  }
  if (!trust || typeof trust !== "object" || Array.isArray(trust)) {
    return sendJson(res, 500, { ok: false, code: "DEMO_TRUST_MISSING" });
  }

  const current = await loadTenantSettings({ dataDir, tenantId });
  const patched = applyTenantSettingsPatch({
    currentSettings: current,
    patch: { defaultMode: "strict", governanceTrustRootsJson: trust.governanceRoots ?? {}, pricingSignerKeysJson: trust.pricingSigners ?? {} },
    settingsKey
  });
  if (!patched.ok) return sendJson(res, 400, { ok: false, code: "INVALID_SETTINGS", message: patched.error ?? "invalid settings" });
  await saveTenantSettings({ dataDir, tenantId, settings: patched.settings, settingsKey });
  await recordTenantOnboardingEvent({
    dataDir,
    tenantId,
    eventType: "demo_trust_enabled",
    source: "onboarding_demo_trust",
    metadata: { defaultMode: "strict" }
  });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "TENANT_DEMO_TRUST_ENABLED",
        actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
        targetType: "tenant_settings",
        targetId: tenantId,
        details: { defaultMode: "strict" }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 200, { ok: true, tenantId, enabled: true });
}

async function handleTenantSampleDownload(req, res, tenantId, { kind, sample } = {}) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let zipBuf;
  try {
    zipBuf = await loadSampleZipBytes({ kind, sample });
  } catch (err) {
    return sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: err?.message ?? "not found" });
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/zip");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"${String(kind ?? "sample")}_${String(sample ?? "sample")}.zip\"`);
  res.end(Buffer.from(zipBuf));
}

async function handleTenantSampleUpload(req, res, tenantId, url, { kind, sample } = {}) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 50_000 });
  } catch {
    json = null;
  }
  if (!json) json = {};

  const mode = typeof json.mode === "string" ? json.mode.trim().toLowerCase() : "auto";
  const modeNorm = mode === "strict" || mode === "compat" || mode === "auto" ? mode : "auto";
  const vendorId = typeof json.vendorId === "string" && json.vendorId.trim() ? json.vendorId.trim() : "vendor_sample";
  const vendorName = typeof json.vendorName === "string" && json.vendorName.trim() ? json.vendorName.trim() : "Sample Vendor";
  const contractId = typeof json.contractId === "string" && json.contractId.trim() ? json.contractId.trim() : "contract_sample";
  const templateId = typeof json.templateId === "string" && json.templateId.trim() ? json.templateId.trim() : null;
  if (templateId !== null) {
    const valid = assertSafeId(templateId, { name: "templateId", maxLen: 128 });
    if (!valid.ok) return sendJson(res, 400, { ok: false, code: "INVALID_TEMPLATE_ID", message: valid.error });
  }
  const templateConfig = json.templateConfig === undefined || json.templateConfig === null ? null : json.templateConfig;
  if (templateConfig !== null && !isPlainObject(templateConfig)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_TEMPLATE_CONFIG", message: "templateConfig must be an object" });
  }
  const templateConfigEncoded = templateConfig ? encodeBase64UrlUtf8(JSON.stringify(templateConfig)) : null;

  let zipBuf;
  try {
    zipBuf = await loadSampleZipBytes({ kind, sample });
  } catch (err) {
    return sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: err?.message ?? "not found" });
  }

  const internalReq = Readable.from([zipBuf]);
  internalReq.method = "POST";
  internalReq.url = `/v1/upload?mode=${encodeURIComponent(modeNorm)}`;
  internalReq.headers = { "content-type": "application/zip", "content-length": String(zipBuf.length) };

  const internalRes = makeInternalRes();
  const internalUrl = new URL(internalReq.url, "http://localhost");
  await handleUploadToTenant(internalReq, internalRes, {
    url: internalUrl,
    tenantId,
    vendorMeta: { vendorId, vendorName, contractId, templateId, templateConfig, templateConfigEncoded },
    authMethod: "onboarding-sample"
  });

  const body = internalRes._body();
  const text = body.toString("utf8");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (internalRes.statusCode !== 200) {
    return sendJson(res, internalRes.statusCode, parsed ?? { ok: false, code: "UPLOAD_FAILED", message: text });
  }
  return sendJson(res, 200, parsed);
}

async function handleTenantSlaTemplatesList(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const verticalRaw = url.searchParams.get("vertical");
  const vertical = verticalRaw === null ? null : String(verticalRaw).trim().toLowerCase();
  let templates = null;
  try {
    templates = listSlaPolicyTemplates({ vertical: vertical || null });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_VERTICAL", message: err?.message ?? "invalid vertical" });
  }
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkSlaTemplateCatalog.v1",
    catalogVersion: SLA_POLICY_TEMPLATE_CATALOG_VERSION,
    tenantId,
    generatedAt: nowIso(),
    templates
  });
}

async function handleTenantSlaTemplateRender(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 100_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });

  const templateId = typeof json.templateId === "string" ? json.templateId.trim() : "";
  if (!templateId) return sendJson(res, 400, { ok: false, code: "TEMPLATE_ID_REQUIRED", message: "templateId is required" });

  let rendered = null;
  try {
    rendered = renderSlaPolicyTemplate({ templateId, overrides: json.overrides ?? null });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: "INVALID_TEMPLATE_OVERRIDES", message: err?.message ?? "invalid overrides" });
  }
  if (!rendered) return sendJson(res, 404, { ok: false, code: "TEMPLATE_NOT_FOUND", message: "template not found" });
  await recordTenantOnboardingEvent({
    dataDir,
    tenantId,
    eventType: "template_rendered",
    source: "onboarding_template_render",
    metadata: {
      templateId: rendered?.templateId ?? templateId,
      hasOverrides: Boolean(json.overrides && typeof json.overrides === "object" && !Array.isArray(json.overrides))
    }
  });
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkSlaTemplateRender.v1",
    catalogVersion: SLA_POLICY_TEMPLATE_CATALOG_VERSION,
    tenantId,
    renderedAt: nowIso(),
    template: rendered
  });
}

async function handleTenantOnboardingPage(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const month = monthKeyUtcNow();
  const html = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<title>Verify Cloud Onboarding</title>",
    "<style>",
    ":root{--bg:#f6f8ff;--card:#ffffff;--ink:#0f172a;--muted:#475569;--line:#dbe4ff;--accent:#1d4ed8;--accent-2:#0f766e;--good:#15803d;--warn:#b45309;--bad:#b91c1c}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:radial-gradient(circle at 0 0,#e0ecff 0,#f6f8ff 42%),radial-gradient(circle at 100% 100%,#ddf4ff 0,#f6f8ff 38%);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink)}",
    ".shell{max-width:1080px;margin:0 auto;padding:24px 18px 40px}",
    ".hero{padding:20px 22px;border:1px solid var(--line);background:#fff;border-radius:18px;box-shadow:0 8px 28px rgba(29,78,216,0.08)}",
    ".hero h1{margin:0 0 6px;font-size:28px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".grid{display:grid;gap:14px;margin-top:14px}",
    ".card{border:1px solid var(--line);border-radius:16px;padding:14px 16px;background:var(--card);box-shadow:0 1px 2px rgba(15,23,42,.04)}",
    ".card h2{margin:0 0 8px;font-size:18px}",
    ".muted{color:var(--muted)}",
    ".row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}",
    ".field{min-width:180px;flex:1}",
    ".field.small{min-width:130px;max-width:180px}",
    "input,textarea,select{width:100%;border:1px solid #c7d2fe;border-radius:10px;padding:8px 10px;font:inherit;background:#fff}",
    "input[type='checkbox']{width:auto}",
    "textarea{min-height:80px;resize:vertical}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:9px 12px;font-weight:600;cursor:pointer;text-decoration:none}",
    ".btn.secondary{background:#334155}",
    ".btn.ghost{background:#fff;color:var(--accent);border:1px solid #bfdbfe}",
    ".btn.success{background:var(--accent-2)}",
    ".btn:disabled{opacity:.45;cursor:not-allowed}",
    ".template-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:8px}",
    ".template-card{border:1px solid #bfdbfe;border-radius:12px;padding:10px;background:#f8fbff;cursor:pointer}",
    ".template-card.active{border-color:var(--accent);box-shadow:0 0 0 2px rgba(29,78,216,.12)}",
    ".tag{display:inline-flex;padding:2px 8px;border-radius:999px;background:#e0f2fe;color:#075985;font-size:12px;font-weight:700}",
    ".status{padding:10px 12px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc}",
    ".status.good{border-color:#bbf7d0;background:#f0fdf4;color:var(--good)}",
    ".status.warn{border-color:#fed7aa;background:#fffbeb;color:var(--warn)}",
    ".status.bad{border-color:#fecaca;background:#fef2f2;color:var(--bad)}",
    ".checklist{display:grid;gap:8px;margin-top:10px}",
    ".check-item{display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid #e2e8f0;border-radius:10px;padding:8px 10px;background:#f8fafc}",
    ".check-item.good{border-color:#bbf7d0;background:#f0fdf4}",
    ".check-item.pending{border-color:#bfdbfe;background:#eff6ff}",
    ".check-item .label{font-weight:600}",
    ".check-item .meta{font-size:12px;color:var(--muted)}",
    "code{background:#f1f5f9;padding:2px 6px;border-radius:6px}",
    ".mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}",
    "</style>",
    "</head><body>",
    "<div class=\"shell\">",
    "<div class=\"hero\">",
    "<h1>Verify Cloud Onboarding Wizard</h1>",
    `<p>Tenant <code>${htmlEscape(tenantId)}</code>. Build SLA config, upload evidence, verify result, and share buyer link in one flow.</p>`,
    `<div style="margin-top:10px"><a class="btn ghost" href="/v1/tenants/${encodeURIComponent(tenantId)}/integrations">Open integrations</a> <a class="btn ghost" href="/v1/tenants/${encodeURIComponent(tenantId)}/settlement-policies">Settlement policies</a></div>`,
    "</div>",
    "<div class=\"grid\">",
    "<section class=\"card\">",
    "<h2>Step 0. Enable demo trust (optional)</h2>",
    "<div class=\"muted\">Applies demo governance/pricing trust roots and sets default mode to strict.</div>",
    "<div style=\"margin-top:8px\"><button class=\"btn ghost\" id=\"enableDemoTrust\">Enable demo trust</button> <span id=\"demoTrustStatus\" class=\"muted\"></span></div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 1. Select SLA template</h2>",
    "<div class=\"row\">",
    "<div class=\"field small\"><div class=\"muted\">Vertical</div><select id=\"verticalFilter\"><option value=\"\">All</option><option value=\"delivery\">Delivery</option><option value=\"security\">Security</option></select></div>",
    "<div class=\"field\"><div class=\"muted\">Selected template</div><div id=\"selectedTemplateSummary\" class=\"status\">None selected</div></div>",
    "</div>",
    "<div id=\"templateGrid\" class=\"template-grid\"></div>",
    "<div id=\"templateLoadStatus\" class=\"muted\" style=\"margin-top:8px\"></div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 2. Configure overrides</h2>",
    "<div class=\"muted\">Fields are generated from the template schema and validated before upload.</div>",
    "<div id=\"configForm\" style=\"margin-top:10px\"></div>",
    "<div style=\"margin-top:10px\">",
    "<button class=\"btn\" id=\"validateConfig\">Validate configuration</button>",
    "<span id=\"configStatus\" class=\"muted\" style=\"margin-left:8px\"></span>",
    "</div>",
    "<pre id=\"configPreview\" style=\"display:none;white-space:pre-wrap;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:260px;overflow:auto\"></pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 3. Upload bundle or sample</h2>",
    "<div class=\"row\">",
    "<div class=\"field\"><div class=\"muted\">Vendor ID</div><input id=\"vendorId\" value=\"vendor_a\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Vendor name</div><input id=\"vendorName\" value=\"Vendor A\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Contract ID</div><input id=\"contractId\" value=\"contract_1\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:10px\">",
    "<div class=\"field\"><div class=\"muted\">Bundle ZIP</div><input id=\"bundleZip\" type=\"file\" accept=\".zip,application/zip\"/></div>",
    "<div class=\"field small\"><div class=\"muted\">Mode</div><select id=\"mode\"><option value=\"auto\">auto</option><option value=\"strict\">strict</option><option value=\"compat\">compat</option></select></div>",
    "</div>",
    "<div style=\"margin-top:10px\">",
    "<button class=\"btn success\" id=\"uploadBundleBtn\">Generate artifact</button>",
    "<button class=\"btn secondary\" id=\"uploadSampleGood\">Use known-good sample</button>",
    "<button class=\"btn secondary\" id=\"uploadSampleBad\">Use known-bad sample</button>",
    "<span id=\"uploadStatus\" class=\"muted\" style=\"margin-left:8px\"></span>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 4. Verification result and buyer handoff</h2>",
    "<div class=\"muted\">This status is computed from the uploaded artifact verification output.</div>",
    "<div id=\"verificationStatus\" class=\"status\" style=\"margin-top:8px\">No artifact generated yet.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<a class=\"btn ghost\" id=\"buyerOpenLink\" target=\"_blank\" rel=\"noreferrer\">Open buyer view</a>",
    "<button class=\"btn ghost\" id=\"buyerCopyLink\">Copy buyer link</button>",
    "<a class=\"btn ghost\" id=\"verifyJsonLink\" target=\"_blank\" rel=\"noreferrer\">Open verify.json</a>",
    "</div>",
    "<div id=\"decisionState\" class=\"muted\" style=\"margin-top:8px\"></div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 5. First settlement checklist</h2>",
    "<div class=\"muted\">Follow this guided sequence to reach a verified first settlement and buyer handoff. Step 7 successful attempts also satisfy the first verified milestone.</div>",
    "<div id=\"checklistSummary\" class=\"status\" style=\"margin-top:8px\">Loading checklist…</div>",
    "<div id=\"firstSettlementChecklist\" class=\"checklist\"></div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn ghost\" id=\"refreshChecklistBtn\">Refresh checklist</button>",
    `<a class="btn ghost" href="/v1/tenants/${encodeURIComponent(tenantId)}/analytics/dashboard?month=${encodeURIComponent(month)}" target="_blank" rel="noreferrer">Open analytics dashboard</a>`,
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 6. Runtime bootstrap (MCP)</h2>",
    "<div class=\"muted\">Generate a bounded runtime key and copy MCP config/env exports for your local agent runtime.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">API key ID (optional)</div><input id=\"runtimeApiKeyId\" placeholder=\"ak_mcp_runtime\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Scopes (comma separated, optional)</div><input id=\"runtimeScopes\" value=\"\" placeholder=\"Leave blank for defaults (recommended)\"/></div>",
    "<div class=\"field\"><div class=\"muted\">Paid tools base URL (optional)</div><input id=\"runtimePaidToolsBaseUrl\" placeholder=\"https://paid.tools.settld.work\"/></div>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"runtimeBootstrapBtn\">Generate runtime config</button>",
    "<button class=\"btn secondary\" id=\"runtimeSmokeBtn\">Run MCP smoke test</button>",
    "<button class=\"btn ghost\" id=\"copyMcpConfigBtn\">Copy MCP config</button>",
    "<button class=\"btn ghost\" id=\"copyEnvExportsBtn\">Copy env exports</button>",
    "</div>",
    "<div id=\"runtimeBootstrapStatus\" class=\"status\" style=\"margin-top:8px\">Runtime bootstrap not generated yet.</div>",
    "<div id=\"runtimeSmokeStatus\" class=\"status\" style=\"margin-top:8px\">MCP smoke test not run yet.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">MCP config JSON</div><pre id=\"runtimeMcpConfig\" class=\"mono\" style=\"white-space:pre-wrap;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:220px;overflow:auto\">{}</pre></div>",
    "<div class=\"field\"><div class=\"muted\">Environment exports</div><pre id=\"runtimeEnvExports\" class=\"mono\" style=\"white-space:pre-wrap;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:220px;overflow:auto\"># none</pre></div>",
    "</div>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Step 7. First live paid call</h2>",
    "<div class=\"muted\">Run an end-to-end paid marketplace flow (register, fund, RFQ, bid, accept, settle, verify), persist attempts, and replay prior runs.</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"firstPaidCallBtn\">Run first paid call</button>",
    "<button class=\"btn ghost\" id=\"firstPaidCallHistoryBtn\">Refresh history</button>",
    "<button class=\"btn ghost\" id=\"firstPaidCallReplayBtn\">Replay selected</button>",
    "</div>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<div class=\"field\"><div class=\"muted\">Attempt history</div><select id=\"firstPaidCallHistorySelect\"><option value=\"\">No attempts yet</option></select></div>",
    "</div>",
    "<div id=\"firstPaidCallStatus\" class=\"status\" style=\"margin-top:8px\">First paid call not run yet.</div>",
    "<pre id=\"firstPaidCallOutput\" class=\"mono\" style=\"white-space:pre-wrap;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:240px;overflow:auto;margin-top:8px\">{}</pre>",
    "<div class=\"row\" style=\"margin-top:8px\">",
    "<button class=\"btn\" id=\"runtimeConformanceBtn\">Run conformance matrix</button>",
    "</div>",
    "<div id=\"runtimeConformanceStatus\" class=\"status\" style=\"margin-top:8px\">Conformance matrix not run yet.</div>",
    "<pre id=\"runtimeConformanceOutput\" class=\"mono\" style=\"white-space:pre-wrap;background:#0b1020;color:#f8fafc;border-radius:12px;padding:10px;max-height:220px;overflow:auto;margin-top:8px\">{}</pre>",
    "</section>",
    "<section class=\"card\">",
    "<h2>Ops exports</h2>",
    "<div class=\"muted\">Use these when sharing monthly evidence with counterparties/compliance.</div>",
    "<div style=\"margin-top:8px\">",
    "<a class=\"btn ghost\" href=\"/v1/inbox?status=green\" target=\"_blank\" rel=\"noreferrer\">Open green inbox JSON</a>",
    `<a class="btn ghost" href="/v1/tenants/${encodeURIComponent(tenantId)}/audit-packet?month=${encodeURIComponent(month)}" target="_blank" rel="noreferrer">Download audit packet</a>`,
    `<a class="btn ghost" href="/v1/tenants/${encodeURIComponent(tenantId)}/security-controls-packet?month=${encodeURIComponent(month)}" target="_blank" rel="noreferrer">Download security controls packet</a>`,
    "</div>",
    "</section>",
    "</div>",
    "</div>",
    "<script>",
    `const tenantId = ${JSON.stringify(tenantId)};`,
    "const state = { templates: [], selectedTemplate: null, renderedTemplate: null, token: null, onboardingMetrics: null, runtimeBootstrap: null, runtimeSmoke: null, firstPaidCall: null, firstPaidHistory: null, runtimeConformance: null };",
    "function setText(id, text){ const el=document.getElementById(id); if(el) el.textContent=String(text||''); }",
    "function setHtml(id, html){ const el=document.getElementById(id); if(el) el.innerHTML=String(html||''); }",
    "async function copyText(value){ const txt=String(value||''); if(!txt) return false; try{ await navigator.clipboard.writeText(txt); return true; } catch { return false; } }",
    "function b64urlJson(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }",
    "function getPath(obj, path){ const parts=String(path||'').split('.').filter(Boolean); let cur=obj; for(const p of parts){ if(!cur||typeof cur!=='object') return undefined; cur=cur[p]; } return cur; }",
    "function setPath(obj, path, value){ const parts=String(path||'').split('.').filter(Boolean); if(!parts.length) return; let cur=obj; for(let i=0;i<parts.length-1;i+=1){ const key=parts[i]; if(!cur[key]||typeof cur[key]!=='object'||Array.isArray(cur[key])) cur[key]={}; cur=cur[key]; } cur[parts[parts.length-1]]=value; }",
    "function currentMeta(){ return { vendorId:document.getElementById('vendorId').value.trim(), vendorName:document.getElementById('vendorName').value.trim(), contractId:document.getElementById('contractId').value.trim(), mode:document.getElementById('mode').value.trim()||'auto' }; }",
    "async function getJson(url){ const res=await fetch(url,{credentials:'same-origin'}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "async function postJson(url, body){ const res=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{} if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status)); return j; }",
    "async function trackOnboardingEvent(eventType, metadata){ try{ await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/events`, { eventType, source: 'onboarding_ui', metadata: metadata||null }); } catch{} }",
    "const checklistStages=[{ key:'wizard_viewed', label:'Open onboarding wizard' },{ key:'template_selected', label:'Select SLA template' },{ key:'template_validated', label:'Validate template configuration' },{ key:'artifact_generated', label:'Generate first artifact (sample or real)' },{ key:'real_upload_generated', label:'Run real vendor upload' },{ key:'first_verified', label:'Get first verified result' },{ key:'buyer_link_shared', label:'Share buyer link' }];",
    "const nextActionByStage={ wizard_viewed:'Open onboarding wizard.', template_selected:'Select an SLA template in Step 1.', template_validated:'Validate configuration in Step 2.', artifact_generated:'Upload a sample or bundle in Step 3.', real_upload_generated:'Run a real vendor upload in Step 3 or complete Step 7 paid flow.', first_verified:'Complete Step 7 first paid call (or another successful real upload) so history shows a passed attempt.', buyer_link_shared:'Copy/share buyer link in Step 4.' };",
    "function funnelStageMap(metrics){ const stages=metrics&&metrics.funnel&&Array.isArray(metrics.funnel.stages)?metrics.funnel.stages:[]; const map=new Map(); for(const s of stages){ const key=String(s&&s.stageKey?s.stageKey:'').trim(); if(!key) continue; map.set(key,s); } return map; }",
    "function formatIsoShort(value){ if(!value) return 'pending'; const ms=Date.parse(String(value)); if(!Number.isFinite(ms)) return 'pending'; return new Date(ms).toISOString().replace('T',' ').slice(0,16)+'Z'; }",
    "function renderChecklist(metrics){ const host=document.getElementById('firstSettlementChecklist'); const summary=document.getElementById('checklistSummary'); if(!host||!summary) return; const map=funnelStageMap(metrics); const funnel=metrics&&metrics.funnel&&typeof metrics.funnel==='object'?metrics.funnel:{}; const rows=checklistStages.map((item, idx)=>{ const stage=map.get(item.key)||null; const reached=Boolean(stage&&stage.reached); const at=stage&&stage.at?formatIsoShort(stage.at):'pending'; return `<div class=\\\"check-item ${reached?'good':'pending'}\\\"><div><div class=\\\"label\\\">${idx+1}. ${item.label}</div><div class=\\\"meta\\\">${reached?('completed '+at):'pending'}</div></div><div class=\\\"meta\\\">${reached?'done':'todo'}</div></div>`; }); setHtml('firstSettlementChecklist', rows.join('')); const reachedStages=Number.isFinite(Number(funnel.reachedStages))?Number(funnel.reachedStages):checklistStages.length-rows.filter((r)=>r.includes('todo')).length; const totalStages=Number.isFinite(Number(funnel.totalStages))?Number(funnel.totalStages):checklistStages.length; const completionPct=Number.isFinite(Number(funnel.completionPct))?Number(funnel.completionPct):0; const nextStageKey=funnel&&typeof funnel.nextStageKey==='string'&&funnel.nextStageKey.trim()?funnel.nextStageKey.trim():null; const nextAction=nextStageKey?(nextActionByStage[nextStageKey]||`Complete ${nextStageKey}.`):'Checklist complete. Continue with operations and monitoring.'; summary.className='status '+(nextStageKey?'warn':'good'); summary.textContent=`Checklist ${reachedStages}/${totalStages} complete (${completionPct}%). ${nextAction}`; }",
    "async function refreshChecklist(){ try{ const j=await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding-metrics`); state.onboardingMetrics=j; renderChecklist(j); } catch(e){ const summary=document.getElementById('checklistSummary'); if(summary){ summary.className='status bad'; summary.textContent='Checklist unavailable: '+e.message; } } }",
    "function renderRuntimeBootstrap(out){ const status=document.getElementById('runtimeBootstrapStatus'); const smoke=document.getElementById('runtimeSmokeStatus'); const mcp=document.getElementById('runtimeMcpConfig'); const env=document.getElementById('runtimeEnvExports'); if(!status||!mcp||!env) return; if(!out||typeof out!=='object'){ status.className='status'; status.textContent='Runtime bootstrap not generated yet.'; if(smoke){ smoke.className='status'; smoke.textContent='MCP smoke test not run yet.'; } mcp.textContent='{}'; env.textContent='# none'; return; } const keyId=out&&out.bootstrap&&out.bootstrap.apiKey&&out.bootstrap.apiKey.keyId?String(out.bootstrap.apiKey.keyId):'n/a'; status.className='status good'; status.textContent=`Runtime config ready. API key: ${keyId}`; if(smoke){ smoke.className='status'; smoke.textContent='MCP smoke test not run yet.'; } mcp.textContent=JSON.stringify(out.mcpConfigJson||{}, null, 2); env.textContent=String(out&&out.bootstrap&&out.bootstrap.exportCommands?out.bootstrap.exportCommands:'# none'); }",
    "async function generateRuntimeBootstrap(){ const status=document.getElementById('runtimeBootstrapStatus'); status.className='status'; status.textContent='Generating runtime bootstrap…'; const keyId=String(document.getElementById('runtimeApiKeyId').value||'').trim(); const scopesRaw=String(document.getElementById('runtimeScopes').value||'').trim(); const paidToolsBaseUrl=String(document.getElementById('runtimePaidToolsBaseUrl').value||'').trim(); const scopes=scopesRaw?scopesRaw.split(',').map((s)=>s.trim()).filter(Boolean):[]; const body={ apiKey: { create:true, description:'magic-link runtime bootstrap' } }; if(keyId) body.apiKey.keyId=keyId; if(scopes.length) body.apiKey.scopes=scopes; if(paidToolsBaseUrl) body.paidToolsBaseUrl=paidToolsBaseUrl; try{ const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap`, body); state.runtimeBootstrap=out; renderRuntimeBootstrap(out); trackOnboardingEvent('runtime_bootstrap_generated', { apiKeyId: keyId||null, scopesCount: scopes.length, hasPaidToolsBaseUrl: Boolean(paidToolsBaseUrl) }); } catch(e){ status.className='status bad'; status.textContent='Runtime bootstrap failed: '+e.message; } }",
    "async function runRuntimeSmokeTest(){ const status=document.getElementById('runtimeSmokeStatus'); if(!status) return; if(!state.runtimeBootstrap||!state.runtimeBootstrap.mcp||!state.runtimeBootstrap.mcp.env){ status.className='status bad'; status.textContent='Generate runtime config first.'; return; } status.className='status'; status.textContent='Running MCP smoke test…'; try{ const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/runtime-bootstrap/smoke-test`, { env: state.runtimeBootstrap.mcp.env }); state.runtimeSmoke=out&&out.smoke?out.smoke:null; const count=Number.isFinite(Number(out&&out.smoke&&out.smoke.toolsCount))?Number(out.smoke.toolsCount):0; const sample=Array.isArray(out&&out.smoke&&out.smoke.sampleTools)?out.smoke.sampleTools.slice(0,5).join(', '):''; status.className='status good'; status.textContent=`MCP smoke passed. tools=${count}${sample?(' ['+sample+']'):''}`; trackOnboardingEvent('runtime_smoke_test_passed', { toolsCount: count }); } catch(e){ status.className='status bad'; status.textContent='MCP smoke failed: '+e.message; trackOnboardingEvent('runtime_smoke_test_failed', { message: String(e&&e.message?e.message:'failed') }); } }",
    "function renderFirstPaidCall(out){ const status=document.getElementById('firstPaidCallStatus'); const pre=document.getElementById('firstPaidCallOutput'); if(!status||!pre) return; if(!out||typeof out!=='object'){ status.className='status'; status.textContent='First paid call not run yet.'; pre.textContent='{}'; return; } const verificationStatus=String(out&&out.verificationStatus?out.verificationStatus:'unknown'); const settlementStatus=String(out&&out.settlementStatus?out.settlementStatus:'unknown'); const runId=String(out&&out.ids&&out.ids.runId?out.ids.runId:'n/a'); const attemptId=String(out&&out.attemptId?out.attemptId:'n/a'); const ok=verificationStatus==='green'&&settlementStatus==='released'; status.className='status '+(ok?'good':'warn'); status.textContent=`First paid call ${ok?'completed':'finished'}: attempt=${attemptId} run=${runId} verification=${verificationStatus} settlement=${settlementStatus}`; pre.textContent=JSON.stringify(out, null, 2); }",
    "function renderFirstPaidHistory(history){ const select=document.getElementById('firstPaidCallHistorySelect'); if(!select) return; const attempts=Array.isArray(history&&history.attempts)?history.attempts:[]; const current=String(select.value||''); select.innerHTML=''; if(!attempts.length){ const o=document.createElement('option'); o.value=''; o.textContent='No attempts yet'; select.appendChild(o); return; } attempts.slice().reverse().forEach((row)=>{ const attemptId=String(row&&row.attemptId?row.attemptId:''); if(!attemptId) return; const status=String(row&&row.status?row.status:'unknown'); const runId=String(row&&row.ids&&row.ids.runId?row.ids.runId:'n/a'); const started=String(row&&row.startedAt?row.startedAt:'').replace('T',' ').slice(0,16); const o=document.createElement('option'); o.value=attemptId; o.textContent=`${started} | ${status} | run=${runId} | ${attemptId}`; if(current&&current===attemptId) o.selected=true; select.appendChild(o); }); if(!select.value && select.options.length) select.value=select.options[0].value; }",
    "async function refreshFirstPaidHistory(){ try{ const out=await getJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call/history`); state.firstPaidHistory=out; renderFirstPaidHistory(out); } catch{} }",
    "async function runFirstPaidCall(){ const status=document.getElementById('firstPaidCallStatus'); if(!status) return; status.className='status'; status.textContent='Running first paid call…'; try{ const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call`, {}); state.firstPaidCall=out; renderFirstPaidCall(out); await refreshFirstPaidHistory(); await refreshChecklist(); } catch(e){ status.className='status bad'; status.textContent='First paid call failed: '+e.message; } }",
    "async function replayFirstPaidCall(){ const status=document.getElementById('firstPaidCallStatus'); const select=document.getElementById('firstPaidCallHistorySelect'); if(!status||!select) return; const attemptId=String(select.value||'').trim(); if(!attemptId){ status.className='status bad'; status.textContent='Select an attempt to replay.'; return; } status.className='status'; status.textContent='Replaying stored first paid call attempt…'; try{ const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/first-paid-call`, { replayAttemptId: attemptId }); state.firstPaidCall=out; renderFirstPaidCall(out); } catch(e){ status.className='status bad'; status.textContent='Replay failed: '+e.message; } }",
    "function renderRuntimeConformance(out){ const status=document.getElementById('runtimeConformanceStatus'); const pre=document.getElementById('runtimeConformanceOutput'); if(!status||!pre) return; if(!out||typeof out!=='object'){ status.className='status'; status.textContent='Conformance matrix not run yet.'; pre.textContent='{}'; return; } const matrix=out&&out.matrix&&typeof out.matrix==='object'?out.matrix:null; const ready=Boolean(matrix&&matrix.ready); const runId=String(matrix&&matrix.runId?matrix.runId:'n/a'); const checks=Array.isArray(matrix&&matrix.checks)?matrix.checks:[]; const failed=checks.filter((c)=>String(c&&c.status||'').toLowerCase()!=='pass').map((c)=>String(c&&c.checkId||'unknown')); status.className='status '+(ready?'good':'warn'); status.textContent=ready?`Conformance passed. run=${runId}`:`Conformance incomplete. run=${runId}. failed=${failed.join(', ')||'unknown'}`; pre.textContent=JSON.stringify(out, null, 2); }",
    "async function runRuntimeConformance(){ const status=document.getElementById('runtimeConformanceStatus'); if(!status) return; status.className='status'; status.textContent='Running conformance matrix…'; try{ const out=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/conformance-matrix`, { targets:['codex','claude','cursor','openclaw'] }); state.runtimeConformance=out; renderRuntimeConformance(out); await refreshFirstPaidHistory(); await refreshChecklist(); } catch(e){ status.className='status bad'; status.textContent='Conformance run failed: '+e.message; } }",
    "function statusFromVerify(v){ const ok=!!(v&&v.ok); const verificationOk=!!(v&&v.verificationOk); const warnings=Array.isArray(v&&v.warnings)?v.warnings:[]; if(!ok||!verificationOk) return 'red'; if(warnings.length) return 'amber'; return 'green'; }",
    "function summarizeTemplate(t){ if(!t) return 'None selected'; return `${t.templateId} (${t.vertical})`; }",
    "function renderTemplateCards(){",
    "  const grid=document.getElementById('templateGrid');",
    "  const selectedId=state.selectedTemplate&&state.selectedTemplate.templateId;",
    "  grid.innerHTML='';",
    "  if(!state.templates.length){ grid.innerHTML='<div class=\"muted\">No templates available.</div>'; return; }",
    "  for(const tpl of state.templates){",
    "    const active=selectedId===tpl.templateId?' active':'';",
    "    const div=document.createElement('button');",
    "    div.type='button'; div.className='template-card'+active;",
    "    div.innerHTML=`<div style=\"display:flex;justify-content:space-between;gap:8px\"><strong>${tpl.name}</strong><span class=\"tag\">${tpl.vertical}</span></div><div class=\"muted\" style=\"margin-top:4px\">${tpl.templateId}</div><div style=\"margin-top:6px\">${tpl.description||''}</div>`;",
    "    div.addEventListener('click',()=>{ state.selectedTemplate=tpl; state.renderedTemplate=null; setText('selectedTemplateSummary', summarizeTemplate(tpl)); renderTemplateCards(); renderConfigForm(); setText('configStatus',''); document.getElementById('configPreview').style.display='none'; trackOnboardingEvent('template_selected', { templateId: tpl.templateId||null, vertical: tpl.vertical||null }); refreshChecklist(); });",
    "    grid.appendChild(div);",
    "  }",
    "}",
    "function renderConfigForm(){",
    "  const host=document.getElementById('configForm'); host.innerHTML='';",
    "  const tpl=state.selectedTemplate;",
    "  if(!tpl){ host.innerHTML='<div class=\"muted\">Select a template in Step 1 first.</div>'; return; }",
    "  const fields=Array.isArray(tpl.overridesSchema&&tpl.overridesSchema.fields)?tpl.overridesSchema.fields:[];",
    "  if(!fields.length){ host.innerHTML='<div class=\"muted\">Template has no override fields.</div>'; return; }",
    "  const row=document.createElement('div'); row.className='row';",
    "  fields.forEach((f, idx)=>{",
    "    const box=document.createElement('div'); box.className='field';",
    "    const label=document.createElement('div'); label.className='muted'; label.textContent=f.label||f.path||f.key||('Field '+(idx+1));",
    "    box.appendChild(label);",
    "    const id='override_'+idx;",
    "    let input=null;",
    "    const initial=getPath(tpl.defaults||{}, f.path||f.key||'');",
    "    if(f.inputType==='select' && Array.isArray(f.options)){",
    "      input=document.createElement('select');",
    "      for(const opt of f.options){ const o=document.createElement('option'); o.value=String(opt); o.textContent=String(opt); input.appendChild(o); }",
    "      if(initial!==undefined && initial!==null) input.value=String(initial);",
    "    } else if(f.inputType==='boolean'){",
    "      input=document.createElement('input'); input.type='checkbox'; input.checked=Boolean(initial);",
    "    } else if(f.inputType==='date'){",
    "      input=document.createElement('input'); input.type='date'; if(initial) input.value=String(initial).slice(0,10);",
    "    } else {",
    "      input=document.createElement('input'); input.type=(f.inputType==='number')?'number':'text';",
    "      if(f.min!==undefined) input.min=String(f.min); if(f.max!==undefined) input.max=String(f.max);",
    "      if(initial!==undefined && initial!==null) input.value=String(initial);",
    "    }",
    "    input.id=id; input.dataset.path=String(f.path||f.key||''); input.dataset.valueType=String(f.valueType||'string'); input.dataset.required=f.required?'1':'0';",
    "    if(f.min!==undefined) input.dataset.min=String(f.min); if(f.max!==undefined) input.dataset.max=String(f.max);",
    "    box.appendChild(input); row.appendChild(box);",
    "  });",
    "  host.appendChild(row);",
    "}",
    "function collectOverrides(){",
    "  const tpl=state.selectedTemplate; if(!tpl) return { ok:false, message:'template not selected' };",
    "  const fields=Array.isArray(tpl.overridesSchema&&tpl.overridesSchema.fields)?tpl.overridesSchema.fields:[];",
    "  const out={};",
    "  for(let i=0;i<fields.length;i+=1){",
    "    const f=fields[i]; const id='override_'+i; const el=document.getElementById(id); if(!el) continue;",
    "    const path=String(el.dataset.path||''); const required=String(el.dataset.required||'')==='1';",
    "    let value=null; const inputType=(f.inputType||'text');",
    "    if(inputType==='boolean'){ value=!!el.checked; if(!required && value===false) continue; }",
    "    else { const raw=String(el.value||'').trim(); if(!raw){ if(required) return { ok:false, message:(f.label||path)+' is required' }; continue; }",
    "      if(inputType==='number' || String(el.dataset.valueType||'')==='integer' || String(el.dataset.valueType||'')==='number'){ const n=Number(raw); if(!Number.isFinite(n)) return { ok:false, message:(f.label||path)+' must be a number' };",
    "        const min=el.dataset.min!==undefined?Number(el.dataset.min):null; const max=el.dataset.max!==undefined?Number(el.dataset.max):null;",
    "        if(Number.isFinite(min) && n<min) return { ok:false, message:(f.label||path)+' must be >= '+min };",
    "        if(Number.isFinite(max) && n>max) return { ok:false, message:(f.label||path)+' must be <= '+max };",
    "        value=String(el.dataset.valueType||'')==='integer'?Math.trunc(n):n;",
    "      } else value=raw;",
    "    }",
    "    setPath(out, path, value);",
    "  }",
    "  return { ok:true, overrides:out };",
    "}",
    "async function loadTemplates(){",
    "  setText('templateLoadStatus','loading templates…');",
    "  try{",
    "    const vertical=document.getElementById('verticalFilter').value.trim();",
    "    const u=new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/sla-templates`, window.location.origin);",
    "    if(vertical) u.searchParams.set('vertical', vertical);",
    "    const j=await getJson(u.pathname + u.search);",
    "    state.templates=Array.isArray(j.templates)?j.templates:[];",
    "    if(state.templates.length && !state.selectedTemplate) state.selectedTemplate=state.templates[0];",
    "    if(state.selectedTemplate){ const still=state.templates.find((t)=>t.templateId===state.selectedTemplate.templateId); if(!still) state.selectedTemplate=state.templates[0]||null; else state.selectedTemplate=still; }",
    "    setText('selectedTemplateSummary', summarizeTemplate(state.selectedTemplate));",
    "    renderTemplateCards(); renderConfigForm(); setText('templateLoadStatus', `loaded ${state.templates.length} template(s)`);",
    "  } catch(e){ setText('templateLoadStatus','failed: '+e.message); }",
    "}",
    "async function validateConfig(){",
    "  const c=collectOverrides();",
    "  if(!c.ok){ setText('configStatus','invalid: '+c.message); return; }",
    "  setText('configStatus','validating…');",
    "  try{",
    "    const tplId=state.selectedTemplate&&state.selectedTemplate.templateId;",
    "    const j=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/sla-templates/render`, { templateId: tplId, overrides: c.overrides });",
    "    state.renderedTemplate=j.template||null;",
    "    setText('configStatus','valid');",
    "    trackOnboardingEvent('template_rendered', { templateId: tplId||null }); refreshChecklist();",
    "    const pre=document.getElementById('configPreview'); pre.style.display='block'; pre.textContent=JSON.stringify(j.template||{}, null, 2);",
    "  } catch(e){ setText('configStatus','invalid: '+e.message); }",
    "}",
    "function uploadQuery(meta){",
    "  const q=new URLSearchParams(); q.set('mode', meta.mode||'auto');",
    "  if(meta.vendorId) q.set('vendorId', meta.vendorId); if(meta.vendorName) q.set('vendorName', meta.vendorName); if(meta.contractId) q.set('contractId', meta.contractId);",
    "  const tpl=state.selectedTemplate; if(tpl&&tpl.templateId) q.set('templateId', tpl.templateId);",
    "  const cfg=state.renderedTemplate&&state.renderedTemplate.defaults?state.renderedTemplate.defaults:(tpl&&tpl.defaults?tpl.defaults:null);",
    "  if(cfg) q.set('templateConfig', b64urlJson(cfg));",
    "  return q;",
    "}",
    "async function updateDecisionState(token){",
    "  try{ const res=await fetch(`/r/${encodeURIComponent(token)}/settlement_decision_report.json`, { credentials:'same-origin' }); if(!res.ok){ setText('decisionState','No buyer decision recorded yet.'); return; } const j=await res.json(); setText('decisionState', `Buyer decision: ${j.decision||'unknown'} at ${j.decidedAt||'n/a'} by ${j.actor&&j.actor.email?j.actor.email:'unknown'}`); }",
    "  catch{ setText('decisionState','No buyer decision recorded yet.'); }",
    "}",
    "async function showVerification(token){",
    "  setText('uploadStatus', `artifact ${token}`);",
    "  const statusEl=document.getElementById('verificationStatus'); statusEl.className='status';",
    "  try{",
    "    const v=await getJson(`/r/${encodeURIComponent(token)}/verify.json`);",
    "    const status=statusFromVerify(v);",
    "    const errs=Array.isArray(v.errors)?v.errors.map((e)=>e&&e.code?e.code:'UNKNOWN'):[];",
    "    const warns=Array.isArray(v.warnings)?v.warnings.map((w)=>w&&w.code?w.code:'UNKNOWN'):[];",
    "    const statusLabel=status==='green'?'Verified - Payable':status==='amber'?'Review Required':'Failed - See Details';",
    "    statusEl.className='status '+(status==='green'?'good':status==='amber'?'warn':'bad');",
    "    statusEl.innerHTML=`<strong>${statusLabel}</strong><div class='muted' style='margin-top:4px'>errors=${errs.length} warnings=${warns.length}</div><div class='muted'>${errs.length?('errorCodes='+errs.slice(0,6).join(', ')):'errorCodes=none'}</div><div class='muted'>${warns.length?('warningCodes='+warns.slice(0,6).join(', ')):'warningCodes=none'}</div>`;",
    "  } catch(e){ statusEl.className='status bad'; statusEl.textContent='Failed to load verify.json: '+e.message; }",
    "  const buyer=`/r/${encodeURIComponent(token)}`;",
    "  const open=document.getElementById('buyerOpenLink'); open.href=buyer; open.textContent='Open buyer view';",
    "  const verify=document.getElementById('verifyJsonLink'); verify.href=`/r/${encodeURIComponent(token)}/verify.json`;",
    "  await updateDecisionState(token);",
    "  await refreshChecklist();",
    "}",
    "async function uploadBundleFromFile(){",
    "  const file=(document.getElementById('bundleZip').files||[])[0];",
    "  if(!file){ setText('uploadStatus','choose a .zip file first'); return; }",
    "  setText('uploadStatus','uploading…');",
    "  const meta=currentMeta();",
    "  const query=uploadQuery(meta).toString();",
    "  try{",
    "    const res=await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/upload?${query}`, { method:'POST', credentials:'same-origin', headers:{'content-type':'application/zip'}, body:file });",
    "    const txt=await res.text(); let j=null; try{ j=txt?JSON.parse(txt):null; }catch{}",
    "    if(!res.ok) throw new Error((j&&j.message)||txt||('HTTP '+res.status));",
    "    state.token=j.token; await showVerification(j.token);",
    "  } catch(e){ setText('uploadStatus','failed: '+e.message); }",
    "}",
    "async function uploadSample(sample){",
    "  setText('uploadStatus','uploading sample…');",
    "  const meta=currentMeta();",
    "  const tpl=state.selectedTemplate;",
    "  const cfg=state.renderedTemplate&&state.renderedTemplate.defaults?state.renderedTemplate.defaults:(tpl&&tpl.defaults?tpl.defaults:null);",
    "  try{",
    "    const j=await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/samples/closepack/${sample}/upload`, { mode:meta.mode||'auto', vendorId:meta.vendorId, vendorName:meta.vendorName, contractId:meta.contractId, templateId:tpl&&tpl.templateId?tpl.templateId:null, templateConfig:cfg });",
    "    state.token=j.token; await showVerification(j.token);",
    "  } catch(e){ setText('uploadStatus','failed: '+e.message); }",
    "}",
    "document.getElementById('enableDemoTrust').addEventListener('click', async()=>{",
    "  setText('demoTrustStatus','working…');",
    "  try{ await postJson(`/v1/tenants/${encodeURIComponent(tenantId)}/onboarding/demo-trust`,{}); setText('demoTrustStatus','enabled'); refreshChecklist(); }",
    "  catch(e){ setText('demoTrustStatus','failed: '+e.message); }",
    "});",
    "document.getElementById('verticalFilter').addEventListener('change', loadTemplates);",
    "document.getElementById('validateConfig').addEventListener('click', validateConfig);",
    "document.getElementById('uploadBundleBtn').addEventListener('click', uploadBundleFromFile);",
    "document.getElementById('uploadSampleGood').addEventListener('click', ()=>uploadSample('known-good'));",
    "document.getElementById('uploadSampleBad').addEventListener('click', ()=>uploadSample('known-bad'));",
    "document.getElementById('runtimeBootstrapBtn').addEventListener('click', ()=>generateRuntimeBootstrap());",
    "document.getElementById('runtimeSmokeBtn').addEventListener('click', ()=>runRuntimeSmokeTest());",
    "document.getElementById('firstPaidCallBtn').addEventListener('click', ()=>runFirstPaidCall());",
    "document.getElementById('firstPaidCallHistoryBtn').addEventListener('click', ()=>refreshFirstPaidHistory());",
    "document.getElementById('firstPaidCallReplayBtn').addEventListener('click', ()=>replayFirstPaidCall());",
    "document.getElementById('runtimeConformanceBtn').addEventListener('click', ()=>runRuntimeConformance());",
    "document.getElementById('copyMcpConfigBtn').addEventListener('click', async()=>{ const text=document.getElementById('runtimeMcpConfig').textContent||''; const ok=await copyText(text); setText('runtimeBootstrapStatus', ok?'MCP config copied.':'Copy failed.'); });",
    "document.getElementById('copyEnvExportsBtn').addEventListener('click', async()=>{ const text=document.getElementById('runtimeEnvExports').textContent||''; const ok=await copyText(text); setText('runtimeBootstrapStatus', ok?'Env exports copied.':'Copy failed.'); });",
    "document.getElementById('buyerOpenLink').addEventListener('click', ()=>{ if(state.token){ trackOnboardingEvent('buyer_link_opened', { token: state.token }); } });",
    "document.getElementById('buyerCopyLink').addEventListener('click', async()=>{",
    "  if(!state.token){ setText('decisionState','Generate an artifact first.'); return; }",
    "  const link=window.location.origin + `/r/${encodeURIComponent(state.token)}`;",
    "  try{ await navigator.clipboard.writeText(link); setText('decisionState','Buyer link copied.'); trackOnboardingEvent('buyer_link_shared', { token: state.token }); refreshChecklist(); }",
    "  catch{ setText('decisionState','Copy failed. Link: '+link); }",
    "});",
    "document.getElementById('refreshChecklistBtn').addEventListener('click', ()=>refreshChecklist());",
    "trackOnboardingEvent('wizard_viewed', { path: window.location.pathname }).finally(()=>refreshChecklist());",
    "renderRuntimeBootstrap(null);",
    "renderFirstPaidCall(null);",
    "renderRuntimeConformance(null);",
    "refreshFirstPaidHistory();",
    "loadTemplates();",
    "</script>",
    "</body></html>"
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

async function handleBuyerLoginOtpRequest(req, res, tenantId) {
  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 10_000 });
  } catch (err) {
    metrics.incCounter("login_otp_requests_total", { tenantId, ok: "false", code: String(err?.code ?? "INVALID_REQUEST") }, 1);
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};
  const email = normalizeEmailLower(json?.email ?? json?.actorEmail ?? null);
  if (!email) {
    metrics.incCounter("login_otp_requests_total", { tenantId, ok: "false", code: "INVALID_EMAIL" }, 1);
    return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
  }

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const allowedDomains = Array.isArray(tenantSettings?.buyerAuthEmailDomains) ? tenantSettings.buyerAuthEmailDomains : [];
  if (!allowedDomains.length) {
    metrics.incCounter("login_otp_requests_total", { tenantId, ok: "false", code: "BUYER_AUTH_DISABLED" }, 1);
    return sendJson(res, 400, { ok: false, code: "BUYER_AUTH_DISABLED", message: "buyer OTP login is not enabled for this tenant" });
  }
  if (!isEmailAllowedByDomains({ email, allowedDomains })) {
    metrics.incCounter("login_otp_requests_total", { tenantId, ok: "false", code: "BUYER_EMAIL_DOMAIN_FORBIDDEN" }, 1);
    return sendJson(res, 400, { ok: false, code: "BUYER_EMAIL_DOMAIN_FORBIDDEN", message: "email domain is not allowed" });
  }

  const issued = await issueBuyerOtp({ dataDir, tenantId, email, ttlSeconds: buyerOtpTtlSeconds, deliveryMode: buyerOtpDeliveryMode, smtp: smtpConfig });
  if (!issued.ok) {
    metrics.incCounter("login_otp_requests_total", { tenantId, ok: "false", code: String(issued.error ?? "OTP_FAILED") }, 1);
    return sendJson(res, 400, { ok: false, code: issued.error ?? "OTP_FAILED", message: issued.message ?? "otp failed" });
  }
  metrics.incCounter("login_otp_requests_total", { tenantId, ok: "true" }, 1);
  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: { at: nowIso(), action: "BUYER_LOGIN_OTP_ISSUED", actor: { method: "email_otp", email: issued.email }, targetType: "buyer_auth", targetId: issued.email, details: { expiresAt: issued.expiresAt } }
    });
  } catch {
    // ignore
  }
  return sendJson(res, 200, { ok: true, tenantId, email: issued.email, expiresAt: issued.expiresAt });
}

async function handleBuyerLogin(req, res, tenantId) {
  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 10_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};
  const email = normalizeEmailLower(json?.email ?? json?.actorEmail ?? null);
  const code = String(json?.code ?? json?.otp ?? "").trim();
  if (!email) return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
  if (!code) return sendJson(res, 400, { ok: false, code: "OTP_REQUIRED", message: "otp code is required" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const allowedDomains = Array.isArray(tenantSettings?.buyerAuthEmailDomains) ? tenantSettings.buyerAuthEmailDomains : [];
  if (!allowedDomains.length) return sendJson(res, 400, { ok: false, code: "BUYER_AUTH_DISABLED", message: "buyer OTP login is not enabled for this tenant" });
  if (!isEmailAllowedByDomains({ email, allowedDomains })) return sendJson(res, 400, { ok: false, code: "BUYER_EMAIL_DOMAIN_FORBIDDEN", message: "email domain is not allowed" });

  const verified = await verifyAndConsumeBuyerOtp({ dataDir, tenantId, email, code, maxAttempts: buyerOtpMaxAttempts });
  if (!verified.ok) return sendJson(res, 400, { ok: false, code: verified.error ?? "OTP_FAILED", message: verified.message ?? "otp failed" });

  const session = createBuyerSessionToken({ sessionKey, tenantId, email, ttlSeconds: buyerSessionTtlSeconds });
  if (!session.ok) return sendJson(res, 500, { ok: false, code: session.error ?? "SESSION_FAILED", message: "failed to create buyer session" });
  setBuyerSessionCookie(res, session.token);

  const role = resolveBuyerRole({ tenantSettings, email });
  try {
    await upsertBuyerUser({
      dataDir,
      tenantId,
      email,
      role,
      status: "active",
      lastLoginAt: nowIso()
    });
  } catch {
    // best effort
  }
  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: { at: nowIso(), action: "BUYER_LOGIN", actor: { method: "buyer_session", email, role }, targetType: "buyer_session", targetId: email, details: { expiresAt: session.payload?.expiresAt ?? null } }
    });
  } catch {
    // ignore
  }
  return sendJson(res, 200, { ok: true, tenantId, email, role, expiresAt: session.payload?.expiresAt ?? null });
}

async function handleBuyerMe(req, res) {
  const buyer = await authenticateBuyerSession(req);
  if (!buyer.ok) return sendJson(res, 401, { ok: false, code: "UNAUTHORIZED" });
  return sendJson(res, 200, { ok: true, principal: buyer.principal });
}

async function handleBuyerLogout(req, res) {
  const buyer = await authenticateBuyerSession(req);
  clearBuyerSessionCookie(res);
  if (buyer.ok) {
    try {
      await appendAuditRecord({
        dataDir,
        tenantId: buyer.principal.tenantId,
        record: { at: nowIso(), action: "BUYER_LOGOUT", actor: { method: "buyer_session", email: buyer.principal.email, role: buyer.principal.role }, targetType: "buyer_session", targetId: buyer.principal.email, details: null }
      });
    } catch {
      // ignore
    }
  }
  return sendJson(res, 200, { ok: true });
}

function normalizeBuyerRoleForApi(value) {
  const role = String(value ?? "").trim().toLowerCase();
  if (role === "admin" || role === "approver" || role === "viewer") return role;
  return null;
}

async function handlePublicSignup(req, res) {
  if (!publicSignupEnabled) {
    return sendJson(res, 403, { ok: false, code: "SIGNUP_DISABLED", message: "public signup is disabled" });
  }
  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  }

  const email = normalizeEmailLower(json?.email ?? json?.contactEmail ?? null);
  if (!email) return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
  const companyName = typeof json?.company === "string" && json.company.trim()
    ? json.company.trim()
    : typeof json?.name === "string" && json.name.trim()
      ? json.name.trim()
      : null;
  if (!companyName) {
    return sendJson(res, 400, { ok: false, code: "INVALID_COMPANY", message: "company (or name) is required" });
  }

  let tenantId = null;
  if (json.tenantId !== undefined && json.tenantId !== null) {
    const parsed = parseTenantIdParam(json.tenantId);
    if (!parsed.ok) return sendJson(res, 400, { ok: false, code: "INVALID_TENANT", message: parsed.error });
    tenantId = parsed.tenantId;
  } else {
    let attempts = 0;
    while (attempts < 10 && !tenantId) {
      attempts += 1;
      const candidate = generateTenantIdFromName(companyName);
      // eslint-disable-next-line no-await-in-loop
      const existing = await loadTenantProfileBestEffort({ dataDir, tenantId: candidate });
      if (!existing) tenantId = candidate;
    }
    if (!tenantId) {
      return sendJson(res, 500, { ok: false, code: "TENANT_ID_GENERATION_FAILED", message: "failed to generate tenantId" });
    }
  }

  const created = await createTenantProfile({
    dataDir,
    tenantId,
    name: companyName,
    contactEmail: email,
    billingEmail: email
  });
  if (!created.ok) {
    const status = created.code === "TENANT_EXISTS" ? 409 : 400;
    return sendJson(res, status, { ok: false, code: created.code ?? "SIGNUP_FAILED", message: created.error ?? "failed to create tenant" });
  }

  const domain = domainFromEmail(email);
  const currentSettings = await loadTenantSettings({ dataDir, tenantId });
  const currentDomains = Array.isArray(currentSettings?.buyerAuthEmailDomains)
    ? currentSettings.buyerAuthEmailDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  const domains = domain && !currentDomains.includes(domain) ? [...currentDomains, domain] : currentDomains;
  const currentRoles = isPlainObject(currentSettings?.buyerUserRoles) ? { ...currentSettings.buyerUserRoles } : {};
  currentRoles[email] = "admin";
  const patched = applyTenantSettingsPatch({
    currentSettings,
    patch: { buyerAuthEmailDomains: domains, buyerUserRoles: currentRoles },
    settingsKey
  });
  if (!patched.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_SETTINGS", message: patched.error ?? "invalid settings" });
  }
  const relay = ensureDefaultEventRelayWebhook({ settings: patched.settings, tenantId });
  await saveTenantSettings({ dataDir, tenantId, settings: relay.settings, settingsKey });
  await upsertBuyerUser({
    dataDir,
    tenantId,
    email,
    role: "admin",
    fullName: typeof json?.fullName === "string" ? json.fullName : "",
    company: companyName,
    status: "active"
  });

  const issued = await issueBuyerOtp({ dataDir, tenantId, email, ttlSeconds: buyerOtpTtlSeconds, deliveryMode: buyerOtpDeliveryMode, smtp: smtpConfig });
  if (!issued.ok) {
    return sendJson(res, 202, {
      ok: true,
      tenantId,
      email,
      otpIssued: false,
      warning: issued.error ?? "OTP_FAILED",
      message: issued.message ?? "tenant created, otp issue failed"
    });
  }

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "PUBLIC_SIGNUP",
        actor: { method: "public_signup", email, role: "admin" },
        targetType: "tenant",
        targetId: tenantId,
        details: { companyName, expiresAt: issued.expiresAt }
      }
    });
  } catch {
    // ignore
  }

  return sendJson(res, 201, { ok: true, tenantId, email, otpIssued: true, expiresAt: issued.expiresAt });
}

async function handleBuyerUsersList(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const users = await listBuyerUsers({ dataDir, tenantId });
  const settings = await loadTenantSettings({ dataDir, tenantId });
  const roles = isPlainObject(settings?.buyerUserRoles) ? settings.buyerUserRoles : {};
  const byEmail = new Map(users.map((row) => [String(row.email).toLowerCase(), row]));
  for (const [rawEmail, rawRole] of Object.entries(roles)) {
    const email = normalizeEmailLower(rawEmail);
    const role = normalizeBuyerRoleForApi(rawRole) ?? "viewer";
    if (!email) continue;
    if (byEmail.has(email)) {
      const row = byEmail.get(email);
      if (row.role !== role) row.role = role;
      continue;
    }
    byEmail.set(email, {
      email,
      role,
      fullName: "",
      company: "",
      status: "invited",
      createdAt: null,
      updatedAt: null,
      lastLoginAt: null
    });
  }
  const merged = [...byEmail.values()].sort((a, b) => cmpString(a.email, b.email));
  return sendJson(res, 200, { ok: true, tenantId, users: merged });
}

async function handleBuyerUsersUpsert(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  let json;
  try {
    json = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return sendJson(res, 400, { ok: false, code: "INVALID_REQUEST", message: "body must be an object" });
  const email = normalizeEmailLower(json?.email ?? null);
  if (!email) return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
  const role = normalizeBuyerRoleForApi(json?.role ?? "viewer");
  if (!role) return sendJson(res, 400, { ok: false, code: "INVALID_ROLE", message: "role must be admin|approver|viewer" });

  const currentSettings = await loadTenantSettings({ dataDir, tenantId });
  const currentDomains = Array.isArray(currentSettings?.buyerAuthEmailDomains)
    ? currentSettings.buyerAuthEmailDomains.map((d) => String(d ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  const domain = domainFromEmail(email);
  const domains = domain && !currentDomains.includes(domain) ? [...currentDomains, domain] : currentDomains;
  const roles = isPlainObject(currentSettings?.buyerUserRoles) ? { ...currentSettings.buyerUserRoles } : {};
  roles[email] = role;
  const patched = applyTenantSettingsPatch({
    currentSettings,
    patch: { buyerAuthEmailDomains: domains, buyerUserRoles: roles },
    settingsKey
  });
  if (!patched.ok) return sendJson(res, 400, { ok: false, code: "INVALID_SETTINGS", message: patched.error ?? "invalid settings" });
  await saveTenantSettings({ dataDir, tenantId, settings: patched.settings, settingsKey });

  const user = await upsertBuyerUser({
    dataDir,
    tenantId,
    email,
    role,
    fullName: typeof json?.fullName === "string" ? json.fullName : "",
    company: typeof json?.company === "string" ? json.company : "",
    status: typeof json?.status === "string" && json.status.trim() ? json.status.trim() : "active"
  });
  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "BUYER_USER_UPSERT",
        actor: {
          method: auth.principal?.method ?? "unknown",
          email: auth.principal?.email ?? null,
          role: auth.principal?.role ?? "admin"
        },
        targetType: "buyer_user",
        targetId: email,
        details: { role }
      }
    });
  } catch {
    // ignore
  }
  return sendJson(res, 200, { ok: true, tenantId, user });
}

async function handleTenantUsageGet(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });

  const include = url.searchParams.get("include") ? String(url.searchParams.get("include")).trim() : "";
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const summary = await loadUsageSummary({ dataDir, tenantId, monthKey: month });
  const records = include === "records" ? await loadUsageRecords({ dataDir, tenantId, monthKey: month }) : null;
  const monthLimit = Number.isInteger(entitlements?.limits?.maxVerificationsPerMonth) ? entitlements.limits.maxVerificationsPerMonth : null;
  const verificationRuns = Number.parseInt(String(summary?.verificationRuns ?? 0), 10);
  const verificationRunsUsed = Number.isInteger(verificationRuns) && verificationRuns >= 0 ? verificationRuns : 0;
  const quota = monthLimit === null
    ? { maxVerificationsPerMonth: null }
    : {
        maxVerificationsPerMonth: {
          limit: monthLimit,
          used: verificationRunsUsed,
          remaining: Math.max(0, monthLimit - verificationRunsUsed)
        }
      };
  const thresholdState = await loadBillingUsageThresholdStateBestEffort({ tenantId, monthKey: month });
  const thresholdAlerts = buildUsageThresholdStatus({
    monthKey: month,
    limit: monthLimit,
    used: verificationRunsUsed,
    state: thresholdState
  });

  const out = {
    schemaVersion: "MagicLinkUsageReport.v1",
    tenantId,
    month,
    generatedAt: nowIso(),
    entitlements,
    quota,
    summary,
    thresholdAlerts
  };
  if (records) out.records = records;
  return sendJson(res, 200, out);
}

async function handleTenantBillingInvoiceExport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const format = url.searchParams.get("format") ? String(url.searchParams.get("format")).trim().toLowerCase() : "json";
  if (format !== "json" && format !== "pdf") return sendJson(res, 400, { ok: false, code: "INVALID_FORMAT", message: "format must be json|pdf" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const entitlements = resolveTenantEntitlementsFromSettings(tenantSettings);
  const summary = await loadUsageSummary({ dataDir, tenantId, monthKey: month });
  const runs = Number.isSafeInteger(Number(summary?.verificationRuns ?? 0)) ? Number(summary?.verificationRuns ?? 0) : 0;
  const subscriptionCents = Number.isFinite(Number(entitlements?.billing?.subscriptionCents))
    ? Number(entitlements.billing.subscriptionCents)
    : billingSubscriptionCents;
  const pricePerVerificationCents = Number.isFinite(Number(entitlements?.billing?.pricePerVerificationCents))
    ? Number(entitlements.billing.pricePerVerificationCents)
    : billingPricePerVerificationCents;
  const verificationsAmount = Math.round(runs * pricePerVerificationCents * 1000) / 1000;
  const total = Math.round((subscriptionCents + verificationsAmount) * 1000) / 1000;
  const centsText = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    const rounded = Math.round(n * 1000) / 1000;
    const txt = rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return txt || "0";
  };

  const invoice = {
    schemaVersion: "MagicLinkBillingInvoice.v1",
    tenantId,
    plan: String(entitlements?.plan ?? "free"),
    month,
    currency: billingCurrency,
    generatedAt: nowIso(),
    pricing: {
      subscriptionCents: centsText(subscriptionCents),
      pricePerVerificationCents: centsText(pricePerVerificationCents)
    },
    lineItems: [
      {
        code: "SUBSCRIPTION",
        quantity: "1",
        unitPriceCents: centsText(subscriptionCents),
        amountCents: centsText(subscriptionCents)
      },
      {
        code: "VERIFICATIONS",
        quantity: String(runs),
        unitPriceCents: centsText(pricePerVerificationCents),
        amountCents: centsText(verificationsAmount)
      }
    ],
    totals: {
      subtotalCents: centsText(total),
      totalCents: centsText(total)
    },
    usage: summary
  };

  if (format === "pdf") {
    const lines = [
      `Tenant: ${tenantId}`,
      `Month: ${month}`,
      `Currency: ${billingCurrency}`,
      "",
      `Subscription: ${invoice.lineItems[0].amountCents} cents`,
      `Verifications: ${invoice.lineItems[1].quantity} @ ${invoice.lineItems[1].unitPriceCents} cents = ${invoice.lineItems[1].amountCents} cents`,
      "",
      `Total: ${invoice.totals.totalCents} cents`
    ];
    const pdf = buildInvoiceSummaryPdf({ title: "Billing Invoice (non-normative)", lines });
    res.statusCode = 200;
    res.setHeader("content-type", "application/pdf");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", `attachment; filename=\"billing_invoice_${tenantId}_${month}.pdf\"`);
    res.end(Buffer.from(pdf));
    return;
  }

  return sendJson(res, 200, invoice);
}

function safeIsoToMs(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

function monthKeyFromIso(iso) {
  const ms = safeIsoToMs(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function previousMonthKey(monthKey) {
  const raw = String(monthKey ?? "").trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(raw)) return null;
  const year = Number.parseInt(raw.slice(0, 4), 10);
  const month = Number.parseInt(raw.slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  let y = year;
  let m = month - 1;
  if (m === 0) {
    y -= 1;
    m = 12;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

function billingUsageThresholdStatePath({ tenantId, monthKey }) {
  return path.join(dataDir, "billing", "usage-threshold-alerts", tenantId, `${monthKey}.json`);
}

async function loadBillingUsageThresholdStateBestEffort({ tenantId, monthKey }) {
  const fp = billingUsageThresholdStatePath({ tenantId, monthKey });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!isPlainObject(raw)) return null;
    const alertsRaw = isPlainObject(raw.alerts) ? raw.alerts : {};
    const alerts = {};
    for (const pct of BILLING_USAGE_ALERT_THRESHOLD_PCTS) {
      const row = isPlainObject(alertsRaw[pct]) ? alertsRaw[pct] : null;
      if (!row) continue;
      const used = Number.parseInt(String(row.used ?? 0), 10);
      alerts[pct] = {
        thresholdPct: pct,
        emittedAt: typeof row.emittedAt === "string" ? row.emittedAt : null,
        used: Number.isInteger(used) && used >= 0 ? used : 0
      };
    }
    return {
      schemaVersion: "MagicLinkBillingUsageThresholdState.v1",
      tenantId,
      month: monthKey,
      alerts,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
    };
  } catch {
    return null;
  }
}

async function saveBillingUsageThresholdState({ tenantId, monthKey, state }) {
  const fp = billingUsageThresholdStatePath({ tenantId, monthKey });
  await ensureDir(fp);
  const alertsIn = isPlainObject(state?.alerts) ? state.alerts : {};
  const alerts = {};
  for (const pct of BILLING_USAGE_ALERT_THRESHOLD_PCTS) {
    const row = isPlainObject(alertsIn[pct]) ? alertsIn[pct] : null;
    if (!row || !row.emittedAt) continue;
    const used = Number.parseInt(String(row.used ?? 0), 10);
    alerts[pct] = {
      thresholdPct: pct,
      emittedAt: String(row.emittedAt),
      used: Number.isInteger(used) && used >= 0 ? used : 0
    };
  }
  const payload = {
    schemaVersion: "MagicLinkBillingUsageThresholdState.v1",
    tenantId,
    month: monthKey,
    updatedAt: nowIso(),
    alerts
  };
  await fs.writeFile(fp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return payload;
}

function usageThresholdTriggerRuns({ limit, thresholdPct }) {
  const limitInt = Number.parseInt(String(limit ?? 0), 10);
  if (!Number.isInteger(limitInt) || limitInt <= 0) return null;
  const pct = Number.parseInt(String(thresholdPct ?? 0), 10);
  if (!Number.isInteger(pct) || pct <= 0) return null;
  return Math.max(1, Math.ceil((limitInt * pct) / 100));
}

async function emitBillingUsageThresholdAlertsBestEffort({ tenantId, monthKey, usageSummary, entitlements }) {
  const limit = Number.isInteger(entitlements?.limits?.maxVerificationsPerMonth) ? entitlements.limits.maxVerificationsPerMonth : null;
  if (!Number.isInteger(limit) || limit <= 0) return { emitted: [], state: null };

  const usedRaw = Number.parseInt(String(usageSummary?.verificationRuns ?? 0), 10);
  const used = Number.isInteger(usedRaw) && usedRaw >= 0 ? usedRaw : 0;
  const prior = (await loadBillingUsageThresholdStateBestEffort({ tenantId, monthKey })) ?? {
    schemaVersion: "MagicLinkBillingUsageThresholdState.v1",
    tenantId,
    month: monthKey,
    alerts: {},
    updatedAt: null
  };
  const nextAlerts = isPlainObject(prior.alerts) ? { ...prior.alerts } : {};
  const emitted = [];

  for (const thresholdPct of BILLING_USAGE_ALERT_THRESHOLD_PCTS) {
    const triggerRuns = usageThresholdTriggerRuns({ limit, thresholdPct });
    if (!Number.isInteger(triggerRuns) || triggerRuns < 1) continue;
    if (used < triggerRuns) continue;
    if (isPlainObject(nextAlerts[thresholdPct]) && typeof nextAlerts[thresholdPct].emittedAt === "string" && nextAlerts[thresholdPct].emittedAt.trim() !== "") continue;

    const alert = {
      schemaVersion: "MagicLinkBillingUsageThresholdAlert.v1",
      tenantId,
      month: monthKey,
      thresholdPct,
      triggerRuns,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      overageRuns: Math.max(0, used - limit),
      emittedAt: nowIso()
    };
    nextAlerts[thresholdPct] = { thresholdPct, emittedAt: alert.emittedAt, used };
    emitted.push(alert);
    metrics.incCounter("billing_usage_threshold_alerts_total", { tenantId, threshold: String(thresholdPct) }, 1);
    try {
      await appendAuditRecord({
        dataDir,
        tenantId,
        record: {
          at: alert.emittedAt,
          action: "BILLING_USAGE_THRESHOLD_ALERT_EMITTED",
          actor: { method: "system", email: null, role: "admin" },
          targetType: "billing_usage_threshold",
          targetId: `${tenantId}:${monthKey}:${thresholdPct}`,
          details: {
            month: monthKey,
            thresholdPct,
            triggerRuns,
            limit,
            used,
            remaining: alert.remaining,
            overageRuns: alert.overageRuns
          }
        }
      });
    } catch {
      // ignore audit write failures for best-effort alert emission.
    }
  }

  const state = await saveBillingUsageThresholdState({
    tenantId,
    monthKey,
    state: { ...prior, alerts: nextAlerts }
  });
  return { emitted, state };
}

function buildUsageThresholdStatus({ monthKey, limit, used, state }) {
  if (!Number.isInteger(limit) || limit <= 0) return null;
  const usedInt = Number.isInteger(used) && used >= 0 ? used : 0;
  const alerts = isPlainObject(state?.alerts) ? state.alerts : {};
  return {
    schemaVersion: "MagicLinkUsageThresholdStatus.v1",
    month: monthKey,
    metric: "verificationRuns",
    limit,
    used: usedInt,
    remaining: Math.max(0, limit - usedInt),
    thresholds: BILLING_USAGE_ALERT_THRESHOLD_PCTS.map((thresholdPct) => {
      const triggerRuns = usageThresholdTriggerRuns({ limit, thresholdPct });
      const emitted = isPlainObject(alerts[thresholdPct]) ? alerts[thresholdPct] : null;
      return {
        thresholdPct,
        triggerRuns,
        reached: Number.isInteger(triggerRuns) && usedInt >= triggerRuns,
        emittedAt: emitted && typeof emitted.emittedAt === "string" ? emitted.emittedAt : null
      };
    })
  };
}

async function listTenantIdsFromDiskBestEffort() {
  const dir = path.join(dataDir, "tenants");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    out.sort(cmpString);
    return out;
  } catch {
    return [];
  }
}

function archiveMarkerPath({ tenantId, month }) {
  return path.join(dataDir, "exports", "archive_export", tenantId, `${month}.json`);
}

async function readArchiveMarkerBestEffort({ tenantId, month }) {
  const fp = archiveMarkerPath({ tenantId, month });
  try {
    return JSON.parse(await fs.readFile(fp, "utf8"));
  } catch {
    return null;
  }
}

async function writeArchiveMarkerBestEffort({ tenantId, month, marker }) {
  const fp = archiveMarkerPath({ tenantId, month });
  await ensureDir(fp);
  try {
    await fs.writeFile(fp, JSON.stringify(marker ?? {}, null, 2) + "\n", "utf8");
  } catch {
    // ignore
  }
}

function normalizeS3Prefix(prefix) {
  const p = String(prefix ?? "").trim().replaceAll("\\", "/");
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

function runStatusFrom({ meta, publicSummary }) {
  if (!meta || typeof meta !== "object") return "processing";
  if (!meta.finishedAt) return "processing";
  const ok = Boolean(publicSummary?.verification?.ok);
  const warningCodes = Array.isArray(publicSummary?.verification?.warningCodes) ? publicSummary.verification.warningCodes : [];
  if (!ok) return "red";
  if (warningCodes.length) return "amber";
  return "green";
}

function runStatusFromRunRecord(runRecord) {
  if (!runRecord || typeof runRecord !== "object" || Array.isArray(runRecord)) return "processing";
  const verification = runRecord.verification && typeof runRecord.verification === "object" && !Array.isArray(runRecord.verification) ? runRecord.verification : null;
  if (!verification || typeof verification.ok !== "boolean") return "processing";
  if (!verification.ok) return "red";
  const warningCodes = Array.isArray(verification.warningCodes) ? verification.warningCodes : [];
  return warningCodes.length ? "amber" : "green";
}

async function loadPublicSummaryForToken({ token, meta }) {
  const fp = typeof meta?.publicJsonPath === "string" ? meta.publicJsonPath : path.join(dataDir, "public", `${token}.json`);
  try {
    return JSON.parse(await fs.readFile(fp, "utf8"));
  } catch {
    return null;
  }
}

function normalizeReceiptStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "green" || status === "amber" || status === "red" || status === "processing") return status;
  return "processing";
}

function publicReceiptBadgePalette(status) {
  if (status === "green") return { background: "#ecfdf5", border: "#86efac", text: "#065f46" };
  if (status === "amber") return { background: "#fffbeb", border: "#fcd34d", text: "#92400e" };
  if (status === "red") return { background: "#fef2f2", border: "#fca5a5", text: "#991b1b" };
  return { background: "#f8fafc", border: "#cbd5e1", text: "#334155" };
}

async function hashFileHexBestEffort(fp) {
  if (typeof fp !== "string" || !fp.trim()) return null;
  try {
    const buf = await fs.readFile(fp);
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

function computePublicReceiptSignature(summaryHash) {
  const hh = typeof summaryHash === "string" && /^[0-9a-f]{64}$/.test(summaryHash) ? summaryHash : null;
  if (!hh || !Buffer.isBuffer(settingsKey) || settingsKey.length < 16) return null;
  const keyId = `settings_hmac_${sha256Hex(settingsKey).slice(0, 16)}`;
  const signatureHex = crypto.createHmac("sha256", settingsKey).update(hh).digest("hex");
  return {
    schemaVersion: "PublicReceiptSignature.v1",
    algorithm: "hmac-sha256",
    keyId,
    signatureHex
  };
}

function compactFindingCodes(values, { max = 20 } = {}) {
  const rows = Array.isArray(values) ? values : [];
  const out = [];
  for (const row of rows) {
    const code = typeof row === "string" ? row.trim() : typeof row?.code === "string" ? row.code.trim() : "";
    if (!code) continue;
    out.push(code);
    if (out.length >= max) break;
  }
  return out;
}

async function loadPublicReceiptContext({ req, token }) {
  if (typeof token !== "string" || !/^ml_[0-9a-f]{48}$/.test(token)) {
    return { ok: false, statusCode: 400, body: { ok: false, code: "INVALID_TOKEN", message: "token must match ml_[0-9a-f]{48}" } };
  }

  let meta = null;
  try {
    meta = await loadMeta(token);
  } catch {
    return { ok: false, statusCode: 404, body: { ok: false, code: "TOKEN_NOT_FOUND", message: "token not found" } };
  }

  if (meta.revokedAt) {
    return { ok: false, statusCode: 410, body: { ok: false, code: "TOKEN_REVOKED", message: "token has been revoked" } };
  }
  if (isExpired(meta.createdAt)) {
    return { ok: false, statusCode: 410, body: { ok: false, code: "TOKEN_EXPIRED", message: "token has expired" } };
  }

  const tenantId = typeof meta.tenantId === "string" ? meta.tenantId : "default";
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const limits = tenantRateLimits(tenantSettings);
  const rl = applyRateLimit({ req, tenantId, tenantSettings, category: "verification_view", limitPerHour: limits.verificationViewsPerHour });
  if (!rl.ok) {
    return {
      ok: false,
      statusCode: 429,
      retryAfterSeconds: rl.retryAfterSeconds ?? 60,
      body: {
        ok: false,
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
        retryAfterSeconds: rl.retryAfterSeconds ?? null,
        scope: rl.scope ?? null
      }
    };
  }

  const retentionDays = effectiveRetentionDaysForRun({
    tenantSettings,
    vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
    contractId: typeof meta.contractId === "string" ? meta.contractId : null
  });
  if (isPastRetention(meta.createdAt, retentionDays)) {
    return { ok: false, statusCode: 410, body: { ok: false, code: "TOKEN_RETAINED", message: "retention window elapsed" } };
  }

  const publicSummary = await loadPublicSummaryForToken({ token, meta });
  if (!isPlainObject(publicSummary)) {
    return { ok: false, statusCode: 404, body: { ok: false, code: "PUBLIC_SUMMARY_NOT_FOUND", message: "public summary not found for token" } };
  }
  const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
  const verifyJsonSha256 = await hashFileHexBestEffort(meta.verifyJsonPath);
  const receiptSha256 = await hashFileHexBestEffort(meta.receiptJsonPath);
  const status = normalizeReceiptStatus(runStatusFrom({ meta, publicSummary }));

  return {
    ok: true,
    token,
    meta,
    tenantId,
    publicSummary,
    decisionReport,
    verifyJsonSha256,
    receiptSha256,
    status
  };
}

async function handlePublicReceiptSummary(req, res, token) {
  const loaded = await loadPublicReceiptContext({ req, token });
  if (!loaded.ok) {
    if (Number.isInteger(loaded.retryAfterSeconds)) {
      res.setHeader("retry-after", String(loaded.retryAfterSeconds));
    }
    return sendJson(res, loaded.statusCode, loaded.body);
  }

  const {
    meta,
    publicSummary,
    decisionReport,
    verifyJsonSha256,
    receiptSha256,
    status
  } = loaded;

  const warnings = compactFindingCodes(publicSummary?.verification?.warningCodes ?? publicSummary?.verification?.warnings ?? []);
  const errors = compactFindingCodes(publicSummary?.verification?.errorCodes ?? publicSummary?.verification?.errors ?? []);
  const settlementOutcome = typeof decisionReport?.decision === "string" ? decisionReport.decision : null;
  const settlementSignedAt = typeof decisionReport?.signedAt === "string" ? decisionReport.signedAt : null;
  const settlementSignerKeyId = typeof decisionReport?.signerKeyId === "string" ? decisionReport.signerKeyId : null;
  const settlementReportHash = typeof decisionReport?.reportHash === "string" ? decisionReport.reportHash : null;
  const settlementSignature = typeof decisionReport?.signature === "string" ? decisionReport.signature : null;
  const receiptHashParam = receiptSha256 ? `?receiptHash=${encodeURIComponent(receiptSha256)}` : "";
  const badgeSvgUrl = `/v1/public/receipts/${encodeURIComponent(token)}/badge.svg${receiptHashParam}`;

  const summaryCore = {
    schemaVersion: "MagicLinkPublicReceiptSummary.v1",
    token,
    generatedAt: nowIso(),
    verification: {
      status,
      ok: Boolean(publicSummary?.verification?.ok),
      warningCodes: warnings,
      errorCodes: errors
    },
    settlement: {
      outcome: settlementOutcome,
      decidedAt: typeof decisionReport?.decidedAt === "string" ? decisionReport.decidedAt : null,
      reportHash: settlementReportHash,
      signerKeyId: settlementSignerKeyId,
      signedAt: settlementSignedAt,
      signature: settlementSignature
    },
    artifacts: {
      verifyJsonSha256,
      receiptSha256,
      bundleSha256: typeof meta?.zipSha256 === "string" ? meta.zipSha256 : null
    },
    links: {
      reportUrl: `/r/${encodeURIComponent(token)}`,
      verifyJsonUrl: `/r/${encodeURIComponent(token)}/verify.json`,
      receiptJsonUrl: receiptSha256 ? `/r/${encodeURIComponent(token)}/receipt.json` : null,
      decisionReportUrl: settlementReportHash ? `/r/${encodeURIComponent(token)}/settlement_decision_report.json` : null
    }
  };

  const summaryHash = sha256Hex(Buffer.from(JSON.stringify(summaryCore), "utf8"));
  const signature = computePublicReceiptSignature(summaryHash);

  return sendJson(res, 200, {
    ok: true,
    ...summaryCore,
    summaryHash,
    signature,
    badge: {
      badgeSvgUrl,
      embedHtml: `<img src="${badgeSvgUrl}" alt="Settld verification ${status}" loading="lazy" decoding="async" />`
    }
  });
}

async function handlePublicReceiptBadge(req, res, token, url) {
  const loaded = await loadPublicReceiptContext({ req, token });
  if (!loaded.ok) {
    if (Number.isInteger(loaded.retryAfterSeconds)) {
      res.setHeader("retry-after", String(loaded.retryAfterSeconds));
    }
    return sendJson(res, loaded.statusCode, loaded.body);
  }

  const expectedReceiptHashRaw = String(url.searchParams.get("receiptHash") ?? "").trim().toLowerCase();
  if (expectedReceiptHashRaw) {
    if (!/^[0-9a-f]{64}$/.test(expectedReceiptHashRaw)) {
      return sendJson(res, 400, { ok: false, code: "INVALID_RECEIPT_HASH", message: "receiptHash must be a 64-char lowercase hex sha256" });
    }
    if (!loaded.receiptSha256) {
      return sendJson(res, 409, { ok: false, code: "RECEIPT_HASH_UNAVAILABLE", message: "receipt hash unavailable for token" });
    }
    if (expectedReceiptHashRaw !== loaded.receiptSha256) {
      return sendJson(res, 409, {
        ok: false,
        code: "RECEIPT_HASH_MISMATCH",
        message: "receipt hash mismatch",
        detail: {
          expected: expectedReceiptHashRaw,
          actual: loaded.receiptSha256
        }
      });
    }
  }

  const status = normalizeReceiptStatus(loaded.status);
  const palette = publicReceiptBadgePalette(status);
  const statusLabel = status.toUpperCase();
  const settlementLabel = typeof loaded.decisionReport?.decision === "string" ? loaded.decisionReport.decision.toUpperCase() : "PENDING";
  const receiptShort = loaded.receiptSha256 ? loaded.receiptSha256.slice(0, 12) : "none";
  const tokenShort = String(token).slice(0, 11);

  const svg = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"520\" height=\"92\" role=\"img\" aria-label=\"Settld public receipt badge\">",
    `  <rect x="1" y="1" width="518" height="90" rx="14" fill="${palette.background}" stroke="${palette.border}" stroke-width="2"/>`,
    `  <text x="22" y="33" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="15" font-weight="700" fill="${palette.text}">SETTLD VERIFIED</text>`,
    `  <text x="22" y="55" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="22" font-weight="800" fill="${palette.text}">${htmlEscape(statusLabel)}</text>`,
    `  <text x="22" y="75" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" fill="${palette.text}">settlement ${htmlEscape(settlementLabel)} · receipt ${htmlEscape(receiptShort)}</text>`,
    `  <text x="365" y="55" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12" fill="${palette.text}">${htmlEscape(tokenShort)}</text>`,
    "</svg>"
  ].join("\n");

  res.statusCode = 200;
  res.setHeader("content-type", "image/svg+xml; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(svg);
}

async function listTenantIndexEntries({ tenantId, max = 50_000 } = {}) {
  const idxDir = path.join(dataDir, "index", tenantId);
  let names = [];
  try {
    names = (await fs.readdir(idxDir)).filter((n) => n.endsWith(".json")).slice(0, max);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const fp = path.join(idxDir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const idx = JSON.parse(await fs.readFile(fp, "utf8"));
      const token = typeof idx?.token === "string" && /^ml_[0-9a-f]{48}$/.test(idx.token) ? idx.token : null;
      const zipSha256 = typeof idx?.zipSha256 === "string" ? idx.zipSha256 : name.replace(/\.json$/, "");
      if (token) out.push({ token, zipSha256 });
    } catch {
      // ignore
    }
  }
  return out;
}

async function handleInbox(req, res, url) {
  const api = checkAuth(req);
  let tenantId = null;
  let tenantSettings = null;
  if (api.ok) {
    const tenant = parseTenantId(req);
    if (!tenant.ok) return sendJson(res, 400, { ok: false, code: "INVALID_TENANT", message: tenant.error });
    tenantId = tenant.tenantId;
    tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  } else {
    const buyer = await authenticateBuyerSession(req);
    if (!buyer.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN" });
    tenantId = buyer.principal.tenantId;
    tenantSettings = buyer.tenantSettings;
  }

  const statusFilter = url.searchParams.get("status") ? String(url.searchParams.get("status")).trim().toLowerCase() : null;
  if (statusFilter && statusFilter !== "green" && statusFilter !== "amber" && statusFilter !== "red" && statusFilter !== "processing") {
    return sendJson(res, 400, { ok: false, code: "INVALID_STATUS", message: "status must be green|amber|red|processing" });
  }

  const vendorId = url.searchParams.get("vendorId") ? String(url.searchParams.get("vendorId")).trim() : null;
  const contractId = url.searchParams.get("contractId") ? String(url.searchParams.get("contractId")).trim() : null;
  const from = url.searchParams.get("from") ? String(url.searchParams.get("from")).trim() : null;
  const to = url.searchParams.get("to") ? String(url.searchParams.get("to")).trim() : null;
  const fromMs = from ? safeIsoToMs(from) : NaN;
  const toMs = to ? safeIsoToMs(to) : NaN;
  if (from && !Number.isFinite(fromMs)) return sendJson(res, 400, { ok: false, code: "INVALID_FROM", message: "from must be an ISO date string" });
  if (to && !Number.isFinite(toMs)) return sendJson(res, 400, { ok: false, code: "INVALID_TO", message: "to must be an ISO date string" });

  const limitRaw = url.searchParams.get("limit") ? String(url.searchParams.get("limit")).trim() : "";
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..5000" });

  const closepackRaw = url.searchParams.get("closepack") ? String(url.searchParams.get("closepack")).trim().toLowerCase() : null;
  const closepackFilter = closepackRaw === null ? null : closepackRaw === "1" || closepackRaw === "true" ? true : closepackRaw === "0" || closepackRaw === "false" ? false : null;
  if (closepackRaw !== null && closepackFilter === null) {
    return sendJson(res, 400, { ok: false, code: "INVALID_CLOSEPACK", message: "closepack must be true|false|1|0" });
  }
  const slaFilter = url.searchParams.get("sla") ? String(url.searchParams.get("sla")).trim().toLowerCase() : null;
  if (slaFilter && slaFilter !== "pass" && slaFilter !== "fail" && slaFilter !== "missing") {
    return sendJson(res, 400, { ok: false, code: "INVALID_SLA", message: "sla must be pass|fail|missing" });
  }
  const acceptanceFilter = url.searchParams.get("acceptance") ? String(url.searchParams.get("acceptance")).trim().toLowerCase() : null;
  if (acceptanceFilter && acceptanceFilter !== "pass" && acceptanceFilter !== "fail" && acceptanceFilter !== "missing") {
    return sendJson(res, 400, { ok: false, code: "INVALID_ACCEPTANCE", message: "acceptance must be pass|fail|missing" });
  }

  const rows = [];
  const seenTokens = new Set();
  const runRecordScanLimit = Math.max(limit * 20, 5_000);
  const runRecords = await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max: runRecordScanLimit });

  const evalStatus = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "missing";
    if (!obj.present) return "missing";
    return obj.pass ? "pass" : "fail";
  };

  for (const rr of runRecords) {
    const token = typeof rr?.token === "string" && /^ml_[0-9a-f]{48}$/.test(rr.token) ? rr.token : null;
    if (!token) continue;
    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : null;
    if (!createdAt || isExpired(createdAt)) continue;

    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : null
        });
    if (isPastRetention(createdAt, retentionDays)) continue;

    const createdMs = safeIsoToMs(createdAt);
    if (Number.isFinite(fromMs) && Number.isFinite(createdMs) && createdMs < fromMs) continue;
    if (Number.isFinite(toMs) && Number.isFinite(createdMs) && createdMs > toMs) continue;

    if (vendorId && String(rr?.vendorId ?? "") !== vendorId) continue;
    if (contractId && String(rr?.contractId ?? "") !== contractId) continue;

    const status = runStatusFromRunRecord(rr);
    if (statusFilter && status !== statusFilter) continue;

    const closePackSummaryV1 = rr?.closePackSummaryV1 ?? null;
    const hasClosePack = Boolean(closePackSummaryV1 && typeof closePackSummaryV1 === "object" && !Array.isArray(closePackSummaryV1) && closePackSummaryV1.hasClosePack === true);
    if (closepackFilter !== null && hasClosePack !== closepackFilter) continue;

    const slaStatus = hasClosePack ? evalStatus(closePackSummaryV1?.sla ?? null) : "missing";
    const acceptanceStatus = hasClosePack ? evalStatus(closePackSummaryV1?.acceptance ?? null) : "missing";
    if (slaFilter) {
      if (!hasClosePack) continue;
      if (slaStatus !== slaFilter) continue;
    }
    if (acceptanceFilter) {
      if (!hasClosePack) continue;
      if (acceptanceStatus !== acceptanceFilter) continue;
    }

    const claim = rr?.invoiceClaim ?? null;
    const errorCodes = Array.isArray(rr?.verification?.errorCodes) ? rr.verification.errorCodes.map(String).filter(Boolean) : [];
    const warningCodes = Array.isArray(rr?.verification?.warningCodes) ? rr.verification.warningCodes.map(String).filter(Boolean) : [];
    const decisionSummary = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;

    rows.push({
      schemaVersion: "MagicLinkInboxRow.v1",
      token,
      url: `/r/${token}`,
      createdAt,
      zipSha256: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : null,
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : null,
      vendorName: typeof rr?.vendorName === "string" ? rr.vendorName : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : null,
      templateId: typeof rr?.templateId === "string" ? rr.templateId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      modeRequested: typeof rr?.modeRequested === "string" ? rr.modeRequested : null,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : null,
      status,
      topErrorCodes: errorCodes.slice(0, 5),
      topWarningCodes: warningCodes.slice(0, 5),
      closePack: hasClosePack
        ? {
            slaStatus,
            acceptanceStatus,
            evidenceItemCount: Number.isInteger(closePackSummaryV1?.evidenceIndex?.itemCount) ? closePackSummaryV1.evidenceIndex.itemCount : null,
            evidenceByType: closePackSummaryV1?.evidenceIndex?.byType ?? null
          }
        : null,
      decision: typeof decisionSummary?.decision === "string" ? decisionSummary.decision : null,
      decidedAt: typeof decisionSummary?.decidedAt === "string" ? decisionSummary.decidedAt : null,
      decidedBy: typeof decisionSummary?.decidedByEmail === "string" ? decisionSummary.decidedByEmail : null
    });
    seenTokens.add(token);
  }

  const entries = await listTenantIndexEntries({ tenantId });
  for (const ent of entries) {
    const token = ent.token;
    if (seenTokens.has(token)) continue;
    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    if (!meta || meta.revokedAt || isExpired(meta.createdAt)) continue;
    const retentionDays = effectiveRetentionDaysForRun({
      tenantSettings,
      vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
      contractId: typeof meta.contractId === "string" ? meta.contractId : null
    });
    if (isPastRetention(meta.createdAt, retentionDays)) continue;

    const createdMs = safeIsoToMs(meta.createdAt);
    if (Number.isFinite(fromMs) && Number.isFinite(createdMs) && createdMs < fromMs) continue;
    if (Number.isFinite(toMs) && Number.isFinite(createdMs) && createdMs > toMs) continue;

    if (vendorId && String(meta.vendorId ?? "") !== vendorId) continue;
    if (contractId && String(meta.contractId ?? "") !== contractId) continue;

    // eslint-disable-next-line no-await-in-loop
    const pub = await loadPublicSummaryForToken({ token, meta });
    const status = runStatusFrom({ meta, publicSummary: pub });
    if (statusFilter && status !== statusFilter) continue;

    const closePackSummaryV1 = pub?.closePackSummaryV1 ?? null;
    const hasClosePack = Boolean(closePackSummaryV1 && typeof closePackSummaryV1 === "object" && !Array.isArray(closePackSummaryV1) && closePackSummaryV1.hasClosePack === true);
    if (closepackFilter !== null && hasClosePack !== closepackFilter) continue;

    const slaStatus = hasClosePack ? evalStatus(closePackSummaryV1?.sla ?? null) : "missing";
    const acceptanceStatus = hasClosePack ? evalStatus(closePackSummaryV1?.acceptance ?? null) : "missing";
    if (slaFilter) {
      if (!hasClosePack) continue;
      if (slaStatus !== slaFilter) continue;
    }
    if (acceptanceFilter) {
      if (!hasClosePack) continue;
      if (acceptanceStatus !== acceptanceFilter) continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });

    const claim = pub?.invoiceClaim ?? null;
    const errorCodes = Array.isArray(pub?.verification?.errorCodes) ? pub.verification.errorCodes.map(String).filter(Boolean) : [];
    const warningCodes = Array.isArray(pub?.verification?.warningCodes) ? pub.verification.warningCodes.map(String).filter(Boolean) : [];

    rows.push({
      schemaVersion: "MagicLinkInboxRow.v1",
      token,
      url: `/r/${token}`,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
      zipSha256: typeof meta.zipSha256 === "string" ? meta.zipSha256 : ent.zipSha256,
      vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
      vendorName: typeof meta.vendorName === "string" ? meta.vendorName : null,
      contractId: typeof meta.contractId === "string" ? meta.contractId : null,
      templateId: typeof meta.templateId === "string" ? meta.templateId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      modeRequested: typeof meta.modeRequested === "string" ? meta.modeRequested : null,
      modeResolved: typeof meta.modeResolved === "string" ? meta.modeResolved : null,
      status,
      topErrorCodes: errorCodes.slice(0, 5),
      topWarningCodes: warningCodes.slice(0, 5),
      closePack: hasClosePack
        ? {
            slaStatus,
            acceptanceStatus,
            evidenceItemCount: Number.isInteger(closePackSummaryV1?.evidenceIndex?.itemCount) ? closePackSummaryV1.evidenceIndex.itemCount : null,
            evidenceByType: closePackSummaryV1?.evidenceIndex?.byType ?? null
          }
        : null,
      decision: decisionReport && typeof decisionReport.decision === "string" ? decisionReport.decision : null,
      decidedAt: decisionReport && typeof decisionReport.decidedAt === "string" ? decisionReport.decidedAt : null,
      decidedBy: typeof decisionReport?.actor?.email === "string" ? decisionReport.actor.email : null
    });
    seenTokens.add(token);
  }

  rows.sort((a, b) => cmpString(b.createdAt ?? "", a.createdAt ?? "") || cmpString(a.token, b.token));

  return sendJson(res, 200, { ok: true, schemaVersion: "MagicLinkInbox.v1", tenantId, generatedAt: nowIso(), rows: rows.slice(0, limit) });
}

async function buildTenantAuditPacketZipBytes({ tenantId, month, includeBundles }) {
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const artifactStorage = isPlainObject(tenantSettings?.artifactStorage) ? tenantSettings.artifactStorage : null;
  const precompute = Boolean(artifactStorage && artifactStorage.precomputeMonthlyAuditPackets === true);
  const cachePath = path.join(
    dataDir,
    "exports",
    "cache",
    "audit_packet",
    tenantId,
    `${month}${includeBundles ? "" : "_no_bundles"}.zip`
  );
  if (precompute) {
    try {
      return await fs.readFile(cachePath);
    } catch {
      // miss
    }
  }

  const files = new Map();
  const runs = [];
  const tokens = new Set();
  const attachRunFilesBestEffort = async ({ token, meta, runRecord, decisionFiles }) => {
    const prefix = `runs/${token}/`;
    if (runRecord && typeof runRecord === "object" && !Array.isArray(runRecord)) {
      files.set(`${prefix}run_record.json`, Buffer.from(JSON.stringify(runRecord, null, 2) + "\n", "utf8"));
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
    if (includeBundles && meta.zipPath) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}bundle.zip`, await fs.readFile(meta.zipPath));
      } catch {
        // ignore
      }
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      files.set(`${prefix}verify.json`, await fs.readFile(meta.verifyJsonPath));
    } catch {
      // ignore
    }
    if (meta.publicJsonPath) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}public_summary.json`, await fs.readFile(meta.publicJsonPath));
      } catch {
        // ignore
      }
    }
    if (meta.receiptJsonPath) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}producer_receipt.json`, await fs.readFile(meta.receiptJsonPath));
      } catch {
        // ignore
      }
    }
    if (meta.closePackDir) {
      const base = String(meta.closePackDir);
      for (const name of [
        "closepack_summary_v1.json",
        "evidence_index.json",
        "sla_definition.json",
        "sla_evaluation.json",
        "acceptance_criteria.json",
        "acceptance_evaluation.json"
      ]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          files.set(`${prefix}closepack/${name}`, await fs.readFile(path.join(base, name)));
        } catch {
          // ignore
        }
      }
    }
    for (const f of decisionFiles) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}settlement_decisions/${f.name}`, await fs.readFile(f.path));
      } catch {
        // ignore
      }
    }
  };

  const runRecords = await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max: 200_000 });
  for (const rr of runRecords) {
    const token = typeof rr?.token === "string" && /^ml_[0-9a-f]{48}$/.test(rr.token) ? rr.token : null;
    if (!token || tokens.has(token)) continue;

    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    if (meta && (meta.revokedAt || isExpired(meta.createdAt))) continue;

    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : typeof meta?.createdAt === "string" ? meta.createdAt : null;
    if (!createdAt) continue;
    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null
        });
    if (isPastRetention(createdAt, retentionDays)) continue;
    if (monthKeyFromIso(createdAt) !== month) continue;

    // eslint-disable-next-line no-await-in-loop
    const pub = meta ? await loadPublicSummaryForToken({ token, meta }) : null;
    // eslint-disable-next-line no-await-in-loop
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
    // eslint-disable-next-line no-await-in-loop
    const decisionFiles = await listSettlementDecisionReportFiles({ dataDir, token });

    const runRecordStatus = runStatusFromRunRecord(rr);
    const status = runRecordStatus === "processing" ? runStatusFrom({ meta, publicSummary: pub }) : runRecordStatus;
    const claim = rr?.invoiceClaim ?? pub?.invoiceClaim ?? null;
    const decisionSummary = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;

    runs.push({
      token,
      createdAt,
      zipSha256: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : typeof meta?.zipSha256 === "string" ? meta.zipSha256 : null,
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
      vendorName: typeof rr?.vendorName === "string" ? rr.vendorName : typeof meta?.vendorName === "string" ? meta.vendorName : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : typeof meta?.modeResolved === "string" ? meta.modeResolved : null,
      status,
      decision:
        typeof decisionSummary?.decision === "string"
          ? decisionSummary.decision
          : decisionReport && typeof decisionReport.decision === "string"
            ? decisionReport.decision
            : null,
      decidedAt:
        typeof decisionSummary?.decidedAt === "string"
          ? decisionSummary.decidedAt
          : decisionReport && typeof decisionReport.decidedAt === "string"
            ? decisionReport.decidedAt
            : null,
      decidedBy:
        typeof decisionSummary?.decidedByEmail === "string"
          ? decisionSummary.decidedByEmail
          : typeof decisionReport?.actor?.email === "string"
            ? decisionReport.actor.email
            : null
    });
    tokens.add(token);
    // eslint-disable-next-line no-await-in-loop
    await attachRunFilesBestEffort({ token, meta, runRecord: rr, decisionFiles });
  }

  const entries = await listTenantIndexEntries({ tenantId });
  for (const ent of entries) {
    const token = ent.token;
    if (tokens.has(token)) continue;

    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    // eslint-disable-next-line no-await-in-loop
    const rr = await readRunRecordBestEffort({ dataDir, tenantId, token });
    if (!meta && !rr) continue;
    if (meta && (meta.revokedAt || isExpired(meta.createdAt))) continue;

    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : typeof meta?.createdAt === "string" ? meta.createdAt : null;
    if (!createdAt) continue;
    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null
        });
    if (isPastRetention(createdAt, retentionDays)) continue;
    if (monthKeyFromIso(createdAt) !== month) continue;

    // eslint-disable-next-line no-await-in-loop
    const pub = meta ? await loadPublicSummaryForToken({ token, meta }) : null;
    // eslint-disable-next-line no-await-in-loop
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
    // eslint-disable-next-line no-await-in-loop
    const decisionFiles = await listSettlementDecisionReportFiles({ dataDir, token });

    const runRecordStatus = rr ? runStatusFromRunRecord(rr) : "processing";
    const status = runRecordStatus === "processing" ? runStatusFrom({ meta, publicSummary: pub }) : runRecordStatus;
    const claim = rr?.invoiceClaim ?? pub?.invoiceClaim ?? null;
    const decisionSummary = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;

    runs.push({
      token,
      createdAt,
      zipSha256: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : typeof meta?.zipSha256 === "string" ? meta.zipSha256 : ent.zipSha256,
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
      vendorName: typeof rr?.vendorName === "string" ? rr.vendorName : typeof meta?.vendorName === "string" ? meta.vendorName : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : typeof meta?.modeResolved === "string" ? meta.modeResolved : null,
      status,
      decision:
        typeof decisionSummary?.decision === "string"
          ? decisionSummary.decision
          : decisionReport && typeof decisionReport.decision === "string"
            ? decisionReport.decision
            : null,
      decidedAt:
        typeof decisionSummary?.decidedAt === "string"
          ? decisionSummary.decidedAt
          : decisionReport && typeof decisionReport.decidedAt === "string"
            ? decisionReport.decidedAt
            : null,
      decidedBy:
        typeof decisionSummary?.decidedByEmail === "string"
          ? decisionSummary.decidedByEmail
          : typeof decisionReport?.actor?.email === "string"
            ? decisionReport.actor.email
            : null
    });
    tokens.add(token);
    // eslint-disable-next-line no-await-in-loop
    await attachRunFilesBestEffort({ token, meta, runRecord: rr, decisionFiles });
  }

  // Best-effort: include webhook attempts/records for runs in this month.
  for (const sub of ["record", "attempts"]) {
    const dir = path.join(dataDir, "webhooks", sub);
    let names = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names) {
      const fp = path.join(dir, name);
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(fp, "utf8");
        const j = JSON.parse(raw);
        if (!j || typeof j !== "object" || Array.isArray(j)) continue;
        if (String(j.tenantId ?? "") !== tenantId) continue;
        const token = typeof j.token === "string" ? j.token : null;
        if (!token || !tokens.has(token)) continue;
        const sentAt = typeof j.sentAt === "string" ? j.sentAt : null;
        if (sentAt && monthKeyFromIso(sentAt) !== month) continue;
        files.set(`webhooks/${sub}/${name}`, Buffer.from(raw, "utf8"));
      } catch {
        // ignore
      }
    }
  }

  runs.sort((a, b) => cmpString(a.createdAt ?? "", b.createdAt ?? "") || cmpString(a.token, b.token));
  const index = { schemaVersion: "MagicLinkMonthlyAuditPacketIndex.v1", tenantId, month, generatedAt: nowIso(), includeBundles, runs };
  files.set("index.json", Buffer.from(JSON.stringify(index, null, 2) + "\n", "utf8"));

  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  const buf = Buffer.from(zip);
  if (precompute) {
    try {
      await ensureDir(cachePath);
      await fs.writeFile(cachePath, buf);
    } catch {
      // ignore
    }
  }
  return buf;
}

function archiveSinkFingerprint(sink) {
  if (!sink || typeof sink !== "object" || Array.isArray(sink)) return null;
  const stable = {
    type: sink.type ?? null,
    enabled: Boolean(sink.enabled),
    endpoint: sink.endpoint ?? null,
    region: sink.region ?? null,
    bucket: sink.bucket ?? null,
    prefix: sink.prefix ?? null,
    pathStyle: sink.pathStyle ?? null,
    sse: sink.sse ?? null,
    kmsKeyId: sink.kmsKeyId ?? null
  };
  try {
    return sha256Hex(JSON.stringify(stable));
  } catch {
    return null;
  }
}

async function runTenantArchiveExportOnce({ tenantId, month, dryRunDir = null, force = false } = {}) {
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const sink = isPlainObject(tenantSettings?.archiveExportSink) ? tenantSettings.archiveExportSink : null;
  if (!sink || sink.type !== "s3" || !sink.enabled) {
    return { ok: false, code: "ARCHIVE_EXPORT_NOT_CONFIGURED" };
  }

  const sinkHash = archiveSinkFingerprint(sink);
  const marker = await readArchiveMarkerBestEffort({ tenantId, month });
  if (!force && marker && marker.ok === true && marker.month === month && marker.sinkHash && marker.sinkHash === sinkHash) {
    return { ok: true, skipped: true, marker };
  }

  const auditZip = await buildTenantAuditPacketZipBytes({ tenantId, month, includeBundles: true });
  const csv = await buildTenantCsvExportText({ tenantId, month });

  const prefix = normalizeS3Prefix(sink.prefix);
  const keyBase = `${prefix}${tenantId}/${month}/`;
  const auditKey = `${keyBase}audit_packet_${tenantId}_${month}.zip`;
  const csvKey = `${keyBase}export_${tenantId}_${month}.csv`;

  const results = [];

  if (dryRunDir) {
    const outDir = path.join(dryRunDir, tenantId, month);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, path.basename(auditKey)), auditZip);
    await fs.writeFile(path.join(outDir, path.basename(csvKey)), Buffer.from(csv, "utf8"));
    results.push({ kind: "audit_packet", mode: "dry-run", key: auditKey, ok: true });
    results.push({ kind: "csv", mode: "dry-run", key: csvKey, ok: true });
  } else {
    const endpoint = typeof sink.endpoint === "string" && sink.endpoint.trim() ? sink.endpoint.trim() : null;
    const region = typeof sink.region === "string" && sink.region.trim() ? sink.region.trim() : null;
    const bucket = typeof sink.bucket === "string" && sink.bucket.trim() ? sink.bucket.trim() : null;
    if (!bucket) return { ok: false, code: "ARCHIVE_EXPORT_BUCKET_MISSING" };
    if (!region && !endpoint) return { ok: false, code: "ARCHIVE_EXPORT_REGION_MISSING" };

    const accessKeyId = typeof sink.accessKeyId === "string" && sink.accessKeyId.trim() ? sink.accessKeyId.trim() : null;
    const secretAccessKey = decryptStoredSecret({ settingsKey, storedSecret: sink.secretAccessKey });
    const sessionToken = decryptStoredSecret({ settingsKey, storedSecret: sink.sessionToken });
    if (!accessKeyId || !secretAccessKey) return { ok: false, code: "ARCHIVE_EXPORT_CREDS_MISSING" };

    const pathStyle = Boolean(sink.pathStyle ?? (endpoint ? true : false));
    const sse = typeof sink.sse === "string" ? sink.sse : "none";
    const kmsKeyId = typeof sink.kmsKeyId === "string" && sink.kmsKeyId.trim() ? sink.kmsKeyId.trim() : null;
    const regionEffective = region ?? "us-east-1";

    const urlAudit = buildS3ObjectUrl({ endpoint, region: regionEffective, bucket, key: auditKey, pathStyle });
    const urlCsv = buildS3ObjectUrl({ endpoint, region: regionEffective, bucket, key: csvKey, pathStyle });

    const putAudit = await s3PutObject({
      url: urlAudit,
      region: regionEffective,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      body: auditZip,
      contentType: "application/zip",
      sse,
      kmsKeyId
    });
    results.push({ kind: "audit_packet", mode: "s3", key: auditKey, ok: Boolean(putAudit.ok), statusCode: putAudit.statusCode ?? null, error: putAudit.ok ? null : putAudit.error ?? null });

    const putCsv = await s3PutObject({
      url: urlCsv,
      region: regionEffective,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      body: Buffer.from(csv, "utf8"),
      contentType: "text/csv; charset=utf-8",
      sse,
      kmsKeyId
    });
    results.push({ kind: "csv", mode: "s3", key: csvKey, ok: Boolean(putCsv.ok), statusCode: putCsv.statusCode ?? null, error: putCsv.ok ? null : putCsv.error ?? null });
  }

  const ok = results.every((r) => r.ok);
  const markerOut = { schemaVersion: "MagicLinkArchiveExportMarker.v1", tenantId, month, ok, sinkHash, attemptedAt: nowIso(), results };
  await writeArchiveMarkerBestEffort({ tenantId, month, marker: markerOut });

  try {
    await appendAuditRecord({
      dataDir,
      tenantId,
      record: {
        at: nowIso(),
        action: "ARCHIVE_EXPORT_PUSH",
        actor: { method: "system", email: null, role: null },
        targetType: "month",
        targetId: month,
        details: { ok, sink: { type: "s3", endpoint: sink.endpoint ?? null, region: sink.region ?? null, bucket: sink.bucket ?? null, prefix: sink.prefix ?? null }, results }
      }
    });
  } catch {
    // ignore
  }

  return { ok, month, results, marker: markerOut };
}

async function handleTenantArchiveExportTrigger(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : previousMonthKey(monthKeyUtcNow());
  if (!month || !/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const dryRun = url.searchParams.get("dryRun") === "1";
  const force = url.searchParams.get("force") === "1";
  const dryRunDir = dryRun ? path.join(dataDir, "exports_outbox") : null;

  const result = await runTenantArchiveExportOnce({ tenantId, month, dryRunDir, force });
  return sendJson(res, 200, { ok: Boolean(result.ok), tenantId, month, dryRun, result });
}

async function handleTenantAuditPacketExport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const includeBundles = url.searchParams.get("includeBundles") ? String(url.searchParams.get("includeBundles")).trim() === "1" : true;

  const zipBuf = await buildTenantAuditPacketZipBytes({ tenantId, month, includeBundles });
  res.statusCode = 200;
  res.setHeader("content-type", "application/zip");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"audit_packet_${tenantId}_${month}.zip\"`);
  res.end(zipBuf);
}

async function handleTenantSecurityControlsPacketExport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const safeSettings = sanitizeTenantSettingsForApi(tenantSettings);
  const trust = governanceTrustInfo({ tenantSettings, envValue: process.env.SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON ?? "" });

  const unzipBudgets = {
    maxEntries: 20_000,
    maxPathBytes: 512,
    maxFileBytes: 50 * 1024 * 1024,
    maxTotalBytes: 200 * 1024 * 1024,
    maxCompressionRatio: 200
  };

  const toolVersion = await readToolVersionBestEffort();
  const toolCommit = readToolCommitBestEffort();
  const serviceVersion = readServiceVersionBestEffort();
  const serviceCommit = readServiceCommitBestEffort();

  const index = {
    schemaVersion: "MagicLinkSecurityControlsPacketIndex.v1",
    tenantId,
    month,
    generatedAt: nowIso(),
    packet: {
      schemaVersion: "MagicLinkSecurityPacketRef.v1",
      packetIndexPath: "packet_index.json",
      checksumsPath: "checksums.sha256",
      dataInventoryPath: "data_inventory.json",
      includedDocs: []
    },
    threatModel: {
      summary: "Hosted ingestion defends against hostile ZIPs (zip-slip, traversal, symlinks, duplicates, encryption) and enforces explicit budgets to reduce DoS risk.",
      hostileZip: [
        "path traversal / zip-slip",
        "symlink attacks",
        "duplicate entries / overwrite attacks",
        "encrypted entries",
        "zip bombs (compression ratio / total size / entry count)"
      ],
      webThreats: [
        "token guessing / link leakage",
        "HTML injection / XSS via bundle metadata",
        "resource exhaustion (huge uploads, unzip bombs, slow verifications)",
        "credential/key misuse (API key, ingest keys)",
        "webhook delivery abuse (replay, secret leakage)"
      ],
      mitigations: {
        tokens: [
          "high-entropy token ids (ml_ + 24 random bytes)",
          "token TTL and explicit revocation",
          "tenant scoped exports (admin/buyer session required)"
        ],
        xss: ["escape all HTML output", "render/export only allowlisted fields (see redaction_allowlist.json)", "deterministic truncation of long strings"],
        dos: [
          "Content-Length required and bounded by MAGIC_LINK_MAX_UPLOAD_BYTES",
          "safe unzip budgets enforced (entry count, per-file bytes, total bytes, compression ratio)",
          "verification timeouts and concurrency caps",
          "upload rate limiting per tenant"
        ],
        secrets: ["tenant settings secrets encrypted at rest when MAGIC_LINK_SETTINGS_KEY_HEX is configured", "support bundle redacts secrets by default"]
      },
      dosBudgets: {
        uploadMaxBytes: maxUploadBytes,
        verifyTimeoutMs,
        maxConcurrentJobs,
        maxConcurrentJobsPerTenant,
        unzip: unzipBudgets
      }
    },
    versions: {
      node: process.version,
      service: { name: "settld-magic-link", version: serviceVersion ?? null, commit: serviceCommit ?? null, env: String(process.env.NODE_ENV ?? "development") },
      verifier: { name: "settld-verify", version: toolVersion ?? null, commit: toolCommit ?? null }
    },
    trust: {
      configured: Boolean(trust?.configured),
      keyIds: Array.isArray(trust?.keyIds) ? trust.keyIds : [],
      setHash: typeof trust?.setHash === "string" ? trust.setHash : null,
      source: typeof trust?.source === "string" ? trust.source : null
    },
    settings: safeSettings,
    budgets: {
      upload: { maxUploadBytes },
      verify: {
        timeoutMs: verifyTimeoutMs,
        maxConcurrentJobs,
        maxConcurrentJobsPerTenant,
        queue: {
          adapter: "memory",
          workers: verifyQueueWorkers,
          maxAttempts: verifyQueueMaxAttempts,
          retryBackoffMs: verifyQueueRetryBackoffMs,
          ...verifyQueue.stats()
        }
      },
      unzip: unzipBudgets
    },
    controls: {
      auth: {
        adminApi: { method: apiKey ? "x-api-key" : "disabled", header: "x-api-key" },
        buyerSessions: { enabled: true, otpDeliveryMode: buyerOtpDeliveryMode, sessionTtlSeconds: buyerSessionTtlSeconds },
        vendorIngestKeys: { enabled: true, header: "Authorization: Bearer <ingestKey>" },
        decisionOtp: { enabled: true, otpDeliveryMode: decisionOtpDeliveryMode, ttlSeconds: decisionOtpTtlSeconds, maxAttempts: decisionOtpMaxAttempts }
      },
      tokens: {
        magicLinkToken: { prefix: "ml_", entropyBits: 192, ttlSeconds: tokenTtlSeconds, revocable: true }
      },
      rateLimits: {
        defaultsPerTenant: {
          uploadsPerHour: uploadsPerHourDefault,
          verificationViewsPerHour: 1000,
          decisionsPerHour: 300,
          otpRequestsPerHour: 300
        },
        legacyUploadsPerMinute: uploadsPerMinuteLegacy
      },
      storage: {
        dataDir,
        formatVersion: MAGIC_LINK_DATA_FORMAT_VERSION_CURRENT,
        migrateOnStartup,
        runStore: runStoreModeInfo()
      },
      exports: {
        archiveExport: {
          enabled: archiveExportEnabled,
          intervalSeconds: archiveExportIntervalSeconds,
          triggerEndpoint: "/v1/tenants/:tenant/archive-export",
          dryRunOutbox: "exports_outbox/<tenant>/<YYYY-MM>/"
        }
      }
    }
  };

  const files = new Map();
  files.set("redaction_allowlist.json", Buffer.from(JSON.stringify(MAGIC_LINK_RENDER_MODEL_ALLOWLIST_V1, null, 2) + "\n", "utf8"));
  files.set(
    "redaction_sample_render_model.json",
    Buffer.from(JSON.stringify({ schemaVersion: "MagicLinkSampleRenderModel.v1", invoiceClaim: sampleRenderModelInvoiceClaimV1() }, null, 2) + "\n", "utf8")
  );
  files.set(
    "retention_behavior.json",
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: "MagicLinkRetentionBehavior.v1",
          summary:
            "Hosted retention deletes stored bundle zips and derived artifacts after the effective retention window, while keeping minimal immutable metadata (ids/hashes/timestamps/codes) for accounting and audit support.",
          deletes: [
            "zips/<token>.zip (bundle bytes; when artifactStorage.storeBundleZip=true)",
            "verify/<token>.json (verifier output)",
            "public/<token>.json (public summary)",
            "receipt/<token>.json (producer receipt)",
            "pdf/<token>.pdf (summary PDF; when artifactStorage.storePdf=true)",
            "decisions/<token>.json (decision request)",
            "settlement_decisions/<token>/ (decision reports)",
            "closepack/<token>/ (closepack surfaces)",
            "webhooks/{attempts,record}/<token>_*.json (delivery records)",
            "webhook_retry/{pending,dead-letter}/*_<token>_*.json (persistent webhook retry jobs)",
            "index/<tenant>/<sha256>.json (dedupe index entry)",
            "exports/cache/audit_packet/<tenant>/<month>.zip (optional export cache)"
          ],
          keeps: ["runs/<tenant>/<token>.json (minimal immutable run record)", "usage/<tenant>/<month>.jsonl (billing/audit usage log)", "audit/<tenant>/<month>.jsonl (audit log)"]
        },
        null,
        2
      ) + "\n",
      "utf8"
    )
  );
  files.set(
    "data_inventory.json",
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: "MagicLinkDataInventory.v1",
          generatedAt: nowIso(),
          tenantId,
          storage: {
            backend: "filesystem",
            dataDir,
            perRun: {
              bundleZip: {
                path: "zips/<token>.zip",
                contains: "Uploaded bundle bytes (ZIP)",
                retention: "optional (artifactStorage.storeBundleZip); deleted after retention window"
              },
              verifyOutput: { path: "verify/<token>.json", contains: "Hosted verifier output (VerifyCliOutput.v1)", retention: "deleted after retention window" },
              publicSummary: { path: "public/<token>.json", contains: "Redacted public summary (MagicLinkPublicSummary.v1)", retention: "deleted after retention window" },
              producerReceipt: { path: "receipt/<token>.json", contains: "Embedded producer receipt when present", retention: "deleted after retention window" },
              pdfSummary: {
                path: "pdf/<token>.pdf",
                contains: "Non-normative PDF summary (redacted)",
                retention: "optional (artifactStorage.storePdf); deleted after retention window"
              },
              decisionRequest: { path: "decisions/<token>.json", contains: "Decision input record (if used)", retention: "deleted after retention window" },
              decisionReports: { path: "settlement_decisions/<token>/", contains: "Signed decision reports (if used)", retention: "deleted after retention window" },
              closePackSurfaces: { path: "closepack/<token>/", contains: "ClosePack evaluation/index surfaces (if present)", retention: "deleted after retention window" },
              runRecord: {
                path: "runs/<tenant>/<token>.json",
                contains: "Minimal immutable metadata for support/accounting (MagicLinkRunRecord.v1)",
                retention: "retained beyond blob retention"
              }
            },
            exports: {
              auditPacketCache: {
                path: "exports/cache/audit_packet/<tenant>/<YYYY-MM>.zip",
                contains: "Optional cached monthly audit packet ZIPs (artifactStorage.precomputeMonthlyAuditPackets)",
                retention: "best-effort bounded by ops policy"
              },
              archiveExportMarkers: {
                path: "exports/archive_export/<tenant>/<YYYY-MM>.json",
                contains: "Archive export idempotency markers (success/failure; no secrets)",
                retention: "retained per ops policy"
              },
              dryRunOutbox: {
                path: "exports_outbox/<tenant>/<YYYY-MM>/",
                contains: "Dry-run local export outputs (operator testing)",
                retention: "retained per ops policy"
              }
            },
            webhooks: {
              attempts: { path: "webhooks/attempts/<token>_*.json", contains: "Webhook delivery attempts (no secrets)", retention: "deleted after retention window" },
              record: { path: "webhooks/record/<token>_*.json", contains: "Recorded webhook payloads (demo/record mode)", retention: "deleted after retention window" }
            },
            webhookRetry: {
              pending: {
                path: "webhook_retry/pending/*_<token>_*.json",
                contains: "Pending webhook retry jobs for failed deliveries",
                retention: "deleted after retention window for matching token; otherwise retried until success/dead-letter"
              },
              deadLetter: {
                path: "webhook_retry/dead-letter/*_<token>_*.json",
                contains: "Webhook retry jobs that exhausted attempts",
                retention: "deleted after retention window for matching token or when replayed"
              }
            },
            auditLog: { path: "audit/<tenant>/<YYYY-MM>.jsonl", contains: "Admin/audit events (settings, keys, logins, decisions)", retention: "retained per ops policy" },
            usage: { path: "usage/<tenant>/<YYYY-MM>.jsonl", contains: "Billing/accounting usage records", retention: "retained per ops policy" }
          },
          redaction: {
            allowlistPath: "redaction_allowlist.json",
            note:
              "Hosted UI/PDF/CSV/support exports are built from allowlisted, escaped, and truncated fields. Raw evidence file contents are not separately parsed/stored outside the uploaded bundle bytes."
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    )
  );

  const docFiles = [
    { rel: "docs/pilot-kit/security-qa.md", out: "pilot-kit/security-qa.md" },
    { rel: "docs/pilot-kit/security-summary.md", out: "pilot-kit/security-summary.md" },
    { rel: "docs/pilot-kit/architecture-one-pager.md", out: "pilot-kit/architecture-one-pager.md" },
    { rel: "docs/pilot-kit/procurement-one-pager.md", out: "pilot-kit/procurement-one-pager.md" },
    { rel: "docs/pilot-kit/rfp-clause.md", out: "pilot-kit/rfp-clause.md" },
    { rel: "docs/pilot-kit/offline-verify.md", out: "pilot-kit/offline-verify.md" }
  ];
  for (const d of docFiles) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await readRepoFileUtf8BestEffort(d.rel);
    if (!raw) continue;
    files.set(d.out, Buffer.from(raw, "utf8"));
    if (index?.packet?.includedDocs && Array.isArray(index.packet.includedDocs)) index.packet.includedDocs.push(d.out);
  }

  // Best-effort: include audit log for this month (settings + ingest key changes).
  const auditFp = path.join(dataDir, "audit", tenantId, `${month}.jsonl`);
  try {
    files.set("audit_log.jsonl", await fs.readFile(auditFp));
  } catch {
    // ignore
  }

  files.set("index.json", Buffer.from(JSON.stringify(index, null, 2) + "\n", "utf8"));

  // Packet index (checksummed inventory of files in this packet; excludes itself to avoid self-hashing).
  {
    const describe = (name) => {
      if (name === "index.json") return "Security & controls summary (budgets, trust, settings snapshot)";
      if (name === "packet_index.json") return "Packet file inventory (sha256 + sizes)";
      if (name === "checksums.sha256") return "sha256 checksums (sha256sum format; excludes itself)";
      if (name === "data_inventory.json") return "Data inventory manifest (what is stored, where, retention)";
      if (name === "retention_behavior.json") return "Retention deletion/kept artifacts summary";
      if (name === "redaction_allowlist.json") return "Redaction/render allowlist manifest";
      if (name === "redaction_sample_render_model.json") return "Sample redacted render model (non-customer)";
      if (name === "audit_log.jsonl") return "Audit log (best-effort, month-bounded)";
      if (name.startsWith("pilot-kit/")) return "Reference document (operations/security)";
      return "Packet file";
    };
    const entries = [];
    for (const [name, bytes] of [...files.entries()].sort((a, b) => cmpString(a[0], b[0]))) {
      if (name === "packet_index.json") continue;
      if (name === "checksums.sha256") continue;
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      entries.push({
        path: name,
        bytes: buf.length,
        sha256: sha256Hex(buf),
        description: describe(name)
      });
    }
    const packetIndex = {
      schemaVersion: "MagicLinkSecurityPacketIndex.v1",
      tenantId,
      month,
      generatedAt: nowIso(),
      service: { name: "settld-magic-link", version: serviceVersion ?? null, commit: serviceCommit ?? null },
      files: entries
    };
    files.set("packet_index.json", Buffer.from(JSON.stringify(packetIndex, null, 2) + "\n", "utf8"));
  }

  // sha256 checksums file (sha256sum format). Excludes itself.
  {
    const lines = [];
    for (const [name, bytes] of [...files.entries()].sort((a, b) => cmpString(a[0], b[0]))) {
      if (name === "checksums.sha256") continue;
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      lines.push(`${sha256Hex(buf)}  ${name}`);
    }
    files.set("checksums.sha256", Buffer.from(lines.join("\n") + "\n", "utf8"));
  }

  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  res.statusCode = 200;
  res.setHeader("content-type", "application/zip");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"security_controls_${tenantId}_${month}.zip\"`);
  res.end(Buffer.from(zip));
}

function sanitizeMetaForSupport(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const {
    zipPath: _zipPath,
    verifyJsonPath: _verifyJsonPath,
    metaPath: _metaPath,
    publicJsonPath: _publicJsonPath,
    receiptJsonPath: _receiptJsonPath,
    summaryPdfPath: _summaryPdfPath,
    decisionPath: _decisionPath,
    settlementDecisionsDir: _settlementDecisionsDir,
    closePackDir: _closePackDir,
    closePackSummaryPath: _closePackSummaryPath,
    ...rest
  } = meta;
  return rest;
}

function incTallies(tallies, codes) {
  const list = Array.isArray(codes) ? codes.map((c) => String(c ?? "").trim()).filter(Boolean) : [];
  for (const code of list) tallies[code] = Number(tallies[code] ?? 0) + 1;
}

async function readAuditExcerpt({ tenantId, fromMs, toMs, limitLines = 50_000 } = {}) {
  const outLines = [];
  const from = Number.isFinite(fromMs) ? fromMs : 0;
  const to = Number.isFinite(toMs) ? toMs : Date.now();
  const fromMonth = monthKeyFromIso(new Date(from).toISOString());
  const toMonth = monthKeyFromIso(new Date(to).toISOString());
  const months = [];
  if (fromMonth && toMonth) {
    const [fy, fm] = fromMonth.split("-").map((x) => Number.parseInt(x, 10));
    const [ty, tm] = toMonth.split("-").map((x) => Number.parseInt(x, 10));
    if (Number.isInteger(fy) && Number.isInteger(fm) && Number.isInteger(ty) && Number.isInteger(tm)) {
      let y = fy;
      let m = fm;
      while (y < ty || (y === ty && m <= tm)) {
        months.push(`${y}-${String(m).padStart(2, "0")}`);
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
  }
  if (!months.length) return "";

  for (const month of months) {
    const fp = path.join(dataDir, "audit", tenantId, `${month}.jsonl`);
    let raw = "";
    try {
      // eslint-disable-next-line no-await-in-loop
      raw = await fs.readFile(fp, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      if (outLines.length >= limitLines) break;
      try {
        const j = JSON.parse(line);
        const atMs = safeIsoToMs(j?.at);
        if (!Number.isFinite(atMs)) continue;
        if (atMs < from || atMs > to) continue;
        outLines.push(line);
      } catch {
        // ignore
      }
    }
    if (outLines.length >= limitLines) break;
  }
  return outLines.length ? outLines.join("\n") + "\n" : "";
}

async function handleTenantSupportBundleExport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  const toIso = url.searchParams.get("to") ? String(url.searchParams.get("to")).trim() : null;
  const fromIso = url.searchParams.get("from") ? String(url.searchParams.get("from")).trim() : null;
  const toMs = toIso ? safeIsoToMs(toIso) : Date.now();
  const fromMs = fromIso ? safeIsoToMs(fromIso) : toMs - 7 * 24 * 3600_000;
  if (toIso && !Number.isFinite(toMs)) return sendJson(res, 400, { ok: false, code: "INVALID_TO", message: "to must be an ISO date string" });
  if (fromIso && !Number.isFinite(fromMs)) return sendJson(res, 400, { ok: false, code: "INVALID_FROM", message: "from must be an ISO date string" });

  const includeBundles = url.searchParams.get("includeBundles") === "1";
  const limitRaw = url.searchParams.get("limit") ? String(url.searchParams.get("limit")).trim() : "";
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..2000" });

  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const runs = [];
  const files = new Map();
  const errorTallies = {};
  const warningTallies = {};
  const seenTokens = new Set();
  const runRecordScanLimit = Math.max(limit * 20, 5_000);
  const runRecords = await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max: runRecordScanLimit });

  const collectErrorsAndWarnings = async ({ rr, meta, pub }) => {
    let errors = [];
    let warnings = [];
    if (rr && typeof rr === "object" && !Array.isArray(rr)) {
      errors = Array.isArray(rr?.verification?.errorCodes) ? rr.verification.errorCodes.map((c) => ({ code: c })) : [];
      warnings = Array.isArray(rr?.verification?.warningCodes) ? rr.verification.warningCodes.map((c) => ({ code: c })) : [];
      return { errors, warnings };
    }
    if (meta && meta.verifyJsonPath) {
      let verifyJson = null;
      try {
        verifyJson = JSON.parse(await fs.readFile(meta.verifyJsonPath, "utf8"));
      } catch {
        verifyJson = null;
      }
      errors = Array.isArray(verifyJson?.errors) ? verifyJson.errors : [];
      warnings = Array.isArray(verifyJson?.warnings) ? verifyJson.warnings : [];
      return { errors, warnings };
    }
    if (pub?.verification) {
      errors = Array.isArray(pub.verification.errorCodes) ? pub.verification.errorCodes.map((c) => ({ code: c })) : [];
      warnings = Array.isArray(pub.verification.warningCodes) ? pub.verification.warningCodes.map((c) => ({ code: c })) : [];
    }
    return { errors, warnings };
  };

  const attachSupportFilesBestEffort = async ({ token, rr, meta }) => {
    const prefix = `runs/${token}/`;
    if (rr && typeof rr === "object" && !Array.isArray(rr)) {
      files.set(`${prefix}run_record.json`, Buffer.from(JSON.stringify(rr, null, 2) + "\n", "utf8"));
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
    files.set(`${prefix}meta.json`, Buffer.from(JSON.stringify(sanitizeMetaForSupport(meta), null, 2) + "\n", "utf8"));
    try {
      // eslint-disable-next-line no-await-in-loop
      files.set(`${prefix}verify.json`, await fs.readFile(meta.verifyJsonPath));
    } catch {
      // ignore
    }
    if (meta.publicJsonPath) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}public_summary.json`, await fs.readFile(meta.publicJsonPath));
      } catch {
        // ignore
      }
    }
    if (includeBundles) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`${prefix}bundle.zip`, await fs.readFile(meta.zipPath));
      } catch {
        // ignore
      }
    }
  };

  for (const rr of runRecords) {
    if (runs.length >= limit) break;
    const token = typeof rr?.token === "string" && /^ml_[0-9a-f]{48}$/.test(rr.token) ? rr.token : null;
    if (!token || seenTokens.has(token)) continue;

    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    if (meta && (meta.revokedAt || isExpired(meta.createdAt))) continue;

    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : typeof meta?.createdAt === "string" ? meta.createdAt : null;
    const createdAtMs = createdAt ? safeIsoToMs(createdAt) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;
    if (createdAtMs < fromMs || createdAtMs > toMs) continue;

    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null
        });
    const retained = createdAt ? isPastRetention(createdAt, retentionDays) : true;

    // eslint-disable-next-line no-await-in-loop
    const pub = meta ? await loadPublicSummaryForToken({ token, meta }) : null;
    const runRecordStatus = runStatusFromRunRecord(rr);
    const status = runRecordStatus === "processing" ? runStatusFrom({ meta, publicSummary: pub }) : runRecordStatus;

    // eslint-disable-next-line no-await-in-loop
    const { errors, warnings } = await collectErrorsAndWarnings({ rr, meta, pub });
    incTallies(errorTallies, errors.map((e) => e?.code));
    incTallies(warningTallies, warnings.map((w) => w?.code));

    const claim = rr?.invoiceClaim ?? pub?.invoiceClaim ?? null;
    runs.push({
      token,
      createdAt,
      zipSha256: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : typeof meta?.zipSha256 === "string" ? meta.zipSha256 : null,
      zipBytes: Number.isFinite(Number(rr?.zipBytes)) ? Number(rr.zipBytes) : Number.isFinite(Number(meta?.zipBytes)) ? Number(meta.zipBytes) : null,
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
      vendorName: typeof rr?.vendorName === "string" ? rr.vendorName : typeof meta?.vendorName === "string" ? meta.vendorName : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      status,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : typeof meta?.modeResolved === "string" ? meta.modeResolved : null,
      verifyOk: Boolean(rr?.verification?.verificationOk ?? meta?.verifyOk),
      durationMs: Number.isFinite(Number(rr?.durationMs)) ? Number(rr.durationMs) : Number.isFinite(Number(meta?.durationMs)) ? Number(meta.durationMs) : null,
      errorsCount: errors.length,
      warningsCount: warnings.length,
      retained
    });
    seenTokens.add(token);
    // eslint-disable-next-line no-await-in-loop
    await attachSupportFilesBestEffort({ token, rr, meta });
  }

  const entries = await listTenantIndexEntries({ tenantId });
  for (const ent of entries) {
    if (runs.length >= limit) break;
    const token = ent.token;
    if (seenTokens.has(token)) continue;

    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    // eslint-disable-next-line no-await-in-loop
    const rr = await readRunRecordBestEffort({ dataDir, tenantId, token });
    if (!meta && !rr) continue;
    if (meta && (meta.revokedAt || isExpired(meta.createdAt))) continue;

    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : typeof meta?.createdAt === "string" ? meta.createdAt : null;
    const createdAtMs = createdAt ? safeIsoToMs(createdAt) : NaN;
    if (!Number.isFinite(createdAtMs)) continue;
    if (createdAtMs < fromMs || createdAtMs > toMs) continue;

    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null
        });
    const retained = createdAt ? isPastRetention(createdAt, retentionDays) : true;

    // eslint-disable-next-line no-await-in-loop
    const pub = meta ? await loadPublicSummaryForToken({ token, meta }) : null;
    const runRecordStatus = rr ? runStatusFromRunRecord(rr) : "processing";
    const status = runRecordStatus === "processing" ? runStatusFrom({ meta, publicSummary: pub }) : runRecordStatus;

    // eslint-disable-next-line no-await-in-loop
    const { errors, warnings } = await collectErrorsAndWarnings({ rr, meta, pub });
    incTallies(errorTallies, errors.map((e) => e?.code));
    incTallies(warningTallies, warnings.map((w) => w?.code));

    const claim = rr?.invoiceClaim ?? pub?.invoiceClaim ?? null;
    runs.push({
      token,
      createdAt,
      zipSha256: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : typeof meta?.zipSha256 === "string" ? meta.zipSha256 : null,
      zipBytes: Number.isFinite(Number(rr?.zipBytes)) ? Number(rr.zipBytes) : Number.isFinite(Number(meta?.zipBytes)) ? Number(meta.zipBytes) : null,
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : typeof meta?.vendorId === "string" ? meta.vendorId : null,
      vendorName: typeof rr?.vendorName === "string" ? rr.vendorName : typeof meta?.vendorName === "string" ? meta.vendorName : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : typeof meta?.contractId === "string" ? meta.contractId : null,
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : null,
      currency: typeof claim?.currency === "string" ? claim.currency : null,
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      status,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : typeof meta?.modeResolved === "string" ? meta.modeResolved : null,
      verifyOk: Boolean(rr?.verification?.verificationOk ?? meta?.verifyOk),
      durationMs: Number.isFinite(Number(rr?.durationMs)) ? Number(rr.durationMs) : Number.isFinite(Number(meta?.durationMs)) ? Number(meta.durationMs) : null,
      errorsCount: errors.length,
      warningsCount: warnings.length,
      retained
    });
    seenTokens.add(token);
    // eslint-disable-next-line no-await-in-loop
    await attachSupportFilesBestEffort({ token, rr, meta });
  }

  runs.sort((a, b) => cmpString(a.createdAt ?? "", b.createdAt ?? "") || cmpString(a.token, b.token));

  const auditExcerpt = await readAuditExcerpt({ tenantId, fromMs, toMs });
  if (auditExcerpt) files.set("audit_log_excerpt.jsonl", Buffer.from(auditExcerpt, "utf8"));

  const safeSettings = sanitizeTenantSettingsForApi(tenantSettings);
  files.set("tenant_settings_redacted.json", Buffer.from(JSON.stringify(safeSettings, null, 2) + "\n", "utf8"));

  const tallies = { schemaVersion: "MagicLinkSupportBundleTallies.v1", generatedAt: nowIso(), errors: errorTallies, warnings: warningTallies };
  files.set("tallies.json", Buffer.from(JSON.stringify(tallies, null, 2) + "\n", "utf8"));

  const index = {
    schemaVersion: "MagicLinkSupportBundle.v1",
    tenantId,
    generatedAt: nowIso(),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    includeBundles,
    runsCount: runs.length,
    runs
  };
  files.set("index.json", Buffer.from(JSON.stringify(index, null, 2) + "\n", "utf8"));

  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  res.statusCode = 200;
  res.setHeader("content-type", "application/zip");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"support_bundle_${tenantId}_${monthKeyUtcNow()}.zip\"`);
  res.end(Buffer.from(zip));
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replaceAll("\"", "\"\"")}"`;
}

async function buildTenantCsvExportText({ tenantId, month }) {
  const rows = [];
  const seenTokens = new Set();
  const runRecords = await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max: 200_000 });

  for (const rr of runRecords) {
    const token = typeof rr?.token === "string" && /^ml_[0-9a-f]{48}$/.test(rr.token) ? rr.token : null;
    if (!token || seenTokens.has(token)) continue;

    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : null;
    if (!createdAt || isExpired(createdAt)) continue;
    if (monthKeyFromIso(createdAt) !== month) continue;

    const status = runStatusFromRunRecord(rr);
    const claim = rr?.invoiceClaim ?? null;
    const pricingSigs = rr?.pricingMatrixSignatures ?? null;
    const pricingTermsSigned = Boolean(pricingSigs && typeof pricingSigs === "object" && !Array.isArray(pricingSigs) && pricingSigs.present && Array.isArray(pricingSigs.signerKeyIds) && pricingSigs.signerKeyIds.length > 0);
    const errorCodes = Array.isArray(rr?.verification?.errorCodes) ? rr.verification.errorCodes.map(String).filter(Boolean) : [];
    const warningCodes = Array.isArray(rr?.verification?.warningCodes) ? rr.verification.warningCodes.map(String).filter(Boolean) : [];
    const base = publicBaseUrl ? String(publicBaseUrl).replace(/\/+$/, "") : "";
    const magicLinkUrl = base ? `${base}/r/${token}` : `/r/${token}`;

    const decisionSummary = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;
    const decidedBy = typeof decisionSummary?.decidedByEmail === "string" ? decisionSummary.decidedByEmail : "";
    const decidedAt = typeof decisionSummary?.decidedAt === "string" ? decisionSummary.decidedAt : "";
    const decision = typeof decisionSummary?.decision === "string" ? decisionSummary.decision : "";

    rows.push({
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : "",
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : "",
      contractId: typeof rr?.contractId === "string" ? rr.contractId : "",
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : "",
      currency: typeof claim?.currency === "string" ? claim.currency : "",
      pricingTermsSigned: pricingTermsSigned ? "true" : "false",
      status,
      modeResolved: typeof rr?.modeResolved === "string" ? rr.modeResolved : "",
      decision,
      decidedAt,
      decidedBy,
      topWarningCodes: warningCodes.slice(0, 5).join(";"),
      topErrorCodes: errorCodes.slice(0, 5).join(";"),
      magicLinkUrl,
      bundleHash: typeof rr?.zipSha256 === "string" ? rr.zipSha256 : "",
      createdAt
    });
    seenTokens.add(token);
  }

  // Back-compat: include legacy runs that predate run records.
  const entries = await listTenantIndexEntries({ tenantId });
  for (const ent of entries) {
    const token = ent.token;
    if (seenTokens.has(token)) continue;

    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    if (meta && (meta.revokedAt || isExpired(meta.createdAt))) continue;

    const createdAt = typeof meta?.createdAt === "string" ? meta.createdAt : null;
    if (!createdAt) continue;
    if (monthKeyFromIso(createdAt) !== month) continue;

    // eslint-disable-next-line no-await-in-loop
    const pub = meta ? await loadPublicSummaryForToken({ token, meta }) : null;
    // eslint-disable-next-line no-await-in-loop
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });

    const status = runStatusFrom({ meta, publicSummary: pub });
    const claim = pub?.invoiceClaim ?? null;
    const pricingSigs = pub?.pricingMatrixSignatures ?? null;
    const pricingTermsSigned = Boolean(pricingSigs && typeof pricingSigs === "object" && !Array.isArray(pricingSigs) && pricingSigs.present && Array.isArray(pricingSigs.signerKeyIds) && pricingSigs.signerKeyIds.length > 0);
    const errorCodes = Array.isArray(pub?.verification?.errorCodes) ? pub.verification.errorCodes.map(String).filter(Boolean) : [];
    const warningCodes = Array.isArray(pub?.verification?.warningCodes) ? pub.verification.warningCodes.map(String).filter(Boolean) : [];
    const base = publicBaseUrl ? String(publicBaseUrl).replace(/\/+$/, "") : "";
    const magicLinkUrl = base ? `${base}/r/${token}` : `/r/${token}`;
    const decidedBy = typeof decisionReport?.actor?.email === "string" ? decisionReport.actor.email : "";
    const decidedAt = decisionReport && typeof decisionReport.decidedAt === "string" ? decisionReport.decidedAt : "";
    const decision = decisionReport && typeof decisionReport.decision === "string" ? decisionReport.decision : "";

    rows.push({
      invoiceId: typeof claim?.invoiceId === "string" ? claim.invoiceId : "",
      vendorId: typeof meta?.vendorId === "string" ? meta.vendorId : "",
      contractId: typeof meta?.contractId === "string" ? meta.contractId : "",
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : "",
      currency: typeof claim?.currency === "string" ? claim.currency : "",
      pricingTermsSigned: pricingTermsSigned ? "true" : "false",
      status,
      modeResolved: typeof meta?.modeResolved === "string" ? meta.modeResolved : "",
      decision,
      decidedAt,
      decidedBy,
      topWarningCodes: warningCodes.slice(0, 5).join(";"),
      topErrorCodes: errorCodes.slice(0, 5).join(";"),
      magicLinkUrl,
      bundleHash: typeof meta?.zipSha256 === "string" ? meta.zipSha256 : "",
      createdAt
    });
    seenTokens.add(token);
  }

  rows.sort((a, b) => cmpString(a.createdAt, b.createdAt) || cmpString(a.bundleHash, b.bundleHash));

  const header = [
    "invoiceId",
    "vendorId",
    "contractId",
    "totalCents",
    "currency",
    "pricing_terms_signed",
    "status",
    "mode",
    "decision",
    "decidedAt",
    "decidedBy",
    "topWarningCodes",
    "topErrorCodes",
    "magicLinkUrl",
    "bundleHash",
    "createdAt"
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.invoiceId,
        r.vendorId,
        r.contractId,
        r.totalCents,
        r.currency,
        r.pricingTermsSigned,
        r.status,
        r.modeResolved,
        r.decision,
        r.decidedAt,
        r.decidedBy,
        r.topWarningCodes,
        r.topErrorCodes,
        r.magicLinkUrl,
        r.bundleHash,
        r.createdAt
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

async function handleTenantCsvExport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;

  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const csv = await buildTenantCsvExportText({ tenantId, month });

  res.statusCode = 200;
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"export_${tenantId}_${month}.csv\"`);
  res.end(csv);
}

function medianMs(values) {
  const nums = values.filter((x) => Number.isFinite(Number(x))).map((x) => Number(x)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function pct(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return round2((p / t) * 100);
}

function analyticsBucketStartMs(ms, bucket) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (bucket === "month") return Date.UTC(y, m, 1);
  if (bucket === "week") {
    const weekday = d.getUTCDay();
    const delta = weekday === 0 ? 6 : weekday - 1;
    return Date.UTC(y, m, day - delta);
  }
  return Date.UTC(y, m, day);
}

function analyticsBucketLabel(ms, bucket) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (bucket === "month") return `${y}-${m}`;
  if (bucket === "week") return `week_of_${y}-${m}-${day}`;
  return `${y}-${m}-${day}`;
}

function addMoneyToByCurrency(target, currency, cents, field) {
  const cur = String(currency ?? "").trim() || "UNK";
  const raw = String(cents ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) return;
  if (!target[cur]) target[cur] = { processedCents: "0", heldCents: "0" };
  const prev = BigInt(target[cur][field] ?? "0");
  target[cur][field] = String(prev + BigInt(raw));
}

function addCodeCounts(counter, codes, maxCodesPerRow = 5) {
  const list = Array.isArray(codes) ? codes : [];
  for (const code of list.slice(0, maxCodesPerRow)) {
    const c = String(code ?? "").trim();
    if (!c) continue;
    counter.set(c, Number(counter.get(c) ?? 0) + 1);
  }
}

function createAnalyticsAggregate(id) {
  return {
    id,
    runs: 0,
    green: 0,
    amber: 0,
    red: 0,
    processing: 0,
    approved: 0,
    held: 0,
    decided: 0,
    verificationDurationsMs: [],
    approvalDurationsMs: [],
    moneyByCurrency: {}
  };
}

function updateAnalyticsAggregate(agg, row) {
  agg.runs += 1;
  if (row.status === "green") agg.green += 1;
  else if (row.status === "amber") agg.amber += 1;
  else if (row.status === "red") agg.red += 1;
  else agg.processing += 1;

  if (row.decision === "approve") agg.approved += 1;
  if (row.decision === "hold") agg.held += 1;
  if (row.decision) agg.decided += 1;
  if (Number.isFinite(Number(row.durationMs))) agg.verificationDurationsMs.push(Number(row.durationMs));
  if (Number.isFinite(Number(row.approvalDurationMs))) agg.approvalDurationsMs.push(Number(row.approvalDurationMs));

  addMoneyToByCurrency(agg.moneyByCurrency, row.currency, row.totalCents, "processedCents");
  if (row.status === "red" || row.decision === "hold") addMoneyToByCurrency(agg.moneyByCurrency, row.currency, row.totalCents, "heldCents");
}

function finalizeAnalyticsAggregate(agg, labelKey) {
  const denominator = Math.max(1, agg.runs);
  return {
    [labelKey]: agg.id,
    runs: agg.runs,
    green: agg.green,
    amber: agg.amber,
    red: agg.red,
    processing: agg.processing,
    decided: agg.decided,
    approved: agg.approved,
    held: agg.held,
    greenRatePct: pct(agg.green, denominator),
    approvalRatePct: pct(agg.approved, denominator),
    holdRatePct: pct(agg.held, denominator),
    verificationDurationMedianMs: medianMs(agg.verificationDurationsMs),
    approvalDurationMedianMs: medianMs(agg.approvalDurationsMs),
    moneyByCurrency: agg.moneyByCurrency
  };
}

async function listTenantAnalyticsRowsBestEffort({ tenantId, month, tenantSettings, max = 200_000 } = {}) {
  const rows = [];
  const seenTokens = new Set();
  const runRecords = await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max });

  for (const rr of runRecords) {
    const token = typeof rr?.token === "string" && /^ml_[0-9a-f]{48}$/.test(rr.token) ? rr.token : null;
    if (!token || seenTokens.has(token)) continue;
    const createdAt = typeof rr?.createdAt === "string" ? rr.createdAt : null;
    if (!createdAt || isExpired(createdAt)) continue;
    if (monthKeyFromIso(createdAt) !== month) continue;
    const retentionDays = Number.isInteger(rr?.retentionDaysEffective)
      ? rr.retentionDaysEffective
      : effectiveRetentionDaysForRun({
          tenantSettings,
          vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : null,
          contractId: typeof rr?.contractId === "string" ? rr.contractId : null
        });
    if (isPastRetention(createdAt, retentionDays)) continue;

    const decisionSummary = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;
    const decidedAt = typeof decisionSummary?.decidedAt === "string" ? decisionSummary.decidedAt : null;
    const createdAtMs = safeIsoToMs(createdAt);
    const decidedAtMs = safeIsoToMs(decidedAt);
    const approvalDurationMs = Number.isFinite(createdAtMs) && Number.isFinite(decidedAtMs) && decidedAtMs >= createdAtMs ? decidedAtMs - createdAtMs : null;

    const claim = rr?.invoiceClaim && typeof rr.invoiceClaim === "object" && !Array.isArray(rr.invoiceClaim) ? rr.invoiceClaim : null;
    rows.push({
      token,
      createdAt,
      status: runStatusFromRunRecord(rr),
      vendorId: typeof rr?.vendorId === "string" ? rr.vendorId : null,
      contractId: typeof rr?.contractId === "string" ? rr.contractId : null,
      durationMs: Number.isFinite(Number(rr?.durationMs)) ? Number(rr.durationMs) : null,
      decision: typeof decisionSummary?.decision === "string" ? decisionSummary.decision : null,
      approvalDurationMs,
      currency: typeof claim?.currency === "string" ? claim.currency : "UNK",
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      warningCodes: Array.isArray(rr?.verification?.warningCodes) ? rr.verification.warningCodes.map(String).filter(Boolean) : [],
      errorCodes: Array.isArray(rr?.verification?.errorCodes) ? rr.verification.errorCodes.map(String).filter(Boolean) : []
    });
    seenTokens.add(token);
  }

  const entries = await listTenantIndexEntries({ tenantId, max });
  for (const ent of entries) {
    const token = ent.token;
    if (!token || seenTokens.has(token)) continue;
    let meta = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      meta = await loadMeta(token);
    } catch {
      meta = null;
    }
    if (!meta || meta.revokedAt || isExpired(meta.createdAt)) continue;
    if (monthKeyFromIso(meta.createdAt) !== month) continue;

    const retentionDays = effectiveRetentionDaysForRun({
      tenantSettings,
      vendorId: typeof meta?.vendorId === "string" ? meta.vendorId : null,
      contractId: typeof meta?.contractId === "string" ? meta.contractId : null
    });
    if (isPastRetention(meta.createdAt, retentionDays)) continue;

    // eslint-disable-next-line no-await-in-loop
    const pub = await loadPublicSummaryForToken({ token, meta });
    // eslint-disable-next-line no-await-in-loop
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
    const claim = pub?.invoiceClaim && typeof pub.invoiceClaim === "object" && !Array.isArray(pub.invoiceClaim) ? pub.invoiceClaim : null;
    const createdAtMs = safeIsoToMs(meta.createdAt);
    const decidedAt = decisionReport && typeof decisionReport.decidedAt === "string" ? decisionReport.decidedAt : null;
    const decidedAtMs = safeIsoToMs(decidedAt);
    const approvalDurationMs = Number.isFinite(createdAtMs) && Number.isFinite(decidedAtMs) && decidedAtMs >= createdAtMs ? decidedAtMs - createdAtMs : null;

    rows.push({
      token,
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
      status: runStatusFrom({ meta, publicSummary: pub }),
      vendorId: typeof meta?.vendorId === "string" ? meta.vendorId : null,
      contractId: typeof meta?.contractId === "string" ? meta.contractId : null,
      durationMs: Number.isFinite(Number(meta?.durationMs)) ? Number(meta.durationMs) : null,
      decision: decisionReport && typeof decisionReport.decision === "string" ? decisionReport.decision : null,
      approvalDurationMs,
      currency: typeof claim?.currency === "string" ? claim.currency : "UNK",
      totalCents: typeof claim?.totalCents === "string" ? claim.totalCents : null,
      warningCodes: Array.isArray(pub?.verification?.warningCodes) ? pub.verification.warningCodes.map(String).filter(Boolean) : [],
      errorCodes: Array.isArray(pub?.verification?.errorCodes) ? pub.verification.errorCodes.map(String).filter(Boolean) : []
    });
    seenTokens.add(token);
  }

  return rows;
}

async function buildTenantAnalyticsReport({ tenantId, month, bucket = "day", limit = 20 }) {
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const rows = await listTenantAnalyticsRowsBestEffort({ tenantId, month, tenantSettings, max: 200_000 });
  const totals = createAnalyticsAggregate("totals");
  const byVendor = new Map();
  const byContract = new Map();
  const errorCounts = new Map();
  const warningCounts = new Map();
  const trend = new Map();

  for (const row of rows) {
    updateAnalyticsAggregate(totals, row);
    addCodeCounts(errorCounts, row.errorCodes);
    addCodeCounts(warningCounts, row.warningCodes);

    const vendorKey = row.vendorId ? String(row.vendorId) : "unknown_vendor";
    if (!byVendor.has(vendorKey)) byVendor.set(vendorKey, createAnalyticsAggregate(vendorKey));
    updateAnalyticsAggregate(byVendor.get(vendorKey), row);

    const contractKey = row.contractId ? String(row.contractId) : "unknown_contract";
    if (!byContract.has(contractKey)) byContract.set(contractKey, createAnalyticsAggregate(contractKey));
    updateAnalyticsAggregate(byContract.get(contractKey), row);

    const createdAtMs = safeIsoToMs(row.createdAt);
    if (Number.isFinite(createdAtMs)) {
      const startMs = analyticsBucketStartMs(createdAtMs, bucket);
      const key = `${startMs}`;
      if (!trend.has(key)) {
        trend.set(key, {
          bucketStart: new Date(startMs).toISOString(),
          bucketLabel: analyticsBucketLabel(startMs, bucket),
          runs: 0,
          green: 0,
          amber: 0,
          red: 0,
          processing: 0,
          approved: 0,
          held: 0
        });
      }
      const entry = trend.get(key);
      entry.runs += 1;
      if (row.status === "green") entry.green += 1;
      else if (row.status === "amber") entry.amber += 1;
      else if (row.status === "red") entry.red += 1;
      else entry.processing += 1;
      if (row.decision === "approve") entry.approved += 1;
      if (row.decision === "hold") entry.held += 1;
    }
  }

  const byVendorRows = [...byVendor.values()]
    .map((agg) => finalizeAnalyticsAggregate(agg, "vendorId"))
    .sort((a, b) => b.runs - a.runs || cmpString(a.vendorId, b.vendorId))
    .slice(0, limit);
  const byContractRows = [...byContract.values()]
    .map((agg) => finalizeAnalyticsAggregate(agg, "contractId"))
    .sort((a, b) => b.runs - a.runs || cmpString(a.contractId, b.contractId))
    .slice(0, limit);
  const trendRows = [...trend.values()]
    .sort((a, b) => cmpString(a.bucketStart, b.bucketStart))
    .map((entry) => ({
      ...entry,
      greenRatePct: pct(entry.green, Math.max(1, entry.runs)),
      approvalRatePct: pct(entry.approved, Math.max(1, entry.runs))
    }));

  const topErrorCodes = [...errorCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || cmpString(a.code, b.code))
    .slice(0, 20);
  const topWarningCodes = [...warningCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || cmpString(a.code, b.code))
    .slice(0, 20);

  const totalsRow = finalizeAnalyticsAggregate(totals, "group");
  return {
    schemaVersion: "MagicLinkAnalyticsReport.v1",
    tenantId,
    month,
    bucket,
    generatedAt: nowIso(),
    totals: {
      runs: totalsRow.runs,
      green: totalsRow.green,
      amber: totalsRow.amber,
      red: totalsRow.red,
      processing: totalsRow.processing,
      decided: totalsRow.decided,
      approved: totalsRow.approved,
      held: totalsRow.held,
      greenRatePct: totalsRow.greenRatePct,
      approvalRatePct: totalsRow.approvalRatePct,
      holdRatePct: totalsRow.holdRatePct,
      verificationDurationMedianMs: totalsRow.verificationDurationMedianMs,
      approvalDurationMedianMs: totalsRow.approvalDurationMedianMs
    },
    moneyByCurrency: totalsRow.moneyByCurrency,
    topErrorCodes,
    topWarningCodes,
    byVendor: byVendorRows,
    byContract: byContractRows,
    trends: trendRows
  };
}

function trustConfidenceFromRuns(runs) {
  const n = Number(runs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const normalized = Math.log10(Math.min(1000, n) + 1) / Math.log10(1000 + 1);
  return round2(Math.max(0, Math.min(1, normalized)));
}

function trustScoreFromAggregate({ runs, green, red, approved, held } = {}) {
  const total = Math.max(1, Number(runs ?? 0));
  const greenRate = Number(green ?? 0) / total;
  const redRate = Number(red ?? 0) / total;
  const approvalRate = Number(approved ?? 0) / total;
  const holdRate = Number(held ?? 0) / total;
  const quality = 0.55 * greenRate + 0.2 * approvalRate + 0.15 * (1 - redRate) + 0.1 * (1 - holdRate);
  const confidence = trustConfidenceFromRuns(total);
  const blended = quality * confidence + 0.5 * (1 - confidence);
  return round2(Math.max(0, Math.min(1, blended)) * 100);
}

function trustTierFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "unknown";
  if (n >= 85) return "high";
  if (n >= 65) return "medium";
  return "low";
}

function createTrustAggregate() {
  return {
    runs: 0,
    green: 0,
    amber: 0,
    red: 0,
    approved: 0,
    held: 0,
    moneyByCurrency: {},
    lastRunAt: null
  };
}

function updateTrustAggregate(agg, row) {
  agg.runs += 1;
  if (row.status === "green") agg.green += 1;
  else if (row.status === "amber") agg.amber += 1;
  else if (row.status === "red") agg.red += 1;
  if (row.decision === "approve") agg.approved += 1;
  if (row.decision === "hold") agg.held += 1;
  addMoneyToByCurrency(agg.moneyByCurrency, row.currency, row.totalCents, "processedCents");
  if (row.status === "red" || row.decision === "hold") addMoneyToByCurrency(agg.moneyByCurrency, row.currency, row.totalCents, "heldCents");
  const createdAtMs = safeIsoToMs(row.createdAt);
  if (Number.isFinite(createdAtMs)) {
    const currentMs = safeIsoToMs(agg.lastRunAt);
    if (!Number.isFinite(currentMs) || createdAtMs > currentMs) agg.lastRunAt = new Date(createdAtMs).toISOString();
  }
}

function finalizeTrustAggregate(agg) {
  const runs = Number(agg?.runs ?? 0);
  const score = trustScoreFromAggregate(agg);
  const confidence = trustConfidenceFromRuns(runs);
  return {
    runs,
    green: Number(agg?.green ?? 0),
    amber: Number(agg?.amber ?? 0),
    red: Number(agg?.red ?? 0),
    approved: Number(agg?.approved ?? 0),
    held: Number(agg?.held ?? 0),
    greenRatePct: pct(agg?.green ?? 0, Math.max(1, runs)),
    approvalRatePct: pct(agg?.approved ?? 0, Math.max(1, runs)),
    holdRatePct: pct(agg?.held ?? 0, Math.max(1, runs)),
    score,
    confidence,
    tier: trustTierFromScore(score),
    lastRunAt: agg?.lastRunAt ?? null,
    moneyByCurrency: agg?.moneyByCurrency ?? {}
  };
}

async function buildTenantTrustGraph({ tenantId, month, minRuns = 1, maxEdges = 200 }) {
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const rows = await listTenantAnalyticsRowsBestEffort({ tenantId, month, tenantSettings, max: 200_000 });
  const vendorAgg = new Map();
  const contractAgg = new Map();
  const pairAgg = new Map();

  for (const row of rows) {
    const vendorId = typeof row?.vendorId === "string" && row.vendorId.trim() ? row.vendorId.trim() : null;
    const contractId = typeof row?.contractId === "string" && row.contractId.trim() ? row.contractId.trim() : null;
    if (!vendorId) continue;

    if (!vendorAgg.has(vendorId)) vendorAgg.set(vendorId, createTrustAggregate());
    updateTrustAggregate(vendorAgg.get(vendorId), row);

    if (!contractId) continue;
    if (!contractAgg.has(contractId)) contractAgg.set(contractId, createTrustAggregate());
    updateTrustAggregate(contractAgg.get(contractId), row);

    const key = `${vendorId}\u0000${contractId}`;
    if (!pairAgg.has(key)) pairAgg.set(key, createTrustAggregate());
    updateTrustAggregate(pairAgg.get(key), row);
  }

  const vendorContractEdges = [...pairAgg.entries()]
    .map(([key, agg]) => {
      const [vendorId, contractId] = key.split("\u0000");
      const metrics = finalizeTrustAggregate(agg);
      return {
        id: `vendor:${vendorId}->contract:${contractId}`,
        source: `vendor:${vendorId}`,
        target: `contract:${contractId}`,
        kind: "vendor_contract",
        vendorId,
        contractId,
        ...metrics
      };
    })
    .filter((edge) => edge.runs >= minRuns)
    .sort((a, b) => b.runs - a.runs || b.score - a.score || cmpString(a.id, b.id))
    .slice(0, maxEdges);

  const vendorIdsInGraph = new Set(vendorContractEdges.map((edge) => edge.vendorId));
  const contractIdsInGraph = new Set(vendorContractEdges.map((edge) => edge.contractId));

  if (!vendorIdsInGraph.size) {
    const topVendors = [...vendorAgg.entries()]
      .map(([vendorId, agg]) => ({ vendorId, ...finalizeTrustAggregate(agg) }))
      .filter((row) => row.runs >= minRuns)
      .sort((a, b) => b.runs - a.runs || b.score - a.score || cmpString(a.vendorId, b.vendorId))
      .slice(0, maxEdges);
    for (const row of topVendors) vendorIdsInGraph.add(row.vendorId);
  }

  const buyerVendorEdges = [...vendorIdsInGraph]
    .map((vendorId) => {
      const agg = vendorAgg.get(vendorId);
      if (!agg) return null;
      const metrics = finalizeTrustAggregate(agg);
      return {
        id: `buyer:${tenantId}->vendor:${vendorId}`,
        source: `buyer:${tenantId}`,
        target: `vendor:${vendorId}`,
        kind: "buyer_vendor",
        vendorId,
        ...metrics
      };
    })
    .filter((row) => row && row.runs >= minRuns)
    .sort((a, b) => b.runs - a.runs || b.score - a.score || cmpString(a.id, b.id))
    .slice(0, maxEdges);

  const nodes = [];
  const tenantScoreSource = buyerVendorEdges.length
    ? round2(buyerVendorEdges.reduce((sum, edge) => sum + Number(edge.score ?? 0), 0) / buyerVendorEdges.length)
    : 50;
  nodes.push({
    id: `buyer:${tenantId}`,
    type: "buyer",
    label: tenantId,
    runs: buyerVendorEdges.reduce((sum, edge) => sum + Number(edge.runs ?? 0), 0),
    score: tenantScoreSource,
    tier: trustTierFromScore(tenantScoreSource)
  });

  for (const vendorId of [...vendorIdsInGraph].sort(cmpString)) {
    const agg = vendorAgg.get(vendorId);
    if (!agg) continue;
    const metrics = finalizeTrustAggregate(agg);
    nodes.push({
      id: `vendor:${vendorId}`,
      type: "vendor",
      label: vendorId,
      runs: metrics.runs,
      score: metrics.score,
      confidence: metrics.confidence,
      tier: metrics.tier
    });
  }

  for (const contractId of [...contractIdsInGraph].sort(cmpString)) {
    const agg = contractAgg.get(contractId);
    if (!agg) continue;
    const metrics = finalizeTrustAggregate(agg);
    nodes.push({
      id: `contract:${contractId}`,
      type: "contract",
      label: contractId,
      runs: metrics.runs,
      score: metrics.score,
      confidence: metrics.confidence,
      tier: metrics.tier
    });
  }

  const edges = [...buyerVendorEdges, ...vendorContractEdges].map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    runs: edge.runs,
    greenRatePct: edge.greenRatePct,
    approvalRatePct: edge.approvalRatePct,
    holdRatePct: edge.holdRatePct,
    score: edge.score,
    confidence: edge.confidence,
    tier: edge.tier,
    lastRunAt: edge.lastRunAt,
    moneyByCurrency: edge.moneyByCurrency
  }));

  return {
    schemaVersion: "MagicLinkTrustGraph.v1",
    tenantId,
    month,
    generatedAt: nowIso(),
    summary: {
      runs: rows.length,
      vendorNodes: nodes.filter((n) => n.type === "vendor").length,
      contractNodes: nodes.filter((n) => n.type === "contract").length,
      edges: edges.length
    },
    nodes,
    edges
  };
}

function trustGraphSnapshotPath({ tenantId, month }) {
  return path.join(dataDir, "trust_graph", "snapshots", String(tenantId ?? "default"), `${String(month ?? "")}.json`);
}

async function writeTrustGraphSnapshot({ tenantId, month, graph, source = "manual" } = {}) {
  const fp = trustGraphSnapshotPath({ tenantId, month });
  const snapshot = {
    schemaVersion: "MagicLinkTrustGraphSnapshot.v1",
    tenantId,
    month,
    generatedAt: nowIso(),
    source,
    graph
  };
  await ensureDir(fp);
  await fs.writeFile(fp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  return snapshot;
}

async function readTrustGraphSnapshotBestEffort({ tenantId, month } = {}) {
  const fp = trustGraphSnapshotPath({ tenantId, month });
  try {
    const raw = JSON.parse(await fs.readFile(fp, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.graph && typeof raw.graph === "object" && !Array.isArray(raw.graph)) return raw;
    if (raw.schemaVersion === "MagicLinkTrustGraph.v1") {
      return {
        schemaVersion: "MagicLinkTrustGraphSnapshot.v1",
        tenantId,
        month,
        generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : nowIso(),
        source: "legacy",
        graph: raw
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function listTrustGraphSnapshotsBestEffort({ tenantId, limit = 100 } = {}) {
  const dir = path.join(dataDir, "trust_graph", "snapshots", String(tenantId ?? "default"));
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  const months = names
    .filter((name) => /^[0-9]{4}-[0-9]{2}\.json$/.test(name))
    .map((name) => name.slice(0, -".json".length))
    .sort((a, b) => cmpString(b, a))
    .slice(0, Math.max(1, Math.min(500, Number.parseInt(String(limit ?? "100"), 10) || 100)));

  const rows = [];
  for (const month of months) {
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await readTrustGraphSnapshotBestEffort({ tenantId, month });
    if (!snapshot) continue;
    const graph = snapshot.graph && typeof snapshot.graph === "object" && !Array.isArray(snapshot.graph) ? snapshot.graph : null;
    rows.push({
      month,
      generatedAt: typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : null,
      source: typeof snapshot.source === "string" ? snapshot.source : null,
      nodes: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
      edges: Array.isArray(graph?.edges) ? graph.edges.length : 0,
      runs: Number.isFinite(Number(graph?.summary?.runs)) ? Number(graph.summary.runs) : 0
    });
  }
  return rows;
}

function trustDiffEntry({ id, before, after } = {}) {
  const beforeScore = Number.isFinite(Number(before?.score)) ? Number(before.score) : null;
  const afterScore = Number.isFinite(Number(after?.score)) ? Number(after.score) : null;
  const beforeRuns = Number.isFinite(Number(before?.runs)) ? Number(before.runs) : 0;
  const afterRuns = Number.isFinite(Number(after?.runs)) ? Number(after.runs) : 0;
  const status = before && after ? (beforeScore !== afterScore || beforeRuns !== afterRuns ? "changed" : "unchanged") : before ? "removed" : "added";
  return {
    id,
    status,
    beforeScore,
    afterScore,
    deltaScore: beforeScore === null || afterScore === null ? null : round2(afterScore - beforeScore),
    beforeRuns,
    afterRuns,
    deltaRuns: afterRuns - beforeRuns
  };
}

function buildTrustGraphDiff({ baseGraph, compareGraph, limit = 50, includeUnchanged = false } = {}) {
  const baseNodes = Array.isArray(baseGraph?.nodes) ? baseGraph.nodes : [];
  const compareNodes = Array.isArray(compareGraph?.nodes) ? compareGraph.nodes : [];
  const baseEdges = Array.isArray(baseGraph?.edges) ? baseGraph.edges : [];
  const compareEdges = Array.isArray(compareGraph?.edges) ? compareGraph.edges : [];

  const baseNodeMap = new Map(baseNodes.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => id));
  const compareNodeMap = new Map(compareNodes.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => id));
  const baseEdgeMap = new Map(baseEdges.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => id));
  const compareEdgeMap = new Map(compareEdges.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => id));

  const nodeIds = new Set([...baseNodeMap.keys(), ...compareNodeMap.keys()]);
  const edgeIds = new Set([...baseEdgeMap.keys(), ...compareEdgeMap.keys()]);
  const nodeChanges = [];
  const edgeChanges = [];

  for (const id of nodeIds) {
    const before = baseNodeMap.get(id) ?? null;
    const after = compareNodeMap.get(id) ?? null;
    const entry = trustDiffEntry({ id, before, after });
    if (!includeUnchanged && entry.status === "unchanged") continue;
    const type = after?.type ?? before?.type ?? null;
    nodeChanges.push({ ...entry, type });
  }
  for (const id of edgeIds) {
    const before = baseEdgeMap.get(id) ?? null;
    const after = compareEdgeMap.get(id) ?? null;
    const entry = trustDiffEntry({ id, before, after });
    if (!includeUnchanged && entry.status === "unchanged") continue;
    const kind = after?.kind ?? before?.kind ?? null;
    const source = after?.source ?? before?.source ?? null;
    const target = after?.target ?? before?.target ?? null;
    edgeChanges.push({ ...entry, kind, source, target });
  }

  const sorter = (a, b) => {
    const deltaScoreA = Number.isFinite(Number(a.deltaScore)) ? Math.abs(Number(a.deltaScore)) : -1;
    const deltaScoreB = Number.isFinite(Number(b.deltaScore)) ? Math.abs(Number(b.deltaScore)) : -1;
    if (deltaScoreB !== deltaScoreA) return deltaScoreB - deltaScoreA;
    const deltaRunsA = Math.abs(Number(a.deltaRuns ?? 0));
    const deltaRunsB = Math.abs(Number(b.deltaRuns ?? 0));
    if (deltaRunsB !== deltaRunsA) return deltaRunsB - deltaRunsA;
    return cmpString(String(a.id ?? ""), String(b.id ?? ""));
  };
  nodeChanges.sort(sorter);
  edgeChanges.sort(sorter);

  const all = [...nodeChanges, ...edgeChanges];
  const summary = {
    nodeChanges: nodeChanges.length,
    edgeChanges: edgeChanges.length,
    added: all.filter((row) => row.status === "added").length,
    removed: all.filter((row) => row.status === "removed").length,
    changed: all.filter((row) => row.status === "changed").length,
    unchangedIncluded: Boolean(includeUnchanged)
  };
  return {
    schemaVersion: "MagicLinkTrustGraphDiff.v1",
    summary,
    nodeChanges: nodeChanges.slice(0, limit),
    edgeChanges: edgeChanges.slice(0, limit)
  };
}

async function loadOrBuildTrustGraph({ tenantId, month, minRuns, maxEdges, persistIfMissing = false } = {}) {
  const snapshot = await readTrustGraphSnapshotBestEffort({ tenantId, month });
  if (snapshot && snapshot.graph && typeof snapshot.graph === "object" && !Array.isArray(snapshot.graph)) {
    return { source: "snapshot", snapshot, graph: snapshot.graph };
  }
  const graph = await buildTenantTrustGraph({ tenantId, month, minRuns, maxEdges });
  if (persistIfMissing) {
    const written = await writeTrustGraphSnapshot({ tenantId, month, graph, source: "auto" });
    return { source: "built", snapshot: written, graph };
  }
  return { source: "built", snapshot: null, graph };
}

async function handleTenantTrustGraphSnapshotsList(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..500" });
  const rows = await listTrustGraphSnapshotsBestEffort({ tenantId, limit });
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkTrustGraphSnapshotList.v1",
    tenantId,
    generatedAt: nowIso(),
    count: rows.length,
    rows
  });
}

async function handleTenantTrustGraphSnapshotCreate(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 20_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const month = body && typeof body.month === "string" && body.month.trim() ? body.month.trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const minRuns = Number.isInteger(body?.minRuns) ? body.minRuns : Number.parseInt(String(body?.minRuns ?? "1"), 10);
  if (!Number.isInteger(minRuns) || minRuns < 1 || minRuns > 100_000) return sendJson(res, 400, { ok: false, code: "INVALID_MIN_RUNS", message: "minRuns must be 1..100000" });
  const maxEdges = Number.isInteger(body?.maxEdges) ? body.maxEdges : Number.parseInt(String(body?.maxEdges ?? "200"), 10);
  if (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 2000) return sendJson(res, 400, { ok: false, code: "INVALID_MAX_EDGES", message: "maxEdges must be 1..2000" });

  const graph = await buildTenantTrustGraph({ tenantId, month, minRuns, maxEdges });
  const snapshot = await writeTrustGraphSnapshot({ tenantId, month, graph, source: "manual" });
  return sendJson(res, 200, { ok: true, snapshot });
}

async function handleTenantTrustGraphDiff(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;

  const compareMonth = url.searchParams.get("compareMonth") ? String(url.searchParams.get("compareMonth")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(compareMonth)) return sendJson(res, 400, { ok: false, code: "INVALID_COMPARE_MONTH", message: "compareMonth must be YYYY-MM" });
  const baseMonthRaw = url.searchParams.get("baseMonth") ? String(url.searchParams.get("baseMonth")).trim() : previousMonthKey(compareMonth);
  const baseMonth = typeof baseMonthRaw === "string" ? baseMonthRaw : "";
  if (!/^[0-9]{4}-[0-9]{2}$/.test(baseMonth)) return sendJson(res, 400, { ok: false, code: "INVALID_BASE_MONTH", message: "baseMonth must be YYYY-MM" });

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 50 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..500" });

  const minRunsRaw = url.searchParams.get("minRuns");
  const minRuns = minRunsRaw === null ? 1 : Number.parseInt(String(minRunsRaw), 10);
  if (!Number.isInteger(minRuns) || minRuns < 1 || minRuns > 100_000) return sendJson(res, 400, { ok: false, code: "INVALID_MIN_RUNS", message: "minRuns must be 1..100000" });
  const maxEdgesRaw = url.searchParams.get("maxEdges");
  const maxEdges = maxEdgesRaw === null ? 200 : Number.parseInt(String(maxEdgesRaw), 10);
  if (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 2000) return sendJson(res, 400, { ok: false, code: "INVALID_MAX_EDGES", message: "maxEdges must be 1..2000" });
  const includeUnchangedRaw = url.searchParams.get("includeUnchanged");
  const includeUnchanged = includeUnchangedRaw === "1" || includeUnchangedRaw === "true";

  const base = await loadOrBuildTrustGraph({ tenantId, month: baseMonth, minRuns, maxEdges, persistIfMissing: false });
  const compare = await loadOrBuildTrustGraph({ tenantId, month: compareMonth, minRuns, maxEdges, persistIfMissing: false });
  const diff = buildTrustGraphDiff({ baseGraph: base.graph, compareGraph: compare.graph, limit, includeUnchanged });
  return sendJson(res, 200, {
    ok: true,
    diff: {
      ...diff,
      tenantId,
      baseMonth,
      compareMonth,
      generatedAt: nowIso(),
      sources: { base: base.source, compare: compare.source }
    }
  });
}

async function handleTenantAnalyticsReport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;
  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const bucketRaw = url.searchParams.get("bucket") ? String(url.searchParams.get("bucket")).trim().toLowerCase() : "day";
  const bucket = bucketRaw === "week" || bucketRaw === "month" ? bucketRaw : bucketRaw === "day" ? "day" : null;
  if (!bucket) return sendJson(res, 400, { ok: false, code: "INVALID_BUCKET", message: "bucket must be day|week|month" });
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 20 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be 1..200" });
  const report = await buildTenantAnalyticsReport({ tenantId, month, bucket, limit });
  return sendJson(res, 200, { ok: true, report });
}

async function handleTenantTrustGraph(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;
  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const minRunsRaw = url.searchParams.get("minRuns");
  const minRuns = minRunsRaw === null ? 1 : Number.parseInt(String(minRunsRaw), 10);
  if (!Number.isInteger(minRuns) || minRuns < 1 || minRuns > 100_000) return sendJson(res, 400, { ok: false, code: "INVALID_MIN_RUNS", message: "minRuns must be 1..100000" });
  const maxEdgesRaw = url.searchParams.get("maxEdges");
  const maxEdges = maxEdgesRaw === null ? 200 : Number.parseInt(String(maxEdgesRaw), 10);
  if (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 2000) return sendJson(res, 400, { ok: false, code: "INVALID_MAX_EDGES", message: "maxEdges must be 1..2000" });
  const graph = await buildTenantTrustGraph({ tenantId, month, minRuns, maxEdges });
  return sendJson(res, 200, { ok: true, graph });
}

async function buildTenantRoiReport({ tenantId, month }) {
  const runs = (await listTenantRunRecordRowsBestEffort({ dataDir, tenantId, max: 200_000 }))
    .filter((rr) => rr && typeof rr === "object" && !Array.isArray(rr))
    .filter((rr) => {
      const createdAt = typeof rr.createdAt === "string" ? rr.createdAt : null;
      if (!createdAt) return false;
      if (isExpired(createdAt)) return false;
      return monthKeyFromIso(createdAt) === month;
    });

  let green = 0;
  let amber = 0;
  let red = 0;
  let approved = 0;
  let held = 0;
  let decided = 0;
  const approvalDurationsMs = [];

  const moneyByCurrency = {};
  const failureCodes = new Map(); // code -> {count, moneyByCurrency}

  const addMoney = (currency, cents, field) => {
    const cur = String(currency ?? "").trim() || "UNK";
    const raw = String(cents ?? "").trim();
    if (!/^[0-9]+$/.test(raw)) return;
    if (!moneyByCurrency[cur]) moneyByCurrency[cur] = { processedCents: "0", heldCents: "0" };
    const prev = BigInt(moneyByCurrency[cur][field] ?? "0");
    moneyByCurrency[cur][field] = String(prev + BigInt(raw));
  };

  const addFailureCode = (code, currency, cents) => {
    const c = String(code ?? "").trim();
    if (!c) return;
    const entry = failureCodes.get(c) ?? { count: 0, moneyByCurrency: {} };
    entry.count += 1;
    const cur = String(currency ?? "").trim() || "UNK";
    const raw = String(cents ?? "").trim();
    if (/^[0-9]+$/.test(raw)) {
      const prev = BigInt(entry.moneyByCurrency[cur] ?? "0");
      entry.moneyByCurrency[cur] = String(prev + BigInt(raw));
    }
    failureCodes.set(c, entry);
  };

  for (const rr of runs) {
    const claim = rr.invoiceClaim && typeof rr.invoiceClaim === "object" && !Array.isArray(rr.invoiceClaim) ? rr.invoiceClaim : null;
    const currency = typeof claim?.currency === "string" ? claim.currency : "UNK";
    const totalCents = typeof claim?.totalCents === "string" ? claim.totalCents : null;
    if (totalCents) addMoney(currency, totalCents, "processedCents");

    const ok = Boolean(rr?.verification?.ok);
    const warnings = Array.isArray(rr?.verification?.warningCodes) ? rr.verification.warningCodes : [];
    const status = ok ? (warnings.length ? "amber" : "green") : "red";

    if (status === "green") green += 1;
    else if (status === "amber") amber += 1;
    else red += 1;

    const decision = rr?.decision && typeof rr.decision === "object" && !Array.isArray(rr.decision) ? rr.decision : null;
    const decisionValue = typeof decision?.decision === "string" ? decision.decision : null;
    if (decisionValue) decided += 1;
    if (decisionValue === "approve") approved += 1;
    if (decisionValue === "hold") held += 1;

    const shouldCountHeldMoney = status === "red" || decisionValue === "hold";
    if (shouldCountHeldMoney && totalCents) addMoney(currency, totalCents, "heldCents");

    if (status === "red") {
      const codes = Array.isArray(rr?.verification?.errorCodes) ? rr.verification.errorCodes : [];
      const top = codes.length ? codes : ["FAILED"];
      for (const code of top.slice(0, 5)) addFailureCode(code, currency, totalCents);
    }

    if (decisionValue === "approve") {
      const createdAt = typeof rr.createdAt === "string" ? rr.createdAt : null;
      const decidedAt = typeof decision?.decidedAt === "string" ? decision.decidedAt : null;
      const createdMs = createdAt ? Date.parse(createdAt) : NaN;
      const decidedMs = decidedAt ? Date.parse(decidedAt) : NaN;
      if (Number.isFinite(createdMs) && Number.isFinite(decidedMs) && decidedMs >= createdMs) approvalDurationsMs.push(decidedMs - createdMs);
    }
  }

  const topFailureCodes = [...failureCodes.entries()]
    .map(([code, v]) => ({ code, count: v.count, heldCentsByCurrency: v.moneyByCurrency }))
    .sort((a, b) => b.count - a.count || cmpString(a.code, b.code))
    .slice(0, 10);

  return {
    schemaVersion: "MagicLinkRoiReport.v1",
    tenantId,
    month,
    generatedAt: nowIso(),
    totals: {
      runs: runs.length,
      green,
      amber,
      red,
      decided,
      approved,
      held
    },
    moneyByCurrency,
    approvalTimeMs: { median: medianMs(approvalDurationsMs) },
    topFailureCodes
  };
}

async function handleTenantRoiReport(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "approver" });
  if (!auth.ok) return;
  const month = url.searchParams.get("month") ? String(url.searchParams.get("month")).trim() : monthKeyUtcNow();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month)) return sendJson(res, 400, { ok: false, code: "INVALID_MONTH", message: "month must be YYYY-MM" });
  const report = await buildTenantRoiReport({ tenantId, month });
  return sendJson(res, 200, { ok: true, report });
}

async function handleTenantWebhookRetryList(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const stateRaw = url.searchParams.get("state");
  const state = stateRaw === "dead-letter" ? "dead-letter" : "pending";
  const providerRaw = url.searchParams.get("provider");
  const providerParsed = parseWebhookRetryProviderFilter(providerRaw, { allowAll: true });
  if (!providerParsed.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PROVIDER", message: providerParsed.error });
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be an integer 1..500" });
  }
  const rawRows = await listWebhookRetryJobs({ dataDir, tenantId, state, limit: 5_000 });
  const normalizedRows = normalizeWebhookRetryRowsForApi(rawRows).filter((row) => row?.event !== WEBHOOK_RETRY_ALERT_EVENT);
  const rows = filterWebhookRetryRowsByProvider(normalizedRows, providerParsed.provider).slice(0, limit);
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkWebhookRetryList.v1",
    tenantId,
    state,
    provider: providerParsed.provider ?? "all",
    count: rows.length,
    rows
  });
}

async function handleTenantWebhookRetryRunOnce(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const stats = await processWebhookRetryQueueOnce({ dataDir, settingsKey, timeoutMs: webhookTimeoutMs, tenantIdFilter: tenantId });
  if (stats.retried > 0) metrics.incCounter("webhook_retry_retries_total", null, stats.retried);
  if (stats.deadLettered > 0) metrics.incCounter("webhook_retry_dead_letter_total", null, stats.deadLettered);
  if (stats.delivered > 0) metrics.incCounter("webhook_retry_deliveries_total", null, stats.delivered);
  metrics.setGauge("webhook_retry_queue_depth_gauge", null, await webhookRetryQueueDepth({ dataDir }));
  await evaluateWebhookDeadLetterAlerts({ tenantIdFilter: tenantId, reason: "manual_run_once" });
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkWebhookRetryRunResult.v1",
    tenantId,
    stats
  });
}

async function handleTenantWebhookDeadLetterReplay(req, res, tenantId, token, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 30_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return sendJson(res, 400, { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "idempotencyKey is required" });
  }
  const providerRawQuery = url.searchParams.get("provider");
  const providerRawBody = typeof body?.provider === "string" ? body.provider : "";
  const providerParsed = parseWebhookRetryProviderFilter(providerRawQuery || providerRawBody, { allowAll: true });
  if (!providerParsed.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PROVIDER", message: providerParsed.error });
  }
  const deadRows = await listWebhookRetryJobs({ dataDir, tenantId, state: "dead-letter", limit: 5_000 });
  const matched = deadRows.find((row) => row?.token === token && row?.idempotencyKey === idempotencyKey) ?? null;
  if (!matched) {
    return sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "dead-letter job not found" });
  }
  const matchedProvider = retryProviderFromWebhookUrl(matched.webhookUrl);
  if (providerParsed.provider && matchedProvider !== providerParsed.provider) {
    return sendJson(res, 409, {
      ok: false,
      code: "PROVIDER_MISMATCH",
      message: `retry job provider is ${matchedProvider}, requested ${providerParsed.provider}`
    });
  }
  const resetAttempts = Boolean(body?.resetAttempts);
  const useCurrentSettings = body?.useCurrentSettings === undefined ? true : Boolean(body.useCurrentSettings);
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const replayed = await replayWebhookDeadLetterJob({
    dataDir,
    tenantId,
    token,
    idempotencyKey,
    resetAttempts,
    tenantSettings,
    useCurrentSettings
  });
  if (!replayed.ok) {
    const code = replayed.code ?? "REPLAY_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "PENDING_EXISTS" ? 409 : 400;
    return sendJson(res, status, { ok: false, code, message: replayed.message ?? "failed to replay dead-letter job" });
  }
  metrics.setGauge("webhook_retry_queue_depth_gauge", null, await webhookRetryQueueDepth({ dataDir }));
  await evaluateWebhookDeadLetterAlerts({ tenantIdFilter: tenantId, reason: "replay" });
  return sendJson(res, 200, { ok: true, replayed: { ...replayed, provider: matchedProvider } });
}

async function handleTenantWebhookDeadLetterReplayLatest(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 30_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const providerRawQuery = url.searchParams.get("provider");
  const providerRawBody = typeof body?.provider === "string" ? body.provider : "";
  const providerParsed = parseWebhookRetryProviderFilter(providerRawQuery || providerRawBody, { allowAll: true });
  if (!providerParsed.ok) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PROVIDER", message: providerParsed.error });
  }
  const resetAttempts = Boolean(body?.resetAttempts);
  const useCurrentSettings = body?.useCurrentSettings === undefined ? true : Boolean(body.useCurrentSettings);
  const deadRawRows = await listWebhookRetryJobs({ dataDir, tenantId, state: "dead-letter", limit: 5_000 });
  const normalizedRows = normalizeWebhookRetryRowsForApi(deadRawRows).filter((row) => row?.event !== WEBHOOK_RETRY_ALERT_EVENT);
  const filtered = filterWebhookRetryRowsByProvider(normalizedRows, providerParsed.provider);
  const latest = filtered[0] ?? null;
  if (!latest) {
    return sendJson(res, 404, {
      ok: false,
      code: "NOT_FOUND",
      message: `no dead-letter webhook retries found for provider ${providerParsed.provider ?? "all"}`
    });
  }
  const token = typeof latest.token === "string" ? latest.token : "";
  const idempotencyKey = typeof latest.idempotencyKey === "string" ? latest.idempotencyKey : "";
  if (!token || !idempotencyKey) {
    return sendJson(res, 500, { ok: false, code: "INVALID_RETRY_ROW", message: "latest retry row is missing token or idempotencyKey" });
  }
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const replayed = await replayWebhookDeadLetterJob({
    dataDir,
    tenantId,
    token,
    idempotencyKey,
    resetAttempts,
    tenantSettings,
    useCurrentSettings
  });
  if (!replayed.ok) {
    const code = replayed.code ?? "REPLAY_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "PENDING_EXISTS" ? 409 : 400;
    return sendJson(res, status, { ok: false, code, message: replayed.message ?? "failed to replay dead-letter job" });
  }
  metrics.setGauge("webhook_retry_queue_depth_gauge", null, await webhookRetryQueueDepth({ dataDir }));
  await evaluateWebhookDeadLetterAlerts({ tenantIdFilter: tenantId, reason: "replay_latest" });
  return sendJson(res, 200, {
    ok: true,
    provider: providerParsed.provider ?? "all",
    latest,
    replayed: { ...replayed, provider: retryProviderFromWebhookUrl(latest.webhookUrl) }
  });
}

async function handleTenantPaymentTriggerRetryList(req, res, tenantId, url) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const stateRaw = url.searchParams.get("state");
  const state = stateRaw === "dead-letter" ? "dead-letter" : "pending";
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 100 : Number.parseInt(String(limitRaw), 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return sendJson(res, 400, { ok: false, code: "INVALID_LIMIT", message: "limit must be an integer 1..500" });
  }
  const rows = await listPaymentTriggerRetryJobs({ dataDir, tenantId, state, limit });
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkPaymentTriggerRetryList.v1",
    tenantId,
    state,
    count: rows.length,
    rows
  });
}

async function handleTenantPaymentTriggerRetryRunOnce(req, res, tenantId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  const stats = await processPaymentTriggerRetryQueueOnce({ dataDir, settingsKey, timeoutMs: webhookTimeoutMs, tenantIdFilter: tenantId });
  if (stats.retried > 0) metrics.incCounter("payment_trigger_retries_total", null, stats.retried);
  if (stats.deadLettered > 0) metrics.incCounter("payment_trigger_dead_letter_total", null, stats.deadLettered);
  if (stats.delivered > 0) metrics.incCounter("payment_trigger_retry_deliveries_total", null, stats.delivered);
  return sendJson(res, 200, {
    ok: true,
    schemaVersion: "MagicLinkPaymentTriggerRetryRunResult.v1",
    tenantId,
    stats
  });
}

async function handleTenantPaymentTriggerDeadLetterReplay(req, res, tenantId, token) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;
  let body = null;
  try {
    body = await readJsonBody(req, { maxBytes: 30_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return sendJson(res, 400, { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "idempotencyKey is required" });
  }
  const resetAttempts = Boolean(body?.resetAttempts);
  const useCurrentSettings = body?.useCurrentSettings === undefined ? true : Boolean(body.useCurrentSettings);
  const tenantSettings = await loadTenantSettings({ dataDir, tenantId });
  const replayed = await replayPaymentTriggerDeadLetterJob({
    dataDir,
    tenantId,
    token,
    idempotencyKey,
    resetAttempts,
    tenantSettings,
    useCurrentSettings
  });
  if (!replayed.ok) {
    const code = replayed.code ?? "REPLAY_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "PENDING_EXISTS" ? 409 : 400;
    return sendJson(res, status, { ok: false, code, message: replayed.message ?? "failed to replay dead-letter job" });
  }
  return sendJson(res, 200, { ok: true, replayed });
}

async function handleIngestKeyCreate(req, res, tenantId, vendorId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};

  const vendorName = typeof json.vendorName === "string" ? json.vendorName : null;
  const expiresAt = typeof json.expiresAt === "string" ? json.expiresAt : null;
  const created = await createIngestKey({ dataDir, tenantId, vendorId, vendorName, expiresAt });
  if (!created.ok) return sendJson(res, 500, { ok: false, code: created.error ?? "INTERNAL", message: created.message ?? "failed to create ingest key" });

  await appendAuditRecord({
    dataDir,
    tenantId,
    record: { at: nowIso(), action: "INGEST_KEY_CREATED", actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null }, targetType: "vendor", targetId: vendorId, details: { keyHash: created.keyHash, expiresAt: expiresAt ?? null } }
  });

  return sendJson(res, 200, { ok: true, tenantId, vendorId, ingestKey: created.ingestKey, keyHash: created.keyHash });
}

async function handleIngestKeyRevoke(req, res, tenantId, keyHash) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 50_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  const reason = typeof json?.reason === "string" ? json.reason : null;
  const revoked = await revokeIngestKey({ dataDir, tenantId, keyHash, reason });
  if (!revoked.ok) return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });

  await appendAuditRecord({
    dataDir,
    tenantId,
    record: { at: nowIso(), action: "INGEST_KEY_REVOKED", actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null }, targetType: "ingest_key", targetId: keyHash, details: { reason: reason ?? null } }
  });

  return sendJson(res, 200, { ok: true, tenantId, keyHash, revokedAt: revoked.revokedAt ?? null, alreadyRevoked: Boolean(revoked.alreadyRevoked) });
}

async function handleVendorOnboardingPack(req, res, tenantId, vendorId) {
  const auth = await requireTenantPrincipal(req, res, { tenantId, minBuyerRole: "admin" });
  if (!auth.ok) return;

  let json = null;
  try {
    json = await readJsonBody(req, { maxBytes: 500_000 });
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }
  if (!json) json = {};

  const vendorName = typeof json.vendorName === "string" && json.vendorName.trim() ? json.vendorName.trim() : null;
  const contractId = typeof json.contractId === "string" && json.contractId.trim() ? json.contractId.trim() : null;
  if (contractId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(contractId)) return sendJson(res, 400, { ok: false, code: "INVALID_CONTRACT", message: "contractId invalid" });
  const expiresAt = typeof json.expiresAt === "string" && json.expiresAt.trim() ? json.expiresAt.trim() : null;
  if (expiresAt !== null) {
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) return sendJson(res, 400, { ok: false, code: "INVALID_EXPIRES_AT", message: "expiresAt must be ISO date string" });
  }

  const pricingMatrixJsonText = typeof json.pricingMatrixJsonText === "string" ? json.pricingMatrixJsonText : null;
  const pricingMatrixSignaturesJsonText = typeof json.pricingMatrixSignaturesJsonText === "string" ? json.pricingMatrixSignaturesJsonText : null;
  if ((pricingMatrixJsonText !== null) !== (pricingMatrixSignaturesJsonText !== null)) {
    return sendJson(res, 400, { ok: false, code: "INVALID_PRICING", message: "pricingMatrixJsonText and pricingMatrixSignaturesJsonText must be provided together" });
  }

  const created = await createIngestKey({ dataDir, tenantId, vendorId, vendorName, expiresAt });
  if (!created.ok) return sendJson(res, 500, { ok: false, code: created.error ?? "INTERNAL", message: created.message ?? "failed to create ingest key" });

  await appendAuditRecord({
    dataDir,
    tenantId,
    record: {
      at: nowIso(),
      action: "VENDOR_ONBOARDING_PACK_CREATED",
      actor: { method: auth.principal?.method ?? null, email: auth.principal?.email ?? null, role: auth.principal?.role ?? null },
      targetType: "vendor",
      targetId: vendorId,
      details: { keyHash: created.keyHash, contractId: contractId ?? null, expiresAt: expiresAt ?? null }
    }
  });

  const base = publicBaseUrl ? String(publicBaseUrl).replace(/\/+$/, "") : "";
  const ingestUrl = base ? `${base}/v1/ingest/${tenantId}` : `/v1/ingest/${tenantId}`;

  const meta = {
    schemaVersion: "VendorOnboardingPack.v1",
    tenantId,
    vendorId,
    vendorName,
    contractId,
    ingestUrl,
    generatedAt: nowIso(),
    ingestKeyHash: created.keyHash,
    expiresAt
  };

  const readmeLines = [];
  readmeLines.push("# Vendor Onboarding Pack");
  readmeLines.push("");
  readmeLines.push(`Buyer tenant: ${tenantId}`);
  readmeLines.push(`Vendor id: ${vendorId}`);
  if (vendorName) readmeLines.push(`Vendor name: ${vendorName}`);
  if (contractId) readmeLines.push(`Contract: ${contractId}`);
  readmeLines.push("");
  readmeLines.push("This pack contains a vendor-scoped ingest key and (optionally) buyer-signed pricing terms.");
  readmeLines.push("");
  readmeLines.push("## Submit an InvoiceBundle.zip");
  readmeLines.push("");
  readmeLines.push("Using curl:");
  readmeLines.push("```bash");
  readmeLines.push(`curl -X POST \\`);
  readmeLines.push(`  -H \"Authorization: Bearer $(cat ingest_key.txt)\" \\`);
  readmeLines.push(`  -H \"Content-Type: application/zip\" \\`);
  readmeLines.push(`  --data-binary @InvoiceBundle.zip \\`);
  readmeLines.push(`  \"${ingestUrl}?mode=auto${contractId ? `&contractId=${encodeURIComponent(contractId)}` : ""}\"`);
  readmeLines.push("```");
  readmeLines.push("");
  readmeLines.push("Using settld-magic-link:");
  readmeLines.push("```bash");
  readmeLines.push(`settld-magic-link ingest InvoiceBundle.zip --url ${base || "http://host:port"} --tenant ${tenantId} --ingest-key $(cat ingest_key.txt) --mode auto${contractId ? ` --contract ${contractId}` : ""}`);
  readmeLines.push("```");
  readmeLines.push("");
  readmeLines.push("Keep `ingest_key.txt` secret.");
  readmeLines.push("");
  readmeLines.push("## Local verification (recommended)");
  readmeLines.push("");
  readmeLines.push("This pack includes known-good and known-bad sample ClosePacks plus a demo trust roots file.");
  readmeLines.push("For vendors generating ClosePacks from raw inputs, see `VENDOR_ENGINEER.md`.");
  readmeLines.push("");
  readmeLines.push("- macOS/Linux: `bash verify-locally.sh`");
  readmeLines.push("- Windows: run `powershell -ExecutionPolicy Bypass -File verify-locally.ps1`");
  readmeLines.push("");
  readmeLines.push("Samples:");
  readmeLines.push("- `samples/known_good_closepack/`");
  readmeLines.push("- `samples/known_bad_closepack/`");
  readmeLines.push("- `samples/trust.json`");
  readmeLines.push("");
  readmeLines.push("## Rotate ingest key");
  readmeLines.push("");
  readmeLines.push("A buyer admin can revoke and re-issue keys at any time:");
  readmeLines.push("");
  readmeLines.push("1) Create a new key (admin):");
  readmeLines.push("```bash");
  readmeLines.push(`curl -sS -X POST -H \"x-api-key: <admin>\" http://host:port/v1/tenants/${tenantId}/vendors/${vendorId}/ingest-keys`);
  readmeLines.push("```");
  readmeLines.push("2) Revoke the old key (admin):");
  readmeLines.push("```bash");
  readmeLines.push(`curl -sS -X POST -H \"x-api-key: <admin>\" http://host:port/v1/tenants/${tenantId}/ingest-keys/<keyHash>/revoke`);
  readmeLines.push("```");

  const files = new Map();
  files.set("metadata.json", Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8"));
  files.set("ingest_key.txt", Buffer.from(`${created.ingestKey}\n`, "utf8"));
  files.set("README.md", Buffer.from(readmeLines.join("\n") + "\n", "utf8"));
  files.set(
    "VENDOR_ENGINEER.md",
    Buffer.from(
      [
        "# Vendor engineer guide (ClosePack)",
        "",
        "This pack is designed to make your first upload succeed without reading the full spec.",
        "",
        "## Quick sanity check (recommended)",
        "",
        "Run the local verifier against the included samples:",
        "",
        "- macOS/Linux: `bash verify-locally.sh`",
        "- Windows: `powershell -ExecutionPolicy Bypass -File verify-locally.ps1`",
        "",
        "If the known-good sample passes and the known-bad sample fails, your local environment is OK.",
        "",
        "## Produce a ClosePack from JSON inputs",
        "",
        "If you already generate the underlying evidence bundle(s), you can assemble a ClosePack deterministically with `settld-produce closepack-from-json`.",
        "",
        "Inputs you will need:",
        "- A proof bundle directory (e.g. JobProof.v1): contains the evidence files you reference",
        "- `pricing_matrix.json` and `pricing_matrix_signatures.json` (buyer-signed pricing terms)",
        "- `metering_report.json` (your metering summary + evidenceRefs pointing into the proof bundle)",
        "",
        "Example (paths are illustrative):",
        "```bash",
        "settld-produce closepack-from-json \\",
        "  --format json \\",
        "  --out ./ClosePack \\",
        "  --tenant tenant_demo \\",
        "  --invoice-id invoice_demo \\",
        "  --protocol 1.0 \\",
        "  --jobproof ./JobProof \\",
        "  --pricing-matrix ./pricing_matrix.json \\",
        "  --pricing-signatures ./pricing_matrix_signatures.json \\",
        "  --metering-report ./metering_report.json \\",
        "  --deterministic",
        "```",
        "",
        "Then zip your ClosePack (or use your existing bundler) and verify locally:",
        "```bash",
        "settld-verify --strict --format json --close-pack ./ClosePack > /tmp/verify.json",
        "```",
        "",
        "## Upload",
        "",
        "Use the ingest key from `ingest_key.txt`:",
        "",
        "```bash",
        "curl -X POST \\",
        "  -H \"Authorization: Bearer $(cat ingest_key.txt)\" \\",
        "  -H \"Content-Type: application/zip\" \\",
        "  --data-binary @ClosePack.zip \\",
        `  \"${ingestUrl}?mode=auto${contractId ? `&contractId=${encodeURIComponent(contractId)}` : ""}\"`,
        "```",
        "",
        "## Troubleshooting (common failures)",
        "",
        "- `ZIP_*`: the upload zip was rejected for safety (e.g. traversal, symlinks, zip bomb). Rebuild the zip with a normal tool and ensure paths are relative.",
        "- `HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_MISSING`: pricing terms were required but missing signerKeyId(s). Ensure `pricing_matrix_signatures.json` includes `signerKeyId` entries.",
        "- `HOSTED_POLICY_PRICING_MATRIX_SIGNER_KEYID_NOT_ALLOWED`: pricing signer is not allowed by buyer policy. Use the key(s) the buyer provided.",
        "- `VENDOR_MISMATCH` / `CONTRACT_MISMATCH`: the exact bundle hash was already uploaded under different metadata; change bundle contents or coordinate with the buyer.",
        "- HTTP `429 RATE_LIMITED`: retry later (you'll get `retryAfterSeconds`).",
        "",
        "When asking for help, send only: the error/warning codes + the `token` (no secrets).",
        ""
      ].join("\n"),
      "utf8"
    )
  );
  files.set(
    "verify-locally.sh",
    Buffer.from(
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        "if ! command -v settld-verify >/dev/null 2>&1; then",
        "  echo \"missing: settld-verify (install via npm pack or use repo bin)\" >&2",
        "  exit 2",
        "fi",
        "",
        "ROOT=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
        "TRUST_JSON=\"$ROOT/samples/trust.json\"",
        "",
        "GOV=\"$(node -e 'const j=require(process.argv[1]); process.stdout.write(JSON.stringify(j.governanceRoots||{}));' \"$TRUST_JSON\")\"",
        "PRICING=\"$(node -e 'const j=require(process.argv[1]); process.stdout.write(JSON.stringify(j.pricingSigners||{}));' \"$TRUST_JSON\")\"",
        "",
        "export SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON=\"$GOV\"",
        "export SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON=\"$PRICING\"",
        "",
        "echo \"verifying known-good ClosePack (strict)...\"",
        "settld-verify --strict --format json --close-pack \"$ROOT/samples/known_good_closepack\" >/tmp/settld_known_good.json",
        "echo \"ok: /tmp/settld_known_good.json\"",
        "",
        "echo \"verifying known-bad ClosePack (strict, expected to fail)...\"",
        "if settld-verify --strict --format json --close-pack \"$ROOT/samples/known_bad_closepack\" >/tmp/settld_known_bad.json; then",
        "  echo \"unexpected success; expected failure\" >&2",
        "  exit 1",
        "fi",
        "echo \"ok (failed as expected): /tmp/settld_known_bad.json\"",
        ""
      ].join("\n"),
      "utf8"
    )
  );
  files.set(
    "verify-locally.ps1",
    Buffer.from(
      [
        "$ErrorActionPreference = 'Stop'",
        "",
        "function Require-Cmd($name) {",
        "  $cmd = Get-Command $name -ErrorAction SilentlyContinue",
        "  if (-not $cmd) { throw \"missing: $name\" }",
        "}",
        "",
        "Require-Cmd settld-verify",
        "Require-Cmd node",
        "",
        "$Root = Split-Path -Parent $MyInvocation.MyCommand.Path",
        "$Trust = Join-Path $Root 'samples/trust.json'",
        "",
        "$Gov = node -e \"const j=require(process.argv[1]); process.stdout.write(JSON.stringify(j.governanceRoots||{}));\" $Trust",
        "$Pricing = node -e \"const j=require(process.argv[1]); process.stdout.write(JSON.stringify(j.pricingSigners||{}));\" $Trust",
        "",
        "$env:SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON = $Gov",
        "$env:SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON = $Pricing",
        "",
        "Write-Host 'verifying known-good ClosePack (strict)...'",
        "settld-verify --strict --format json --close-pack (Join-Path $Root 'samples/known_good_closepack') | Out-File -Encoding utf8 (Join-Path $env:TEMP 'settld_known_good.json')",
        "Write-Host \"ok: $env:TEMP\\settld_known_good.json\"",
        "",
        "Write-Host 'verifying known-bad ClosePack (strict, expected to fail)...'",
        "try {",
        "  settld-verify --strict --format json --close-pack (Join-Path $Root 'samples/known_bad_closepack') | Out-File -Encoding utf8 (Join-Path $env:TEMP 'settld_known_bad.json')",
        "  throw 'unexpected success; expected failure'",
        "} catch {",
        "  Write-Host \"ok (failed as expected): $env:TEMP\\settld_known_bad.json\"",
        "}",
        ""
      ].join("\n"),
      "utf8"
    )
  );
  if (pricingMatrixJsonText !== null) {
    files.set("pricing/pricing_matrix.json", Buffer.from(pricingMatrixJsonText, "utf8"));
    files.set("pricing/pricing_matrix_signatures.json", Buffer.from(pricingMatrixSignaturesJsonText, "utf8"));
  }
  try {
    const trustRaw = await fs.readFile(path.join(samplesDir, "trust.json"));
    files.set("samples/trust.json", trustRaw);
  } catch {
    // ignore
  }
  try {
    await addDirToZipFiles({ files, dir: path.join(samplesDir, "closepack", "known-good"), prefix: "samples/known_good_closepack" });
    await addDirToZipFiles({ files, dir: path.join(samplesDir, "closepack", "known-bad"), prefix: "samples/known_bad_closepack" });
  } catch {
    // ignore
  }

  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  res.statusCode = 200;
  res.setHeader("content-type", "application/zip");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename=\"vendor_onboarding_pack_${tenantId}_${vendorId}.zip\"`);
  res.end(Buffer.from(zip));
}

async function handleIngestUpload(req, res, tenantId) {
  const ingestKey = parseAuthorizationBearerToken(req);
  const auth = await authenticateIngestKey({ dataDir, tenantId, ingestKey });
  if (!auth.ok) return sendJson(res, 403, { ok: false, code: "FORBIDDEN" });

  const url = new URL(req.url ?? `/v1/ingest/${tenantId}`, "http://localhost");
  // Vendor uploads may provide contractId; vendorId/vendorName are stamped from key.
  const meta = parseUploadRunMetadataFromUrl(url);
  if (!meta.ok) return sendJson(res, 400, { ok: false, code: "INVALID_METADATA", message: meta.error });
  if (meta.vendorId !== null || meta.vendorName !== null) return sendJson(res, 400, { ok: false, code: "INVALID_METADATA", message: "vendorId/vendorName are not allowed for ingest uploads" });

  const vendorMeta = {
    vendorId: auth.record.vendorId,
    vendorName: typeof auth.record.vendorName === "string" ? auth.record.vendorName : null,
    contractId: meta.contractId,
    templateId: meta.templateId,
    templateConfig: meta.templateConfig,
    templateConfigEncoded: meta.templateConfigEncoded
  };
  return await handleUploadToTenant(req, res, { url, tenantId, vendorMeta, authMethod: "ingest-key", vendorMetaLocked: true });
}

async function handleReport(req, res, token) {
  let meta;
  try {
    meta = await loadMeta(token);
  } catch {
    return sendText(res, 404, "not found\n");
  }
  if (meta.revokedAt) return sendText(res, 410, "revoked\n");
  if (isExpired(meta.createdAt)) return sendText(res, 410, "expired\n");
  const tenantId = typeof meta.tenantId === "string" ? meta.tenantId : "default";
  const ts = await loadTenantSettings({ dataDir, tenantId });
  {
    const limits = tenantRateLimits(ts);
    const rl = applyRateLimit({ req, tenantId, tenantSettings: ts, category: "verification_view", limitPerHour: limits.verificationViewsPerHour });
    if (!rl.ok) {
      metrics.incCounter("rate_limit_events_total", { tenantId, category: "verification_view", scope: rl.scope ?? "tenant" }, 1);
      res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
      return sendJson(res, 429, { ok: false, code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterSeconds: rl.retryAfterSeconds ?? null, scope: rl.scope ?? null });
    }
  }
  const retentionDays = effectiveRetentionDaysForRun({
    tenantSettings: ts,
    vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
    contractId: typeof meta.contractId === "string" ? meta.contractId : null
  });
  if (isPastRetention(meta.createdAt, retentionDays)) return sendText(res, 410, "retained\n");

  const verifyRaw = await fs.readFile(meta.verifyJsonPath, "utf8");
  const cliOut = JSON.parse(verifyRaw);

  const ok = Boolean(cliOut?.ok);
  const verificationOk = Boolean(cliOut?.verificationOk);
  const errors = Array.isArray(cliOut?.errors) ? cliOut.errors : [];
  const warnings = Array.isArray(cliOut?.warnings) ? cliOut.warnings : [];
  const sum = cliOut?.summary ?? {};
  const hosted = cliOut?.hosted ?? {};
  const trust = hosted?.trust ?? null;

  let pub = null;
  try {
    if (meta.publicJsonPath) pub = JSON.parse(await fs.readFile(meta.publicJsonPath, "utf8"));
  } catch {
    pub = null;
  }
  const claim = pub?.invoiceClaim ?? null;
  const lineItems = Array.isArray(claim?.lineItems) ? claim.lineItems : [];
  const metering = pub?.metering ?? null;
  const pricingMatrixSignatures = pub?.pricingMatrixSignatures ?? null;
  const closePackSummaryV1 = pub?.closePackSummaryV1 ?? null;
  const pricingSignerKeyIds = Array.isArray(pricingMatrixSignatures?.signerKeyIds) ? pricingMatrixSignatures.signerKeyIds : [];
  const pricingTermsText = pricingMatrixSignatures && pricingMatrixSignatures.present
    ? pricingSignerKeyIds.length
      ? `Signed by ${pricingSignerKeyIds.join(", ")}`
      : "Signature surface present (no trusted signer)"
    : "Unsigned";

  const status = statusFromCliOutput(cliOut);
  const statusLabel = status === "green" ? "Green" : status === "amber" ? "Amber" : "Red";
  const statusText = status === "green" ? "Verified" : status === "amber" ? "Verified (warnings)" : "Verification failed";

  const policySel = resolvePolicyForRun({ tenantSettings: ts, vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null, contractId: typeof meta.contractId === "string" ? meta.contractId : null });
  const policyEffective = normalizePolicyProfileForEnforcement(policySel.policy);
  const approveAllowed = status === "green" || (status === "amber" && policyEffective.allowAmberApprovals);
  const decisionOtpDomains = Array.isArray(ts?.decisionAuthEmailDomains) ? ts.decisionAuthEmailDomains : [];
  const decisionOtpEnabled = decisionOtpDomains.length > 0;

  const sub = classifySubresults(cliOut);
  const subWork = sub.workProofVerified === true ? "Verified" : sub.workProofVerified === false ? "Failed" : "Unknown";
  const subMath = sub.invoiceMathVerified === true ? "Verified" : sub.invoiceMathVerified === false ? "Failed" : "Unknown";

  const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
  const decisionStatus = typeof decisionReport?.decision === "string" ? decisionReport.decision : null;

  async function fileExists(fp) {
    try {
      await fs.access(fp);
      return true;
    } catch {
      return false;
    }
  }

  const downloads = [];
  downloads.push(`<a class="btn" href="/r/${encodeURIComponent(token)}/bundle.zip">Download Bundle (ZIP)</a>`);
  downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/verify.json">Download verification JSON</a>`);
  downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/audit-packet.zip">Download audit packet</a>`);
  if (meta.receiptJsonPath) downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/receipt.json">Download producer receipt</a>`);
  if (meta.summaryPdfPath) downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/summary.pdf">Download PDF summary</a>`);
  if (meta.closePackDir && String(sum.type ?? "") === "ClosePack.v1") {
    const base = String(meta.closePackDir);
    const addIf = async (rel, label) => {
      const fp = path.join(base, rel);
      if (!(await fileExists(fp))) return;
      downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/closepack/${encodeURIComponent(rel)}">${htmlEscape(label)}</a>`);
    };
    await addIf("closepack_summary_v1.json", "Download ClosePack summary");
    await addIf("evidence_index.json", "Download EvidenceIndex");
    await addIf("sla_definition.json", "Download SLA definition");
    await addIf("sla_evaluation.json", "Download SLA evaluation");
    await addIf("acceptance_criteria.json", "Download Acceptance criteria");
    await addIf("acceptance_evaluation.json", "Download Acceptance evaluation");
  }
  if (decisionStatus === "approve") downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/closepack.zip">Download ClosePack ZIP</a>`);
  if (decisionReport) downloads.push(`<a class="btn secondary" href="/r/${encodeURIComponent(token)}/settlement_decision_report.json">Download Audit Receipt</a>`);

  const trustConfigured = Boolean(trust && trust.configured);
  const trustKeyIds = Array.isArray(trust?.keyIds) ? trust.keyIds : [];
  const trustSetHash = typeof trust?.setHash === "string" ? trust.setHash : "";
  const hasTrustMissingWarning = warnings.some((w) => String(w?.code ?? "") === "TRUSTED_GOVERNANCE_ROOT_KEYS_MISSING_LENIENT");

  const closePackSection = (() => {
    if (String(sum?.type ?? "") !== "ClosePack.v1") return "";
    if (!closePackSummaryV1 || typeof closePackSummaryV1 !== "object" || Array.isArray(closePackSummaryV1)) return "";
    const sla = closePackSummaryV1.sla && typeof closePackSummaryV1.sla === "object" && !Array.isArray(closePackSummaryV1.sla) ? closePackSummaryV1.sla : {};
    const acceptance =
      closePackSummaryV1.acceptance && typeof closePackSummaryV1.acceptance === "object" && !Array.isArray(closePackSummaryV1.acceptance) ? closePackSummaryV1.acceptance : {};
    const evidenceIndex =
      closePackSummaryV1.evidenceIndex && typeof closePackSummaryV1.evidenceIndex === "object" && !Array.isArray(closePackSummaryV1.evidenceIndex)
        ? closePackSummaryV1.evidenceIndex
        : {};
    const byType = evidenceIndex.byType && typeof evidenceIndex.byType === "object" && !Array.isArray(evidenceIndex.byType) ? evidenceIndex.byType : {};
    const countText = ["gps", "video", "checkpoint"]
      .map((k) => (Number.isInteger(byType[k]) ? `${k}:${byType[k]}` : null))
      .filter(Boolean)
      .join(" ");
    const icon = (present, pass) => (present ? (pass ? "✅" : "❌") : "—");
    return [
      "<h3 style=\"margin:14px 0 6px\">ClosePack</h3>",
      "<table><tbody>",
      `<tr><th>SLA</th><td>${htmlEscape(icon(Boolean(sla.present), Boolean(sla.pass)))} <span class="muted">failingClauses=<code>${htmlEscape(String(sla.failingClausesCount ?? 0))}</code></span></td></tr>`,
      `<tr><th>Acceptance</th><td>${htmlEscape(icon(Boolean(acceptance.present), Boolean(acceptance.pass)))} <span class="muted">failingCriteria=<code>${htmlEscape(String(acceptance.failingCriteriaCount ?? 0))}</code></span></td></tr>`,
      `<tr><th>Evidence index</th><td>${htmlEscape(icon(Boolean(evidenceIndex.present), true))} <span class="muted">items=<code>${htmlEscape(String(evidenceIndex.itemCount ?? 0))}</code>${countText ? ` (${htmlEscape(countText)})` : ""}</span></td></tr>`,
      "</tbody></table>"
    ].join("\n");
  })();

  const banner = (() => {
    if (status === "red" && errors.some((e) => String(e?.code ?? "") === "strict requires trusted governance root keys")) {
      return `<div class="banner red">Strict verification is not possible: missing trust anchors (<code>SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON</code>).</div>`;
    }
    if (hasTrustMissingWarning) {
      return `<div class="banner amber">Governance not anchored: verification ran in compat mode because trust anchors are missing. Provide trust roots to run strict verification.</div>`;
    }
    if (!cliOut?.mode?.strict) {
      return `<div class="banner">Compat verification: integrity + invoice math verified, governance enforcement is not required in this mode.</div>`;
    }
    if (trustConfigured) {
      const shortHash = trustSetHash ? htmlEscape(trustSetHash.slice(0, 16)) : "";
      return `<div class="banner green">Strict verification: governance enforced under trust root set <code>${shortHash}</code>…</div>`;
    }
    return "";
  })();

  const title = `${statusLabel} — Invoice Verification`;
  const totalText =
    claim && typeof claim.currency === "string" && typeof claim.totalCents === "string"
      ? formatMoneyFromCentsString({ currency: claim.currency, cents: claim.totalCents })
      : "";

  const decisionBox = (() => {
    const statusLabel = decisionStatus === "approve" ? "Approved" : decisionStatus === "hold" ? "Hold" : "None";
    const decidedAt = typeof decisionReport?.decidedAt === "string" ? decisionReport.decidedAt : null;
    const actorName = typeof decisionReport?.actor?.name === "string" ? decisionReport.actor.name : null;
    const actorEmail = typeof decisionReport?.actor?.email === "string" ? decisionReport.actor.email : null;
    const note = typeof decisionReport?.note === "string" ? decisionReport.note : null;
    const signerKeyId = typeof decisionReport?.signerKeyId === "string" ? decisionReport.signerKeyId : null;

    const currentLine = decisionStatus
      ? `<div class="muted">Current: <code>${htmlEscape(statusLabel)}</code> at <code>${htmlEscape(decidedAt ?? "")}</code> by <code>${htmlEscape(actorName ?? "")}</code> (<code>${htmlEscape(actorEmail ?? "")}</code>)${signerKeyId ? ` - signed by <code>${htmlEscape(signerKeyId)}</code>` : ""}</div>`
      : `<div class="muted">Current: <code>None</code></div>`;
    const noteLine = note ? `<div class="muted" style="margin-top:6px">Note: ${htmlEscape(note)}</div>` : "";
    const locked = Boolean(decisionStatus);
    const lockedNote = locked ? "<div class=\"muted\" style=\"margin-top:8px\">Decision already recorded. This page is now read-only.</div>" : "";
    const approveDisabled = !approveAllowed || locked ? " disabled" : "";
    const holdDisabled = locked ? " disabled" : "";
    const approveHint = approveAllowed ? "" : "<div class=\"muted\" style=\"margin-top:8px\">Approve is disabled by policy for this verification status.</div>";

    const authNote = !locked && decisionOtpEnabled
      ? `<div class="muted" style="margin-top:8px">Decision actions require email OTP (${htmlEscape(decisionOtpDomains.join(", "))}).</div>`
      : "";
    const otpRequestForm = !locked && decisionOtpEnabled
      ? [
          `<form method="POST" action="/r/${encodeURIComponent(token)}/otp/request" style="margin-top:10px">`,
          "<div class=\"row\" style=\"gap:10px\">",
          "<div style=\"flex:1;min-width:220px\"><div class=\"muted\">Email</div><input name=\"email\" autocomplete=\"email\" required></div>",
          "</div>",
          "<div style=\"margin-top:10px\">",
          "<button class=\"btn secondary\" type=\"submit\">Send OTP code</button>",
          "</div>",
          "</form>"
        ].join("")
      : "";
    const nameField = decisionOtpEnabled
      ? "<div style=\"flex:1;min-width:160px\"><div class=\"muted\">Name (optional)</div><input name=\"name\" autocomplete=\"name\"></div>"
      : "<div style=\"flex:1;min-width:160px\"><div class=\"muted\">Name</div><input name=\"name\" autocomplete=\"name\" required></div>";
    const otpField = decisionOtpEnabled
      ? "<div style=\"flex:1;min-width:160px\"><div class=\"muted\">OTP code</div><input name=\"otp\" autocomplete=\"one-time-code\" required></div>"
      : "";
    const actionForm = locked
      ? ""
      : [
          `<form method="POST" action="/r/${encodeURIComponent(token)}/decision" style="margin-top:10px">`,
          "<div class=\"row\" style=\"gap:10px\">",
          nameField,
          "<div style=\"flex:1;min-width:220px\"><div class=\"muted\">Email</div><input name=\"email\" autocomplete=\"email\" required></div>",
          otpField,
          "</div>",
          "<div style=\"margin-top:10px\"><div class=\"muted\">Reason (optional)</div><textarea name=\"note\" maxlength=\"2000\"></textarea></div>",
          "<div style=\"margin-top:10px\">",
          `<button class="btn" type="submit" name="decision" value="approve"${approveDisabled}>Approve</button>`,
          `<button class="btn secondary" type="submit" name="decision" value="hold"${holdDisabled}>Hold</button>`,
          "</div>",
          approveHint,
          "</form>"
        ].join("");

    return [
      "<h3 style=\"margin:14px 0 6px\">Decision</h3>",
      currentLine,
      noteLine,
      lockedNote,
      authNote,
      otpRequestForm,
      actionForm,
      "<div class=\"muted\" style=\"margin-top:8px\">All values on this page are derived from the signed artifact and verification outputs.</div>",
      "<div class=\"muted\" style=\"margin-top:6px\">Decisions are recorded as signed <code>SettlementDecisionReport.v1</code> (portable + offline verifiable).</div>"
    ].join("");
  })();

  const body = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    `<title>${htmlEscape(title)}</title>`,
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>",
    "<style>",
    "body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:24px;max-width:980px;line-height:1.35}",
    ".row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start}",
    ".card{border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,0.03)}",
    ".title{display:flex;align-items:center;gap:12px;margin:0 0 10px}",
    ".badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font-weight:700;font-size:13px;border:1px solid #e5e7eb}",
    ".badge.green{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}",
    ".badge.amber{background:#fffbeb;color:#92400e;border-color:#fde68a}",
    ".badge.red{background:#fef2f2;color:#991b1b;border-color:#fecaca}",
    "code{background:#f4f4f5;padding:2px 6px;border-radius:6px}",
    "pre{background:#0b1020;color:#e8e8e8;padding:12px;border-radius:10px;overflow:auto}",
    "table{border-collapse:collapse;width:100%}",
    "th,td{border-bottom:1px solid #e5e7eb;padding:8px 6px;text-align:left;font-size:14px;vertical-align:top}",
    ".btn{display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:10px 12px;border-radius:10px;margin:4px 6px 0 0}",
    ".btn.secondary{background:#374151}",
    "button.btn{border:none;cursor:pointer}",
    "input,textarea{width:100%;box-sizing:border-box;border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px;font-size:14px}",
    "textarea{min-height:80px;resize:vertical}",
    ".muted{color:#6b7280}",
    ".banner{border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;margin:12px 0;background:#f9fafb}",
    ".banner.green{background:#ecfdf5;border-color:#a7f3d0}",
    ".banner.amber{background:#fffbeb;border-color:#fde68a}",
    ".banner.red{background:#fef2f2;border-color:#fecaca}",
    "</style>",
    "</head><body>",
    `<div class="title"><span class="badge ${htmlEscape(status)}">${htmlEscape(statusLabel)}</span><h1 style="margin:0">${htmlEscape(statusText)}</h1></div>`,
    banner,
    "<div class=\"muted\" style=\"margin:0 0 10px\">Derived from artifact-only verification data. No vendor-side mutable state is used.</div>",
    "<div class=\"row\">",
    "<div class=\"card\" style=\"flex:2;min-width:320px\">",
    "<h2 style=\"margin:0 0 8px\">Invoice</h2>",
    claim
      ? `<div><div style="font-size:22px;font-weight:800">${htmlEscape(totalText)}</div><div class="muted">invoiceId=<code>${htmlEscape(claim.invoiceId ?? "")}</code> tenantId=<code>${htmlEscape(claim.tenantId ?? "")}</code>${meta.vendorId ? ` vendorId=<code>${htmlEscape(meta.vendorId)}</code>` : ""}${meta.contractId ? ` contractId=<code>${htmlEscape(meta.contractId)}</code>` : ""}${meta.vendorName ? ` vendorName=<code>${htmlEscape(meta.vendorName)}</code>` : ""}</div></div>`
      : "<div class=\"muted\">Invoice claim not available.</div>",
    metering && (metering.itemsCount !== null || metering.evidenceRefsCount !== null)
      ? `<div class="muted" style="margin-top:8px">metering items=<code>${htmlEscape(metering.itemsCount ?? "")}</code> evidence files referenced=<code>${htmlEscape(metering.evidenceRefsCount ?? "")}</code></div>`
      : "",
    lineItems.length
      ? "<h3 style=\"margin:14px 0 6px\">Line items</h3>" +
        "<table><thead><tr><th>code</th><th>quantity</th><th>unitPriceCents</th><th>amountCents</th></tr></thead><tbody>" +
        lineItems
          .map(
            (it) =>
              `<tr><td><code>${htmlEscape(it.code ?? "")}</code></td><td>${htmlEscape(it.quantity ?? "")}</td><td>${htmlEscape(it.unitPriceCents ?? "")}</td><td>${htmlEscape(it.amountCents ?? "")}</td></tr>`
          )
          .join("") +
    "</tbody></table>"
      : "",
    "<h3 style=\"margin:14px 0 6px\">Downloads</h3>",
    `<div>${downloads.join("")}</div>`,
    decisionBox,
    "</div>",
    "<div class=\"card\" style=\"flex:1;min-width:260px\">",
    "<h2 style=\"margin:0 0 8px\">Verification</h2>",
    `<table><tbody>
      <tr><th>Work proof</th><td>${htmlEscape(subWork)}</td></tr>
      <tr><th>Invoice math</th><td>${htmlEscape(subMath)}</td></tr>
      <tr><th>Pricing terms</th><td>${htmlEscape(pricingTermsText)}</td></tr>
      <tr><th>Mode</th><td><code>${htmlEscape(String(meta.modeResolved ?? hosted?.modeResolved ?? ""))}</code></td></tr>
      <tr><th>Verifier</th><td><code>${htmlEscape(String(cliOut?.tool?.version ?? ""))}</code> <span class="muted">${htmlEscape(String(cliOut?.tool?.commit ?? ""))}</span></td></tr>
    </tbody></table>`,
    closePackSection,
    "<h3 style=\"margin:14px 0 6px\">Trust</h3>",
    trustConfigured
      ? `<div class="muted">trustRootSetHash=<code>${htmlEscape(trustSetHash)}</code></div><div class="muted">keyIds=<code>${htmlEscape(trustKeyIds.join(", "))}</code></div>`
      : `<div class="muted">No governance trust roots configured.</div>`,
    "</div>",
    "</div>",
    "<div class=\"card\" style=\"margin-top:16px\">",
    "<h2 style=\"margin:0 0 8px\">Details</h2>",
    `<div class="muted">token=<code>${htmlEscape(token)}</code> uploadedAt=<code>${htmlEscape(meta.createdAt)}</code> bundleSha256=<code>${htmlEscape(meta.zipSha256 ?? "")}</code></div>`,
    `<div class="muted">manifestHash=<code>${htmlEscape(sum.manifestHash ?? "")}</code> protocol=<code>${htmlEscape(sum.type ?? "")}</code></div>`,
    `<h3 style="margin:14px 0 6px">Errors (${errors.length})</h3>`,
    errors.length ? `<pre>${htmlEscape(JSON.stringify(errors, null, 2))}</pre>` : "<div class=\"muted\">None</div>",
    `<h3 style="margin:14px 0 6px">Warnings (${warnings.length})</h3>`,
    warnings.length ? `<pre>${htmlEscape(JSON.stringify(warnings, null, 2))}</pre>` : "<div class=\"muted\">None</div>",
    "</div>",
    "</body></html>"
  ].join("\n");
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

async function handleDecisionOtpRequest(req, res, token) {
  let meta;
  try {
    meta = await loadMeta(token);
  } catch {
    return sendText(res, 404, "not found\n");
  }
  if (meta.revokedAt) return sendText(res, 410, "revoked\n");
  if (isExpired(meta.createdAt)) return sendText(res, 410, "expired\n");
  const tenantId = typeof meta.tenantId === "string" ? meta.tenantId : "default";
  const ts = await loadTenantSettings({ dataDir, tenantId });
  {
    const limits = tenantRateLimits(ts);
    const rl = applyRateLimit({ req, tenantId, tenantSettings: ts, category: "decision_otp", limitPerHour: limits.otpRequestsPerHour });
    if (!rl.ok) {
      metrics.incCounter("rate_limit_events_total", { tenantId, category: "decision_otp", scope: rl.scope ?? "tenant" }, 1);
      res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
      return sendJson(res, 429, { ok: false, code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterSeconds: rl.retryAfterSeconds ?? null, scope: rl.scope ?? null });
    }
  }
  const retentionDays = effectiveRetentionDaysForRun({
    tenantSettings: ts,
    vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
    contractId: typeof meta.contractId === "string" ? meta.contractId : null
  });
  if (isPastRetention(meta.createdAt, retentionDays)) return sendText(res, 410, "retained\n");

  const allowedDomains = Array.isArray(ts?.decisionAuthEmailDomains) ? ts.decisionAuthEmailDomains : [];
  if (!allowedDomains.length) {
    metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "false", code: "OTP_DISABLED" }, 1);
    return sendJson(res, 400, { ok: false, code: "OTP_DISABLED", message: "decision OTP is not enabled for this tenant" });
  }

  const contentType = req.headers["content-type"] ? String(req.headers["content-type"]) : "";
  let body = null;
  try {
    if (contentType.includes("application/json")) {
      body = await readJsonBody(req, { maxBytes: 10_000 });
    } else {
      const raw = (await readBody(req, { maxBytes: 10_000 })).toString("utf8");
      const params = new URLSearchParams(raw);
      body = Object.fromEntries(params.entries());
    }
  } catch (err) {
    metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "false", code: String(err?.code ?? "INVALID_REQUEST") }, 1);
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }

  const email = normalizeEmailLower(body?.email ?? body?.actorEmail ?? null);
  if (!email) {
    metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "false", code: "INVALID_EMAIL" }, 1);
    return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
  }
  if (!isEmailAllowedByDomains({ email, allowedDomains })) {
    metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "false", code: "OTP_EMAIL_DOMAIN_FORBIDDEN" }, 1);
    return sendJson(res, 400, { ok: false, code: "OTP_EMAIL_DOMAIN_FORBIDDEN", message: "email domain is not allowed" });
  }

  const issued = await issueDecisionOtp({ dataDir, token, email, ttlSeconds: decisionOtpTtlSeconds, deliveryMode: decisionOtpDeliveryMode, smtp: smtpConfig });
  if (!issued.ok) {
    metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "false", code: String(issued.error ?? "OTP_FAILED") }, 1);
    return sendJson(res, 400, { ok: false, code: issued.error ?? "OTP_FAILED", message: issued.message ?? "otp failed" });
  }
  metrics.incCounter("decision_otp_requests_total", { tenantId: String(tenantId ?? "default"), ok: "true" }, 1);

  if (contentType.includes("application/x-www-form-urlencoded")) {
    res.statusCode = 303;
    res.setHeader("location", `/r/${encodeURIComponent(token)}`);
    res.end("");
    return;
  }
  return sendJson(res, 200, { ok: true, token, email: issued.email, expiresAt: issued.expiresAt });
}

async function buildDecisionClosePackZipBytes({ token, meta } = {}) {
  if (!meta || typeof meta !== "object") throw new TypeError("meta is required");
  const files = new Map();

  if (meta.zipPath) {
    try {
      files.set("bundle.zip", await fs.readFile(meta.zipPath));
    } catch {
      // ignore
    }
  }
  if (meta.verifyJsonPath) {
    try {
      files.set("verify.json", await fs.readFile(meta.verifyJsonPath));
    } catch {
      // ignore
    }
  }
  if (meta.publicJsonPath) {
    try {
      files.set("public_summary.json", await fs.readFile(meta.publicJsonPath));
    } catch {
      // ignore
    }
  }
  if (meta.receiptJsonPath) {
    try {
      files.set("producer_receipt.json", await fs.readFile(meta.receiptJsonPath));
    } catch {
      // ignore
    }
  }
  if (meta.summaryPdfPath) {
    try {
      files.set("invoice_summary.pdf", await fs.readFile(meta.summaryPdfPath));
    } catch {
      // ignore
    }
  }
  if (meta.closePackDir) {
    const base = String(meta.closePackDir);
    for (const name of [
      "closepack_summary_v1.json",
      "evidence_index.json",
      "sla_definition.json",
      "sla_evaluation.json",
      "acceptance_criteria.json",
      "acceptance_evaluation.json"
    ]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        files.set(`closepack/${name}`, await fs.readFile(path.join(base, name)));
      } catch {
        // ignore
      }
    }
  }
  const decisionFiles = await listSettlementDecisionReportFiles({ dataDir, token });
  for (const f of decisionFiles) {
    try {
      // eslint-disable-next-line no-await-in-loop
      files.set(`settlement_decisions/${f.name}`, await fs.readFile(f.path));
    } catch {
      // ignore
    }
  }

  if (files.size === 0) throw new Error("no files available for closepack zip");
  const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
  return Buffer.from(zip);
}

async function ensureDecisionClosePackZip({ token, meta } = {}) {
  if (!token || typeof token !== "string") return { ok: false, error: "INVALID_TOKEN" };
  if (!meta || typeof meta !== "object") return { ok: false, error: "INVALID_META" };
  const outPath = path.join(dataDir, "closepack_exports", `${token}.zip`);
  if (typeof meta.approvalClosePackZipPath === "string" && meta.approvalClosePackZipPath.trim()) {
    try {
      await fs.access(meta.approvalClosePackZipPath);
      return { ok: true, path: meta.approvalClosePackZipPath, reused: true };
    } catch {
      // fall through and rebuild
    }
  }

  let zipBuf = null;
  try {
    zipBuf = await buildDecisionClosePackZipBytes({ token, meta });
  } catch (err) {
    return { ok: false, error: "CLOSEPACK_BUILD_FAILED", detail: { message: err?.message ?? String(err ?? "") } };
  }

  try {
    await ensureDir(outPath);
    await fs.writeFile(outPath, zipBuf);
  } catch (err) {
    return { ok: false, error: "CLOSEPACK_WRITE_FAILED", detail: { message: err?.message ?? String(err ?? "") } };
  }

  try {
    const metaPath = path.join(dataDir, "meta", `${token}.json`);
    const next = { ...meta, approvalClosePackZipPath: outPath };
    await fs.writeFile(metaPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    meta.approvalClosePackZipPath = outPath;
  } catch {
    // ignore metadata persistence failure for best-effort generation
  }
  return { ok: true, path: outPath, bytes: zipBuf.length };
}

async function handleDecision(req, res, token, { internalAutoDecision = false } = {}) {
  let meta;
  try {
    meta = await loadMeta(token);
  } catch {
    return sendText(res, 404, "not found\n");
  }
  if (meta.revokedAt) return sendText(res, 410, "revoked\n");
  if (isExpired(meta.createdAt)) return sendText(res, 410, "expired\n");
  const tenantId = typeof meta.tenantId === "string" ? meta.tenantId : "default";
  const ts = await loadTenantSettings({ dataDir, tenantId });
  if (!internalAutoDecision) {
    const limits = tenantRateLimits(ts);
    const rl = applyRateLimit({ req, tenantId, tenantSettings: ts, category: "decision", limitPerHour: limits.decisionsPerHour });
    if (!rl.ok) {
      metrics.incCounter("rate_limit_events_total", { tenantId, category: "decision", scope: rl.scope ?? "tenant" }, 1);
      res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
      return sendJson(res, 429, { ok: false, code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterSeconds: rl.retryAfterSeconds ?? null, scope: rl.scope ?? null });
    }
  }
  const retentionDays = effectiveRetentionDaysForRun({
    tenantSettings: ts,
    vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
    contractId: typeof meta.contractId === "string" ? meta.contractId : null
  });
  if (isPastRetention(meta.createdAt, retentionDays)) return sendText(res, 410, "retained\n");

  const latestDecision = await loadLatestSettlementDecisionReport({ dataDir, token });
  if (latestDecision && typeof latestDecision.decision === "string" && latestDecision.decision.trim()) {
    const contentTypeExisting = req.headers["content-type"] ? String(req.headers["content-type"]) : "";
    if (contentTypeExisting.includes("application/x-www-form-urlencoded")) {
      res.statusCode = 303;
      res.setHeader("location", `/r/${encodeURIComponent(token)}`);
      res.end("");
      return;
    }
    return sendJson(res, 409, {
      ok: false,
      code: "DECISION_ALREADY_RECORDED",
      message: "decision already recorded",
      detail: {
        decision: latestDecision.decision,
        decidedAt: typeof latestDecision.decidedAt === "string" ? latestDecision.decidedAt : null
      }
    });
  }

  const contentType = req.headers["content-type"] ? String(req.headers["content-type"]) : "";
  let body = null;
  try {
    if (contentType.includes("application/json")) {
      body = await readJsonBody(req, { maxBytes: 50_000 });
    } else {
      const raw = (await readBody(req, { maxBytes: 50_000 })).toString("utf8");
      const params = new URLSearchParams(raw);
      body = Object.fromEntries(params.entries());
    }
  } catch (err) {
    return sendJson(res, 400, { ok: false, code: err?.code ?? "INVALID_REQUEST", message: err?.message ?? "invalid request" });
  }

  const decision = body?.decision ?? body?.action ?? null;
  const decisionNormalized = String(decision ?? "").trim().toLowerCase();
  if (decisionNormalized !== "approve" && decisionNormalized !== "hold") {
    return sendJson(res, 400, { ok: false, code: "INVALID_DECISION", message: "decision must be approve|hold" });
  }
  const actorName = body?.name ?? body?.actorName ?? null;
  const actorEmail = body?.email ?? body?.actorEmail ?? null;
  const otp = body?.otp ?? body?.code ?? body?.otpCode ?? null;
  const note = body?.note ?? null;

  const decisionOtpDomains = Array.isArray(ts?.decisionAuthEmailDomains) ? ts.decisionAuthEmailDomains : [];
  const otpRequired = !internalAutoDecision && decisionOtpDomains.length > 0;
  const actorEmailNorm = normalizeEmailLower(actorEmail);
  if (otpRequired) {
    if (!actorEmailNorm) return sendJson(res, 400, { ok: false, code: "INVALID_EMAIL", message: "email is required" });
    if (!isEmailAllowedByDomains({ email: actorEmailNorm, allowedDomains: decisionOtpDomains })) {
      return sendJson(res, 400, { ok: false, code: "OTP_EMAIL_DOMAIN_FORBIDDEN", message: "email domain is not allowed" });
    }
    if (otp === null || otp === undefined || !String(otp).trim()) {
      return sendJson(res, 400, { ok: false, code: "OTP_REQUIRED", message: "otp code is required" });
    }
    const verified = await verifyAndConsumeDecisionOtp({ dataDir, token, email: actorEmailNorm, code: otp, maxAttempts: decisionOtpMaxAttempts });
    if (!verified.ok) return sendJson(res, 400, { ok: false, code: verified.error ?? "OTP_FAILED", message: verified.message ?? "otp failed" });
  }

  let cliOut = null;
  try {
    cliOut = JSON.parse(await fs.readFile(meta.verifyJsonPath, "utf8"));
  } catch {
    cliOut = null;
  }
  const status = cliOut ? statusFromCliOutput(cliOut) : "processing";
  const policySel = resolvePolicyForRun({ tenantSettings: ts, vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null, contractId: typeof meta.contractId === "string" ? meta.contractId : null });
  const policyEffective = normalizePolicyProfileForEnforcement(policySel.policy);

  if (decisionNormalized === "approve") {
    const okToApprove = status === "green" || (status === "amber" && policyEffective.allowAmberApprovals);
    if (!okToApprove) {
      return sendJson(res, 400, { ok: false, code: "APPROVE_FORBIDDEN", message: "approve is not allowed for this verification status", detail: { status, allowAmberApprovals: Boolean(policyEffective.allowAmberApprovals) } });
    }
  }

  let verifyJsonSha256 = null;
  try {
    const verifyBuf = await fs.readFile(meta.verifyJsonPath);
    verifyJsonSha256 = sha256Hex(verifyBuf);
  } catch {
    verifyJsonSha256 = null;
  }

  const decidedAt = nowIso();

  const pub = meta.publicJsonPath ? await readJsonIfExists(meta.publicJsonPath) : null;
  let manifestHash = typeof pub?.bundle?.manifestHash === "string" ? pub.bundle.manifestHash : typeof cliOut?.summary?.manifestHash === "string" ? cliOut.summary.manifestHash : null;
  let headAttestationHash = typeof pub?.bundle?.headAttestationHash === "string" ? pub.bundle.headAttestationHash : null;

  if (!manifestHash || !headAttestationHash) {
    let unzip = null;
    try {
      unzip = await unzipToTempSafe({
        zipPath: meta.zipPath,
        budgets: { maxEntries: 20_000, maxPathBytes: 512, maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxCompressionRatio: 200 }
      });
      if (unzip.ok) {
        const m = await readJsonIfExists(path.join(unzip.dir, "manifest.json"));
        const a = await readJsonIfExists(path.join(unzip.dir, "attestation", "bundle_head_attestation.json"));
        if (!manifestHash && typeof m?.manifestHash === "string") manifestHash = m.manifestHash;
        if (!headAttestationHash && typeof a?.attestationHash === "string") headAttestationHash = a.attestationHash;
      }
    } finally {
      if (unzip && unzip.ok && unzip.dir) {
        try {
          await fs.rm(unzip.dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  if (!manifestHash || !headAttestationHash) {
    return sendJson(res, 409, { ok: false, code: "DECISION_BINDING_UNAVAILABLE", message: "verification binding hashes are not available", detail: { manifestHash: manifestHash ?? null, headAttestationHash: headAttestationHash ?? null } });
  }

  const errorCodes = Array.isArray(cliOut?.errors) ? cliOut.errors.map((e) => String(e?.code ?? "")).filter(Boolean) : [];
  const warningCodes = Array.isArray(cliOut?.warnings) ? cliOut.warnings.map((w) => String(w?.code ?? "")).filter(Boolean) : [];
  errorCodes.sort();
  warningCodes.sort();

  const policySnapshot = {
    modeRequested: typeof meta.modeRequested === "string" ? meta.modeRequested : null,
    modeRequiredByPolicy: typeof meta.modeRequiredByPolicy === "string" ? meta.modeRequiredByPolicy : null,
    modeForVerification: typeof meta.modeForVerification === "string" ? meta.modeForVerification : null,
    modeResolved: typeof meta.modeResolved === "string" ? meta.modeResolved : null,
    requiredMode: policyEffective.requiredMode ?? null,
    failOnWarnings: Boolean(policyEffective.failOnWarnings),
    allowAmberApprovals: Boolean(policyEffective.allowAmberApprovals),
    requireProducerReceiptPresent: Boolean(policyEffective.requireProducerReceiptPresent),
    requiredPricingMatrixSignerKeyIds: Array.isArray(policyEffective.requiredSignerKeyIds) ? policyEffective.requiredSignerKeyIds : null,
    source: policySel.source ?? null,
    setHash: policyHashHex(policyEffective)
  };

  const actorEmailForReport = actorEmailNorm ?? (typeof actorEmail === "string" ? actorEmail : null);
  const actorAuthMethod = internalAutoDecision ? "system_auto_decision" : otpRequired ? "email_otp" : "none";
  const reportCore = {
    schemaVersion: "SettlementDecisionReport.v1",
    decision: decisionNormalized,
    decidedAt,
    invoiceBundle: { manifestHash, headAttestationHash },
    policy: policySnapshot,
    verification: {
      ok: Boolean(cliOut?.ok),
      verificationOk: Boolean(cliOut?.verificationOk),
      mode: { strict: Boolean(cliOut?.mode?.strict), failOnWarnings: Boolean(cliOut?.mode?.failOnWarnings) },
      errorCodes,
      warningCodes
    },
    tool: {
      name: typeof cliOut?.tool?.name === "string" ? cliOut.tool.name : "settld-verify-hosted",
      version: typeof cliOut?.tool?.version === "string" ? cliOut.tool.version : null,
      commit: typeof cliOut?.tool?.commit === "string" ? cliOut.tool.commit : null
    },
    note: typeof note === "string" ? safeTruncate(note, { max: 2000 }) : null,
    actor: {
      name: typeof actorName === "string" ? safeTruncate(actorName, { max: 200 }) : null,
      email: actorEmailForReport,
      auth: { method: actorAuthMethod },
      client: { ip: typeof req.socket?.remoteAddress === "string" ? req.socket.remoteAddress : null, userAgent: req.headers["user-agent"] ? String(req.headers["user-agent"]) : null }
    },
    hosted: { tenantId: meta.tenantId ?? null, token, zipSha256: meta.zipSha256 ?? null, verifyJsonSha256 }
  };

  let reportHash;
  try {
    reportHash = computeSettlementDecisionReportHashV1(reportCore);
  } catch (err) {
    return sendJson(res, 500, { ok: false, code: "DECISION_REPORT_HASH_FAILED", message: "failed to hash decision report", detail: { message: err?.message ?? String(err ?? "") } });
  }

  const signed = await signHashHexWithSettlementDecisionSigner({
    signer: ts?.settlementDecisionSigner ?? null,
    hashHex: reportHash,
    context: { tenantId: meta.tenantId ?? null, token, zipSha256: meta.zipSha256 ?? null, manifestHash, headAttestationHash, decision: reportCore.decision, decidedAt }
  });
  if (!signed.ok) {
    const code = signed.error ?? "DECISION_SIGNER_FAILED";
    const status = code === "DECISION_SIGNER_NOT_CONFIGURED" ? 409 : 500;
    return sendJson(res, status, { ok: false, code, message: "decision signer is not configured", detail: signed.detail ?? null });
  }

  const report = {
    ...reportCore,
    reportHash,
    signature: signed.signatureBase64,
    signerKeyId: signed.signerKeyId,
    signedAt: decidedAt
  };

  const stored = await appendSettlementDecisionReport({ dataDir, token, report });
  if (!stored.ok) return sendJson(res, 400, { ok: false, code: stored.error ?? "DECISION_STORE_FAILED", message: stored.message ?? "failed to store decision report" });

  try {
    const tenantIdForRecord = typeof meta.tenantId === "string" && meta.tenantId.trim() ? meta.tenantId.trim() : "default";
    await updateRunRecordDecisionBestEffort({ dataDir, tenantId: tenantIdForRecord, token, decisionReport: report });
  } catch {
    // ignore
  }

  try {
    const tenantIdForAudit = typeof meta.tenantId === "string" && meta.tenantId.trim() ? meta.tenantId.trim() : "default";
    await appendAuditRecord({
      dataDir,
      tenantId: tenantIdForAudit,
      record: {
        at: nowIso(),
        action: "SETTLEMENT_DECISION_RECORDED",
        actor: { method: actorAuthMethod, email: actorEmailForReport, name: reportCore?.actor?.name ?? null },
        targetType: "magic_link",
        targetId: token,
        details: {
          decision: reportCore.decision,
          decidedAt,
          reportHash,
          signerKeyId: signed.signerKeyId ?? null,
          manifestHash,
          headAttestationHash,
          verifyJsonSha256
        }
      }
    });
  } catch {
    // ignore
  }

  let closePackZipUrl = null;
  if (decisionNormalized === "approve") {
    const ensured = await ensureDecisionClosePackZip({ token, meta });
    if (ensured.ok) closePackZipUrl = `/r/${token}/closepack.zip`;
  }

  let paymentTrigger = { ok: true, skipped: true, reason: "PAYMENT_TRIGGER_NOT_APPROVED" };
  if (decisionNormalized === "approve") {
    try {
      paymentTrigger = await sendPaymentTriggerOnApproval({
        dataDir,
        tenantId,
        token,
        tenantSettings: ts,
        decisionReport: report,
        publicSummary: pub,
        closePackZipUrl,
        publicBaseUrl,
        settingsKey,
        timeoutMs: webhookTimeoutMs,
        retryMaxAttempts: paymentTriggerMaxAttempts,
        retryBackoffMs: paymentTriggerRetryBackoffMs
      });
    } catch (err) {
      paymentTrigger = { ok: false, skipped: false, reason: "PAYMENT_TRIGGER_EXCEPTION", error: err?.message ?? String(err ?? "payment trigger failed") };
    }
    metrics.incCounter("payment_trigger_deliveries_total", { tenantId, ok: paymentTrigger.ok ? "true" : "false" }, 1);
  }

  try {
    const tenantIdForWebhook = typeof meta.tenantId === "string" && meta.tenantId.trim() ? meta.tenantId.trim() : "default";
    const event = decisionNormalized === "approve" ? "decision.approved" : "decision.held";
    const payload = buildWebhookPayload({
      event,
      tenantId: tenantIdForWebhook,
      token,
      zipSha256: typeof meta.zipSha256 === "string" ? meta.zipSha256 : null,
      zipBytes: Number.isFinite(Number(meta.zipBytes)) ? Number(meta.zipBytes) : null,
      modeResolved: typeof meta.modeResolved === "string" ? meta.modeResolved : null,
      modeRequested: typeof meta.modeRequested === "string" ? meta.modeRequested : null,
      cliOut,
      publicBaseUrl,
      decisionReport: report,
      publicSummary: pub,
      closePackZipUrl
    });
    const webhookResults = await deliverTenantWebhooks({
      dataDir,
      tenantId: tenantIdForWebhook,
      token,
      event,
      payload,
      webhooks: ts?.webhooks ?? [],
      settingsKey,
      deliveryMode: webhookDeliveryMode,
      timeoutMs: webhookTimeoutMs,
      maxAttempts: webhookMaxAttempts,
      retryBackoffMs: webhookRetryBackoffMs
    });
    for (const r of webhookResults) {
      const ok = Boolean(r && r.ok);
      metrics.incCounter("webhook_deliveries_total", { tenantId: tenantIdForWebhook, event, ok: ok ? "true" : "false" }, 1);
    }
    await enqueueWebhookRetriesBestEffort({
      tenantId: tenantIdForWebhook,
      token,
      event,
      payload,
      webhooks: ts?.webhooks ?? [],
      deliveryResults: webhookResults
    });
  } catch {
    // ignore webhook delivery failures for decision path
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    res.statusCode = 303;
    res.setHeader("location", `/r/${encodeURIComponent(token)}`);
    res.end("");
    return;
  }
  return sendJson(res, 200, {
    ok: true,
    token,
    decisionReport: report,
    closePackZipUrl,
    paymentTrigger: {
      ok: Boolean(paymentTrigger?.ok),
      skipped: Boolean(paymentTrigger?.skipped),
      reason: typeof paymentTrigger?.reason === "string" ? paymentTrigger.reason : null,
      idempotencyKey: typeof paymentTrigger?.idempotencyKey === "string" ? paymentTrigger.idempotencyKey : null,
      queued: Boolean(paymentTrigger?.queued),
      attemptCount: Number.isInteger(paymentTrigger?.attemptCount) ? paymentTrigger.attemptCount : null,
      maxAttempts: Number.isInteger(paymentTrigger?.maxAttempts) ? paymentTrigger.maxAttempts : null,
      nextAttemptAt: typeof paymentTrigger?.nextAttemptAt === "string" ? paymentTrigger.nextAttemptAt : null
    },
    stored: { name: stored.name ?? null, seq: stored.seq ?? null }
  });
}

async function handleDownload(req, res, token, which) {
  let meta;
  try {
    meta = await loadMeta(token);
  } catch {
    return sendText(res, 404, "not found\n");
  }
  if (meta.revokedAt) return sendText(res, 410, "revoked\n");
  if (isExpired(meta.createdAt)) return sendText(res, 410, "expired\n");
  const tenantId = typeof meta.tenantId === "string" ? meta.tenantId : "default";
  const ts = await loadTenantSettings({ dataDir, tenantId });
  {
    const limits = tenantRateLimits(ts);
    const rl = applyRateLimit({ req, tenantId, tenantSettings: ts, category: "verification_view", limitPerHour: limits.verificationViewsPerHour });
    if (!rl.ok) {
      metrics.incCounter("rate_limit_events_total", { tenantId, category: "verification_view", scope: rl.scope ?? "tenant" }, 1);
      res.setHeader("retry-after", String(rl.retryAfterSeconds ?? 60));
      return sendJson(res, 429, { ok: false, code: "RATE_LIMITED", message: "rate limit exceeded", retryAfterSeconds: rl.retryAfterSeconds ?? null, scope: rl.scope ?? null });
    }
  }
  const retentionDays = effectiveRetentionDaysForRun({
    tenantSettings: ts,
    vendorId: typeof meta.vendorId === "string" ? meta.vendorId : null,
    contractId: typeof meta.contractId === "string" ? meta.contractId : null
  });
  if (isPastRetention(meta.createdAt, retentionDays)) return sendText(res, 410, "retained\n");

  if (which === "bundle.zip") {
    if (!meta.zipPath) return sendText(res, 404, "not found\n");
    let buf;
    try {
      buf = await fs.readFile(meta.zipPath);
    } catch {
      return sendText(res, 404, "not found\n");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"bundle.zip\"");
    res.end(buf);
    return;
  }
  if (which === "verify.json") {
    const buf = await fs.readFile(meta.verifyJsonPath);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"verify.json\"");
    res.end(buf);
    return;
  }
  if (which === "receipt.json") {
    if (!meta.receiptJsonPath) return sendText(res, 404, "not found\n");
    const buf = await fs.readFile(meta.receiptJsonPath);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"verification_report.json\"");
    res.end(buf);
    return;
  }
  if (which === "summary.pdf") {
    if (!meta.summaryPdfPath) return sendText(res, 404, "not found\n");
    const buf = await fs.readFile(meta.summaryPdfPath);
    res.statusCode = 200;
    res.setHeader("content-type", "application/pdf");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"invoice_summary.pdf\"");
    res.end(buf);
    return;
  }
  if (which === "settlement_decision_report.json") {
    const rep = await loadLatestSettlementDecisionReport({ dataDir, token });
    if (!rep) return sendText(res, 404, "not found\n");
    const buf = Buffer.from(JSON.stringify(rep, null, 2) + "\n", "utf8");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"settlement_decision_report.json\"");
    res.end(buf);
    return;
  }
  if (which === "settlement_decision_reports.zip") {
    const list = await listSettlementDecisionReportFiles({ dataDir, token });
    if (!list.length) return sendText(res, 404, "not found\n");
    const files = new Map();
    for (const f of list) {
      // eslint-disable-next-line no-await-in-loop
      files.set(f.name, await fs.readFile(f.path));
    }
    const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"settlement_decision_reports.zip\"");
    res.end(Buffer.from(zip));
    return;
  }
  if (which === "closepack.zip") {
    const decisionReport = await loadLatestSettlementDecisionReport({ dataDir, token });
    const decision = typeof decisionReport?.decision === "string" ? decisionReport.decision : null;
    if (decision !== "approve") return sendText(res, 404, "not found\n");

    let fp = typeof meta.approvalClosePackZipPath === "string" ? meta.approvalClosePackZipPath : null;
    if (!fp) {
      const ensured = await ensureDecisionClosePackZip({ token, meta });
      if (!ensured.ok || !ensured.path) return sendText(res, 404, "not found\n");
      fp = ensured.path;
    }
    let buf;
    try {
      buf = await fs.readFile(fp);
    } catch {
      return sendText(res, 404, "not found\n");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"closepack.zip\"");
    res.end(buf);
    return;
  }
  if (which && which.startsWith("closepack/")) {
    const rel = which.slice("closepack/".length);
    const allowed = new Set([
      "closepack_summary_v1.json",
      "evidence_index.json",
      "sla_definition.json",
      "sla_evaluation.json",
      "acceptance_criteria.json",
      "acceptance_evaluation.json"
    ]);
    if (!allowed.has(rel)) return sendText(res, 404, "not found\n");
    const dir = typeof meta.closePackDir === "string" && meta.closePackDir.trim() ? meta.closePackDir : null;
    if (!dir) return sendText(res, 404, "not found\n");
    const fp = path.join(dir, rel);
    let buf;
    try {
      buf = await fs.readFile(fp);
    } catch {
      return sendText(res, 404, "not found\n");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", `attachment; filename=\"${rel}\"`);
    res.end(buf);
    return;
  }
  if (which === "audit-packet.zip") {
    const files = new Map();
    files.set("bundle.zip", await fs.readFile(meta.zipPath));
    files.set("verify.json", await fs.readFile(meta.verifyJsonPath));
    if (meta.publicJsonPath) files.set("public_summary.json", await fs.readFile(meta.publicJsonPath));
    if (meta.receiptJsonPath) files.set("producer_receipt.json", await fs.readFile(meta.receiptJsonPath));
    if (meta.summaryPdfPath) files.set("invoice_summary.pdf", await fs.readFile(meta.summaryPdfPath));
    const decisionFiles = await listSettlementDecisionReportFiles({ dataDir, token });
    for (const f of decisionFiles) {
      // eslint-disable-next-line no-await-in-loop
      files.set(`settlement_decisions/${f.name}`, await fs.readFile(f.path));
    }
    if (meta.closePackDir) {
      const base = String(meta.closePackDir);
      for (const name of [
        "closepack_summary_v1.json",
        "evidence_index.json",
        "sla_definition.json",
        "sla_evaluation.json",
        "acceptance_criteria.json",
        "acceptance_evaluation.json"
      ]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          files.set(`closepack/${name}`, await fs.readFile(path.join(base, name)));
        } catch {
          // ignore
        }
      }
    }

    const zip = buildDeterministicZipStore({ files, mtime: new Date("2000-01-01T00:00:00.000Z") });
    res.statusCode = 200;
    res.setHeader("content-type", "application/zip");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-disposition", "attachment; filename=\"audit_packet.zip\"");
    res.end(Buffer.from(zip));
    return;
  }
  return sendText(res, 404, "not found\n");
}

export async function magicLinkHandler(req, res) {
  const method = String(req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true });
    if (method === "GET" && pathname === "/healthz") {
      const sig = await readinessSignals();
      return sendJson(res, sig.dataDirWritable ? 200 : 503, { ok: Boolean(sig.dataDirWritable), ...sig });
    }
    if (method === "GET" && pathname === "/pricing") return await handlePricingPage(req, res);
    if (method === "GET" && pathname === "/metrics") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(metrics.renderPrometheusText());
      return;
    }
    if (method === "POST" && pathname === "/v1/upload") return await handleUpload(req, res);
    if (method === "POST" && pathname === "/v1/revoke") return await handleRevoke(req, res);
    if (method === "GET" && pathname === "/v1/inbox") return await handleInbox(req, res, url);
    if (method === "GET" && pathname === "/v1/buyer/me") return await handleBuyerMe(req, res);
    if (method === "POST" && pathname === "/v1/buyer/logout") return await handleBuyerLogout(req, res);
    if (method === "POST" && pathname === "/v1/public/signup") return await handlePublicSignup(req, res);
    if (method === "POST" && pathname === "/v1/tenants") return await handleTenantCreate(req, res);
    if (method === "POST" && pathname === "/v1/billing/stripe/webhook") return await handleStripeBillingWebhook(req, res);

    const ingestMatch = /^\/v1\/ingest\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname);
    if (ingestMatch) {
      const tenantId = ingestMatch[1];
      if (method === "POST") return await handleIngestUpload(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const buyerOtpMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/buyer\/login\/otp$/.exec(pathname);
    if (buyerOtpMatch) {
      const tenantId = buyerOtpMatch[1];
      if (method === "POST") return await handleBuyerLoginOtpRequest(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const buyerLoginMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/buyer\/login$/.exec(pathname);
    if (buyerLoginMatch) {
      const tenantId = buyerLoginMatch[1];
      if (method === "POST") return await handleBuyerLogin(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const buyerUsersMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/buyer\/users$/.exec(pathname);
    if (buyerUsersMatch) {
      const tenantId = buyerUsersMatch[1];
      if (method === "GET") return await handleBuyerUsersList(req, res, tenantId);
      if (method === "POST") return await handleBuyerUsersUpsert(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettingsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settings$/.exec(pathname);
    if (tenantSettingsMatch) {
      const tenantId = tenantSettingsMatch[1];
      if (method === "GET") return await handleTenantSettingsGet(req, res, tenantId);
      if (method === "PUT") return await handleTenantSettingsPut(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantPlanMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/plan$/.exec(pathname);
    if (tenantPlanMatch) {
      const tenantId = tenantPlanMatch[1];
      if (method === "POST") return await handleTenantPlanSet(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantEntitlementsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/entitlements$/.exec(pathname);
    if (tenantEntitlementsMatch) {
      const tenantId = tenantEntitlementsMatch[1];
      if (method === "GET") return await handleTenantEntitlementsGet(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantUploadMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/upload$/.exec(pathname);
    if (tenantUploadMatch) {
      const tenantId = tenantUploadMatch[1];
      if (method === "POST") return await handleTenantUpload(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantOnboardingMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding$/.exec(pathname);
    if (tenantOnboardingMatch) {
      const tenantId = tenantOnboardingMatch[1];
      if (method === "GET") return await handleTenantOnboardingPage(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantOnboardingEventsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/events$/.exec(pathname);
    if (tenantOnboardingEventsMatch) {
      const tenantId = tenantOnboardingEventsMatch[1];
      if (method === "POST") return await handleTenantOnboardingEvent(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantOnboardingMetricsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding-metrics$/.exec(pathname);
    if (tenantOnboardingMetricsMatch) {
      const tenantId = tenantOnboardingMetricsMatch[1];
      if (method === "GET") return await handleTenantOnboardingMetrics(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantRuntimeBootstrapMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/runtime-bootstrap$/.exec(pathname);
    if (tenantRuntimeBootstrapMatch) {
      const tenantId = tenantRuntimeBootstrapMatch[1];
      if (method === "POST") return await handleTenantRuntimeBootstrap(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantRuntimeBootstrapSmokeMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/runtime-bootstrap\/smoke-test$/.exec(pathname);
    if (tenantRuntimeBootstrapSmokeMatch) {
      const tenantId = tenantRuntimeBootstrapSmokeMatch[1];
      if (method === "POST") return await handleTenantRuntimeBootstrapSmokeTest(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantFirstPaidCallMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/first-paid-call$/.exec(pathname);
    if (tenantFirstPaidCallMatch) {
      const tenantId = tenantFirstPaidCallMatch[1];
      if (method === "POST") return await handleTenantFirstPaidCall(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantFirstPaidCallHistoryMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/first-paid-call\/history$/.exec(pathname);
    if (tenantFirstPaidCallHistoryMatch) {
      const tenantId = tenantFirstPaidCallHistoryMatch[1];
      if (method === "GET") return await handleTenantFirstPaidCallHistory(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantRuntimeConformanceMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/conformance-matrix$/.exec(pathname);
    if (tenantRuntimeConformanceMatch) {
      const tenantId = tenantRuntimeConformanceMatch[1];
      if (method === "POST") return await handleTenantRuntimeConformanceMatrix(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantIntegrationsPageMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/integrations$/.exec(pathname);
    if (tenantIntegrationsPageMatch) {
      const tenantId = tenantIntegrationsPageMatch[1];
      if (method === "GET") return await handleTenantIntegrationsPage(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesPageMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies$/.exec(pathname);
    if (tenantSettlementPoliciesPageMatch) {
      const tenantId = tenantSettlementPoliciesPageMatch[1];
      if (method === "GET") return await handleTenantSettlementPoliciesPage(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantAnalyticsDashboardMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/analytics\/dashboard$/.exec(pathname);
    if (tenantAnalyticsDashboardMatch) {
      const tenantId = tenantAnalyticsDashboardMatch[1];
      if (method === "GET") return await handleTenantAnalyticsDashboard(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantIntegrationsStateMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/integrations\/state$/.exec(pathname);
    if (tenantIntegrationsStateMatch) {
      const tenantId = tenantIntegrationsStateMatch[1];
      if (method === "GET") return await handleTenantIntegrationsState(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesStateMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/state$/.exec(pathname);
    if (tenantSettlementPoliciesStateMatch) {
      const tenantId = tenantSettlementPoliciesStateMatch[1];
      if (method === "GET") return await handleTenantSettlementPoliciesState(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesPresetsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/presets$/.exec(pathname);
    if (tenantSettlementPoliciesPresetsMatch) {
      const tenantId = tenantSettlementPoliciesPresetsMatch[1];
      if (method === "GET") return await handleTenantSettlementPolicyPresets(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesPresetApplyMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/presets\/apply$/.exec(pathname);
    if (tenantSettlementPoliciesPresetApplyMatch) {
      const tenantId = tenantSettlementPoliciesPresetApplyMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicyPresetApply(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesUpsertMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/upsert$/.exec(pathname);
    if (tenantSettlementPoliciesUpsertMatch) {
      const tenantId = tenantSettlementPoliciesUpsertMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicyUpsert(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesRolloutMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/rollout$/.exec(pathname);
    if (tenantSettlementPoliciesRolloutMatch) {
      const tenantId = tenantSettlementPoliciesRolloutMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicyRollout(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesRollbackMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/rollback$/.exec(pathname);
    if (tenantSettlementPoliciesRollbackMatch) {
      const tenantId = tenantSettlementPoliciesRollbackMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicyRollback(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesDiffMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/diff$/.exec(pathname);
    if (tenantSettlementPoliciesDiffMatch) {
      const tenantId = tenantSettlementPoliciesDiffMatch[1];
      if (method === "GET") return await handleTenantSettlementPolicyDiff(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesDefaultMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/default$/.exec(pathname);
    if (tenantSettlementPoliciesDefaultMatch) {
      const tenantId = tenantSettlementPoliciesDefaultMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicySetDefault(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSettlementPoliciesReplayMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/settlement-policies\/test-replay$/.exec(pathname);
    if (tenantSettlementPoliciesReplayMatch) {
      const tenantId = tenantSettlementPoliciesReplayMatch[1];
      if (method === "POST") return await handleTenantSettlementPolicyTestReplay(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantIntegrationsOauthStartMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/integrations\/(slack|zapier)\/oauth\/start$/.exec(pathname);
    if (tenantIntegrationsOauthStartMatch) {
      const tenantId = tenantIntegrationsOauthStartMatch[1];
      const provider = tenantIntegrationsOauthStartMatch[2];
      if (method === "GET") return await handleTenantIntegrationOauthStart(req, res, tenantId, provider);
      return sendText(res, 405, "method not allowed\n");
    }

    const integrationsOauthCallbackMatch = /^\/v1\/integrations\/(slack|zapier)\/oauth\/callback$/.exec(pathname);
    if (integrationsOauthCallbackMatch) {
      const provider = integrationsOauthCallbackMatch[1];
      if (method === "GET") return await handleIntegrationOauthCallback(req, res, provider, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantIntegrationsActionMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/integrations\/(slack|zapier)\/(connect|disconnect|test-send)$/.exec(pathname);
    if (tenantIntegrationsActionMatch) {
      const tenantId = tenantIntegrationsActionMatch[1];
      const provider = tenantIntegrationsActionMatch[2];
      const action = tenantIntegrationsActionMatch[3];
      if (method !== "POST") return sendText(res, 405, "method not allowed\n");
      if (action === "connect") return await handleTenantIntegrationConnect(req, res, tenantId, provider);
      if (action === "disconnect") return await handleTenantIntegrationDisconnect(req, res, tenantId, provider);
      if (action === "test-send") return await handleTenantIntegrationTestSend(req, res, tenantId, provider);
      return sendText(res, 404, "not found\n");
    }

    const tenantSlaTemplatesMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/sla-templates$/.exec(pathname);
    if (tenantSlaTemplatesMatch) {
      const tenantId = tenantSlaTemplatesMatch[1];
      if (method === "GET") return await handleTenantSlaTemplatesList(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSlaTemplatesRenderMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/sla-templates\/render$/.exec(pathname);
    if (tenantSlaTemplatesRenderMatch) {
      const tenantId = tenantSlaTemplatesRenderMatch[1];
      if (method === "POST") return await handleTenantSlaTemplateRender(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantDemoTrustMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/onboarding\/demo-trust$/.exec(pathname);
    if (tenantDemoTrustMatch) {
      const tenantId = tenantDemoTrustMatch[1];
      if (method === "POST") return await handleTenantOnboardingEnableDemoTrust(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSampleZipMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/samples\/closepack\/(known-good|known-bad)\.zip$/.exec(pathname);
    if (tenantSampleZipMatch) {
      const tenantId = tenantSampleZipMatch[1];
      const sample = tenantSampleZipMatch[2];
      if (method === "GET") return await handleTenantSampleDownload(req, res, tenantId, { kind: "closepack", sample });
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSampleUploadMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/samples\/closepack\/(known-good|known-bad)\/upload$/.exec(pathname);
    if (tenantSampleUploadMatch) {
      const tenantId = tenantSampleUploadMatch[1];
      const sample = tenantSampleUploadMatch[2];
      if (method === "POST") return await handleTenantSampleUpload(req, res, tenantId, url, { kind: "closepack", sample });
      return sendText(res, 405, "method not allowed\n");
    }

    const ingestKeysCreateMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/vendors\/([a-zA-Z0-9_-]{1,64})\/ingest-keys$/.exec(pathname);
    if (ingestKeysCreateMatch) {
      const tenantId = ingestKeysCreateMatch[1];
      const vendorId = ingestKeysCreateMatch[2];
      if (method === "POST") return await handleIngestKeyCreate(req, res, tenantId, vendorId);
      return sendText(res, 405, "method not allowed\n");
    }

    const onboardingPackMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/vendors\/([a-zA-Z0-9_-]{1,64})\/onboarding-pack$/.exec(pathname);
    if (onboardingPackMatch) {
      const tenantId = onboardingPackMatch[1];
      const vendorId = onboardingPackMatch[2];
      if (method === "POST") return await handleVendorOnboardingPack(req, res, tenantId, vendorId);
      return sendText(res, 405, "method not allowed\n");
    }

    const ingestKeysRevokeMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/ingest-keys\/([0-9a-f]{64})\/revoke$/.exec(pathname);
    if (ingestKeysRevokeMatch) {
      const tenantId = ingestKeysRevokeMatch[1];
      const keyHash = ingestKeysRevokeMatch[2];
      if (method === "POST") return await handleIngestKeyRevoke(req, res, tenantId, keyHash);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantUsageMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/usage$/.exec(pathname);
    if (tenantUsageMatch) {
      const tenantId = tenantUsageMatch[1];
      if (method === "GET") return await handleTenantUsageGet(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingUsageMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing\/usage$/.exec(pathname);
    if (tenantBillingUsageMatch) {
      const tenantId = tenantBillingUsageMatch[1];
      if (method === "GET") return await handleTenantUsageGet(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingStateMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing\/state$/.exec(pathname);
    if (tenantBillingStateMatch) {
      const tenantId = tenantBillingStateMatch[1];
      if (method === "GET") return await handleTenantBillingStateGet(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingCheckoutMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing\/checkout$/.exec(pathname);
    if (tenantBillingCheckoutMatch) {
      const tenantId = tenantBillingCheckoutMatch[1];
      if (method === "POST") return await handleTenantBillingCheckoutCreate(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingPortalMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing\/portal$/.exec(pathname);
    if (tenantBillingPortalMatch) {
      const tenantId = tenantBillingPortalMatch[1];
      if (method === "POST") return await handleTenantBillingPortalCreate(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingInvoiceMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing-invoice$/.exec(pathname);
    if (tenantBillingInvoiceMatch) {
      const tenantId = tenantBillingInvoiceMatch[1];
      if (method === "GET") return await handleTenantBillingInvoiceExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantBillingInvoiceDraftMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/billing\/invoice-draft$/.exec(pathname);
    if (tenantBillingInvoiceDraftMatch) {
      const tenantId = tenantBillingInvoiceDraftMatch[1];
      if (method === "GET") return await handleTenantBillingInvoiceExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantAuditPacketMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/audit-packet$/.exec(pathname);
    if (tenantAuditPacketMatch) {
      const tenantId = tenantAuditPacketMatch[1];
      if (method === "GET") return await handleTenantAuditPacketExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantArchiveExportMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/archive-export$/.exec(pathname);
    if (tenantArchiveExportMatch) {
      const tenantId = tenantArchiveExportMatch[1];
      if (method === "POST") return await handleTenantArchiveExportTrigger(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSecurityControlsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/security-controls-packet$/.exec(pathname);
    if (tenantSecurityControlsMatch) {
      const tenantId = tenantSecurityControlsMatch[1];
      if (method === "GET") return await handleTenantSecurityControlsPacketExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantSupportBundleMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/support-bundle$/.exec(pathname);
    if (tenantSupportBundleMatch) {
      const tenantId = tenantSupportBundleMatch[1];
      if (method === "GET") return await handleTenantSupportBundleExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantCsvExportMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/export\.csv$/.exec(pathname);
    if (tenantCsvExportMatch) {
      const tenantId = tenantCsvExportMatch[1];
      if (method === "GET") return await handleTenantCsvExport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantAnalyticsReportMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/analytics$/.exec(pathname);
    if (tenantAnalyticsReportMatch) {
      const tenantId = tenantAnalyticsReportMatch[1];
      if (method === "GET") return await handleTenantAnalyticsReport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantTrustGraphMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/trust-graph$/.exec(pathname);
    if (tenantTrustGraphMatch) {
      const tenantId = tenantTrustGraphMatch[1];
      if (method === "GET") return await handleTenantTrustGraph(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantTrustGraphSnapshotsMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/trust-graph\/snapshots$/.exec(pathname);
    if (tenantTrustGraphSnapshotsMatch) {
      const tenantId = tenantTrustGraphSnapshotsMatch[1];
      if (method === "GET") return await handleTenantTrustGraphSnapshotsList(req, res, tenantId, url);
      if (method === "POST") return await handleTenantTrustGraphSnapshotCreate(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantTrustGraphDiffMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/trust-graph\/diff$/.exec(pathname);
    if (tenantTrustGraphDiffMatch) {
      const tenantId = tenantTrustGraphDiffMatch[1];
      if (method === "GET") return await handleTenantTrustGraphDiff(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantRoiReportMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/roi-report$/.exec(pathname);
    if (tenantRoiReportMatch) {
      const tenantId = tenantRoiReportMatch[1];
      if (method === "GET") return await handleTenantRoiReport(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantWebhookRetryListMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/webhook-retries$/.exec(pathname);
    if (tenantWebhookRetryListMatch) {
      const tenantId = tenantWebhookRetryListMatch[1];
      if (method === "GET") return await handleTenantWebhookRetryList(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantWebhookRetryRunMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/webhook-retries\/run-once$/.exec(pathname);
    if (tenantWebhookRetryRunMatch) {
      const tenantId = tenantWebhookRetryRunMatch[1];
      if (method === "POST") return await handleTenantWebhookRetryRunOnce(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantWebhookDeadLetterReplayLatestMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/webhook-retries\/replay-latest$/.exec(pathname);
    if (tenantWebhookDeadLetterReplayLatestMatch) {
      const tenantId = tenantWebhookDeadLetterReplayLatestMatch[1];
      if (method === "POST") return await handleTenantWebhookDeadLetterReplayLatest(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantWebhookDeadLetterReplayMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/webhook-retries\/([A-Za-z0-9_-]{1,128})\/replay$/.exec(pathname);
    if (tenantWebhookDeadLetterReplayMatch) {
      const tenantId = tenantWebhookDeadLetterReplayMatch[1];
      const token = tenantWebhookDeadLetterReplayMatch[2];
      if (method === "POST") return await handleTenantWebhookDeadLetterReplay(req, res, tenantId, token, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantPaymentTriggerRetryListMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/payment-trigger-retries$/.exec(pathname);
    if (tenantPaymentTriggerRetryListMatch) {
      const tenantId = tenantPaymentTriggerRetryListMatch[1];
      if (method === "GET") return await handleTenantPaymentTriggerRetryList(req, res, tenantId, url);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantPaymentTriggerRetryRunMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/payment-trigger-retries\/run-once$/.exec(pathname);
    if (tenantPaymentTriggerRetryRunMatch) {
      const tenantId = tenantPaymentTriggerRetryRunMatch[1];
      if (method === "POST") return await handleTenantPaymentTriggerRetryRunOnce(req, res, tenantId);
      return sendText(res, 405, "method not allowed\n");
    }

    const tenantPaymentTriggerDeadLetterReplayMatch = /^\/v1\/tenants\/([a-zA-Z0-9_-]{1,64})\/payment-trigger-retries\/(ml_[0-9a-f]{48})\/replay$/.exec(pathname);
    if (tenantPaymentTriggerDeadLetterReplayMatch) {
      const tenantId = tenantPaymentTriggerDeadLetterReplayMatch[1];
      const token = tenantPaymentTriggerDeadLetterReplayMatch[2];
      if (method === "POST") return await handleTenantPaymentTriggerDeadLetterReplay(req, res, tenantId, token);
      return sendText(res, 405, "method not allowed\n");
    }

    const publicReceiptSummaryMatch = /^\/v1\/public\/receipts\/(ml_[0-9a-f]{48})$/.exec(pathname);
    if (publicReceiptSummaryMatch) {
      if (method === "GET") return await handlePublicReceiptSummary(req, res, publicReceiptSummaryMatch[1]);
      return sendText(res, 405, "method not allowed\n");
    }

    const publicReceiptBadgeMatch = /^\/v1\/public\/receipts\/(ml_[0-9a-f]{48})\/badge\.svg$/.exec(pathname);
    if (publicReceiptBadgeMatch) {
      if (method === "GET") return await handlePublicReceiptBadge(req, res, publicReceiptBadgeMatch[1], url);
      return sendText(res, 405, "method not allowed\n");
    }

    const otpMatch = /^\/r\/(ml_[0-9a-f]{48})\/otp\/request$/.exec(pathname);
    if (otpMatch && method === "POST") {
      return await handleDecisionOtpRequest(req, res, otpMatch[1]);
    }

    const decisionMatch = /^\/r\/(ml_[0-9a-f]{48})\/decision$/.exec(pathname);
    if (decisionMatch && method === "POST") {
      return await handleDecision(req, res, decisionMatch[1]);
    }

    const m =
      /^\/r\/(ml_[0-9a-f]{48})(?:\/(bundle\.zip|verify\.json|receipt\.json|summary\.pdf|audit-packet\.zip|closepack\.zip|settlement_decision_report\.json|settlement_decision_reports\.zip|closepack\/closepack_summary_v1\.json|closepack\/evidence_index\.json|closepack\/sla_definition\.json|closepack\/sla_evaluation\.json|closepack\/acceptance_criteria\.json|closepack\/acceptance_evaluation\.json))?$/.exec(
        pathname
      );
    if (method === "GET" && m) {
      const token = m[1];
      const which = m[2] ?? null;
      if (!which) return await handleReport(req, res, token);
      return await handleDownload(req, res, token, which);
    }

    return sendText(res, 404, "not found\n");
  } catch (err) {
    return sendJson(res, 500, { ok: false, code: "INTERNAL", message: err?.message ?? String(err ?? "error") });
  }
}

export const magicLinkServer = http.createServer(magicLinkHandler);

const archiveExportEnabled = String(process.env.MAGIC_LINK_ARCHIVE_EXPORT_ENABLED ?? "1").trim() !== "0";
const archiveExportIntervalSeconds = Number.parseInt(String(process.env.MAGIC_LINK_ARCHIVE_EXPORT_INTERVAL_SECONDS ?? "86400"), 10);
if (!Number.isInteger(archiveExportIntervalSeconds) || archiveExportIntervalSeconds < 60) throw new Error("MAGIC_LINK_ARCHIVE_EXPORT_INTERVAL_SECONDS must be an integer >= 60");

function startArchiveExportScheduler() {
  if (!archiveExportEnabled) return;
  const tick = async () => {
    const month = previousMonthKey(monthKeyUtcNow());
    if (!month) return;
    const tenantIds = await listTenantIdsFromDiskBestEffort();
    for (const tenantId of tenantIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await runTenantArchiveExportOnce({ tenantId, month });
      } catch {
        // ignore per-tenant failures
      }
    }
  };
  tick().catch(() => {});
  const timer = setInterval(() => {
    tick().catch(() => {});
  }, archiveExportIntervalSeconds * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

if (process.env.MAGIC_LINK_DISABLE_LISTEN !== "1") {
  if (socketPath) {
    try {
      const st = await fs.lstat(socketPath);
      if (!st.isSocket()) throw new Error("MAGIC_LINK_SOCKET_PATH exists and is not a unix socket");
      await fs.rm(socketPath);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    magicLinkServer.listen(socketPath, () => {
      // eslint-disable-next-line no-console
      console.log(`magic-link listening on unix:${socketPath} dataDir=${dataDir}`);
      startArchiveExportScheduler();
    });
  } else {
    magicLinkServer.listen(port, host, () => {
      const addr = magicLinkServer.address();
      const actualPort = typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : port;
      // eslint-disable-next-line no-console
      console.log(`magic-link listening on ${host}:${actualPort} dataDir=${dataDir}`);
      startArchiveExportScheduler();
    });
  }
}
