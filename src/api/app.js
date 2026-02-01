import { createStore } from "./store.js";
import { readJsonBody, sendError, sendJson, sendText } from "./http.js";
import { createId } from "../core/ids.js";
import { appendChainedEvent, createChainedEvent, verifyChainedEvents } from "../core/event-chain.js";
import { keyIdFromPublicKeyPem, sha256Hex, verifyHashHexEd25519 } from "../core/crypto.js";
import { listKnownEventTypes, requiredSignerKindForEventType, SIGNER_KIND } from "../core/event-policy.js";
import { canonicalJsonStringify, normalizeForCanonicalJson } from "../core/canonical-json.js";
import { reduceJob } from "../core/job-reducer.js";
import { ledgerEntriesForJobEvent } from "../core/ledger-postings.js";
import { makeIdempotencyEndpoint, makeIdempotencyStoreKey, normalizePrincipalId } from "../core/idempotency.js";
import { authKeyId, authKeySecret, hashAuthKeySecret, normalizeAuthKeyStatus, normalizeScopes } from "../core/auth.js";
import { isWithinAccessWindow, validateAccessPlanIssuedPayload, validateAccessResultPayload, validateAccessRevokedPayload } from "../core/access.js";
import { validateSkillLicensedPayload, validateSkillUsedPayload } from "../core/skills.js";
import { validateIncidentDetectedPayload, validateIncidentReportedPayload } from "../core/incidents.js";
import { validateEvidenceCapturedPayload, validateEvidenceExpiredPayload, validateEvidenceViewedPayload } from "../core/evidence.js";
import { validateZoneCoverageReportedPayload } from "../core/zone-coverage.js";
import { validateProofEvaluatedPayload } from "../core/proof-events.js";
import { verifyZoneCoverageProofV1 } from "../core/proof-verifier.js";
import { computeZoneSetHash, validateZoneSetV1 } from "../core/zoneset.js";
import {
  computeClaimTotalCents,
  validateClaimApprovedPayload,
  validateClaimDeniedPayload,
  validateClaimOpenedPayload,
  validateClaimPaidPayload,
  validateClaimTriagedPayload,
  validateJobAdjustedPayload
} from "../core/claims.js";
import { reduceRobot } from "../core/robot-reducer.js";
import { reduceOperator } from "../core/operator-reducer.js";
import { validateRobotAvailabilitySetPayload, validateRobotStatusChangedPayload } from "../core/robots.js";
import {
  validateMaintenanceCompletedPayload,
  validateMaintenanceRequestedPayload,
  validateRobotQuarantineClearedPayload,
  validateRobotQuarantinedPayload,
  validateRobotUnhealthyPayload
} from "../core/robot-health.js";
import { validateOperatorShiftClosedPayload, validateOperatorShiftOpenedPayload } from "../core/operators.js";
import {
  ENV_TIER,
  validateBookedPayload,
  validateBookingWindowInput,
  validateReservedPayload,
  windowsOverlap as bookingWindowsOverlap
} from "../core/booking.js";
import { robotIsAvailableForWindow } from "../core/robots.js";
import { computeQuote } from "../core/pricing.js";
import { selectRobotForJob } from "../core/dispatch.js";
import {
  computeLivenessPolicy,
  validateJobExecutionAbortedPayload,
  validateJobExecutionCompletedPayload,
  validateJobExecutionResumedPayload,
  validateJobExecutionStartedPayload,
  validateJobExecutionStalledPayload,
  validateJobHeartbeatPayload
} from "../core/liveness.js";
import { validateJobRescheduledPayload } from "../core/rescheduling.js";
import { validateJobCancelledPayload } from "../core/cancellation.js";
import { normalizeZoneId } from "../core/zones.js";
import { computeSlaPolicy } from "../core/sla.js";
import { getPilotTemplate, listPilotTemplates } from "../core/pilot-templates.js";
import {
  validateDispatchConfirmedPayload,
  validateDispatchEvaluatedPayload,
  validateDispatchFailedPayload,
  validateDispatchRequestedPayload
} from "../core/dispatch-events.js";
import { validateOperatorCoverageReleasedPayload, validateOperatorCoverageReservedPayload } from "../core/operator-coverage.js";
import {
  validateAssistAcceptedPayload,
  validateAssistAssignedPayload,
  validateAssistDeclinedPayload,
  validateAssistQueuedPayload,
  validateAssistRequestedPayload,
  validateAssistTimeoutPayload
} from "../core/assist.js";
import { computeOperatorCostCents, validateOperatorCostRecordedPayload } from "../core/operator-cost.js";
import {
  SLA_BREACH_TYPE,
  SLA_CREDIT_TRIGGER_TYPE,
  validateSlaBreachDetectedPayload,
  validateSlaCreditIssuedPayload
} from "../core/sla-events.js";
import { buildAuditExport, buildEvidenceExport } from "../core/audit-export.js";
import { DEFAULT_TENANT_ID, makeScopedKey, normalizeTenantId, parseScopedKey } from "../core/tenancy.js";
import {
  COVERAGE_FEE_MODEL,
  CREDIT_FUNDING_MODEL,
  applyContractSlaOverrides,
  createDefaultContract,
  selectBestContract,
  validateContract
} from "../core/contracts.js";
import { computeMonthlyStatement, parseYearMonth, statementToCsv } from "../core/statements.js";
import { computeGlBatchBodyV1 } from "../core/gl-batch.js";
import { computeFinanceAccountMapHash, validateFinanceAccountMapV1 } from "../core/finance-account-map.js";
import { renderJournalCsvV1 } from "../core/journal-csv.js";
import { buildEvidenceDownloadUrl, verifyEvidenceDownload } from "../core/evidence-store.js";
import { computeHoldExposureV1 } from "../core/hold-exposure.js";
import { buildDeterministicZipStore, sha256HexBytes } from "../core/deterministic-zip.js";
import { buildFinancePackBundleV1 } from "../core/finance-pack-bundle.js";
import { buildMonthProofBundleV1 } from "../core/proof-bundle.js";
import {
  ARTIFACT_TYPE,
  buildMonthlyStatementV1,
  buildHeldExposureRollforwardV1,
  buildPartyStatementV1,
  buildPayoutInstructionV1,
  buildJournalCsvV1,
  buildGlBatchV1,
  buildFinancePackBundlePointerV1,
  computeArtifactHash,
  hmacSignArtifact,
  sliceEventsThroughChainHash
} from "../core/artifacts.js";
import { buildPolicySnapshot, computePolicyHash } from "../core/policy.js";
import { MONTH_CLOSE_BASIS, makeMonthCloseStreamId, reduceMonthClose, validateMonthCloseRequestedPayload, validateMonthClosedPayload, validateMonthCloseReopenedPayload } from "../core/month-close.js";
import { MONTH_CLOSE_HOLD_POLICY, normalizeMonthCloseHoldPolicy } from "../core/month-close-hold-policy.js";
import {
  GOVERNANCE_STREAM_ID,
  validateServerSignerKeyRegisteredPayload,
  validateServerSignerKeyRevokedPayload,
  validateServerSignerKeyRotatedPayload,
  validateTenantPolicyUpdatedPayload
} from "../core/governance.js";
import { computePartyStatement, computePayoutAmountCentsForStatement, jobIdFromLedgerMemo, payoutKeyFor } from "../core/party-statements.js";
import { RISK_BASIS, computeRiskAssessment, validateRiskScoredPayload } from "../core/risk.js";
import { FINANCE_STREAM_ID, validateInsurerReimbursementRecordedPayload } from "../core/insurer-reimbursements.js";
import { ledgerEntriesForFinanceEvent } from "../core/ledger-postings-finance.js";
import { createArtifactWorker, deriveArtifactEnqueuesFromJobEvents } from "./workers/artifacts.js";
import { createDeliveryWorker } from "./workers/deliveries.js";
import { createProofWorker, deriveProofEvalEnqueuesFromJobEvents } from "./workers/proof.js";
import { processOutbox as processInMemoryOutbox } from "./outbox.js";
import { authenticateRequest, requireScope } from "./middleware/auth.js";
import { normalizeSignerKeyPurpose, normalizeSignerKeyStatus, SIGNER_KEY_PURPOSE, SIGNER_KEY_STATUS } from "../core/signer-keys.js";
import { getLogContext, logger, withLogContext } from "../core/log.js";
import { createMetrics } from "../core/metrics.js";
import { makeOpsAuditRecord } from "../core/ops-audit.js";
import { createSecretsProvider } from "../core/secrets.js";
import { checkUrlSafety, checkUrlSafetySync } from "../core/url-safety.js";
import { clampRetentionDays, computeExpiresAtIso } from "../core/retention.js";
import { clampQuota, isQuotaExceeded } from "../core/quotas.js";
import { buildOpenApiSpec } from "./openapi.js";
import { RETENTION_CLEANUP_ADVISORY_LOCK_KEY } from "../core/maintenance-locks.js";
import { compareProtocolVersions, parseProtocolVersion, resolveProtocolPolicy } from "../core/protocol.js";
import {
  CONTRACT_DOCUMENT_TYPE_V1,
  contractDocumentV1FromLegacyContract,
  hashContractDocumentV1,
  validateContractDocumentV1
} from "../core/contract-document.js";
import { CONTRACT_COMPILER_ID, compileBookingPolicySnapshot, compileContractPolicyTemplate } from "../core/contract-compiler.js";
import { reconcileGlBatchAgainstPartyStatements } from "../../packages/artifact-verify/src/index.js";

export function createApi({
  store = createStore(),
  now = () => new Date().toISOString(),
  opsTokens = null,
  opsToken = null,
  exportDestinations = null,
  ingestToken = null,
  deliveryMaxAttempts = 10,
  deliveryBackoffBaseMs = 1000,
  deliveryBackoffMaxMs = 60_000,
  deliveryRandom = Math.random,
  fetchFn = null,
  rateLimitRpm = null,
  rateLimitBurst = null,
  protocol = null
} = {}) {
  const apiStartedAtMs = Date.now();
  const apiStartedAtIso = new Date(apiStartedAtMs).toISOString();

  const protocolPolicy = resolveProtocolPolicy(protocol ?? {});

  const serverSigner = { keyId: store.serverSigner.keyId, privateKeyPem: store.serverSigner.privateKeyPem };
  const OPS_SCOPES = Object.freeze({
    OPS_READ: "ops_read",
    OPS_WRITE: "ops_write",
    FINANCE_READ: "finance_read",
    FINANCE_WRITE: "finance_write",
    AUDIT_READ: "audit_read",
    GOVERNANCE_TENANT_READ: "governance_tenant_read",
    GOVERNANCE_TENANT_WRITE: "governance_tenant_write",
    GOVERNANCE_GLOBAL_READ: "governance_global_read",
    GOVERNANCE_GLOBAL_WRITE: "governance_global_write"
  });
  const ALL_OPS_SCOPES = new Set(Object.values(OPS_SCOPES));

  const opsTokensRaw = opsTokens ?? (typeof process !== "undefined" ? (process.env.PROXY_OPS_TOKENS ?? null) : null);
  const legacyOpsTokenRaw = opsToken ?? (typeof process !== "undefined" ? (process.env.PROXY_OPS_TOKEN ?? null) : null);
  const rateLimitRpmRaw = rateLimitRpm ?? (typeof process !== "undefined" ? (process.env.PROXY_RATE_LIMIT_RPM ?? null) : null);
  const rateLimitBurstRaw = rateLimitBurst ?? (typeof process !== "undefined" ? (process.env.PROXY_RATE_LIMIT_BURST ?? null) : null);

  const evidenceSigningSecret =
    typeof process !== "undefined" && typeof process.env.PROXY_EVIDENCE_SIGNING_SECRET === "string" && process.env.PROXY_EVIDENCE_SIGNING_SECRET.trim() !== ""
      ? process.env.PROXY_EVIDENCE_SIGNING_SECRET.trim()
      : sha256Hex(store.serverSigner.privateKeyPem);

  const exportDestinationsRaw =
    exportDestinations ?? (typeof process !== "undefined" ? (process.env.PROXY_EXPORT_DESTINATIONS ?? null) : null);

  const rateLimitRpmValue = rateLimitRpmRaw && String(rateLimitRpmRaw).trim() !== "" ? Number(rateLimitRpmRaw) : 0;
  if (rateLimitRpmRaw && String(rateLimitRpmRaw).trim() !== "" && (!Number.isFinite(rateLimitRpmValue) || rateLimitRpmValue <= 0)) {
    throw new TypeError("PROXY_RATE_LIMIT_RPM must be a positive number");
  }
  const rateLimitBurstValue = rateLimitRpmValue
    ? rateLimitBurstRaw && String(rateLimitBurstRaw).trim() !== ""
      ? Number(rateLimitBurstRaw)
      : rateLimitRpmValue
    : 0;
  if (rateLimitRpmValue && (!Number.isFinite(rateLimitBurstValue) || rateLimitBurstValue <= 0)) {
    throw new TypeError("PROXY_RATE_LIMIT_BURST must be a positive number");
  }
  const rateBuckets = new Map(); // tenantId -> { tokens, lastMs }
  const rateRefillPerMs = rateLimitRpmValue ? rateLimitRpmValue / 60_000 : 0;

  function setProtocolResponseHeaders(res) {
    try {
      res.setHeader("x-settld-protocol", protocolPolicy.current);
      res.setHeader("x-settld-supported-protocols", protocolPolicy.supported.join(","));
      if (protocolPolicy.buildId) res.setHeader("x-settld-build", String(protocolPolicy.buildId));
    } catch {
      // ignore
    }
  }

  function parseAndValidateRequestProtocol({ req, required }) {
    const header = req?.headers?.["x-settld-protocol"] ? String(req.headers["x-settld-protocol"]).trim() : "";
    if (!header) {
      if (required) {
        return { ok: false, statusCode: 400, code: "PROTOCOL_VERSION_REQUIRED", message: "x-settld-protocol is required" };
      }
      return { ok: true, protocol: protocolPolicy.current, assumed: true };
    }

    let p;
    try {
      p = parseProtocolVersion(header).raw;
    } catch (err) {
      return { ok: false, statusCode: 400, code: "INVALID_PROTOCOL_VERSION", message: err?.message ?? "invalid protocol" };
    }

    try {
      if (compareProtocolVersions(p, protocolPolicy.min) < 0) {
        return { ok: false, statusCode: 426, code: "PROTOCOL_TOO_OLD", message: "protocol too old", details: { min: protocolPolicy.min } };
      }
      if (compareProtocolVersions(p, protocolPolicy.max) > 0) {
        return { ok: false, statusCode: 400, code: "PROTOCOL_TOO_NEW", message: "protocol too new", details: { max: protocolPolicy.max } };
      }
    } catch (err) {
      return { ok: false, statusCode: 400, code: "INVALID_PROTOCOL_VERSION", message: err?.message ?? "invalid protocol" };
    }

    const dep = protocolPolicy.deprecations?.byVersion?.get?.(p) ?? null;
    if (dep?.cutoffAt) {
      const cutoffMs = Date.parse(dep.cutoffAt);
      const nowMs = Date.parse(nowIso());
      if (Number.isFinite(cutoffMs) && Number.isFinite(nowMs) && nowMs > cutoffMs) {
        return { ok: false, statusCode: 426, code: "PROTOCOL_DEPRECATED", message: "protocol deprecated", details: { cutoffAt: dep.cutoffAt } };
      }
    }

    return { ok: true, protocol: p, assumed: false };
  }

  function requireProtocolHeaderForWrite(req, res) {
    const check = parseAndValidateRequestProtocol({ req, required: protocolPolicy.requireHeader });
    if (!check.ok) {
      sendError(res, check.statusCode ?? 400, check.message ?? "invalid protocol", check.details ?? null, { code: check.code ?? "INVALID_PROTOCOL_VERSION" });
      return false;
    }
    return true;
  }

  function parseEventSchemaVersionFromBody(body) {
    if (!body || typeof body !== "object") return { ok: true, schemaVersion: 1, assumed: true };
    const raw = body?.schemaVersion ?? body?.schema_version ?? null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return { ok: true, schemaVersion: 1, assumed: true };
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, statusCode: 400, code: "INVALID_EVENT_SCHEMA", message: "schemaVersion must be an integer" };
    }
    if (n !== 1) {
      return { ok: false, statusCode: 400, code: "UNSUPPORTED_EVENT_VERSION", message: "unsupported event schemaVersion", details: { supported: [1] } };
    }
    return { ok: true, schemaVersion: n, assumed: false };
  }

  function takeRateLimitToken({ tenantId }) {
    if (!rateLimitRpmValue) return { ok: true };
    const nowMs = Date.now();
    const key = normalizeTenant(tenantId);
    const existing = rateBuckets.get(key) ?? null;
    const lastMs = existing?.lastMs ?? nowMs;
    const elapsedMs = Math.max(0, nowMs - lastMs);
    const prevTokens =
      typeof existing?.tokens === "number" && Number.isFinite(existing.tokens) ? existing.tokens : rateLimitBurstValue;
    const refilled = Math.min(rateLimitBurstValue, prevTokens + elapsedMs * rateRefillPerMs);
    if (refilled < 1) {
      const waitMs = rateRefillPerMs > 0 ? Math.ceil((1 - refilled) / rateRefillPerMs) : 60_000;
      const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
      rateBuckets.set(key, { tokens: refilled, lastMs: nowMs });
      return { ok: false, retryAfterSeconds };
    }
    rateBuckets.set(key, { tokens: refilled - 1, lastMs: nowMs });
    return { ok: true };
  }

  function parseExportDestinations(raw) {
    if (raw === null || raw === undefined) return new Map();
    const text = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
    if (!text) return new Map();
    let parsed;
    try {
      parsed = typeof raw === "string" ? JSON.parse(text) : raw;
    } catch (err) {
      throw new TypeError(`invalid PROXY_EXPORT_DESTINATIONS JSON: ${err?.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("export destinations must be a JSON object mapping tenantId -> destinations[]");
    const map = new Map();
    for (const [tenantIdRaw, list] of Object.entries(parsed)) {
      const tenantId = normalizeTenantId(tenantIdRaw);
      if (!Array.isArray(list)) throw new TypeError(`export destinations for ${tenantId} must be an array`);
      const normalized = [];
      for (const d of list) {
        if (!d || typeof d !== "object" || Array.isArray(d)) throw new TypeError("destination must be an object");
        const destinationId = d.destinationId ? String(d.destinationId) : null;
        const kind = d.kind ? String(d.kind) : "webhook";
        if (!destinationId) throw new TypeError("destination requires destinationId");
        const artifactTypes = d.artifactTypes ? (Array.isArray(d.artifactTypes) ? d.artifactTypes.map(String) : null) : null;
        if (kind === "webhook") {
          const url = d.url ? String(d.url) : null;
          const secretRef = d.secretRef ? String(d.secretRef) : d.credentialRef ? String(d.credentialRef) : null;
          const secret = d.secret ? String(d.secret) : null;
          if (!url || (!secretRef && !secret)) throw new TypeError("webhook destination requires url and (secretRef or secret)");
          if (
            secret &&
            !secretRef &&
            typeof process !== "undefined" &&
            process.env.NODE_ENV === "production" &&
            process.env.PROXY_ALLOW_INLINE_SECRETS !== "1"
          ) {
            throw new TypeError("inline webhook secrets are not allowed in production; use secretRef");
          }
          normalized.push({ destinationId, kind, url, secretRef: secretRef ?? null, secret: secretRef ? null : secret, artifactTypes });
          continue;
        }
        if (kind === "s3") {
          const endpoint = d.endpoint ? String(d.endpoint) : null;
          const region = d.region ? String(d.region) : "us-east-1";
          const bucket = d.bucket ? String(d.bucket) : null;
          const accessKeyIdRef = d.accessKeyIdRef ? String(d.accessKeyIdRef) : null;
          const secretAccessKeyRef = d.secretAccessKeyRef ? String(d.secretAccessKeyRef) : null;
          const accessKeyId = d.accessKeyId ? String(d.accessKeyId) : null;
          const secretAccessKey = d.secretAccessKey ? String(d.secretAccessKey) : null;
          const forcePathStyle = d.forcePathStyle === false ? false : true;
          const prefix = d.prefix ? String(d.prefix) : "";
          if (!endpoint || !bucket || (!accessKeyIdRef && !accessKeyId) || (!secretAccessKeyRef && !secretAccessKey)) {
            throw new TypeError("s3 destination requires endpoint, bucket, and (accessKeyIdRef or accessKeyId) and (secretAccessKeyRef or secretAccessKey)");
          }
          if (
            accessKeyId &&
            secretAccessKey &&
            !accessKeyIdRef &&
            !secretAccessKeyRef &&
            typeof process !== "undefined" &&
            process.env.NODE_ENV === "production" &&
            process.env.PROXY_ALLOW_INLINE_SECRETS !== "1"
          ) {
            throw new TypeError("inline s3 credentials are not allowed in production; use accessKeyIdRef/secretAccessKeyRef");
          }
          normalized.push({
            destinationId,
            kind,
            endpoint,
            region,
            bucket,
            accessKeyIdRef: accessKeyIdRef ?? null,
            secretAccessKeyRef: secretAccessKeyRef ?? null,
            accessKeyId: accessKeyIdRef ? null : accessKeyId,
            secretAccessKey: secretAccessKeyRef ? null : secretAccessKey,
            forcePathStyle,
            prefix,
            artifactTypes
          });
          continue;
        }
        throw new TypeError(`unsupported destination kind: ${kind}`);
      }
      map.set(tenantId, normalized);
    }
    return map;
  }

  const exportDestinationsByTenant = parseExportDestinations(exportDestinationsRaw);
  const listDestinationsForTenant = (tenantId) => exportDestinationsByTenant.get(normalizeTenantId(tenantId)) ?? [];

  const ingestTokenValue =
    ingestToken ?? (typeof process !== "undefined" ? (process.env.PROXY_INGEST_TOKEN ?? null) : null);

  function parseNonNegativeIntEnv(name, fallback) {
    if (typeof process === "undefined" || !process.env) return fallback;
    const raw = process.env[name] ?? null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
    return n;
  }

  const quotaPlatformMaxOpenJobs = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_OPEN_JOBS", 0);
  const quotaPlatformMaxPendingDeliveries = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_PENDING_DELIVERIES", 0);
  const quotaPlatformMaxIngestDlqDepth = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_INGEST_DLQ_DEPTH", 0);
  const quotaPlatformMaxEvidenceRefsPerJob = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_EVIDENCE_REFS_PER_JOB", 0);
  const quotaPlatformMaxArtifactsPerJobType = parseNonNegativeIntEnv("PROXY_QUOTA_PLATFORM_MAX_ARTIFACTS_PER_JOB_TYPE", 0);

  const ingestRecordsRetentionMaxDays = parseNonNegativeIntEnv("PROXY_RETENTION_INGEST_RECORDS_MAX_DAYS", 0);
  const outboxMaxAttempts = (() => {
    const raw = typeof process !== "undefined" ? (process.env.PROXY_OUTBOX_MAX_ATTEMPTS ?? null) : null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return 25;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("PROXY_OUTBOX_MAX_ATTEMPTS must be a positive integer");
    return n;
  })();

  const retentionCleanupDefaultBatchSize = (() => {
    const n = parseNonNegativeIntEnv("PROXY_RETENTION_CLEANUP_BATCH_SIZE", 500);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("PROXY_RETENTION_CLEANUP_BATCH_SIZE must be a positive safe integer");
    return n;
  })();

  const retentionCleanupDefaultMaxMillis = (() => {
    const n = parseNonNegativeIntEnv("PROXY_RETENTION_CLEANUP_MAX_MILLIS", 1500);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError("PROXY_RETENTION_CLEANUP_MAX_MILLIS must be a positive safe integer");
    return n;
  })();

  const retentionCleanupDefaultDryRun = typeof process !== "undefined" && process.env.PROXY_RETENTION_CLEANUP_DRY_RUN === "1";

  const evidenceContentTypeAllowlist = (() => {
    if (typeof process === "undefined" || !process.env) return null;
    const raw = process.env.PROXY_EVIDENCE_CONTENT_TYPE_ALLOWLIST ?? null;
    if (raw === null || raw === undefined || String(raw).trim() === "") return null;
    const list = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return null;
    return new Set(list);
  })();

  const evidenceRequireSizeBytes =
    typeof process !== "undefined" && typeof process.env.PROXY_EVIDENCE_REQUIRE_SIZE_BYTES === "string" && process.env.PROXY_EVIDENCE_REQUIRE_SIZE_BYTES === "1";

  const evidenceMaxSizeBytes = parseNonNegativeIntEnv("PROXY_EVIDENCE_MAX_SIZE_BYTES", 0);

  function parseOpsTokens(raw) {
    if (raw === null || raw === undefined) return new Map();
    const text = String(raw).trim();
    if (!text) return new Map();

    const map = new Map();
    const entries = text
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [tokenRaw, scopesRaw] = entry.split(":");
      const token = tokenRaw ? tokenRaw.trim() : "";
      if (!token) continue;
      const scopes = new Set();
      const scopesList = scopesRaw
        ? scopesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      for (const s of scopesList) {
        if (!ALL_OPS_SCOPES.has(s)) throw new TypeError(`unknown ops scope: ${s}`);
        scopes.add(s);
      }
      map.set(token, scopes);
    }
    return map;
  }

  let opsTokenScopes = parseOpsTokens(opsTokensRaw);
  const normalizedLegacyOpsToken = typeof legacyOpsTokenRaw === "string" ? legacyOpsTokenRaw.trim() : "";
  if (opsTokenScopes.size === 0 && normalizedLegacyOpsToken) {
    // Back-compat: a single ops token grants full access.
    opsTokenScopes = new Map([[normalizedLegacyOpsToken, new Set(ALL_OPS_SCOPES)]]);
  }

  function nowIso() {
    const value = typeof now === "function" ? now() : new Date().toISOString();
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw new TypeError("now() must return an ISO date string");
    return value;
  }

  // Keep in-memory derived subsystems (deliveries/correlations) time-consistent in tests.
  if (store && typeof store === "object" && typeof store.nowIso === "function") {
    store.nowIso = nowIso;
  }

  const metrics = store?.metrics && typeof store.metrics.incCounter === "function" ? store.metrics : createMetrics();
  try {
    store.metrics = metrics;
  } catch {}

  const secrets = store?.secrets && typeof store.secrets.getSecret === "function" ? store.secrets : createSecretsProvider();
  try {
    store.secrets = secrets;
  } catch {}

  function metricInc(name, labels, value = 1) {
    try {
      metrics.incCounter(name, labels, value);
    } catch {}
  }

  function metricGauge(name, labels, value) {
    try {
      metrics.setGauge(name, labels, value);
    } catch {}
  }

  const knownOutboxKindsForGauge = new Set();
  const knownDeliveryDlqDestinationsForGauge = new Set();

  async function refreshOutboxPendingGauges() {
    const counts = new Map();

    if (store?.kind === "pg" && store?.pg?.pool) {
      try {
        const res = await store.pg.pool.query("SELECT topic, COUNT(*)::bigint AS count FROM outbox WHERE processed_at IS NULL GROUP BY topic");
        for (const row of res.rows) {
          const kind = row?.topic ? String(row.topic) : null;
          if (!kind) continue;
          const n = Number(row.count);
          counts.set(kind, Number.isFinite(n) ? n : 0);
        }
      } catch {
        // ignore
      }
    } else if (Array.isArray(store?.outbox)) {
      const cursor = Number.isSafeInteger(store?.outboxCursor) ? store.outboxCursor : 0;
      for (let i = cursor; i < store.outbox.length; i += 1) {
        const msg = store.outbox[i];
        const kind = msg?.type ? String(msg.type) : null;
        if (!kind) continue;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }

    for (const kind of counts.keys()) knownOutboxKindsForGauge.add(kind);
    for (const kind of knownOutboxKindsForGauge) metricGauge("outbox_pending_gauge", { kind }, 0);
    for (const [kind, count] of counts.entries()) metricGauge("outbox_pending_gauge", { kind }, count);
  }

  function parseTopReasonCodesFromMetrics({ metricPrefix, snapshot, topN = 10 } = {}) {
    const out = new Map(); // reason -> count
    if (!snapshot || typeof snapshot !== "object") return [];
    const counters = snapshot.counters ?? {};
    if (!counters || typeof counters !== "object") return [];
    for (const [k, vRaw] of Object.entries(counters)) {
      if (typeof k !== "string" || !k.startsWith(`${metricPrefix}|`)) continue;
      const idx = k.indexOf("reason=");
      if (idx === -1) continue;
      const reason = k.slice(idx + "reason=".length).trim();
      if (!reason) continue;
      const v = Number(vRaw);
      if (!Number.isFinite(v) || v <= 0) continue;
      out.set(reason, (out.get(reason) ?? 0) + v);
    }
    const rows = Array.from(out.entries()).map(([reason, count]) => ({ reason, count }));
    rows.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return rows.slice(0, Math.max(0, Math.min(50, Number(topN) || 0)));
  }

  async function computeOpsBacklogSummary({ tenantId, includeOutbox = true } = {}) {
    const outboxByKind = includeOutbox ? {} : null;
    let deliveriesPending = 0;
    let deliveriesFailed = 0;
    let ingestRejected = 0;
    const deliveryDlqTopDestinations = [];

    if (store?.kind === "pg" && store?.pg?.pool) {
      if (includeOutbox) {
        try {
          const res = await store.pg.pool.query("SELECT topic, COUNT(*)::bigint AS count FROM outbox WHERE processed_at IS NULL GROUP BY topic");
          for (const row of res.rows ?? []) {
            const kind = row?.topic ? String(row.topic) : null;
            if (!kind) continue;
            const n = Number(row?.count ?? 0);
            outboxByKind[kind] = Number.isFinite(n) ? n : 0;
          }
        } catch {}
      }

      try {
        const res = await store.pg.pool.query(
          "SELECT state, COUNT(*)::bigint AS count FROM deliveries WHERE tenant_id = $1 AND state IN ('pending','failed') GROUP BY state",
          [tenantId]
        );
        for (const row of res.rows ?? []) {
          const state = row?.state ? String(row.state) : "";
          const n = Number(row?.count ?? 0);
          const count = Number.isFinite(n) ? n : 0;
          if (state === "pending") deliveriesPending = count;
          if (state === "failed") deliveriesFailed = count;
        }
      } catch {}

      // DLQ visibility: top destinations by failed delivery count (bounded to avoid high-cardinality).
      try {
        const res = await store.pg.pool.query(
          `
            SELECT destination_id, COUNT(*)::bigint AS count
            FROM deliveries
            WHERE tenant_id = $1 AND state = 'failed'
            GROUP BY destination_id
            ORDER BY COUNT(*) DESC, destination_id ASC
            LIMIT 10
          `,
          [tenantId]
        );
        for (const row of res.rows ?? []) {
          const destinationId = row?.destination_id ? String(row.destination_id) : null;
          if (!destinationId) continue;
          const n = Number(row?.count ?? 0);
          deliveryDlqTopDestinations.push({ destinationId, count: Number.isFinite(n) ? n : 0 });
        }
      } catch {}

      try {
        const res = await store.pg.pool.query("SELECT COUNT(*)::bigint AS count FROM ingest_records WHERE tenant_id = $1 AND status = 'rejected'", [tenantId]);
        const n = Number(res.rows?.[0]?.count ?? 0);
        ingestRejected = Number.isFinite(n) ? n : 0;
      } catch {}
    } else {
      if (includeOutbox) {
        const counts = new Map();
        const cursor = Number.isSafeInteger(store?.outboxCursor) ? store.outboxCursor : 0;
        for (let i = cursor; i < (store?.outbox?.length ?? 0); i += 1) {
          const msg = store.outbox[i];
          const kind = msg?.type ? String(msg.type) : null;
          if (!kind) continue;
          counts.set(kind, (counts.get(kind) ?? 0) + 1);
        }
        for (const [kind, count] of counts.entries()) outboxByKind[kind] = count;
      }

      if (store?.deliveries instanceof Map) {
        const byDestination = new Map();
        for (const d of store.deliveries.values()) {
          if (!d || typeof d !== "object") continue;
          const state = d.state ?? null;
          if (state === "pending") deliveriesPending += 1;
          if (state === "failed") {
            deliveriesFailed += 1;
            const destId = d.destinationId ? String(d.destinationId) : null;
            if (destId) byDestination.set(destId, (byDestination.get(destId) ?? 0) + 1);
          }
        }
        const rows = Array.from(byDestination.entries()).map(([destinationId, count]) => ({ destinationId, count }));
        rows.sort((a, b) => b.count - a.count || a.destinationId.localeCompare(b.destinationId));
        deliveryDlqTopDestinations.push(...rows.slice(0, 10));
      }

      if (store?.ingestRecords instanceof Map) {
        for (const r of store.ingestRecords.values()) {
          if (r?.status === "rejected") ingestRejected += 1;
        }
      }
    }

    return {
      outboxByKind: includeOutbox ? outboxByKind : null,
      deliveriesPending,
      deliveriesFailed,
      ingestRejected,
      deliveryDlqTopDestinations
    };
  }

  async function fetchMaintenanceRetentionRunInfo({ tenantId }) {
    if (typeof store.listOpsAudit !== "function") return { last: null, lastOk: null };
    try {
      const records = await store.listOpsAudit({ tenantId, limit: 200, offset: 0 });
      let last = null;
      let lastOk = null;
      for (const r of records ?? []) {
        if (!r || typeof r !== "object") continue;
        if (r.action !== "MAINTENANCE_RETENTION_RUN") continue;
        if (!last) last = r;
        const outcome = r?.details?.outcome ?? null;
        if (!lastOk && outcome === "ok") lastOk = r;
        if (last && lastOk) break;
      }
      return { last, lastOk };
    } catch {
      return { last: null, lastOk: null };
    }
  }

	  async function refreshAlertGauges({ tenantId }) {
	    await refreshOutboxPendingGauges();

	    const backlog = await computeOpsBacklogSummary({ tenantId, includeOutbox: false });
	    metricGauge("deliveries_pending_gauge", { state: "pending" }, Number(backlog?.deliveriesPending ?? 0));
	    metricGauge("deliveries_pending_gauge", { state: "failed" }, Number(backlog?.deliveriesFailed ?? 0));
	    metricGauge("ingest_rejected_gauge", null, Number(backlog?.ingestRejected ?? 0));
	    metricGauge("delivery_dlq_pending_total_gauge", null, Number(backlog?.deliveriesFailed ?? 0));

    const topDlq = Array.isArray(backlog?.deliveryDlqTopDestinations) ? backlog.deliveryDlqTopDestinations : [];
    for (const row of topDlq) {
      if (!row?.destinationId) continue;
      knownDeliveryDlqDestinationsForGauge.add(String(row.destinationId));
    }
    for (const destinationId of knownDeliveryDlqDestinationsForGauge) {
      metricGauge("delivery_dlq_pending_by_destination_gauge", { destinationId }, 0);
    }
    for (const row of topDlq) {
      const destinationId = row?.destinationId ? String(row.destinationId) : null;
      if (!destinationId) continue;
      const n = Number(row?.count ?? 0);
      metricGauge("delivery_dlq_pending_by_destination_gauge", { destinationId }, Number.isFinite(n) ? n : 0);
    }

    const retentionInfo = await fetchMaintenanceRetentionRunInfo({ tenantId });
    const last = retentionInfo?.last ?? null;
    const lastOk = retentionInfo?.lastOk ?? null;

    const lastRunAtMs = last?.at ? Date.parse(String(last.at)) : NaN;
    const lastOkAtMs = lastOk?.at ? Date.parse(String(lastOk.at)) : NaN;
    metricGauge("maintenance_last_run_unixtime", { kind: "retention_cleanup" }, Number.isFinite(lastRunAtMs) ? Math.floor(lastRunAtMs / 1000) : 0);
    metricGauge("maintenance_last_success_unixtime", { kind: "retention_cleanup" }, Number.isFinite(lastOkAtMs) ? Math.floor(lastOkAtMs / 1000) : 0);

	    const outcome = last?.details?.outcome ?? null;
	    metricGauge("maintenance_last_run_ok_gauge", { kind: "retention_cleanup" }, outcome === "ok" ? 1 : 0);

	    // Settlement holds: finance-operability gauges (count + aging distribution).
	    try {
	      const nowAt = nowIso();
	      const nowMs = Date.parse(nowAt);
	      let heldCount = 0;
	      let oldestAgeSeconds = 0;

	      const ages = [];
	      for (const job of listJobs({ tenantId })) {
	        const hold = job?.settlementHold ?? null;
	        if (!hold || typeof hold !== "object") continue;
	        const status = typeof hold.status === "string" ? hold.status.toUpperCase() : "";
	        if (status !== "HELD") continue;
	        heldCount += 1;
	        const heldAt = hold.heldAt ?? null;
	        const heldAtMs = heldAt ? Date.parse(String(heldAt)) : NaN;
	        const ageSeconds = Number.isFinite(nowMs) && Number.isFinite(heldAtMs) ? Math.max(0, Math.floor((nowMs - heldAtMs) / 1000)) : 0;
	        ages.push(ageSeconds);
	        if (ageSeconds > oldestAgeSeconds) oldestAgeSeconds = ageSeconds;
	      }

	      metricGauge("settlement_holds_open_gauge", { status: "HELD" }, heldCount);
	      metricGauge("settlement_hold_oldest_age_seconds_gauge", null, oldestAgeSeconds);

	      // Use Prom-style bucket gauges for a snapshot distribution of open holds.
	      const buckets = [3600, 6 * 3600, 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600];
	      ages.sort((a, b) => a - b);
	      let idx = 0;
	      for (const b of buckets) {
	        while (idx < ages.length && ages[idx] <= b) idx += 1;
	        metricGauge("settlement_hold_age_seconds_bucket", { le: String(b) }, idx);
	      }
	      metricGauge("settlement_hold_age_seconds_bucket", { le: "+Inf" }, ages.length);
	    } catch {
	      // ignore
	    }
	  }

  function inferIngestReasonCode(reason) {
    const msg = typeof reason === "string" ? reason.trim() : "";
    if (!msg) return "UNKNOWN";
    const lower = msg.toLowerCase();

    if (lower === "event.at is too far in the future") return "FUTURE_TIMESTAMP";
    if (lower === "too many events in request") return "INGEST_MAX_EVENTS_EXCEEDED";
    if (lower === "tenant quota exceeded") return "TENANT_QUOTA_EXCEEDED";
    if (lower.includes("signature policy rejected")) return "SIGNATURE_POLICY";
    if (lower.includes("event chain verification failed")) return "CHAIN_BREAK";
    if (lower.includes("job transition rejected") || lower.includes("transition")) return "TRANSITION_ILLEGAL";
    if (lower.startsWith("unsupported signerkind=")) return "SIGNATURE_POLICY";
    if (lower === "ingest cannot spoof robot/operator actors") return "SIGNATURE_POLICY";
    if (lower.includes(" is required") || lower.startsWith("invalid ") || lower.includes("must be")) return "SCHEMA_INVALID";

    return "EVENT_REJECTED";
  }

  async function commitTx(ops, { audit = null } = {}) {
    if (!Array.isArray(ops) || ops.length === 0) throw new TypeError("commitTx requires non-empty ops[]");
    const ctx = getLogContext() ?? {};
    const requestId = ctx?.requestId ?? null;
    const derivedOutbox = [];
    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      if (op.kind === "JOB_EVENTS_APPENDED") {
        try {
          derivedOutbox.push(...deriveArtifactEnqueuesFromJobEvents({ tenantId: op.tenantId ?? DEFAULT_TENANT_ID, jobId: op.jobId, events: op.events ?? [] }));
        } catch {
          // Ignore: artifact triggers are best-effort; core semantics are in the job stream.
        }
        try {
          derivedOutbox.push(...deriveProofEvalEnqueuesFromJobEvents({ tenantId: op.tenantId ?? DEFAULT_TENANT_ID, jobId: op.jobId, events: op.events ?? [] }));
        } catch {
          // Ignore: proof triggers are best-effort; proof events are derived and idempotent.
        }
      }
    }

    function attachRequestId(record) {
      if (!requestId) return record;
      if (!record || typeof record !== "object" || Array.isArray(record)) return record;
      if (record.requestId) return record;
      return { ...record, requestId };
    }

    const normalizedOps = [];
    for (const op of ops) {
      if (!op || typeof op !== "object") continue;
      if (op.kind === "OUTBOX_ENQUEUE" && Array.isArray(op.messages)) {
        normalizedOps.push({ ...op, messages: op.messages.map(attachRequestId) });
        continue;
      }
      if (op.kind === "INGEST_RECORDS_PUT" && Array.isArray(op.records)) {
        normalizedOps.push({ ...op, records: op.records.map(attachRequestId) });
        continue;
      }
      normalizedOps.push(op);
    }

    const derived = derivedOutbox.map(attachRequestId);
    const augmented = derived.length ? [...normalizedOps, { kind: "OUTBOX_ENQUEUE", messages: derived }] : normalizedOps;

    const ctxPath = typeof ctx?.path === "string" ? ctx.path : "";
    const ctxMethod = typeof ctx?.method === "string" ? String(ctx.method).toUpperCase() : "";
    const isOpsWrite = ctxPath.startsWith("/ops") && ctxMethod !== "GET" && ctxMethod !== "HEAD" && ctxMethod !== "";
    if (!audit && isOpsWrite) {
      const tenantIdFromOps = ops.find((op) => op && typeof op === "object" && typeof op.tenantId === "string" && op.tenantId.trim())?.tenantId ?? DEFAULT_TENANT_ID;
      const tenantId = normalizeTenantId(typeof ctx?.tenantId === "string" ? ctx.tenantId : tenantIdFromOps);
      const actorKeyId = typeof ctx?.actorKeyId === "string" && ctx.actorKeyId.trim() ? ctx.actorKeyId : null;
      const actorPrincipalId = typeof ctx?.principalId === "string" && ctx.principalId.trim() ? ctx.principalId : null;
      const details = normalizeForCanonicalJson({
        method: ctxMethod,
        path: ctxPath,
        route: typeof ctx?.route === "string" ? ctx.route : null,
        opKinds: Array.isArray(ops) ? ops.map((op) => op?.kind).filter(Boolean) : []
      });
      audit = {
        tenantId,
        actorKeyId,
        actorPrincipalId,
        requestId: typeof requestId === "string" ? requestId : null,
        action: "OPS_HTTP_WRITE",
        targetType: null,
        targetId: null,
        at: nowIso(),
        detailsHash: sha256Hex(canonicalJsonStringify(details)),
        details
      };
    }

    try {
      await store.commitTx({ at: nowIso(), ops: augmented, audit: audit ? attachRequestId(audit) : null });
    } catch (err) {
      if (err?.code === "PREV_CHAIN_HASH_MISMATCH") {
        err.statusCode = 409;
        err.message = "event append conflict";
      }
      throw err;
    }
  }

  async function listAllLedgerEntriesForTenant({ tenantId, memoPrefix = null, maxEntries = 50_000 } = {}) {
    tenantId = normalizeTenant(tenantId);
    if (memoPrefix !== null && (typeof memoPrefix !== "string" || memoPrefix.trim() === "")) throw new TypeError("memoPrefix must be null or a non-empty string");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new TypeError("maxEntries must be a positive safe integer");

    const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
    if (typeof store.listLedgerEntries !== "function") {
      const all = Array.isArray(ledger?.entries) ? ledger.entries : [];
      const filtered = memoPrefix ? all.filter((e) => typeof e?.memo === "string" && e.memo.startsWith(memoPrefix)) : all;
      return filtered.slice(0, maxEntries);
    }

    const entries = [];
    const pageSize = 5000;
    let offset = 0;
    while (entries.length < maxEntries) {
      // listLedgerEntries may be sync (memory) or async (pg). await handles both.
      // Note: ordering is not guaranteed; statements compute balances by filtering entry.at.
      // eslint-disable-next-line no-await-in-loop
      const batch = await store.listLedgerEntries({ tenantId, memoPrefix, limit: pageSize, offset });
      if (!Array.isArray(batch) || batch.length === 0) break;
      entries.push(...batch);
      if (batch.length < pageSize) break;
      offset += batch.length;
    }
    return entries;
  }

  function normalizeTenant(tenantId) {
    return normalizeTenantId(tenantId, { defaultTenantId: DEFAULT_TENANT_ID });
  }

  function jobStoreKey(tenantId, jobId) {
    return makeScopedKey({ tenantId: normalizeTenant(tenantId), id: jobId });
  }

  function robotStoreKey(tenantId, robotId) {
    return makeScopedKey({ tenantId: normalizeTenant(tenantId), id: robotId });
  }

  function operatorStoreKey(tenantId, operatorId) {
    return makeScopedKey({ tenantId: normalizeTenant(tenantId), id: operatorId });
  }

  function monthStoreKey(tenantId, monthId) {
    return makeScopedKey({ tenantId: normalizeTenant(tenantId), id: monthId });
  }

  function getTenantConfig(tenantId) {
    const normalized = normalizeTenant(tenantId);
    if (typeof store.getConfig === "function") return store.getConfig(normalized);
    return store.config;
  }

  function countOpenJobsForTenant(tenantId) {
    const t = normalizeTenant(tenantId);
    let count = 0;
    for (const job of store.jobs.values()) {
      if (!job?.id) continue;
      if (normalizeTenant(job.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
      const status = job.status ?? null;
      if (status === "ABORTED" || status === "SETTLED") continue;
      count += 1;
    }
    return count;
  }

  function getJobZoneId(job) {
    return normalizeZoneId(job?.booking?.zoneId ?? job?.constraints?.zoneId);
  }

  function getRobotZoneId(robot) {
    return normalizeZoneId(robot?.currentZoneId ?? robot?.homeZoneId);
  }

  function robotHasOverlappingReservation({ tenantId, robotId, window, ignoreJobId = null } = {}) {
    const t = normalizeTenant(tenantId);
    for (const other of store.jobs.values()) {
      if (!other?.id || other.id === ignoreJobId) continue;
      const otherTenant = normalizeTenant(other.tenantId ?? DEFAULT_TENANT_ID);
      if (otherTenant !== t) continue;
      const resv = other.reservation;
      if (!resv || resv.robotId !== robotId) continue;
      if (other.status === "ABORTED" || other.status === "SETTLED") continue;
      if (bookingWindowsOverlap(resv, window)) return true;
    }
    return false;
  }

  function countOperatorCoverageOverlaps({ tenantId, operatorId, window, ignoreJobId = null } = {}) {
    const t = normalizeTenant(tenantId);
    let count = 0;
    for (const other of store.jobs.values()) {
      if (!other?.id || other.id === ignoreJobId) continue;
      const otherTenant = normalizeTenant(other.tenantId ?? DEFAULT_TENANT_ID);
      if (otherTenant !== t) continue;
      if (other.status === "ABORTED" || other.status === "SETTLED") continue;
      const cov = other.operatorCoverage;
      if (!cov || cov.status !== "reserved") continue;
      if (cov.operatorId !== operatorId) continue;
      if (bookingWindowsOverlap({ startAt: cov.startAt, endAt: cov.endAt }, window)) count += 1;
    }
    return count;
  }

  function listAvailableOperators({ tenantId, zoneId, window, ignoreJobId = null } = {}) {
    const t = normalizeTenant(tenantId);
    const z = normalizeZoneId(zoneId);
    const candidates = [];
    for (const op of store.operators.values()) {
      if (!op?.id) continue;
      const opTenant = normalizeTenant(op.tenantId ?? DEFAULT_TENANT_ID);
      if (opTenant !== t) continue;
      if (op.shift?.status !== "open") continue;
      const opZoneId = normalizeZoneId(op.shift?.zoneId);
      if (opZoneId !== z) continue;
      const maxConcurrentJobs = op.shift?.maxConcurrentJobs ?? 1;
      const used = countOperatorCoverageOverlaps({ tenantId: t, operatorId: op.id, window, ignoreJobId });
      if (used >= maxConcurrentJobs) continue;
      candidates.push(op);
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return candidates;
  }

  function listAvailableRobots({ tenantId, zoneId, window, ignoreJobId = null } = {}) {
    const t = normalizeTenant(tenantId);
    const z = normalizeZoneId(zoneId);
    const robots = [];
    for (const robot of store.robots.values()) {
      if (!robot?.id) continue;
      const robotTenant = normalizeTenant(robot.tenantId ?? DEFAULT_TENANT_ID);
      if (robotTenant !== t) continue;
      if (robot.status && robot.status !== "active") continue;
      if (getRobotZoneId(robot) !== z) continue;
      if (!robotIsAvailableForWindow(robot, window)) continue;
      if (robotHasOverlappingReservation({ tenantId: t, robotId: robot.id, window, ignoreJobId })) continue;
      robots.push(robot);
    }
    robots.sort((a, b) => a.id.localeCompare(b.id));
    return robots;
  }

  function getPendingDispatchRequestEvent(events) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    let lastRequestIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.type === "DISPATCH_REQUESTED") {
        lastRequestIndex = i;
        break;
      }
    }
    if (lastRequestIndex === -1) return null;

    for (let i = lastRequestIndex + 1; i < events.length; i += 1) {
      const e = events[i];
      if (e?.type === "DISPATCH_CONFIRMED" || e?.type === "DISPATCH_FAILED") return null;
    }

    return events[lastRequestIndex];
  }

	  async function tickDispatch({ maxMessages = 100 } = {}) {
	    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");
	    if (!Number.isSafeInteger(store.dispatchCursor) || store.dispatchCursor < 0) store.dispatchCursor = 0;

	    const processed = [];
	    const isRobotReservationOverlapError = (err) => {
	      return err?.code === "23P01" || err?.constraint === "robot_reservations_no_overlap";
	    };
	    const isPrevChainMismatchError = (err) => {
	      return err?.code === "PREV_CHAIN_HASH_MISMATCH";
	    };
	    const handleDispatchRequestedMessage = async (message) => {
      if (!message || typeof message !== "object") return null;
      if (message.type !== "DISPATCH_REQUESTED") return null;

      const tenantId = normalizeTenant(message.tenantId ?? DEFAULT_TENANT_ID);

      const jobId = message.jobId;
      if (typeof jobId !== "string" || jobId.trim() === "") return null;

      const existing = getJobEvents(tenantId, jobId);
      if (existing.length === 0) return null;

      const jobBefore = reduceJob(existing);
      if (!jobBefore) return null;
      if (normalizeTenant(jobBefore.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) return null;

      const pendingRequest = getPendingDispatchRequestEvent(existing);
      if (!pendingRequest) return null;
      if (typeof message.sourceEventId === "string" && message.sourceEventId.trim() !== "" && pendingRequest.id !== message.sourceEventId) {
        return null;
      }

      // Idempotency: only dispatch BOOKED jobs that are not already reserved.
      if (jobBefore.status !== "BOOKED") return null;
      if (!jobBefore.booking) return null;
      if (jobBefore.reservation) return null;

      const zoneId = getJobZoneId(jobBefore);
      const window = { startAt: jobBefore.booking.startAt, endAt: jobBefore.booking.endAt };
      const requiresOperatorCoverage = jobBefore.booking.requiresOperatorCoverage === true;

      const robots = listAvailableRobots({ tenantId, zoneId, window, ignoreJobId: jobId });
      const robotCandidates = robots
        .map((r) => ({ robotId: r.id, score: typeof r.trustScore === "number" ? r.trustScore : 0, reasons: ["available"], rejected: false }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.robotId.localeCompare(b.robotId);
        });

      const operators = requiresOperatorCoverage ? listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobId }) : [];

      const evaluatedAt = nowIso();
      const evalPayload = {
        jobId,
        evaluatedAt,
        window,
        zoneId,
        requiresOperatorCoverage,
        candidates: robotCandidates.slice(0, 10),
        selected: null
      };

      if (robotCandidates.length === 0) {
        const failAt = nowIso();
        const failPayload = { jobId, failedAt: failAt, reason: "NO_ROBOTS", details: { zoneId } };

        const evalDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_EVALUATED",
          at: evaluatedAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: evalPayload
        });
        const eventsAfterEval = appendChainedEvent({ events: existing, event: evalDraft, signer: serverSigner });
        const evalEvent = eventsAfterEval[eventsAfterEval.length - 1];

        const failDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_FAILED",
          at: failAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: failPayload
        });
        const nextEvents = appendChainedEvent({ events: eventsAfterEval, event: failDraft, signer: serverSigner });
        const failEvent = nextEvents[nextEvents.length - 1];

        try {
          validateDomainEvent({ jobBefore, event: evalEvent, eventsBefore: existing });
          const jobAfterEval = reduceJob(eventsAfterEval);
          validateDomainEvent({ jobBefore: jobAfterEval, event: failEvent, eventsBefore: eventsAfterEval });
        } catch {
          return null;
        }

        await commitTx([
          { kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [evalEvent, failEvent] },
          {
            kind: "OUTBOX_ENQUEUE",
            messages: [
              {
                type: "NOTIFY_OPS_DISPATCH_FAILED",
                tenantId,
                jobId,
                at: failAt,
                reason: "NO_ROBOTS",
                zoneId,
                window,
                sourceEventId: failEvent.id
              }
            ]
          }
        ]);
        return { jobId, status: "failed", reason: "NO_ROBOTS" };
      }

      if (requiresOperatorCoverage && operators.length === 0) {
        const failAt = nowIso();
        const failPayload = { jobId, failedAt: failAt, reason: "NO_OPERATORS", details: { zoneId } };

        const evalDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_EVALUATED",
          at: evaluatedAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: evalPayload
        });
        const eventsAfterEval = appendChainedEvent({ events: existing, event: evalDraft, signer: serverSigner });
        const evalEvent = eventsAfterEval[eventsAfterEval.length - 1];

        const failDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_FAILED",
          at: failAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: failPayload
        });
        const nextEvents = appendChainedEvent({ events: eventsAfterEval, event: failDraft, signer: serverSigner });
        const failEvent = nextEvents[nextEvents.length - 1];

        try {
          validateDomainEvent({ jobBefore, event: evalEvent, eventsBefore: existing });
          const jobAfterEval = reduceJob(eventsAfterEval);
          validateDomainEvent({ jobBefore: jobAfterEval, event: failEvent, eventsBefore: eventsAfterEval });
        } catch {
          return null;
        }

        await commitTx([
          { kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [evalEvent, failEvent] },
          {
            kind: "OUTBOX_ENQUEUE",
            messages: [
              {
                type: "NOTIFY_OPS_DISPATCH_FAILED",
                tenantId,
                jobId,
                at: failAt,
                reason: "NO_OPERATORS",
                zoneId,
                window,
                sourceEventId: failEvent.id
              }
            ]
          }
        ]);
        return { jobId, status: "failed", reason: "NO_OPERATORS" };
      }

      for (const cand of robotCandidates) {
        const selectedRobotId = cand.robotId;
        const selectedOperator = requiresOperatorCoverage ? operators[0] : null;

        const evalDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_EVALUATED",
          at: evaluatedAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: { ...evalPayload, selected: { robotId: selectedRobotId, operatorId: selectedOperator?.id ?? null } }
        });
        let events = appendChainedEvent({ events: existing, event: evalDraft, signer: serverSigner });
        const evalEvent = events[events.length - 1];

	        const matchDraft = createChainedEvent({
	          streamId: jobId,
	          type: "MATCHED",
	          at: nowIso(),
	          actor: { type: "dispatch", id: "dispatch_v1" },
	          payload: {
	            robotId: selectedRobotId,
	            score: cand.score,
	            algorithm: "trustScore_v2",
	            operatorContractHash: jobBefore.booking?.customerContractHash ?? null,
	            operatorPolicyHash: jobBefore.booking?.policyHash ?? null,
	            operatorCompilerId: jobBefore.booking?.customerCompilerId ?? null
	          }
	        });
        events = appendChainedEvent({ events, event: matchDraft, signer: serverSigner });
        const matchEvent = events[events.length - 1];
        const jobAfterMatch = reduceJob(events);

        const reservationPayload = {
          robotId: selectedRobotId,
          startAt: window.startAt,
          endAt: window.endAt,
          reservationId: createId("rsv"),
          reservedUntil: window.startAt
        };
        const reserveDraft = createChainedEvent({
          streamId: jobId,
          type: "RESERVED",
          at: nowIso(),
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: reservationPayload
        });
        events = appendChainedEvent({ events, event: reserveDraft, signer: serverSigner });
        const reservedEvent = events[events.length - 1];
        const jobAfterReserve = reduceJob(events);

        let coverageEvent = null;
        if (requiresOperatorCoverage) {
          const coveragePayload = {
            jobId,
            operatorId: selectedOperator.id,
            startAt: window.startAt,
            endAt: window.endAt,
            reservationId: createId("opcov"),
            zoneId
          };
          const coverageDraft = createChainedEvent({
            streamId: jobId,
            type: "OPERATOR_COVERAGE_RESERVED",
            at: nowIso(),
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: coveragePayload
          });
          events = appendChainedEvent({ events, event: coverageDraft, signer: serverSigner });
          coverageEvent = events[events.length - 1];
        }

        const confirmedAt = nowIso();
        const confirmedDraft = createChainedEvent({
          streamId: jobId,
          type: "DISPATCH_CONFIRMED",
          at: confirmedAt,
          actor: { type: "dispatch", id: "dispatch_v1" },
          payload: { jobId, confirmedAt }
        });
        events = appendChainedEvent({ events, event: confirmedDraft, signer: serverSigner });
        const confirmedEvent = events[events.length - 1];

        try {
          validateDomainEvent({ jobBefore, event: evalEvent, eventsBefore: existing });
          const jobAfterEval = reduceJob([...existing, evalEvent]);
          validateDomainEvent({ jobBefore: jobAfterEval, event: matchEvent, eventsBefore: [...existing, evalEvent] });
          validateDomainEvent({ jobBefore: jobAfterMatch, event: reservedEvent, eventsBefore: [...existing, evalEvent, matchEvent] });
          if (coverageEvent) {
            validateDomainEvent({ jobBefore: jobAfterReserve, event: coverageEvent, eventsBefore: [...existing, evalEvent, matchEvent, reservedEvent] });
          }
          const jobForConfirm = reduceJob(
            coverageEvent ? [...existing, evalEvent, matchEvent, reservedEvent, coverageEvent] : [...existing, evalEvent, matchEvent, reservedEvent]
          );
          validateDomainEvent({
            jobBefore: jobForConfirm,
            event: confirmedEvent,
            eventsBefore: coverageEvent ? [...existing, evalEvent, matchEvent, reservedEvent, coverageEvent] : [...existing, evalEvent, matchEvent, reservedEvent]
          });
        } catch {
          continue;
        }

        const jobAfter = reduceJob(events);
        const appendedEvents = [evalEvent, matchEvent, reservedEvent, ...(coverageEvent ? [coverageEvent] : []), confirmedEvent];
        const outboxMessages = [];
        if (jobBefore.status !== jobAfter.status) {
          outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: jobBefore.status, toStatus: jobAfter.status, at: confirmedAt });
        }

        const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appendedEvents }];
        if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

        try {
          await commitTx(ops);
        } catch (err) {
          if (isRobotReservationOverlapError(err)) {
            continue;
          }
          throw err;
        }

        return { jobId, status: "dispatched", robotId: selectedRobotId, operatorId: selectedOperator?.id ?? null };
      }

      const failAt = nowIso();
      const failPayload = { jobId, failedAt: failAt, reason: "CONFLICT", details: { zoneId } };

      const evalDraft = createChainedEvent({
        streamId: jobId,
        type: "DISPATCH_EVALUATED",
        at: evaluatedAt,
        actor: { type: "dispatch", id: "dispatch_v1" },
        payload: evalPayload
      });
      const eventsAfterEval = appendChainedEvent({ events: existing, event: evalDraft, signer: serverSigner });
      const evalEvent = eventsAfterEval[eventsAfterEval.length - 1];

      const failDraft = createChainedEvent({
        streamId: jobId,
        type: "DISPATCH_FAILED",
        at: failAt,
        actor: { type: "dispatch", id: "dispatch_v1" },
        payload: failPayload
      });
      const nextEvents = appendChainedEvent({ events: eventsAfterEval, event: failDraft, signer: serverSigner });
      const failEvent = nextEvents[nextEvents.length - 1];

      try {
        validateDomainEvent({ jobBefore, event: evalEvent, eventsBefore: existing });
        const jobAfterEval = reduceJob(eventsAfterEval);
        validateDomainEvent({ jobBefore: jobAfterEval, event: failEvent, eventsBefore: eventsAfterEval });
      } catch {
        return null;
      }

      await commitTx([
        { kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [evalEvent, failEvent] },
        {
          kind: "OUTBOX_ENQUEUE",
          messages: [
            {
              type: "NOTIFY_OPS_DISPATCH_FAILED",
              tenantId,
              jobId,
              at: failAt,
              reason: "CONFLICT",
              zoneId,
              window,
              sourceEventId: failEvent.id
            }
          ]
        }
      ]);
      return { jobId, status: "failed", reason: "CONFLICT" };
    };

    if (
      store.kind === "pg" &&
      typeof store.claimOutbox === "function" &&
      typeof store.markOutboxProcessed === "function" &&
      typeof store.markOutboxFailed === "function" &&
      typeof store.refreshFromDb === "function"
    ) {
      const claimed = await store.claimOutbox({ topic: "DISPATCH_REQUESTED", maxMessages, worker: "dispatch_v1" });
      if (claimed.length) await store.refreshFromDb();
      for (const row of claimed) {
        try {
          let result = await handleDispatchRequestedMessage(row.message);
          const lastError = result ? null : "skipped";
          await store.markOutboxProcessed({ ids: [row.id], lastError });
          if (result) processed.push(result);
          continue;
        } catch (err) {
          if (isPrevChainMismatchError(err)) {
            try {
              await store.refreshFromDb();
              const result = await handleDispatchRequestedMessage(row.message);
              const lastError = result ? null : "skipped";
              await store.markOutboxProcessed({ ids: [row.id], lastError });
              if (result) processed.push(result);
              continue;
	            } catch (err2) {
	              const lastError = typeof err2?.message === "string" && err2.message.trim() ? err2.message : String(err2 ?? "dispatch failed");
	              if (Number.isSafeInteger(row.attempts) && row.attempts >= outboxMaxAttempts) {
	                await store.markOutboxProcessed({ ids: [row.id], lastError: `DLQ:${lastError}` });
	              } else {
	                await store.markOutboxFailed({ ids: [row.id], lastError });
	              }
	              continue;
	            }
	          }
	          const lastError = typeof err?.message === "string" && err.message.trim() ? err.message : String(err ?? "dispatch failed");
	          if (Number.isSafeInteger(row.attempts) && row.attempts >= outboxMaxAttempts) {
	            await store.markOutboxProcessed({ ids: [row.id], lastError: `DLQ:${lastError}` });
	          } else {
	            await store.markOutboxFailed({ ids: [row.id], lastError });
	          }
	          continue;
	        }
	      }
      return { processed, cursor: store.dispatchCursor };
    }

    while (store.dispatchCursor < store.outbox.length && processed.length < maxMessages) {
      const message = store.outbox[store.dispatchCursor];
      store.dispatchCursor += 1;
      const result = await handleDispatchRequestedMessage(message);
      if (result) processed.push(result);
    }

    return { processed, cursor: store.dispatchCursor };
  }

  async function tickOperatorQueue({ maxMessages = 100 } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");
    if (!Number.isSafeInteger(store.operatorQueueCursor) || store.operatorQueueCursor < 0) store.operatorQueueCursor = 0;

    const processed = [];
    while (store.operatorQueueCursor < store.outbox.length && processed.length < maxMessages) {
      const message = store.outbox[store.operatorQueueCursor];
      store.operatorQueueCursor += 1;
      if (!message || typeof message !== "object") continue;
      if (message.type !== "ESCALATION_NEEDED") continue;
      if (message.kind !== "OPERATOR_ASSIST") continue;

      const jobId = message.jobId;
      if (typeof jobId !== "string" || jobId.trim() === "") continue;

      const tenantId = normalizeTenant(message.tenantId ?? DEFAULT_TENANT_ID);
      const existing = getJobEvents(tenantId, jobId);
      if (existing.length === 0) continue;
      const jobBefore = reduceJob(existing);
      if (!jobBefore) continue;
      if (!jobBefore.booking?.requiresOperatorCoverage) continue;
      if (jobBefore.status !== "STALLED") continue;

      // Only queue once.
      if (
        jobBefore.assist?.status === "queued" ||
        jobBefore.assist?.status === "assigned" ||
        jobBefore.assist?.status === "accepted" ||
        jobBefore.assist?.status === "declined" ||
        jobBefore.assist?.status === "timeout"
      ) {
        continue;
      }

      const zoneId = getJobZoneId(jobBefore);
      const window = jobBefore.reservation
        ? { startAt: jobBefore.reservation.startAt, endAt: jobBefore.reservation.endAt }
        : jobBefore.booking
          ? { startAt: jobBefore.booking.startAt, endAt: jobBefore.booking.endAt }
          : null;

      const at = nowIso();
      const queueId = createId("aq");

      const queuedDraft = createChainedEvent({
        streamId: jobId,
        type: "ASSIST_QUEUED",
        at,
        actor: { type: "ops", id: "assist_queue_v0" },
        payload: { jobId, queueId, queuedAt: at, reason: "LIVENESS_STALL", priority: "HIGH" }
      });
      let events = appendChainedEvent({ events: existing, event: queuedDraft, signer: serverSigner });
      const queuedEvent = events[events.length - 1];

      // Prefer the reserved coverage operator if present.
      let operatorId = jobBefore.operatorCoverage?.status === "reserved" ? jobBefore.operatorCoverage.operatorId : null;
      if (operatorId) {
        const op = store.operators.get(operatorStoreKey(tenantId, operatorId));
        if (!op || op.shift?.status !== "open") operatorId = null;
        else if (normalizeZoneId(op.shift?.zoneId) !== zoneId) operatorId = null;
      }
      if (!operatorId) {
        const available = window
          ? listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobId })
          : listAvailableOperators({ tenantId, zoneId, window: { startAt: at, endAt: at }, ignoreJobId: jobId });
        operatorId = available[0]?.id ?? null;
      }

      if (!operatorId) {
        const timedOutAt = nowIso();
        const timeoutDraft = createChainedEvent({
          streamId: jobId,
          type: "ASSIST_TIMEOUT",
          at: timedOutAt,
          actor: { type: "ops", id: "assist_queue_v0" },
          payload: { jobId, queueId, timedOutAt, reason: "NO_OPERATOR_CAPACITY" }
        });
        events = appendChainedEvent({ events, event: timeoutDraft, signer: serverSigner });
        const timeoutEvent = events[events.length - 1];

        try {
          validateDomainEvent({ jobBefore, event: queuedEvent, eventsBefore: existing });
          const jobAfterQueued = reduceJob([...existing, queuedEvent]);
          validateDomainEvent({ jobBefore: jobAfterQueued, event: timeoutEvent, eventsBefore: [...existing, queuedEvent] });
        } catch {
          continue;
        }

        await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [queuedEvent, timeoutEvent] }]);
        processed.push({ jobId, status: "timeout" });
        continue;
      }

      const assignedAt = nowIso();
      const assignedDraft = createChainedEvent({
        streamId: jobId,
        type: "ASSIST_ASSIGNED",
        at: assignedAt,
        actor: { type: "ops", id: "assist_queue_v0" },
        payload: { jobId, queueId, operatorId, assignedAt }
      });
      events = appendChainedEvent({ events, event: assignedDraft, signer: serverSigner });
      const assignedEvent = events[events.length - 1];

      try {
        validateDomainEvent({ jobBefore, event: queuedEvent, eventsBefore: existing });
        const jobAfterQueued = reduceJob([...existing, queuedEvent]);
        validateDomainEvent({ jobBefore: jobAfterQueued, event: assignedEvent, eventsBefore: [...existing, queuedEvent] });
      } catch {
        continue;
      }

      await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [queuedEvent, assignedEvent] }]);

      processed.push({ jobId, status: "assigned", operatorId });
    }

    return { processed, cursor: store.operatorQueueCursor };
  }

  async function tickRobotHealth({ maxMessages = 100 } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");
    if (!Number.isSafeInteger(store.robotHealthCursor) || store.robotHealthCursor < 0) store.robotHealthCursor = 0;

    const processed = [];
    while (store.robotHealthCursor < store.outbox.length && processed.length < maxMessages) {
      const message = store.outbox[store.robotHealthCursor];
      store.robotHealthCursor += 1;

      if (!message || typeof message !== "object") continue;

      if (message.type !== "INCIDENT_RECORDED" && message.type !== "JOB_STALLED") continue;

      const robotId = message.robotId;
      if (typeof robotId !== "string" || robotId.trim() === "") continue;

      const tenantId = normalizeTenant(message.tenantId ?? DEFAULT_TENANT_ID);
      const existingRobotEvents = getRobotEvents(tenantId, robotId);
      if (existingRobotEvents.length === 0) continue;

      const robotBefore = reduceRobot(existingRobotEvents);
      if (!robotBefore) continue;

      // Idempotency: never re-quarantine a currently quarantined robot.
      if (robotBefore.status === "quarantined") continue;

      let shouldQuarantine = false;
      let quarantineReason = "MANUAL";
      let quarantineNotes = null;
      let quarantineIncidentId = null;
      let quarantineJobId = null;

      if (message.type === "INCIDENT_RECORDED") {
        const severity = message.severity;
        const incidentType = message.incidentType;
        const incidentId = message.incidentId ?? null;
        const jobId = message.jobId ?? null;

        if (typeof incidentId === "string" && incidentId.trim() !== "") {
          // Idempotency: avoid reprocessing the same incident.
          const already = existingRobotEvents.some((e) => e.type === "ROBOT_QUARANTINED" && e.payload?.incidentId === incidentId);
          if (already) continue;
        }

        // Policy: auto-quarantine on high severity or safety-related incidents.
        if (Number.isSafeInteger(severity) && severity >= 4) shouldQuarantine = true;
        if (incidentType === "SAFETY_NEAR_MISS" && Number.isSafeInteger(severity) && severity >= 3) shouldQuarantine = true;
        if (incidentType === "UNEXPECTED_HUMAN_CONTACT" && Number.isSafeInteger(severity) && severity >= 3) shouldQuarantine = true;

        if (shouldQuarantine) {
          quarantineReason = "INCIDENT";
          quarantineNotes = `auto quarantine: incident ${incidentType ?? "UNKNOWN"} severity ${severity ?? "?"}`;
          quarantineIncidentId = typeof incidentId === "string" ? incidentId : null;
          quarantineJobId = typeof jobId === "string" ? jobId : null;
        }
      }

      if (message.type === "JOB_STALLED") {
        const stallAt = message.at;
        const refMs = Date.parse(stallAt);
        if (Number.isFinite(refMs)) {
          const lookbackMs = 60 * 60_000;
          const sinceMs = refMs - lookbackMs;
          let stallCount = 0;
          for (const [key, events] of store.jobEvents.entries()) {
            const otherTenant = key.includes("\n") ? parseScopedKey(key).tenantId : DEFAULT_TENANT_ID;
            if (normalizeTenant(otherTenant) !== tenantId) continue;
            if (!Array.isArray(events) || events.length === 0) continue;
            for (const e of events) {
              if (e?.type !== "JOB_EXECUTION_STALLED") continue;
              const rid = e.payload?.robotId ?? null;
              if (rid !== robotId) continue;
              const t = Date.parse(e.at);
              if (Number.isFinite(t) && t >= sinceMs) stallCount += 1;
            }
          }
          if (stallCount >= 3) {
            shouldQuarantine = true;
            quarantineReason = "REPEATED_STALLS";
            quarantineNotes = `auto quarantine: ${stallCount} stalls in last ${lookbackMs / 60_000} minutes`;
          }
        }
      }

      if (!shouldQuarantine) continue;

      const quarantinedAt = nowIso();
      const quarantinePayload = {
        robotId,
        quarantinedAt,
        reason: quarantineReason,
        manualClearRequired: true,
        incidentId: quarantineIncidentId,
        jobId: quarantineJobId,
        notes: quarantineNotes
      };

      const draft = createChainedEvent({
        streamId: robotId,
        type: "ROBOT_QUARANTINED",
        at: quarantinedAt,
        actor: { type: "trust", id: "robot_health_v0" },
        payload: quarantinePayload
      });
      const nextRobotEvents = appendChainedEvent({ events: existingRobotEvents, event: draft, signer: serverSigner });
      const event = nextRobotEvents[nextRobotEvents.length - 1];

      try {
        enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
      } catch {
        continue;
      }

      try {
        reduceRobot(nextRobotEvents);
      } catch {
        continue;
      }

      const notifyMessages = [
        {
          type: "NOTIFY_OPS_ROBOT_QUARANTINED",
          tenantId,
          robotId,
          at: quarantinedAt,
          reason: quarantineReason,
          incidentId: quarantineIncidentId,
          jobId: quarantineJobId,
          ownerId: robotBefore.ownerId ?? null,
          sourceEventId: event.id
        }
      ];
      if (robotBefore.ownerId) {
        notifyMessages.push({
          type: "NOTIFY_OWNER_ROBOT_QUARANTINED",
          tenantId,
          ownerId: robotBefore.ownerId,
          robotId,
          at: quarantinedAt,
          reason: quarantineReason,
          incidentId: quarantineIncidentId,
          jobId: quarantineJobId,
          sourceEventId: event.id
        });
      }

      await commitTx([
        { kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] },
        { kind: "OUTBOX_ENQUEUE", messages: notifyMessages }
      ]);

      processed.push({ robotId, status: "quarantined", reason: quarantineReason });
    }

    return { processed, cursor: store.robotHealthCursor };
  }

  async function tickJobAccounting({ maxMessages = 100 } = {}) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");
    if (!Number.isSafeInteger(store.jobAccountingCursor) || store.jobAccountingCursor < 0) store.jobAccountingCursor = 0;

    const processed = [];

    const getLastSettledEventId = (events) => {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e?.type === "SETTLED") return e.id ?? null;
      }
      return null;
    };

    const computeAssistSeconds = (events, { endAt }) => {
      const endMs = Date.parse(endAt);
      const openByOperatorId = new Map();
      const usedOperatorIds = new Set();

      let totalMs = 0;
      for (const e of events) {
        if (e?.type !== "ASSIST_STARTED" && e?.type !== "ASSIST_ENDED") continue;
        const operatorId = e.actor?.type === "operator" ? e.actor.id : null;
        if (!operatorId) continue;
        const t = Date.parse(e.at);
        if (!Number.isFinite(t)) continue;

        if (e.type === "ASSIST_STARTED") {
          usedOperatorIds.add(operatorId);
          const open = openByOperatorId.get(operatorId);
          if (Number.isFinite(open)) {
            const delta = t - open;
            if (delta > 0) totalMs += delta;
          }
          openByOperatorId.set(operatorId, t);
          continue;
        }

        const open = openByOperatorId.get(operatorId);
        if (!Number.isFinite(open)) continue;
        const delta = t - open;
        if (delta > 0) totalMs += delta;
        openByOperatorId.delete(operatorId);
      }

      if (Number.isFinite(endMs)) {
        for (const startMs of openByOperatorId.values()) {
          const delta = endMs - startMs;
          if (delta > 0) totalMs += delta;
        }
      }

      const assistSeconds = Math.floor(totalMs / 1000);
      return { assistSeconds, usedOperatorIds: Array.from(usedOperatorIds).sort() };
    };

    const computeTotalStallMs = (events, { endAt }) => {
      const endMs = Date.parse(endAt);
      let stallStartMs = null;
      let totalStallMs = 0;

      for (const e of events) {
        if (!e || typeof e !== "object") continue;
        const t = Date.parse(e.at);
        if (!Number.isFinite(t)) continue;

        if (e.type === "JOB_EXECUTION_STALLED") {
          if (stallStartMs === null) stallStartMs = t;
          continue;
        }
        if (e.type === "JOB_EXECUTION_RESUMED") {
          if (stallStartMs === null) continue;
          const delta = t - stallStartMs;
          if (delta > 0) totalStallMs += delta;
          stallStartMs = null;
        }
      }

      if (stallStartMs !== null && Number.isFinite(endMs)) {
        const delta = endMs - stallStartMs;
        if (delta > 0) totalStallMs += delta;
      }

      return totalStallMs;
    };

    while (store.jobAccountingCursor < store.outbox.length && processed.length < maxMessages) {
      const message = store.outbox[store.jobAccountingCursor];
      store.jobAccountingCursor += 1;

      if (!message || typeof message !== "object") continue;
      if (message.type !== "JOB_SETTLED") continue;

      const jobId = message.jobId;
      const settledEventId = message.settledEventId;
      if (typeof jobId !== "string" || jobId.trim() === "") continue;
      if (typeof settledEventId !== "string" || settledEventId.trim() === "") continue;

      const tenantId = normalizeTenant(message.tenantId ?? DEFAULT_TENANT_ID);
      const existing = getJobEvents(tenantId, jobId);
      if (existing.length === 0) continue;

      const lastSettledEventId = getLastSettledEventId(existing);
      if (!lastSettledEventId) continue;
      if (lastSettledEventId !== settledEventId) continue;

      const jobBefore = reduceJob(existing);
      if (!jobBefore) continue;
      if (jobBefore.status !== "SETTLED") continue;

      const alreadyCost = existing.some((e) => e.type === "OPERATOR_COST_RECORDED" && e.payload?.settledEventId === settledEventId);
      const alreadyBreach = existing.some((e) => e.type === "SLA_BREACH_DETECTED" && e.payload?.settledEventId === settledEventId);
      const alreadyCredit = existing.some((e) => e.type === "SLA_CREDIT_ISSUED" && e.payload?.settledEventId === settledEventId);

      const config = getTenantConfig(tenantId);
      const bookingCreditPolicy = jobBefore.booking?.creditPolicy ?? null;
      const shouldTryCredits = bookingCreditPolicy?.enabled === true;

      if (alreadyCost && alreadyBreach && (!shouldTryCredits || alreadyCredit)) {
        processed.push({ jobId, status: "noop" });
        continue;
      }

      const settledAt = message.at ?? nowIso();
      const endAt = jobBefore.execution?.completedAt ?? jobBefore.execution?.abortedAt ?? settledAt;

      const zoneId = getJobZoneId(jobBefore);
      const rateByZone = config?.operatorCost?.rateCentsPerMinuteByZone ?? {};
      const configuredRate = rateByZone[zoneId] ?? rateByZone.default ?? 0;
      const rateCentsPerMinute =
        Number.isSafeInteger(configuredRate) && configuredRate >= 0 ? configuredRate : 0;
      const basis = config?.operatorCost?.basis ?? "SHIFT_RATE";

      let events = existing;
      let workingJob = jobBefore;
      const appendedEvents = [];
      const outboxMessages = [];

      if (!alreadyCost) {
        const assist = computeAssistSeconds(events, { endAt });
        const assistSeconds = assist.assistSeconds;
        const operatorId = assist.usedOperatorIds.length === 1 ? assist.usedOperatorIds[0] : null;

        const costCents = computeOperatorCostCents({ assistSeconds, rateCentsPerMinute });
        const at = nowIso();
        const payload = {
          jobId,
          zoneId,
          operatorId,
          assistSeconds,
          rateCentsPerMinute,
          costCents,
          currency: "USD",
          basis,
          settledEventId
        };

        const draft = createChainedEvent({
          streamId: jobId,
          type: "OPERATOR_COST_RECORDED",
          at,
          actor: { type: "accounting", id: "job_accounting_v0" },
          payload
        });
        const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
        const costEvent = nextEvents[nextEvents.length - 1];

        try {
          validateDomainEvent({ jobBefore: workingJob, event: costEvent, eventsBefore: events });
        } catch {
          continue;
        }

        let ledgerEntries = [];
        try {
          ledgerEntries = ledgerEntriesForJobEvent({ jobBefore: workingJob, event: costEvent, eventsBefore: events });
        } catch {
          continue;
        }

        events = nextEvents;
        try {
          workingJob = reduceJob(events);
        } catch {
          continue;
        }

        appendedEvents.push(costEvent);
        for (const entry of ledgerEntries) {
          if (!entry) continue;
          outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: costEvent.id, entry });
        }
      }

      if (!alreadyBreach) {
        const booking = workingJob.booking ?? null;
        const policy = booking?.sla ?? null;
        const window = booking ? { startAt: booking.startAt, endAt: booking.endAt } : null;

        if (!booking || !policy || !window) {
          // Skip if booking data is missing; cannot compute SLA.
        } else {
          const breaches = [];

          const windowStartMs = Date.parse(window.startAt);
          const windowEndMs = Date.parse(window.endAt);

          const startedAt = workingJob.execution?.startedAt ?? null;
          const completedAt = workingJob.execution?.completedAt ?? null;
          const abortedAt = workingJob.execution?.abortedAt ?? null;

          const startedMs = startedAt ? Date.parse(startedAt) : NaN;
          const completedMs = completedAt ? Date.parse(completedAt) : NaN;
          const abortedMs = abortedAt ? Date.parse(abortedAt) : NaN;

          if (policy.mustStartWithinWindow === true && Number.isFinite(windowEndMs) && Number.isFinite(startedMs) && startedMs > windowEndMs) {
            breaches.push({
              type: SLA_BREACH_TYPE.START_LATE,
              startedAt,
              windowStartAt: window.startAt,
              windowEndAt: window.endAt,
              latenessMs: Math.max(0, startedMs - windowEndMs)
            });
          }

          if (Number.isFinite(windowEndMs) && Number.isFinite(completedMs) && completedMs > windowEndMs) {
            breaches.push({
              type: SLA_BREACH_TYPE.COMPLETE_LATE,
              completedAt,
              windowEndAt: window.endAt,
              latenessMs: Math.max(0, completedMs - windowEndMs)
            });
          }

          if (abortedAt && Number.isFinite(abortedMs)) {
            breaches.push({ type: SLA_BREACH_TYPE.ABORTED, abortedAt });
          }

          const totalStallMs = computeTotalStallMs(events, { endAt });
          if (Number.isSafeInteger(policy.maxStallMs) && policy.maxStallMs > 0 && totalStallMs > policy.maxStallMs) {
            breaches.push({
              type: SLA_BREACH_TYPE.EXCESS_STALL,
              totalStallMs,
              maxStallMs: policy.maxStallMs
            });
          }

          if (breaches.length) {
            const detectedAt = nowIso();
            const policyHash = workingJob.booking?.policyHash ?? null;
            const payload = {
              jobId,
              detectedAt,
              settledEventId,
              policyHash,
              window,
              policy,
              breaches
            };

            const draft = createChainedEvent({
              streamId: jobId,
              type: "SLA_BREACH_DETECTED",
              at: detectedAt,
              actor: { type: "accounting", id: "job_accounting_v0" },
              payload
            });
            const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
            const breachEvent = nextEvents[nextEvents.length - 1];

            try {
              validateDomainEvent({ jobBefore: workingJob, event: breachEvent, eventsBefore: events });
            } catch {
              continue;
            }

            events = nextEvents;
            try {
              workingJob = reduceJob(events);
            } catch {
              continue;
            }

            appendedEvents.push(breachEvent);
          }
        }
      }

      if (shouldTryCredits && !alreadyCredit) {
        const alreadyHasBreach = events.some((e) => e.type === "SLA_BREACH_DETECTED" && e.payload?.settledEventId === settledEventId);

        const computeCreditAmountCents = ({ creditPolicy, breachEvent }) => {
          const defaultAmountCents = creditPolicy?.defaultAmountCents ?? 0;
          const maxCents = creditPolicy?.maxAmountCents ?? 0;
          const ladder = Array.isArray(creditPolicy?.ladder) ? creditPolicy.ladder : null;

          let amountCents = Number.isSafeInteger(defaultAmountCents) && defaultAmountCents > 0 ? defaultAmountCents : 0;

          if (ladder && ladder.length && breachEvent?.payload?.breaches && Array.isArray(breachEvent.payload.breaches)) {
            let maxLatenessMs = 0;
            let aborted = false;
            for (const b of breachEvent.payload.breaches) {
              if (b?.type === SLA_BREACH_TYPE.ABORTED) aborted = true;
              const lm = b?.latenessMs ?? null;
              if (Number.isSafeInteger(lm) && lm > maxLatenessMs) maxLatenessMs = lm;
            }
            if (aborted && maxLatenessMs === 0) maxLatenessMs = Number.MAX_SAFE_INTEGER;

            for (const tier of ladder) {
              const gte = tier?.latenessMsGte ?? null;
              const cents = tier?.amountCents ?? null;
              if (!Number.isSafeInteger(gte) || !Number.isSafeInteger(cents)) continue;
              if (gte <= maxLatenessMs) amountCents = Math.max(0, cents);
            }
          }

          if (Number.isSafeInteger(maxCents) && maxCents > 0) amountCents = Math.min(amountCents, maxCents);
          return amountCents;
        };

        if (alreadyHasBreach) {
          const breachEvent = (() => {
            for (let i = events.length - 1; i >= 0; i -= 1) {
              const e = events[i];
              if (e?.type !== "SLA_BREACH_DETECTED") continue;
              if (e?.payload?.settledEventId !== settledEventId) continue;
              return e;
            }
            return null;
          })();

          const amountCents = computeCreditAmountCents({ creditPolicy: bookingCreditPolicy, breachEvent });
          if (amountCents > 0) {
            let trigger = null;
            if (
              breachEvent &&
              breachEvent.id &&
              breachEvent.payload?.window?.startAt &&
              breachEvent.payload?.window?.endAt &&
              breachEvent.payload?.policy &&
              Array.isArray(breachEvent.payload?.breaches) &&
              breachEvent.payload.breaches.length
            ) {
              trigger = {
                type: SLA_CREDIT_TRIGGER_TYPE.SLA_BREACH,
                breachEventId: breachEvent.id,
                detectedAt: breachEvent.payload?.detectedAt ?? breachEvent.at,
                window: breachEvent.payload.window,
                policy: breachEvent.payload.policy,
                breaches: breachEvent.payload.breaches
              };
            }

            const issuedAt = nowIso();
            const policyHash = workingJob.booking?.policyHash ?? null;
            const payload = {
              jobId,
              creditId: createId("cred"),
              issuedAt,
              amountCents,
              currency: "USD",
              reason: "SLA_BREACH",
              settledEventId,
              policyHash,
              trigger
            };

            const draft = createChainedEvent({
              streamId: jobId,
              type: "SLA_CREDIT_ISSUED",
              at: issuedAt,
              actor: { type: "accounting", id: "job_accounting_v0" },
              payload
            });
            const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
            const creditEvent = nextEvents[nextEvents.length - 1];

            try {
              validateDomainEvent({ jobBefore: workingJob, event: creditEvent, eventsBefore: events });
            } catch {
              continue;
            }

            let ledgerEntries = [];
            try {
              ledgerEntries = ledgerEntriesForJobEvent({ jobBefore: workingJob, event: creditEvent, eventsBefore: events });
            } catch {
              continue;
            }

            events = nextEvents;
            try {
              workingJob = reduceJob(events);
            } catch {
              continue;
            }

            appendedEvents.push(creditEvent);
            for (const entry of ledgerEntries) {
              if (!entry) continue;
              outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: creditEvent.id, entry });
            }
          }
        }
      }

      if (appendedEvents.length === 0) {
        processed.push({ jobId, status: "noop" });
        continue;
      }

      const jobAfter = workingJob;

      const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appendedEvents }];
      if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

      await commitTx(ops);

      processed.push({ jobId, status: "recorded", events: appendedEvents.map((e) => e.type) });
    }

    return { processed, cursor: store.jobAccountingCursor };
  }

  async function tickEvidenceRetention({ maxJobs = 1000 } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs <= 0) throw new TypeError("maxJobs must be a positive safe integer");
    const at = nowIso();
    const nowMs = Date.parse(at);
    const nowMsSafe = Number.isFinite(nowMs) ? nowMs : Date.now();

    const processed = [];
    let scanned = 0;

    if (!store.evidenceStore || typeof store.evidenceStore.deleteEvidence !== "function") {
      return { processed, scanned: 0, skipped: "evidence_store_unavailable" };
    }

    for (const jobSnap of store.jobs.values()) {
      if (!jobSnap?.id) continue;
      scanned += 1;
      if (scanned > maxJobs) break;

      const tenantId = normalizeTenant(jobSnap.tenantId ?? DEFAULT_TENANT_ID);
      const existing = getJobEvents(tenantId, jobSnap.id);
      if (!existing.length) continue;

      let jobBefore;
      try {
        jobBefore = reduceJob(existing);
      } catch {
        continue;
      }
      if (!jobBefore) continue;

      const retentionDays = jobBefore.booking?.evidencePolicy?.retentionDays ?? 0;
      if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) continue;

      const retentionMs = retentionDays * 24 * 60 * 60_000;
      const evidenceItems = Array.isArray(jobBefore.evidence) ? jobBefore.evidence : [];
      if (!evidenceItems.length) continue;

      let events = existing;
      const appended = [];

      for (const ev of evidenceItems) {
        const evidenceId = ev?.evidenceId ?? null;
        const evidenceRef = ev?.evidenceRef ?? null;
        const capturedAt = ev?.at ?? null;
        if (!evidenceId || typeof evidenceId !== "string") continue;
        if (!evidenceRef || typeof evidenceRef !== "string" || !evidenceRef.startsWith("obj://")) continue;
        if (ev?.expiredAt) continue;
        const capturedMs = capturedAt ? Date.parse(capturedAt) : NaN;
        if (!Number.isFinite(capturedMs)) continue;
        if (nowMsSafe - capturedMs <= retentionMs) continue;

        // Delete object (best effort), then append an auditable expiration event.
        try {
          await store.evidenceStore.deleteEvidence({ tenantId, evidenceRef });
        } catch {
          // Ignore deletion failure; we still record expiration so access is denied.
        }

        const payload = {
          jobId: jobBefore.id,
          evidenceId,
          evidenceRef,
          expiredAt: at,
          retentionDays,
          policyHash: jobBefore.booking?.policyHash ?? null
        };
        const draft = createChainedEvent({
          streamId: jobBefore.id,
          type: "EVIDENCE_EXPIRED",
          at,
          actor: { type: "retention", id: "retention_v0" },
          payload
        });
        const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
        const expiredEvent = nextEvents[nextEvents.length - 1];

        try {
          enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(expiredEvent.type), event: expiredEvent });
          validateDomainEvent({ jobBefore, event: expiredEvent, eventsBefore: events });
          reduceJob(nextEvents);
        } catch {
          continue;
        }

        events = nextEvents;
        appended.push(expiredEvent);
      }

      if (appended.length) {
        try {
          await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId: jobBefore.id, events: appended }]);
          processed.push({ jobId: jobBefore.id, expired: appended.length });
        } catch {
          // Ignore: retention is best-effort and can retry later.
        }
      }
    }

    return { processed, scanned };
  }

  async function tickRetentionCleanup({
    tenantId = null,
    maxRows = retentionCleanupDefaultBatchSize,
    maxMillis = retentionCleanupDefaultMaxMillis,
    dryRun = retentionCleanupDefaultDryRun,
    requireLock = false
  } = {}) {
    const startedMs = Date.now();
    const scopedTenantId = tenantId === null || tenantId === undefined ? null : normalizeTenant(tenantId);
    const scope = scopedTenantId ? "tenant" : "global";

    if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new TypeError("maxRows must be a positive safe integer");
    const safeMaxRows = Math.min(10_000, maxRows);
    if (!Number.isSafeInteger(maxMillis) || maxMillis <= 0) throw new TypeError("maxMillis must be a positive safe integer");
    const safeMaxMillis = Math.min(60_000, maxMillis);
    const safeDryRun = dryRun === true;

    const lockKey = RETENTION_CLEANUP_ADVISORY_LOCK_KEY;
    let locked = false;
    let lockClient = null;

    try {
      if (requireLock) {
        if (store?.kind === "pg" && store?.pg?.pool) {
          lockClient = await store.pg.pool.connect();
          const res = await lockClient.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey]);
          locked = Boolean(res.rows[0]?.ok);
          if (!locked) {
            try {
              lockClient.release();
            } catch {}
            lockClient = null;
            const runtimeMs = Date.now() - startedMs;
            logger.info("retention.cleanup.skip", { scope, reason: "already_running", dryRun: safeDryRun, runtimeMs });
            metricGauge("retention_run_seconds", { result: "already_running", scope, dry_run: safeDryRun ? "true" : "false" }, runtimeMs / 1000);
            metricInc("maintenance_runs_total", { kind: "retention_cleanup", result: "already_running", scope, dry_run: safeDryRun ? "true" : "false" }, 1);
            return {
              ok: false,
              code: "MAINTENANCE_ALREADY_RUNNING",
              scope,
              dryRun: safeDryRun,
              maxRows: safeMaxRows,
              maxMillis: safeMaxMillis,
              runtimeMs
            };
          }
        } else {
          store.__retentionCleanupLockHeld = store.__retentionCleanupLockHeld === true;
          if (store.__retentionCleanupLockHeld) {
            const runtimeMs = Date.now() - startedMs;
            logger.info("retention.cleanup.skip", { scope, reason: "already_running", dryRun: safeDryRun, runtimeMs });
            metricGauge("retention_run_seconds", { result: "already_running", scope, dry_run: safeDryRun ? "true" : "false" }, runtimeMs / 1000);
            metricInc("maintenance_runs_total", { kind: "retention_cleanup", result: "already_running", scope, dry_run: safeDryRun ? "true" : "false" }, 1);
            return {
              ok: false,
              code: "MAINTENANCE_ALREADY_RUNNING",
              scope,
              dryRun: safeDryRun,
              maxRows: safeMaxRows,
              maxMillis: safeMaxMillis,
              runtimeMs
            };
          }
          store.__retentionCleanupLockHeld = true;
          locked = true;
        }
      }

      const at = nowIso();
      try {
        logger.info("retention.cleanup.start", {
          scope,
          tenantId: scopedTenantId,
          dryRun: safeDryRun,
          maxRows: safeMaxRows,
          maxMillis: safeMaxMillis
        });

        const processed = [];
        let ingestRecordsPurgedTotal = 0;
        let deliveriesPurgedTotal = 0;
        let deliveryReceiptsPurgedTotal = 0;
        let timedOut = false;

        if (store?.kind === "pg" && typeof store.cleanupRetention === "function") {
          const result = await store.cleanupRetention({
            tenantId: scope === "global" ? null : scopedTenantId,
            maxRows: safeMaxRows,
            maxMillis: safeMaxMillis,
            dryRun: safeDryRun
          });
          processed.push(result);
          ingestRecordsPurgedTotal = Number(result?.ingestRecordsPurged ?? 0);
          deliveriesPurgedTotal = Number(result?.deliveriesPurged ?? 0);
          deliveryReceiptsPurgedTotal = Number(result?.deliveryReceiptsPurged ?? 0);
          timedOut = result?.timedOut === true;
        } else {
          const nowMs = Date.parse(at);
          const nowMsSafe = Number.isFinite(nowMs) ? nowMs : Date.now();

          const tenants = [];
          if (scopedTenantId) {
            tenants.push(scopedTenantId);
          } else if (store?.configByTenant instanceof Map) {
            for (const t of store.configByTenant.keys()) tenants.push(normalizeTenant(t));
          } else {
            tenants.push(DEFAULT_TENANT_ID);
          }

          // Dedupe
          const seen = new Set();
          const uniqueTenants = [];
          for (const t of tenants) {
            const n = normalizeTenant(t);
            if (seen.has(n)) continue;
            seen.add(n);
            uniqueTenants.push(n);
          }

          for (const t of uniqueTenants) {
            const elapsed = Date.now() - startedMs;
            if (elapsed >= safeMaxMillis) {
              timedOut = true;
              break;
            }

            let ingestRecordsPurged = 0;
            if (store.ingestRecords instanceof Map) {
              for (const [, r] of store.ingestRecords.entries()) {
                if (ingestRecordsPurged >= safeMaxRows) break;
                if (!r || typeof r !== "object") continue;
                if (normalizeTenant(r.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
                const expiresAt = r.expiresAt ?? null;
                if (!expiresAt || typeof expiresAt !== "string") continue;
                const expMs = Date.parse(expiresAt);
                if (!Number.isFinite(expMs)) continue;
                if (expMs > nowMsSafe) continue;
                ingestRecordsPurged += 1;
              }
            }

            if (!safeDryRun && store.ingestRecords instanceof Map && ingestRecordsPurged > 0) {
              for (const [key, r] of store.ingestRecords.entries()) {
                if (ingestRecordsPurgedTotal >= safeMaxRows) break;
                if (!r || typeof r !== "object") continue;
                if (normalizeTenant(r.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
                const expiresAt = r.expiresAt ?? null;
                if (!expiresAt || typeof expiresAt !== "string") continue;
                const expMs = Date.parse(expiresAt);
                if (!Number.isFinite(expMs)) continue;
                if (expMs > nowMsSafe) continue;
                store.ingestRecords.delete(key);
                ingestRecordsPurgedTotal += 1;
              }
            } else {
              ingestRecordsPurgedTotal += ingestRecordsPurged;
            }

            let deliveriesPurged = 0;
            let deliveryReceiptsPurged = 0;
            if (store.deliveries instanceof Map) {
              for (const [key, d] of store.deliveries.entries()) {
                if (deliveriesPurged >= safeMaxRows) break;
                if (!d || typeof d !== "object") continue;
                if (normalizeTenant(d.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
                if (d.state === "pending") continue;
                const expiresAt = d.expiresAt ?? null;
                if (!expiresAt || typeof expiresAt !== "string") continue;
                const expMs = Date.parse(expiresAt);
                if (!Number.isFinite(expMs)) continue;
                if (expMs > nowMsSafe) continue;
                deliveriesPurged += 1;
                if (store.deliveryReceipts instanceof Map && store.deliveryReceipts.has(key)) {
                  deliveryReceiptsPurged += 1;
                }
              }
            }

            if (!safeDryRun && store.deliveries instanceof Map && deliveriesPurged > 0) {
              for (const [key, d] of store.deliveries.entries()) {
                if (deliveriesPurgedTotal >= safeMaxRows) break;
                if (!d || typeof d !== "object") continue;
                if (normalizeTenant(d.tenantId ?? DEFAULT_TENANT_ID) !== t) continue;
                if (d.state === "pending") continue;
                const expiresAt = d.expiresAt ?? null;
                if (!expiresAt || typeof expiresAt !== "string") continue;
                const expMs = Date.parse(expiresAt);
                if (!Number.isFinite(expMs)) continue;
                if (expMs > nowMsSafe) continue;
                store.deliveries.delete(key);
                deliveriesPurgedTotal += 1;
                if (store.deliveryReceipts instanceof Map && store.deliveryReceipts.has(key)) {
                  store.deliveryReceipts.delete(key);
                  deliveryReceiptsPurgedTotal += 1;
                }
              }
            } else {
              deliveriesPurgedTotal += deliveriesPurged;
              deliveryReceiptsPurgedTotal += deliveryReceiptsPurged;
            }

            if (ingestRecordsPurged || deliveriesPurged || deliveryReceiptsPurged) {
              processed.push({ tenantId: t, ingestRecordsPurged, deliveriesPurged, deliveryReceiptsPurged, dryRun: safeDryRun });
            }
          }
        }

        const runtimeMs = Date.now() - startedMs;
        const summary = {
          ok: true,
          scope,
          tenantId: scopedTenantId,
          at,
          dryRun: safeDryRun,
          maxRows: safeMaxRows,
          maxMillis: safeMaxMillis,
          runtimeMs,
          timedOut,
          purged: {
            ingest_records: ingestRecordsPurgedTotal,
            deliveries: deliveriesPurgedTotal,
            delivery_receipts: deliveryReceiptsPurgedTotal
          },
          processed
        };

        logger.info("retention.cleanup.done", summary);

        metricGauge("retention_run_seconds", { result: "ok", scope, dry_run: safeDryRun ? "true" : "false" }, runtimeMs / 1000);
        metricInc("maintenance_runs_total", { kind: "retention_cleanup", result: "ok", scope, dry_run: safeDryRun ? "true" : "false" }, 1);
        if (!safeDryRun) {
          if (ingestRecordsPurgedTotal > 0) metricInc("retention_purged_total", { table: "ingest_records" }, ingestRecordsPurgedTotal);
          if (deliveriesPurgedTotal > 0) metricInc("retention_purged_total", { table: "deliveries" }, deliveriesPurgedTotal);
          if (deliveryReceiptsPurgedTotal > 0) metricInc("retention_purged_total", { table: "delivery_receipts" }, deliveryReceiptsPurgedTotal);
        }

        return summary;
      } catch (err) {
        const runtimeMs = Date.now() - startedMs;
        logger.error("retention.cleanup.error", { scope, tenantId: scopedTenantId, dryRun: safeDryRun, runtimeMs, err });
        metricGauge("retention_run_seconds", { result: "error", scope, dry_run: safeDryRun ? "true" : "false" }, runtimeMs / 1000);
        metricInc("maintenance_runs_total", { kind: "retention_cleanup", result: "error", scope, dry_run: safeDryRun ? "true" : "false" }, 1);
        metricInc("maintenance_fail_total", { kind: "retention_cleanup", scope }, 1);
        throw err;
      }
    } finally {
      if (requireLock) {
        if (lockClient) {
          try {
            await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
          } catch {}
          try {
            lockClient.release();
          } catch {}
        } else if (locked && store && typeof store === "object") {
          try {
            store.__retentionCleanupLockHeld = false;
          } catch {}
        }
      }
    }
  }

  function getPendingMonthCloseRequestEvent(events) {
    if (!Array.isArray(events)) throw new TypeError("events must be an array");
    let lastRequestIndex = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.type === "MONTH_CLOSE_REQUESTED") {
        lastRequestIndex = i;
        break;
      }
    }
    if (lastRequestIndex === -1) return null;
    for (let i = lastRequestIndex + 1; i < events.length; i += 1) {
      const e = events[i];
      if (e?.type === "MONTH_CLOSED") return null;
    }
    return events[lastRequestIndex];
  }

	  async function tickMonthClose({ maxMessages = 10 } = {}) {
	    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) throw new TypeError("maxMessages must be a positive safe integer");
	    if (!Number.isSafeInteger(store.monthCloseCursor) || store.monthCloseCursor < 0) store.monthCloseCursor = 0;

	    const processed = [];

	    function monthRangeMs(yearMonth) {
	      parseYearMonth(yearMonth);
	      const [yRaw, mRaw] = String(yearMonth).split("-");
	      const y = Number(yRaw);
	      const m = Number(mRaw);
	      const startMs = Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
	      const endMs = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0, 0);
	      return { startMs, endMs };
	    }

	    // Ensure ledger/app-side projections are up to date in memory mode so month-close can build
	    // allocation-backed party statements.
	    if (store.kind !== "pg" && Array.isArray(store.outbox)) {
	      try {
	        processInMemoryOutbox(store, { maxMessages: Number.MAX_SAFE_INTEGER });
	      } catch {
	        // ignore
	      }
	    }

	    while (store.monthCloseCursor < store.outbox.length && processed.length < maxMessages) {
	      const message = store.outbox[store.monthCloseCursor];
	      store.monthCloseCursor += 1;
	      if (!message || typeof message !== "object") continue;
      if (message.type !== "MONTH_CLOSE_REQUESTED") continue;

      const tenantId = normalizeTenant(message.tenantId ?? DEFAULT_TENANT_ID);
      const month = message.month ? String(message.month) : null;
      const basis = message.basis ? String(message.basis) : MONTH_CLOSE_BASIS.SETTLED_AT;
      if (!month) continue;

      const monthId = message.monthId ? String(message.monthId) : makeMonthCloseStreamId({ month, basis });
      const existing = getMonthEvents(tenantId, monthId);
      if (existing.length === 0) continue;

      const pending = getPendingMonthCloseRequestEvent(existing);
      if (!pending) continue;
      if (typeof message.sourceEventId === "string" && message.sourceEventId.trim() !== "" && pending.id !== message.sourceEventId) {
        continue;
      }

      // Only close once per request.
      const monthBefore = reduceMonthClose(existing);
      if (monthBefore?.status === "CLOSED") continue;

	      let statement;
      const stableGeneratedAt =
        (typeof message.at === "string" && message.at.trim() ? String(message.at) : null) ??
        (typeof pending?.at === "string" && pending.at.trim() ? String(pending.at) : null) ??
        (typeof pending?.payload?.requestedAt === "string" && pending.payload.requestedAt.trim() ? String(pending.payload.requestedAt) : null) ??
        nowIso();

      // Month-close hold policy: whether open holds block close.
      const tenantCfg = typeof store.getConfig === "function" ? store.getConfig(tenantId) : store.configByTenant?.get(tenantId) ?? store.config ?? null;
      let closeHoldPolicy = MONTH_CLOSE_HOLD_POLICY.BLOCK_HOLDS_ORIGINATED_IN_PERIOD;
      let closeHoldPolicySource = { kind: "config", eventId: null, chainHash: null, effectiveFrom: null };
      try {
        closeHoldPolicy = normalizeMonthCloseHoldPolicy(tenantCfg?.finance?.monthCloseHoldPolicy ?? null);
      } catch {
        closeHoldPolicy = MONTH_CLOSE_HOLD_POLICY.BLOCK_HOLDS_ORIGINATED_IN_PERIOD;
      }
      try {
        const { startMs, endMs } = monthRangeMs(month);

        // Effective-dated policy overrides live in the tenant governance stream.
        try {
          const govEvents = getMonthEvents(tenantId, GOVERNANCE_STREAM_ID);
          let selected = null;
          for (const e of govEvents) {
            if (e?.type !== "TENANT_POLICY_UPDATED") continue;
            const finance = e?.payload?.policy?.finance ?? null;
            const modeRaw = finance?.monthCloseHoldPolicy ?? null;
            if (!modeRaw) continue;
            const effectiveFrom = typeof e?.payload?.effectiveFrom === "string" && e.payload.effectiveFrom.trim() ? e.payload.effectiveFrom : e?.at ?? null;
            const effMs = effectiveFrom ? Date.parse(String(effectiveFrom)) : NaN;
            if (!Number.isFinite(effMs) || effMs >= endMs) continue;
            const normalized = normalizeMonthCloseHoldPolicy(modeRaw);
            if (!selected || effMs > selected.effMs) {
              selected = { effMs, effectiveFrom: String(effectiveFrom), policy: normalized, eventId: e?.id ?? null, chainHash: e?.chainHash ?? null };
            }
          }
          if (selected) {
            closeHoldPolicy = selected.policy;
            closeHoldPolicySource = { kind: "governance_event", eventId: selected.eventId, chainHash: selected.chainHash, effectiveFrom: selected.effectiveFrom };
          }
        } catch {
          // ignore governance policy parse failures; fall back to config
        }

        const blocking = [];
        for (const job of listJobs({ tenantId })) {
          if (!job?.id) continue;
          const hold = job.settlementHold ?? null;
          if (!hold || typeof hold !== "object") continue;
          if (String(hold.status ?? "").toUpperCase() !== "HELD") continue;
          if (closeHoldPolicy === MONTH_CLOSE_HOLD_POLICY.ALLOW_WITH_DISCLOSURE) continue;

          if (closeHoldPolicy === MONTH_CLOSE_HOLD_POLICY.BLOCK_ANY_OPEN_HOLDS) {
            blocking.push({ jobId: job.id, holdId: hold.holdId ?? null, heldAt: hold.heldAt ?? null });
            continue;
          }

          const heldAt = typeof hold.heldAt === "string" && hold.heldAt.trim() ? hold.heldAt : job.execution?.completedAt ?? null;
          const heldAtMs = heldAt ? Date.parse(String(heldAt)) : NaN;
          if (!Number.isFinite(heldAtMs)) continue;
          if (heldAtMs >= startMs && heldAtMs < endMs) {
            blocking.push({ jobId: job.id, holdId: hold.holdId ?? null, heldAt: heldAt ?? null });
          }
        }
        if (blocking.length) {
          metricInc("month_close_blocked_total", { tenantId, reason: "open_holds" }, 1);
          processed.push({ month, status: "failed", reason: "open_holds", closeHoldPolicy, closeHoldPolicySource, blocking });
          continue;
        }
      } catch (err) {
        processed.push({ month, status: "failed", reason: "open_holds_check_failed", message: err?.message ?? String(err ?? "") });
        continue;
      }
	      try {
	        let ledgerEntries = [];
	        try {
	          ledgerEntries = await listAllLedgerEntriesForTenant({ tenantId });
	        } catch {
	          ledgerEntries = [];
	        }
	        statement = computeMonthlyStatement({
	          tenantId,
	          customerId: null,
	          siteId: null,
	          month,
	          jobs: listJobs({ tenantId }),
	          getEventsForJob: (jobId) => getJobEvents(tenantId, jobId),
	          ledgerEntries,
	          nowIso: () => stableGeneratedAt
	        });
	      } catch {
	        processed.push({ month, status: "failed", reason: "invalid_statement" });
	        continue;
	      }

      const sliced = pending.chainHash ? sliceEventsThroughChainHash(existing, pending.chainHash) : existing;
      const generatedAt = stableGeneratedAt;

      // Held exposure rollforward (controller reconciliation hook): opening + new − releases − forfeits = ending.
      try {
        const { startMs, endMs } = monthRangeMs(month);

        function addAmounts(bucket, exposure) {
          if (!exposure || typeof exposure !== "object") return;
          const currency = typeof exposure.currency === "string" && exposure.currency.trim() ? exposure.currency : "USD";
          if (!bucket.byCurrency[currency]) {
            bucket.byCurrency[currency] = {
              holdCount: 0,
              amountGrossCents: 0,
              amountNetCents: 0,
              coverageFeeCents: 0
            };
          }
          const c = bucket.byCurrency[currency];
          c.holdCount += 1;
          c.amountGrossCents += Number.isSafeInteger(exposure.amountGrossCents) ? exposure.amountGrossCents : 0;
          c.amountNetCents += Number.isSafeInteger(exposure.amountNetCents) ? exposure.amountNetCents : 0;
          c.coverageFeeCents += Number.isSafeInteger(exposure.coverageFeeCents) ? exposure.coverageFeeCents : 0;
        }

        function emptyBucket() {
          return { holdCount: 0, byCurrency: {} };
        }

        const buckets = {
          opening: emptyBucket(),
          newHolds: emptyBucket(),
          released: emptyBucket(),
          forfeited: emptyBucket(),
          ending: emptyBucket()
        };

        const holdRows = [];
        const jobs = listJobs({ tenantId }).slice().sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
        for (const job of jobs) {
          const hold = job?.settlementHold ?? null;
          if (!hold || typeof hold !== "object") continue;
          const holdId = typeof hold.holdId === "string" && hold.holdId.trim() ? hold.holdId : null;
          const heldAt = typeof hold.heldAt === "string" && hold.heldAt.trim() ? hold.heldAt : null;
          if (!holdId || !heldAt) continue;

          const heldAtMs = Date.parse(heldAt);
          if (!Number.isFinite(heldAtMs)) continue;

          const releasedAt = typeof hold.releasedAt === "string" && hold.releasedAt.trim() ? hold.releasedAt : null;
          const forfeitedAt = typeof hold.forfeitedAt === "string" && hold.forfeitedAt.trim() ? hold.forfeitedAt : null;
          const releasedAtMs = releasedAt ? Date.parse(releasedAt) : NaN;
          const forfeitedAtMs = forfeitedAt ? Date.parse(forfeitedAt) : NaN;

          const expected = hold.expectedExposure ?? null;
          const heldExposure = hold.heldExposure ?? null;

          const openAtStart =
            heldAtMs < startMs &&
            (!Number.isFinite(releasedAtMs) || releasedAtMs >= startMs) &&
            (!Number.isFinite(forfeitedAtMs) || forfeitedAtMs >= startMs);
          const openAtEnd =
            heldAtMs < endMs &&
            (!Number.isFinite(releasedAtMs) || releasedAtMs >= endMs) &&
            (!Number.isFinite(forfeitedAtMs) || forfeitedAtMs >= endMs);

          const isNew = heldAtMs >= startMs && heldAtMs < endMs;
          const isReleased = Number.isFinite(releasedAtMs) && releasedAtMs >= startMs && releasedAtMs < endMs;
          const isForfeited = Number.isFinite(forfeitedAtMs) && forfeitedAtMs >= startMs && forfeitedAtMs < endMs;

          if (openAtStart) {
            buckets.opening.holdCount += 1;
            addAmounts(buckets.opening, heldExposure);
          }
          if (isNew) {
            buckets.newHolds.holdCount += 1;
            addAmounts(buckets.newHolds, heldExposure);
          }
          if (isReleased) {
            buckets.released.holdCount += 1;
            addAmounts(buckets.released, heldExposure);
          }
          if (isForfeited) {
            buckets.forfeited.holdCount += 1;
            addAmounts(buckets.forfeited, heldExposure);
          }
          if (openAtEnd) {
            buckets.ending.holdCount += 1;
            addAmounts(buckets.ending, heldExposure);
          }

          const touched = isNew || isReleased || isForfeited || openAtStart || openAtEnd;
          if (touched) {
            holdRows.push({
              jobId: job.id,
              holdId,
              status: hold.status ?? null,
              heldAt,
              lastUpdatedAt: hold.lastUpdatedAt ?? null,
              releasedAt,
              forfeitedAt,
              forfeitureReason: hold.forfeitureReason ?? null,
              decisionRef: hold.decisionRef ?? null,
              decisionEventRef: hold.decisionEventRef ?? null,
              reasonCodes: Array.isArray(hold.reasonCodes) ? hold.reasonCodes : [],
              missingEvidence: Array.isArray(hold.missingEvidence) ? hold.missingEvidence : [],
              pricingAnchor: hold.pricingAnchor ?? null,
              expectedExposure: expected,
              heldExposure: heldExposure
            });
          }
        }

        holdRows.sort((a, b) => String(a.holdId).localeCompare(String(b.holdId)) || String(a.jobId).localeCompare(String(b.jobId)));

        const rollforward = {
          schemaVersion: "HeldExposureRollforwardReport.v1",
          period: month,
          basis,
          closeHoldPolicy,
          closeHoldPolicySource,
          window: {
            startAt: new Date(startMs).toISOString(),
            endAt: new Date(endMs).toISOString()
          },
          buckets
        };

        const rollArtifactId = `held_roll_${tenantId}_${month}_${pending.id}`;
        const rollBody = buildHeldExposureRollforwardV1({
          tenantId,
          period: month,
          basis,
          rollforward,
          holds: holdRows,
          events: sliced,
          artifactId: rollArtifactId,
          generatedAt
        });
        const rollCore = { ...rollBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? rollBody?.eventProof?.lastChainHash ?? null };
        const rollHash = computeArtifactHash(rollCore);
        const rollArtifact = { ...rollCore, artifactHash: rollHash };
        await store.putArtifact({ tenantId, artifact: rollArtifact });

        const rollDestinations = listDestinationsForTenant(tenantId).filter((d) => {
          const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
          return !allowed || allowed.includes(ARTIFACT_TYPE.HELD_EXPOSURE_ROLLFORWARD_V1);
        });
        for (const dest of rollDestinations) {
          const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.HELD_EXPOSURE_ROLLFORWARD_V1}:${rollArtifact.artifactId}:${rollArtifact.artifactHash}`;
          const scopeKey = `held_roll:period:${month}`;
          const orderSeq = 0;
          const priority = 89;
          const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${rollArtifact.artifactId}`;
          await store.createDelivery({
            tenantId,
            delivery: {
              destinationId: dest.destinationId,
              artifactType: ARTIFACT_TYPE.HELD_EXPOSURE_ROLLFORWARD_V1,
              artifactId: rollArtifact.artifactId,
              artifactHash: rollArtifact.artifactHash,
              dedupeKey,
              scopeKey,
              orderSeq,
              priority,
              orderKey
            }
          });
        }
      } catch (err) {
        processed.push({ month, status: "failed", reason: "held_rollforward_failed", message: err?.message ?? String(err ?? "") });
        continue;
      }
      const statementArtifactId = `stmt_${tenantId}_${month}_${pending.id}`;
      const body = buildMonthlyStatementV1({
	        tenantId,
	        month,
	        basis,
	        statement,
	        events: sliced,
	        artifactId: statementArtifactId,
	        generatedAt
	      });
      const artifactCore = { ...body, sourceEventId: pending.id, atChainHash: pending.chainHash ?? body?.eventProof?.lastChainHash ?? null };
      const artifactHash = computeArtifactHash(artifactCore);
      const artifact = { ...artifactCore, artifactHash };

      try {
        await store.putArtifact({ tenantId, artifact });
      } catch (err) {
        // Artifact hash mismatch means a semantic drift; treat as failure and surface via ops.
        processed.push({ month, status: "failed", reason: err?.code ?? "artifact_put_failed" });
        continue;
      }

      const destinations = listDestinationsForTenant(tenantId).filter((d) => {
        const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
        return !allowed || allowed.includes(ARTIFACT_TYPE.MONTHLY_STATEMENT_V1);
      });
	      for (const dest of destinations) {
	        const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.MONTHLY_STATEMENT_V1}:${artifact.artifactId}:${artifact.artifactHash}`;
	        const scopeKey = `month:${month}`;
	        const orderSeq = 0;
	        const priority = 90;
	        const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${artifact.artifactId}`;
        try {
          await store.createDelivery({
            tenantId,
            delivery: {
              destinationId: dest.destinationId,
              artifactType: ARTIFACT_TYPE.MONTHLY_STATEMENT_V1,
              artifactId: artifact.artifactId,
              artifactHash: artifact.artifactHash,
              dedupeKey,
              scopeKey,
              orderSeq,
              priority,
              orderKey
            }
          });
        } catch {
          // Best-effort: delivery rails will retry based on DB constraints/dedupe.
	        }
	      }

	      // Party statements + payout instructions (Connect v1).
	      try {
	        const periodBounds = parseYearMonth(month);
	        const startMs = Date.parse(periodBounds.startAt);
	        const endMs = Date.parse(periodBounds.endAt);
	        const includedJobIds = new Set((statement.jobs ?? []).map((j) => String(j?.jobId ?? "")).filter((id) => id && id.trim() !== ""));

	        const entries = await listAllLedgerEntriesForTenant({ tenantId });
	        const entriesById = new Map();
	        const includedEntryIds = new Set();
	        for (const entry of entries) {
	          if (!entry?.id || !entry?.at) continue;
	          const t = Date.parse(entry.at);
	          if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
	          entriesById.set(String(entry.id), entry);
	          const jobId = jobIdFromLedgerMemo(entry.memo ?? "");
	          if (jobId && includedJobIds.has(jobId)) includedEntryIds.add(String(entry.id));
	        }

	        const allocations = [];
	        for (const a of store.ledgerAllocations?.values?.() ?? []) {
	          if (!a || typeof a !== "object") continue;
	          if (normalizeTenantId(a.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
	          if (!includedEntryIds.has(String(a.entryId ?? ""))) continue;
	          allocations.push(a);
	        }

	        const byParty = new Map(); // `${partyRole}\n${partyId}` -> allocations
	        for (const a of allocations) {
	          const partyRole = a.partyRole ?? null;
	          const partyId = a.partyId ?? null;
	          if (!partyRole || !partyId) continue;
	          const key = `${partyRole}\n${partyId}`;
	          const list = byParty.get(key) ?? [];
	          list.push(a);
	          byParty.set(key, list);
	        }

	        const partyInfo = new Map(); // key -> { partyId, partyRole, statementHash, statement }
	        for (const [key, partyAllocs] of byParty.entries()) {
	          const [partyRole, partyId] = key.split("\n");
	          const partyStatement = computePartyStatement({
	            tenantId,
	            partyId,
	            partyRole,
	            period: month,
	            basis,
	            allocations: partyAllocs,
	            entriesById,
	            currency: "USD"
	          });

	          const partyArtifactId = `pstmt_${tenantId}_${partyId}_${month}_${pending.id}`;
	          const partyBody = buildPartyStatementV1({
	            tenantId,
	            partyId,
	            partyRole,
	            period: month,
	            basis,
	            statement: partyStatement,
	            events: sliced,
	            artifactId: partyArtifactId,
	            generatedAt
	          });
	          const partyCore = { ...partyBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? partyBody?.eventProof?.lastChainHash ?? null };
	          const partyHash = computeArtifactHash(partyCore);
	          const partyArtifact = { ...partyCore, artifactHash: partyHash };
	          await store.putArtifact({ tenantId, artifact: partyArtifact });
	          if (typeof store.putPartyStatement === "function") {
	            await store.putPartyStatement({
	              tenantId,
	              statement: {
	                partyId,
	                period: month,
	                basis,
	                status: "CLOSED",
	                statementHash: partyHash,
	                artifactId: partyArtifactId,
	                artifactHash: partyHash,
	                closedAt: generatedAt
	              }
	            });
	          }

	          const partyDestinations = listDestinationsForTenant(tenantId).filter((d) => {
	            const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
	            return !allowed || allowed.includes(ARTIFACT_TYPE.PARTY_STATEMENT_V1);
	          });
	          for (const dest of partyDestinations) {
	            const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.PARTY_STATEMENT_V1}:${partyArtifact.artifactId}:${partyArtifact.artifactHash}`;
	            const scopeKey = `party:${partyId}:period:${month}`;
	            const orderSeq = 0;
	            const priority = 85;
	            const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${partyArtifact.artifactId}`;
	            await store.createDelivery({
	              tenantId,
	              delivery: {
	                destinationId: dest.destinationId,
	                artifactType: ARTIFACT_TYPE.PARTY_STATEMENT_V1,
	                artifactId: partyArtifact.artifactId,
	                artifactHash: partyArtifact.artifactHash,
	                dedupeKey,
	                scopeKey,
	                orderSeq,
	                priority,
	                orderKey
	              }
	            });
	          }

	          partyInfo.set(key, { partyId, partyRole, statementHash: partyHash, statement: partyStatement });
	        }

	        for (const info of partyInfo.values()) {
	          const payoutAmountCents = computePayoutAmountCentsForStatement({ partyRole: info.partyRole, statement: info.statement });
	          if (!Number.isSafeInteger(payoutAmountCents) || payoutAmountCents <= 0) continue;
	          const payoutKey = payoutKeyFor({ tenantId, partyId: info.partyId, period: month, statementHash: info.statementHash });
	          const payoutArtifactId = `payout_${tenantId}_${info.partyId}_${month}_${info.statementHash}`;
	          const payoutBody = buildPayoutInstructionV1({
	            tenantId,
	            partyId: info.partyId,
	            partyRole: info.partyRole,
	            period: month,
	            statementHash: info.statementHash,
	            payoutKey,
	            currency: "USD",
	            amountCents: payoutAmountCents,
	            destinationRef: null,
	            events: sliced,
	            artifactId: payoutArtifactId,
	            generatedAt
	          });
	          const payoutCore = { ...payoutBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? payoutBody?.eventProof?.lastChainHash ?? null };
	          const payoutHash = computeArtifactHash(payoutCore);
	          const payoutArtifact = { ...payoutCore, artifactHash: payoutHash };
	          await store.putArtifact({ tenantId, artifact: payoutArtifact });

	          const payoutDestinations = listDestinationsForTenant(tenantId).filter((d) => {
	            const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
	            return !allowed || allowed.includes(ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1);
	          });
	          for (const dest of payoutDestinations) {
	            const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1}:${payoutKey}:${payoutArtifact.artifactHash}`;
	            const scopeKey = `payout:${info.partyId}:period:${month}`;
	            const orderSeq = 0;
	            const priority = 95;
	            const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${payoutArtifact.artifactId}`;
	            await store.createDelivery({
	              tenantId,
	              delivery: {
	                destinationId: dest.destinationId,
	                artifactType: ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1,
	                artifactId: payoutArtifact.artifactId,
	                artifactHash: payoutArtifact.artifactHash,
	                dedupeKey,
	                scopeKey,
	                orderSeq,
	                priority,
	                orderKey
	              }
	            });
	          }
	        }

	          // Finance Pack v1: GLBatch.v1 (canonical GL export input).
	          let glArtifact = null;
	          try {
	            const allocationRows = allocations.map((a) => {
	              const entry = entriesById.get(String(a.entryId ?? "")) ?? null;
	              return {
                entryId: String(a.entryId),
                postingId: String(a.postingId),
                accountId: String(a.accountId),
                partyId: String(a.partyId),
                partyRole: String(a.partyRole),
                currency: String(a.currency ?? "USD"),
                amountCents: Number(a.amountCents),
                memo: typeof entry?.memo === "string" ? entry.memo : null,
                at: typeof entry?.at === "string" ? entry.at : null
              };
            });

            const { body: glBody } = computeGlBatchBodyV1({
              tenantId,
              period: month,
              basis,
              allocationRows,
              generatedAt,
              monthClose: {
                month,
                basis,
                monthCloseEventId: pending.id,
                monthlyStatementArtifactHash: artifactHash
              }
            });

            const glArtifactId = `gl_${tenantId}_${month}_${pending.id}`;
            const glBatchBody = buildGlBatchV1({
              tenantId,
              period: month,
              basis,
              batch: glBody,
              events: sliced,
              artifactId: glArtifactId,
              generatedAt
            });
            const glCore = { ...glBatchBody, sourceEventId: pending.id, atChainHash: pending.chainHash ?? glBatchBody?.eventProof?.lastChainHash ?? null };
	            const glHash = computeArtifactHash(glCore);
	            glArtifact = { ...glCore, artifactHash: glHash };
	            await store.putArtifact({ tenantId, artifact: glArtifact });

            const glDestinations = listDestinationsForTenant(tenantId).filter((d) => {
              const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
              return !allowed || allowed.includes(ARTIFACT_TYPE.GL_BATCH_V1);
            });
            for (const dest of glDestinations) {
              const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.GL_BATCH_V1}:${glArtifact.artifactId}:${glArtifact.artifactHash}`;
              const scopeKey = `glbatch:period:${month}`;
              const orderSeq = 0;
              const priority = 96;
              const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${glArtifact.artifactId}`;
              await store.createDelivery({
                tenantId,
                delivery: {
                  destinationId: dest.destinationId,
                  artifactType: ARTIFACT_TYPE.GL_BATCH_V1,
                  artifactId: glArtifact.artifactId,
                  artifactHash: glArtifact.artifactHash,
                  dedupeKey,
                  scopeKey,
                  orderSeq,
                  priority,
                  orderKey
                }
              });
            }
	          } catch (err) {
	            processed.push({ month, status: "failed", reason: err?.code ?? "gl_batch_failed" });
	            continue;
	          }

	          // Finance Pack v1: JournalCsv.v1 (delivered CSV export).
	          let journalCsvGateMode = "warn";
	          try {
	            const accountMap = await store.getFinanceAccountMap({ tenantId });
	            journalCsvGateMode =
	              accountMap && typeof accountMap === "object" && accountMap.exportPolicy?.gateMode === "strict" ? "strict" : "warn";

	            if (!accountMap) {
	              metricInc("finance_export_blocked_total", { tenantId, kind: "journal_csv", reason: "missing_account_map" }, 1);
	              if (journalCsvGateMode === "strict") {
	                const err = new Error("finance export blocked: missing finance account map");
	                err.code = "FINANCE_EXPORT_BLOCKED";
	                throw err;
	              }
	            } else {
	              const accountMapHash = computeFinanceAccountMapHash(accountMap);
	              const { csv, csvHash } = renderJournalCsvV1({ glBatchArtifact: glArtifact, accountMap });
	              const csvArtifactId = `journalcsv_${tenantId}_${month}_${pending.id}`;
	              const csvBody = buildJournalCsvV1({
	                tenantId,
	                period: month,
	                basis,
	                glBatchArtifactId: glArtifact.artifactId,
	                glBatchArtifactHash: glArtifact.artifactHash,
	                accountMapHash,
	                csv,
	                csvSha256: csvHash,
	                events: sliced,
	                artifactId: csvArtifactId,
	                generatedAt
	              });
	              const csvCore = {
	                ...csvBody,
	                sourceEventId: pending.id,
	                atChainHash: pending.chainHash ?? csvBody?.eventProof?.lastChainHash ?? null
	              };
	              const csvArtifactHash = computeArtifactHash(csvCore);
	              const csvArtifact = { ...csvCore, artifactHash: csvArtifactHash };
	              await store.putArtifact({ tenantId, artifact: csvArtifact });

	              metricInc("finance_journalcsv_emitted_total", { tenantId }, 1);

	              const csvDestinations = listDestinationsForTenant(tenantId).filter((d) => {
	                const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
	                return !allowed || allowed.includes(ARTIFACT_TYPE.JOURNAL_CSV_V1);
	              });
	              for (const dest of csvDestinations) {
	                const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.JOURNAL_CSV_V1}:${csvArtifact.artifactId}:${csvArtifact.artifactHash}`;
	                const scopeKey = `journalcsv:period:${month}`;
	                const orderSeq = 1;
	                const priority = 96;
	                const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${csvArtifact.artifactId}`;
	                await store.createDelivery({
	                  tenantId,
	                  delivery: {
	                    destinationId: dest.destinationId,
	                    artifactType: ARTIFACT_TYPE.JOURNAL_CSV_V1,
	                    artifactId: csvArtifact.artifactId,
	                    artifactHash: csvArtifact.artifactHash,
	                    dedupeKey,
	                    scopeKey,
	                    orderSeq,
	                    priority,
	                    orderKey
	                  }
	                });
	              }
	            }
	          } catch (err) {
	            const reason = err?.code ?? "journal_csv_failed";
	            metricInc("finance_export_blocked_total", { tenantId, kind: "journal_csv", reason }, 1);
	            if (err?.code === "FINANCE_EXPORT_BLOCKED" || (journalCsvGateMode === "strict" && err?.code === "FINANCE_ACCOUNT_MAP_MISSING")) {
	              processed.push({ month, status: "failed", reason });
	              continue;
	            }
	          }
	      } catch (err) {
	        processed.push({ month, status: "failed", reason: err?.code ?? "party_statement_failed" });
	        continue;
	      }

	      const closedAt = nowIso();
	      const closedPayload = {
	        tenantId,
	        month,
        basis,
        closedAt,
        statementArtifactId,
        statementArtifactHash: artifactHash
      };

      let closedEvent;
      try {
        validateMonthClosedPayload(closedPayload);
        const draft = createChainedEvent({
          streamId: monthId,
          type: "MONTH_CLOSED",
          at: closedAt,
          actor: { type: "finance", id: "month_close_v1" },
          payload: closedPayload
        });
        const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
        closedEvent = nextEvents[nextEvents.length - 1];
        enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(closedEvent.type), event: closedEvent });
      } catch {
        processed.push({ month, status: "failed", reason: "close_event_rejected" });
        continue;
      }

      try {
        await commitTx([{ kind: "MONTH_EVENTS_APPENDED", tenantId, monthId, events: [closedEvent] }]);
        processed.push({ month, status: "closed", statementArtifactId, statementArtifactHash: artifactHash });

        // Phase 2: FinancePackBundle.v1 (zip stored by hash + small pointer artifact delivered on rails).
        try {
          const finalMonthEvents = getMonthEvents(tenantId, monthId);
          const allArtifacts = typeof store.listArtifacts === "function" ? await store.listArtifacts({ tenantId }) : [];
          const monthArtifacts = (allArtifacts ?? []).filter((a) => {
            if (!a || typeof a !== "object") return false;
            if (a.period && String(a.period) === String(month)) return true;
            if (a.month && String(a.month) === String(month)) return true;
            return false;
          });

          const glBatch = monthArtifacts
            .filter((a) => a?.artifactType === "GLBatch.v1")
            .sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")))
            .slice(-1)[0];
          const journalCsv = monthArtifacts
            .filter((a) => a?.artifactType === "JournalCsv.v1")
            .sort((a, b) => String(a?.artifactId ?? "").localeCompare(String(b?.artifactId ?? "")))
            .slice(-1)[0];
          const partyStatements = monthArtifacts.filter((a) => a?.artifactType === "PartyStatement.v1");

          if (glBatch && journalCsv && partyStatements.length && store.evidenceStore) {
            const reconcile = reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements });
              if (reconcile.ok) {
                const publicKeyByKeyId = store.publicKeyByKeyId instanceof Map ? store.publicKeyByKeyId : new Map();
                let signerKeys = [];
                if (typeof store.listSignerKeys === "function") {
                  const tenantKeys = await store.listSignerKeys({ tenantId });
                  const defaultKeys = await store.listSignerKeys({ tenantId: DEFAULT_TENANT_ID });
                  const all = [...(tenantKeys ?? []), ...(defaultKeys ?? [])];
                  const byKeyId = new Map();
                  for (const r of all) {
                    const keyId = r?.keyId ? String(r.keyId) : null;
                    if (!keyId) continue;
                    byKeyId.set(keyId, r);
                  }
                  signerKeys = Array.from(byKeyId.values());
                }
                const tenantGovEvents = getMonthEvents(tenantId, GOVERNANCE_STREAM_ID);
                const tenantGovSnapshot = {
                  streamId: GOVERNANCE_STREAM_ID,
                  lastChainHash: tenantGovEvents.length ? tenantGovEvents[tenantGovEvents.length - 1]?.chainHash ?? null : null,
                  lastEventId: tenantGovEvents.length ? tenantGovEvents[tenantGovEvents.length - 1]?.id ?? null : null
                };
                const govEvents = getMonthEvents(DEFAULT_TENANT_ID, GOVERNANCE_STREAM_ID);
                const govSnapshot = {
                  streamId: GOVERNANCE_STREAM_ID,
                  lastChainHash: govEvents.length ? govEvents[govEvents.length - 1]?.chainHash ?? null : null,
                  lastEventId: govEvents.length ? govEvents[govEvents.length - 1]?.id ?? null : null
                };
                const generatedAt = stableGeneratedAt;
                const { files: monthFiles, bundle: monthBundle } = buildMonthProofBundleV1({
                  tenantId,
                  period: String(month),
                  basis,
                  monthEvents: finalMonthEvents,
                  governanceEvents: govEvents,
                  governanceSnapshot: govSnapshot,
                  tenantGovernanceEvents: tenantGovEvents,
                  tenantGovernanceSnapshot: tenantGovSnapshot,
                  artifacts: monthArtifacts,
                  contractDocsByHash: new Map(),
                  publicKeyByKeyId,
                  signerKeys,
                  manifestSigner: serverSigner,
                  requireHeadAttestation: true,
                  generatedAt
                });

              const protocol = "1.0";
              const reconcileBytes = new TextEncoder().encode(`${canonicalJsonStringify(reconcile)}\n`);
              const { files, bundle } = buildFinancePackBundleV1({
                tenantId,
                period: String(month),
                protocol,
                createdAt: stableGeneratedAt,
                monthProofBundle: monthBundle,
                monthProofFiles: monthFiles,
                requireMonthProofAttestation: true,
                verificationReportSigner: serverSigner,
                glBatchArtifact: glBatch,
                journalCsvArtifact: journalCsv,
                reconcileReport: reconcile,
                reconcileReportBytes: reconcileBytes
              });

              const zipBytes = buildDeterministicZipStore({ files, mtime: new Date(stableGeneratedAt) });
              const bundleHash = sha256HexBytes(zipBytes);
              const evidenceRef = `obj://finance-pack/${String(month)}/${bundleHash}.zip`;

              let alreadyExisted = false;
              try {
                const existingZip = await store.evidenceStore.readEvidence({ tenantId, evidenceRef });
                const existingHash = sha256HexBytes(existingZip.data);
                if (existingHash !== bundleHash) throw new Error("finance pack bundle already exists with different bytes");
                alreadyExisted = true;
              } catch (err) {
                if (err?.code !== "ENOENT") throw err;
              }
              if (!alreadyExisted) {
                await store.evidenceStore.putEvidence({ tenantId, evidenceRef, data: zipBytes });
              }

              const pointerArtifactId = `finance_pack_${tenantId}_${String(month)}_${bundleHash}`;
              const objectStore =
                store.evidenceStore?.kind === "s3"
                  ? {
                      kind: "s3",
                      endpoint: store.evidenceStore.endpoint,
                      region: store.evidenceStore.region,
                      bucket: store.evidenceStore.bucket,
                      key: typeof store.evidenceStore.keyFor === "function" ? store.evidenceStore.keyFor({ tenantId, evidenceRef }) : null,
                      forcePathStyle: store.evidenceStore.forcePathStyle !== false
                    }
                  : { kind: store.evidenceStore?.kind ?? "unknown" };

              const pointerBody = buildFinancePackBundlePointerV1({
                tenantId,
                period: String(month),
                basis,
                bundleHash,
                bundleManifestHash: bundle.manifestHash,
                monthProofBundleHash: monthBundle.manifestHash,
                glBatchHash: String(glBatch.artifactHash),
                journalCsvHash: String(journalCsv.csvSha256),
                reconcileReportHash: sha256HexBytes(reconcileBytes),
                financeAccountMapHash: String(journalCsv.accountMapHash),
                evidenceRef,
                objectStore,
                events: finalMonthEvents,
                artifactId: pointerArtifactId,
                generatedAt: stableGeneratedAt
              });
              const pointerCore = { ...pointerBody, sourceEventId: pending.id, atChainHash: closedEvent.chainHash ?? pointerBody?.eventProof?.lastChainHash ?? null };
              const pointerHash = computeArtifactHash(pointerCore);
              const pointerArtifact = { ...pointerCore, artifactHash: pointerHash };
              await store.putArtifact({ tenantId, artifact: pointerArtifact });

              const fpDestinations = listDestinationsForTenant(tenantId).filter((d) => {
                const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
                return !allowed || allowed.includes(ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1);
              });
              for (const dest of fpDestinations) {
                const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1}:${pointerArtifact.artifactId}:${pointerArtifact.artifactHash}`;
                const scopeKey = `finance_pack:period:${month}`;
                const orderSeq = 2;
                const priority = 97;
                const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${pointerArtifact.artifactId}`;
                await store.createDelivery({
                  tenantId,
                  delivery: {
                    destinationId: dest.destinationId,
                    artifactType: ARTIFACT_TYPE.FINANCE_PACK_BUNDLE_V1,
                    artifactId: pointerArtifact.artifactId,
                    artifactHash: pointerArtifact.artifactHash,
                    dedupeKey,
                    scopeKey,
                    orderSeq,
                    priority,
                    orderKey
                  }
                });
              }
            }
          }
        } catch (err) {
          logger.warn("finance_pack.memory.failed", { tenantId, month, basis, err });
        }
      } catch {
        // Ignore: may be concurrent close; idempotency via prevChainHash will prevent forks.
        processed.push({ month, status: "conflict" });
      }
    }

    return { processed, cursor: store.monthCloseCursor };
  }

  async function tickLiveness({ maxJobs = 1000 } = {}) {
    if (!Number.isSafeInteger(maxJobs) || maxJobs <= 0) throw new TypeError("maxJobs must be a positive safe integer");

    const at = nowIso();
    const nowMs = Date.parse(at);
    const appended = [];

    let scanned = 0;
    for (const job of store.jobs.values()) {
      if (!job?.id) continue;
      const tenantId = normalizeTenant(job.tenantId ?? DEFAULT_TENANT_ID);
      scanned += 1;
      if (scanned > maxJobs) break;

      const existing = getJobEvents(tenantId, job.id);
      if (existing.length === 0) continue;

      const jobBefore = reduceJob(existing);
      if (!jobBefore) continue;

      const envTier = jobBefore.booking?.environmentTier ?? null;
      const policy = computeLivenessPolicy({ environmentTier: envTier });

      const startedAt = jobBefore.execution?.startedAt ?? null;
      if (!startedAt) continue;

      const lastHeartbeatAt = jobBefore.execution?.lastHeartbeatAt ?? startedAt;
      const lastMs = Date.parse(lastHeartbeatAt);
      if (!Number.isFinite(lastMs)) continue;

      // If executing and heartbeat is overdue, append a stall event.
      if ((jobBefore.status === "EXECUTING" || jobBefore.status === "ASSISTED") && nowMs - lastMs > policy.stallAfterMs) {
        const robotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? jobBefore.match?.robotId ?? null;
        if (!robotId) continue;

        const draft = createChainedEvent({
          streamId: jobBefore.id,
          type: "JOB_EXECUTION_STALLED",
          at,
          actor: { type: "liveness", id: "liveness_v0" },
          payload: {
            jobId: jobBefore.id,
            robotId,
            detectedAt: at,
            reason: "NO_HEARTBEAT",
            lastHeartbeatAt,
            policy
          }
        });

        const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
        const event = nextEvents[nextEvents.length - 1];

        try {
          enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          validateDomainEvent({ jobBefore, event, eventsBefore: existing });
        } catch {
          continue;
        }

        let jobAfter;
        try {
          jobAfter = reduceJob(nextEvents);
        } catch {
          continue;
        }

        const outboxMessages = [];
        if (jobBefore.status !== jobAfter.status) {
          outboxMessages.push({
            type: "JOB_STATUS_CHANGED",
            tenantId,
            jobId: jobBefore.id,
            fromStatus: jobBefore.status,
            toStatus: jobAfter.status,
            at: event.at
          });
        }
        outboxMessages.push({
          type: "JOB_STALLED",
          tenantId,
          jobId: jobBefore.id,
          robotId,
          at: event.at,
          sourceEventId: event.id
        });
        outboxMessages.push({
          type: "NOTIFY_OPS_JOB_STALLED",
          tenantId,
          jobId: jobBefore.id,
          robotId,
          at: event.at,
          zoneId: getJobZoneId(jobBefore),
          environmentTier: jobBefore.booking?.environmentTier ?? null,
          reason: "NO_HEARTBEAT",
          sourceEventId: event.id
        });
        if (jobBefore.booking?.requiresOperatorCoverage) {
          const zoneId = getJobZoneId(jobBefore);
          const window = jobBefore.reservation
            ? { startAt: jobBefore.reservation.startAt, endAt: jobBefore.reservation.endAt }
            : jobBefore.booking
              ? { startAt: jobBefore.booking.startAt, endAt: jobBefore.booking.endAt }
              : { startAt: at, endAt: at };
          const hasReservedCoverage = jobBefore.operatorCoverage?.status === "reserved";
          const activeOperators = hasReservedCoverage ? 1 : listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobBefore.id }).length;
          outboxMessages.push({
            type: "ESCALATION_NEEDED",
            tenantId,
            jobId: jobBefore.id,
            at: event.at,
            kind: "OPERATOR_ASSIST",
            zoneId,
            capacityAvailable: activeOperators > 0
          });
        }

        const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId: jobBefore.id, events: [event] }];
        if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

        await commitTx(ops);

        appended.push(event);
        continue;
      }

      // If stalled and heartbeats have resumed, append a server-driven resume event.
      if (jobBefore.status === "STALLED") {
        const stalledAt = jobBefore.execution?.stalledAt ?? null;
        const lastHb = jobBefore.execution?.lastHeartbeatAt ?? null;
        if (!stalledAt || !lastHb) continue;
        const stalledMs = Date.parse(stalledAt);
        const lastHbMs = Date.parse(lastHb);
        if (!Number.isFinite(stalledMs) || !Number.isFinite(lastHbMs)) continue;
        if (lastHbMs <= stalledMs) continue;
        if (nowMs - lastHbMs > policy.stallAfterMs) continue;

        const robotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? jobBefore.match?.robotId ?? null;
        if (!robotId) continue;

        const draft = createChainedEvent({
          streamId: jobBefore.id,
          type: "JOB_EXECUTION_RESUMED",
          at,
          actor: { type: "liveness", id: "liveness_v0" },
          payload: { jobId: jobBefore.id, robotId, resumedAt: at }
        });

        const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
        const event = nextEvents[nextEvents.length - 1];

        try {
          enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          validateDomainEvent({ jobBefore, event, eventsBefore: existing });
        } catch {
          continue;
        }

        let jobAfter;
        try {
          jobAfter = reduceJob(nextEvents);
        } catch {
          continue;
        }

        const outboxMessages = [];
        if (jobBefore.status !== jobAfter.status) {
          outboxMessages.push({
            type: "JOB_STATUS_CHANGED",
            tenantId,
            jobId: jobBefore.id,
            fromStatus: jobBefore.status,
            toStatus: jobAfter.status,
            at: event.at
          });
        }

        const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId: jobBefore.id, events: [event] }];
        if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

        await commitTx(ops);

        appended.push(event);
      }
    }

    return { at, appended };
  }

  function enforceSignaturePolicy({ tenantId, signerKind, event }) {
    const t = normalizeTenant(tenantId);
    if (signerKind === SIGNER_KIND.SERVER && (event.actor.type === "robot" || event.actor.type === "operator")) {
      throw new TypeError("server-signed event types may not use robot/operator actor types");
    }

    function assertSignerKeyActive({ keyId, purpose }) {
      if (!keyId) throw new TypeError("missing signerKeyId");
      const key = makeScopedKey({ tenantId: t, id: String(keyId) });
      const record = store.signerKeys?.get?.(key) ?? null;
      if (!record) throw new TypeError("signer key is not registered");
      const status = typeof record.status === "string" && record.status.trim() ? normalizeSignerKeyStatus(record.status) : SIGNER_KEY_STATUS.ACTIVE;
      if (status !== SIGNER_KEY_STATUS.ACTIVE) throw new TypeError("signer key is not active");
      if (purpose) {
        const expectedPurpose = normalizeSignerKeyPurpose(purpose);
        const gotPurpose =
          typeof record.purpose === "string" && record.purpose.trim() ? normalizeSignerKeyPurpose(record.purpose) : SIGNER_KEY_PURPOSE.SERVER;
        if (gotPurpose !== expectedPurpose) throw new TypeError("signer key purpose mismatch");
      }
      return record;
    }

    let effectiveSignerKind = signerKind;
    if (effectiveSignerKind === SIGNER_KIND.SERVER_OR_OPERATOR) {
      if (event.actor.type === "operator") effectiveSignerKind = SIGNER_KIND.OPERATOR;
      else if (event.actor.type === "robot") throw new TypeError("server_or_operator events may not use actor.type=robot");
      else effectiveSignerKind = SIGNER_KIND.SERVER;
    }
    if (effectiveSignerKind === SIGNER_KIND.SERVER_OR_ROBOT) {
      if (event.actor.type === "robot") effectiveSignerKind = SIGNER_KIND.ROBOT;
      else if (event.actor.type === "operator") throw new TypeError("server_or_robot events may not use actor.type=operator");
      else effectiveSignerKind = SIGNER_KIND.SERVER;
    }
    if (effectiveSignerKind === SIGNER_KIND.NONE) {
      if (event.actor.type === "robot") effectiveSignerKind = SIGNER_KIND.ROBOT;
      if (event.actor.type === "operator") effectiveSignerKind = SIGNER_KIND.OPERATOR;
    }

    if (effectiveSignerKind === SIGNER_KIND.ROBOT) {
      if (event.actor.type !== "robot") throw new TypeError("robot-signed events require actor.type=robot");
      const robot = store.robots.get(robotStoreKey(t, event.actor.id));
      if (!robot) throw new TypeError("unknown robot actor.id");
      if (!robot.signerKeyId) throw new TypeError("robot has no registered signerKeyId");
      if (!event.signature) throw new TypeError("robot-signed events require signature");
      if (event.signerKeyId !== robot.signerKeyId) throw new TypeError("event.signerKeyId does not match robot signerKeyId");
      assertSignerKeyActive({ keyId: event.signerKeyId, purpose: SIGNER_KEY_PURPOSE.ROBOT });
    }
    if (effectiveSignerKind === SIGNER_KIND.OPERATOR) {
      if (event.actor.type !== "operator") throw new TypeError("operator-signed events require actor.type=operator");
      const operator = store.operators.get(operatorStoreKey(t, event.actor.id));
      if (!operator) throw new TypeError("unknown operator actor.id");
      if (!operator.signerKeyId) throw new TypeError("operator has no registered signerKeyId");
      if (!event.signature) throw new TypeError("operator-signed events require signature");
      if (event.signerKeyId !== operator.signerKeyId) throw new TypeError("event.signerKeyId does not match operator signerKeyId");
      assertSignerKeyActive({ keyId: event.signerKeyId, purpose: SIGNER_KEY_PURPOSE.OPERATOR });
    }
    if (effectiveSignerKind === SIGNER_KIND.ROBOT_OR_OPERATOR) {
      if (event.actor.type !== "robot" && event.actor.type !== "operator") {
        throw new TypeError("robot_or_operator-signed events require actor.type=robot|operator");
      }
      const entity =
        event.actor.type === "robot" ? store.robots.get(robotStoreKey(t, event.actor.id)) : store.operators.get(operatorStoreKey(t, event.actor.id));
      if (!entity) throw new TypeError(`unknown ${event.actor.type} actor.id`);
      if (!entity.signerKeyId) throw new TypeError(`${event.actor.type} has no registered signerKeyId`);
      if (!event.signature) throw new TypeError("robot_or_operator-signed events require signature");
      if (event.signerKeyId !== entity.signerKeyId) {
        throw new TypeError(`event.signerKeyId does not match ${event.actor.type} signerKeyId`);
      }
      assertSignerKeyActive({
        keyId: event.signerKeyId,
        purpose: event.actor.type === "robot" ? SIGNER_KEY_PURPOSE.ROBOT : SIGNER_KEY_PURPOSE.OPERATOR
      });
    }
    if (effectiveSignerKind === SIGNER_KIND.SERVER) {
      if (!event.signature) throw new TypeError("server-signed events require signature");
      if (event.signerKeyId !== store.serverSigner.keyId) throw new TypeError("event.signerKeyId is not the server key");
    }
  }

  function listJobs({ tenantId } = {}) {
    const t = normalizeTenant(tenantId);
    const jobs = [];
    for (const job of store.jobs.values()) {
      if (!job?.id) continue;
      const jobTenant = normalizeTenant(job.tenantId ?? DEFAULT_TENANT_ID);
      if (jobTenant !== t) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return jobs;
  }

  function listRobots({ tenantId } = {}) {
    const t = normalizeTenant(tenantId);
    const robots = [];
    for (const robot of store.robots.values()) {
      if (!robot?.id) continue;
      const robotTenant = normalizeTenant(robot.tenantId ?? DEFAULT_TENANT_ID);
      if (robotTenant !== t) continue;
      robots.push(robot);
    }
    robots.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return robots;
  }

  function listOperators({ tenantId } = {}) {
    const t = normalizeTenant(tenantId);
    const operators = [];
    for (const op of store.operators.values()) {
      if (!op?.id) continue;
      const opTenant = normalizeTenant(op.tenantId ?? DEFAULT_TENANT_ID);
      if (opTenant !== t) continue;
      operators.push(op);
    }
    operators.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return operators;
  }

  function listContracts({ tenantId } = {}) {
    const t = normalizeTenant(tenantId);
    const contracts = [];
    if (!(store.contracts instanceof Map)) return contracts;
    for (const c of store.contracts.values()) {
      if (!c?.contractId) continue;
      const cTenant = normalizeTenant(c.tenantId ?? DEFAULT_TENANT_ID);
      if (cTenant !== t) continue;
      contracts.push(c);
    }
    contracts.sort((a, b) => String(a.contractId).localeCompare(String(b.contractId)));
    return contracts;
  }

  function getJobEvents(tenantId, jobId) {
    return store.jobEvents.get(jobStoreKey(tenantId, jobId)) ?? [];
  }

  function setJobEvents(tenantId, jobId, events) {
    store.jobEvents.set(jobStoreKey(tenantId, jobId), events);
  }

  function getRobotEvents(tenantId, robotId) {
    return store.robotEvents.get(robotStoreKey(tenantId, robotId)) ?? [];
  }

  function setRobotEvents(tenantId, robotId, events) {
    store.robotEvents.set(robotStoreKey(tenantId, robotId), events);
  }

  function getOperatorEvents(tenantId, operatorId) {
    return store.operatorEvents.get(operatorStoreKey(tenantId, operatorId)) ?? [];
  }

  function setOperatorEvents(tenantId, operatorId, events) {
    store.operatorEvents.set(operatorStoreKey(tenantId, operatorId), events);
  }

  function getMonthEvents(tenantId, monthId) {
    return store.monthEvents?.get?.(monthStoreKey(tenantId, monthId)) ?? [];
  }

  function setMonthEvents(tenantId, monthId, events) {
    if (store.monthEvents?.set) store.monthEvents.set(monthStoreKey(tenantId, monthId), events);
  }

  function assertNonEmptyString(value, name) {
    if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  }

  function assertActor(actor) {
    if (!actor || typeof actor !== "object") throw new TypeError("actor must be an object");
    assertNonEmptyString(actor.type, "actor.type");
    assertNonEmptyString(actor.id, "actor.id");
  }

  function assertIsoDate(value, name) {
    assertNonEmptyString(value, name);
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw new TypeError(`${name} must be an ISO date string`);
  }

  function parseExpectedPrevChainHashHeader(req) {
    const raw = req.headers["x-proxy-expected-prev-chain-hash"];
    if (raw === undefined) return { ok: false, expectedPrevChainHash: null };
    const value = String(raw).trim();
    if (value === "" || value.toLowerCase() === "null") return { ok: true, expectedPrevChainHash: null };
    return { ok: true, expectedPrevChainHash: value };
  }

  function getCurrentPrevChainHash(existingEvents) {
    return existingEvents.length ? existingEvents[existingEvents.length - 1].chainHash : null;
  }

  function computeIdempotencyRequestHash({ method, path, expectedPrevChainHash, body }) {
    return sha256Hex(canonicalJsonStringify({ method, path, expectedPrevChainHash, body }));
  }

  function assertJobPayloadId(payloadJobId, jobId) {
    if (payloadJobId !== jobId) throw new TypeError("payload.jobId must match job id");
  }

  function assertNotTerminal(job) {
    if (!job) throw new TypeError("job is required");
    if (job.status === "COMPLETED" || job.status === "ABORTED" || job.status === "SETTLED") {
      throw new TypeError("job is terminal");
    }
  }

  function validateDomainEvent({ jobBefore, event, eventsBefore }) {
    if (!jobBefore) throw new TypeError("jobBefore is required");
    if (!event || typeof event !== "object") throw new TypeError("event is required");

    const type = event.type;
    const payload = event.payload ?? null;
    const jobTenantId = normalizeTenant(jobBefore.tenantId ?? DEFAULT_TENANT_ID);

    const findIncidentById = (incidentId) => {
      for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
        const e = eventsBefore[i];
        if (e.type !== "INCIDENT_REPORTED" && e.type !== "INCIDENT_DETECTED") continue;
        if (e.payload?.incidentId === incidentId) return e.payload ?? null;
      }
      return null;
    };

    const incidentIdExists = (incidentId) => Boolean(findIncidentById(incidentId));

    const getClaimState = (claimId) => {
      let state = {
        exists: false,
        status: "NONE",
        incidentId: null,
        approved: null,
        adjusted: false
      };

      for (const e of eventsBefore) {
        const p = e.payload ?? null;
        if (!p || p.claimId !== claimId) continue;
        if (e.type === "CLAIM_OPENED") {
          state = { ...state, exists: true, status: "OPEN", incidentId: p.incidentId ?? null };
        }
        if (e.type === "CLAIM_TRIAGED" && state.exists && state.status !== "APPROVED" && state.status !== "DENIED" && state.status !== "PAID") {
          state = { ...state, status: "TRIAGED" };
        }
        if (e.type === "CLAIM_APPROVED") {
          state = {
            ...state,
            exists: true,
            status: "APPROVED",
            approved: { amounts: p.amounts ?? null, currency: p.currency ?? null }
          };
        }
        if (e.type === "CLAIM_DENIED") {
          state = { ...state, exists: true, status: "DENIED", approved: null };
        }
        if (e.type === "JOB_ADJUSTED") {
          state = { ...state, adjusted: true };
        }
        if (e.type === "CLAIM_PAID") {
          state = { ...state, status: "PAID" };
        }
      }

      return state;
    };

    // Access
    if (type === "ACCESS_PLAN_ISSUED") {
      validateAccessPlanIssuedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      assertNotTerminal(jobBefore);
      if (jobBefore.status === "EXECUTING" || jobBefore.status === "ASSISTED") {
        throw new TypeError("cannot issue access plan after execution start");
      }
    }

    if (type === "ACCESS_GRANTED" || type === "ACCESS_DENIED") {
      validateAccessResultPayload(payload, { name: type });
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const plan = jobBefore.accessPlan;
      if (!plan) throw new TypeError("access plan is required before access can be granted/denied");
      if (payload.accessPlanId !== plan.accessPlanId) throw new TypeError("payload.accessPlanId does not match current access plan");
      if (!isWithinAccessWindow({ at: event.at, validFrom: plan.validFrom, validTo: plan.validTo })) {
        throw new TypeError("access event is outside access plan window");
      }
      if (jobBefore.access.status === "revoked" || jobBefore.access.status === "expired") {
        throw new TypeError("access is revoked/expired");
      }
    }

    if (type === "ACCESS_REVOKED" || type === "ACCESS_EXPIRED") {
      validateAccessRevokedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const plan = jobBefore.accessPlan;
      if (!plan) throw new TypeError("access plan is required before access can be revoked/expired");
      if (payload.accessPlanId !== plan.accessPlanId) throw new TypeError("payload.accessPlanId does not match current access plan");
      if (type === "ACCESS_REVOKED" && plan.revocable === false) throw new TypeError("access plan is not revocable");
    }

    // Skills
    // Booking / matching / reservation
    if (type === "BOOKED") {
      validateBookedPayload(payload ?? {});
      assertNotTerminal(jobBefore);
    }

    if (type === "ZONE_COVERAGE_REPORTED") {
      validateZoneCoverageReportedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      // Coverage facts are evidence; accept even after settlement (late evidence feeds disputes/claims),
      // but post-settlement re-proof is governed separately.
      if (jobBefore.status !== "EXECUTING" && jobBefore.status !== "ASSISTED" && jobBefore.status !== "COMPLETED" && jobBefore.status !== "SETTLED") {
        throw new TypeError("zone coverage can only be reported during/after execution");
      }
      const requiredZones = jobBefore.booking?.requiredZones ?? null;
      if (requiredZones && typeof requiredZones === "object") {
        try {
          validateZoneSetV1(requiredZones);
        } catch {
          // If booking requiredZones is invalid, don't accept coverage facts (dispute-resistant).
          throw new TypeError("job requiredZones is invalid");
        }
        const allowedZoneIds = new Set(requiredZones.zones.map((z) => String(z.zoneId)));
        if (!allowedZoneIds.has(payload.zoneId)) {
          throw new TypeError("payload.zoneId is not in requiredZones");
        }
      }
    }

    if (type === "PROOF_EVALUATED") {
      validateProofEvaluatedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      // Proof is evaluated against completed work; allow evaluation after completion.
      // (We allow SETTLED here to avoid races where settlement is appended before the proof worker ticks.)
      if (jobBefore.status !== "COMPLETED" && jobBefore.status !== "SETTLED") {
        throw new TypeError("proof can only be evaluated after completion");
      }

      if (payload.evaluatedAt !== event.at) throw new TypeError("payload.evaluatedAt must match event.at");
      const booking = jobBefore.booking ?? null;
      const expectedCustomerPolicyHash = booking?.policyHash ?? null;
      if (expectedCustomerPolicyHash && payload.customerPolicyHash !== expectedCustomerPolicyHash) {
        throw new TypeError("payload.customerPolicyHash must match booking.policyHash");
      }
      const expectedOperatorPolicyHash = jobBefore.operatorPolicyHash ?? null;
      if (expectedOperatorPolicyHash && payload.operatorPolicyHash !== expectedOperatorPolicyHash) {
        throw new TypeError("payload.operatorPolicyHash must match pinned operatorPolicyHash");
      }

      const requiredZones = booking?.requiredZones ?? null;
      const requiredZonesHash = booking?.requiredZonesHash ?? null;
      if (requiredZones && typeof requiredZones === "object") {
        const computed = computeZoneSetHash(requiredZones);
        if (requiredZonesHash && computed !== requiredZonesHash) throw new TypeError("booking.requiredZonesHash mismatch");
        if (payload.requiredZonesHash !== computed) throw new TypeError("payload.requiredZonesHash must match booking.requiredZonesHash");
      }

      // Allow re-evaluation for the same completion anchor as evidence arrives,
      // but prevent exact duplicates (same evaluatedAtChainHash + customerPolicyHash + factsHash).
      const existsExact = eventsBefore.some(
        (e) =>
          e?.type === "PROOF_EVALUATED" &&
          e?.payload?.evaluatedAtChainHash === payload.evaluatedAtChainHash &&
          e?.payload?.customerPolicyHash === payload.customerPolicyHash &&
          e?.payload?.factsHash !== null &&
          e?.payload?.factsHash !== undefined &&
          e?.payload?.factsHash === payload.factsHash
      );
      if (existsExact) {
        const err = new Error("proof already exists for evaluatedAtChainHash+customerPolicyHash+factsHash");
        err.code = "PROOF_ALREADY_EXISTS_FOR_FACTS";
        throw err;
      }
    }

	    function findHoldState(events, holdId) {
	      if (!Array.isArray(events)) return { exists: false, status: "NONE" };
	      const hid = typeof holdId === "string" ? holdId : "";
	      if (!hid.trim()) return { exists: false, status: "NONE" };
	      let state = {
	        exists: false,
	        status: "NONE",
	        heldEvent: null,
	        heldFactsHash: null,
	        releasedEvent: null,
	        forfeitedEvent: null
	      };
	      for (const e of events) {
	        const p = e?.payload ?? null;
	        if (!p || p.holdId !== hid) continue;
	        if (e.type === "SETTLEMENT_HELD") {
	          state = {
	            ...state,
	            exists: true,
	            status: "HELD",
	            heldEvent: e ?? state.heldEvent,
	            heldFactsHash: typeof p.factsHash === "string" ? p.factsHash : state.heldFactsHash
	          };
	        }
	        if (e.type === "SETTLEMENT_RELEASED") state = { ...state, exists: true, status: "RELEASED", releasedEvent: e ?? state.releasedEvent };
	        if (e.type === "SETTLEMENT_FORFEITED") state = { ...state, exists: true, status: "FORFEITED", forfeitedEvent: e ?? state.forfeitedEvent };
	      }
	      return state;
	    }

    if (type === "SETTLEMENT_HELD") {
      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.heldAt !== event.at) throw new TypeError("payload.heldAt must match event.at");
      assertNonEmptyString(payload.holdId, "payload.holdId");
      assertNonEmptyString(payload.evaluatedAtChainHash, "payload.evaluatedAtChainHash");
      assertNonEmptyString(payload.factsHash, "payload.factsHash");
      if (!/^[a-f0-9]{64}$/i.test(String(payload.factsHash).trim())) throw new TypeError("payload.factsHash must be 64-hex");

      if (jobBefore.status !== "COMPLETED") throw new TypeError("settlement hold can only be created after completion");
      const proofPolicy = jobBefore.booking?.policySnapshot?.proofPolicy ?? null;
      const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
      const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";
      if (gateMode === "warn") throw new TypeError("settlement hold requires strict/holdback proof gating");

      const completionChainHash = findLatestCompletionChainHash(eventsBefore);
      if (!completionChainHash) throw new TypeError("settlement hold requires a completion anchor");
      if (payload.evaluatedAtChainHash !== completionChainHash) throw new TypeError("payload.evaluatedAtChainHash must match latest completion anchor");

      const current = computeCurrentProofFactsHash({ completionChainHash });
      if (!current?.factsHash) throw new TypeError("settlement hold requires a current factsHash");
      if (payload.factsHash !== current.factsHash) throw new TypeError("payload.factsHash must match current factsHash");

      const proofEvent = findMatchingProofEvaluatedEvent({
        events: eventsBefore,
        evaluatedAtChainHash: completionChainHash,
        customerPolicyHash: current?.customerPolicyHash ?? null,
        factsHash: current.factsHash
      });
	      if (!proofEvent) throw new TypeError("settlement hold requires a matching PROOF_EVALUATED");
	      const proofStatus = proofEvent?.payload?.status === null || proofEvent?.payload?.status === undefined ? null : String(proofEvent.payload.status).trim();
	      if (proofStatus !== "INSUFFICIENT_EVIDENCE") throw new TypeError("settlement hold requires INSUFFICIENT_EVIDENCE proof");

	      if (!payload.triggeringProofRef || typeof payload.triggeringProofRef !== "object") throw new TypeError("payload.triggeringProofRef is required");
	      const expectedRef = proofRefFromProofEvent(proofEvent);
	      if (!expectedRef || !proofRefMatches({ expected: expectedRef, actual: payload.triggeringProofRef })) {
	        throw new TypeError("payload.triggeringProofRef must match PROOF_EVALUATED");
	      }

	      // Holds must copy canonical missingEvidence/reasonCodes directly from the triggering proof.
	      const proofPayload = proofEvent?.payload ?? null;
	      const expectedMissing = Array.isArray(proofPayload?.missingEvidence) ? proofPayload.missingEvidence : [];
	      const actualMissing = Array.isArray(payload.missingEvidence) ? payload.missingEvidence : [];
	      if (expectedMissing.length !== actualMissing.length || expectedMissing.some((v, i) => actualMissing[i] !== v)) {
	        throw new TypeError("payload.missingEvidence must match triggering PROOF_EVALUATED.missingEvidence");
	      }
	      const expectedReasons = Array.isArray(proofPayload?.reasonCodes) ? proofPayload.reasonCodes : [];
	      const actualReasons = Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [];
	      if (expectedReasons.length !== actualReasons.length || expectedReasons.some((v, i) => actualReasons[i] !== v)) {
	        throw new TypeError("payload.reasonCodes must match triggering PROOF_EVALUATED.reasonCodes");
	      }

	      // Controller-grade holds must include a stable pricing anchor and deterministic exposure snapshot.
	      if (!payload.pricingAnchor || typeof payload.pricingAnchor !== "object") throw new TypeError("payload.pricingAnchor is required");
	      if (payload.pricingAnchor.evaluatedAtChainHash !== completionChainHash) {
	        throw new TypeError("payload.pricingAnchor.evaluatedAtChainHash must match latest completion anchor");
	      }
	      if (payload.pricingAnchor.customerPolicyHash !== (current?.customerPolicyHash ?? null)) {
	        throw new TypeError("payload.pricingAnchor.customerPolicyHash must match current customerPolicyHash");
	      }
	      if (payload.pricingAnchor.operatorPolicyHash !== (current?.operatorPolicyHash ?? null)) {
	        throw new TypeError("payload.pricingAnchor.operatorPolicyHash must match current operatorPolicyHash");
	      }
	      const expectedHoldId =
	        typeof completionChainHash === "string" &&
	        completionChainHash.trim() &&
	        typeof current?.customerPolicyHash === "string" &&
	        String(current.customerPolicyHash).trim()
	          ? `hold_${sha256Hex(`${completionChainHash}\n${String(current.customerPolicyHash).trim()}`)}`
	          : null;
	      if (expectedHoldId && payload.holdId !== expectedHoldId) throw new TypeError("payload.holdId must match expected hold identity");
	      const qid = payload.pricingAnchor.quoteEventId ?? null;
	      if (qid !== null && qid !== undefined) {
	        assertNonEmptyString(qid, "payload.pricingAnchor.quoteEventId");
	        const quoteEvent = eventsBefore.find((e) => e?.id === qid) ?? null;
	        if (!quoteEvent || quoteEvent.type !== "QUOTE_PROPOSED") throw new TypeError("payload.pricingAnchor.quoteEventId must reference QUOTE_PROPOSED");
	      }

	      if (!payload.exposure || typeof payload.exposure !== "object") throw new TypeError("payload.exposure is required");
	      const exp = payload.exposure.expected ?? null;
	      if (!exp || typeof exp !== "object") throw new TypeError("payload.exposure.expected is required");
	      assertNonEmptyString(exp.currency ?? "", "payload.exposure.expected.currency");
	      if (!Number.isSafeInteger(exp.amountGrossCents)) throw new TypeError("payload.exposure.expected.amountGrossCents must be a safe integer");
	      if (!Number.isSafeInteger(exp.amountNetCents)) throw new TypeError("payload.exposure.expected.amountNetCents must be a safe integer");
	      if (!Number.isSafeInteger(exp.coverageFeeCents)) throw new TypeError("payload.exposure.expected.coverageFeeCents must be a safe integer");
	      if (Number.isSafeInteger(jobBefore.quote?.amountCents) && exp.amountGrossCents !== jobBefore.quote.amountCents) {
	        throw new TypeError("payload.exposure.expected.amountGrossCents must match quote amountCents");
	      }

	      const existingHold = findHoldState(eventsBefore, payload.holdId);
      if (existingHold.status === "HELD" && existingHold.heldFactsHash === payload.factsHash) {
        const err = new Error("settlement hold already active");
        err.code = "SETTLEMENT_HOLD_ALREADY_ACTIVE";
        throw err;
      }
    }

	    if (type === "SETTLEMENT_RELEASED") {
      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.releasedAt !== event.at) throw new TypeError("payload.releasedAt must match event.at");
      assertNonEmptyString(payload.holdId, "payload.holdId");

      if (jobBefore.status !== "COMPLETED") throw new TypeError("settlement hold release can only happen before settlement");

      const hold = findHoldState(eventsBefore, payload.holdId);
      if (hold.status !== "HELD") throw new TypeError("settlement hold must be active to release");

      const proofPolicy = jobBefore.booking?.policySnapshot?.proofPolicy ?? null;
      const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
      const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";
      if (gateMode === "warn") throw new TypeError("settlement hold release requires strict/holdback proof gating");

      const completionChainHash = findLatestCompletionChainHash(eventsBefore);
      if (!completionChainHash) throw new TypeError("settlement hold release requires a completion anchor");

      const current = computeCurrentProofFactsHash({ completionChainHash });
      if (!current?.factsHash) throw new TypeError("settlement hold release requires a current factsHash");

      const proofEvent = findMatchingProofEvaluatedEvent({
        events: eventsBefore,
        evaluatedAtChainHash: completionChainHash,
        customerPolicyHash: current?.customerPolicyHash ?? null,
        factsHash: current.factsHash
      });
	      if (!proofEvent) throw new TypeError("settlement hold release requires a matching PROOF_EVALUATED");
	      const status = proofEvent?.payload?.status === null || proofEvent?.payload?.status === undefined ? null : String(proofEvent.payload.status).trim();
		      if (status !== "PASS" && status !== "FAIL") throw new TypeError("settlement hold release requires PASS or FAIL proof");

	      if (!payload.releasingProofRef || typeof payload.releasingProofRef !== "object") throw new TypeError("payload.releasingProofRef is required");
	      const expectedRef = proofRefFromProofEvent(proofEvent);
	      if (!expectedRef || !proofRefMatches({ expected: expectedRef, actual: payload.releasingProofRef })) {
	        throw new TypeError("payload.releasingProofRef must match PROOF_EVALUATED");
	      }
		    }

	    if (type === "SETTLEMENT_FORFEITED") {
	      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
	      assertJobPayloadId(payload.jobId, jobBefore.id);
	      if (payload.forfeitedAt !== event.at) throw new TypeError("payload.forfeitedAt must match event.at");
	      assertNonEmptyString(payload.holdId, "payload.holdId");
	      assertNonEmptyString(payload.forfeitureReason, "payload.forfeitureReason");
	      if (payload.decisionRef !== undefined && payload.decisionRef !== null) assertNonEmptyString(payload.decisionRef, "payload.decisionRef");
	      if (payload.decisionEventRef !== undefined && payload.decisionEventRef !== null && (typeof payload.decisionEventRef !== "object" || Array.isArray(payload.decisionEventRef))) {
	        throw new TypeError("payload.decisionEventRef must be an object");
	      }
	      assertNonEmptyString(payload.evaluatedAtChainHash, "payload.evaluatedAtChainHash");
	      assertNonEmptyString(payload.factsHash, "payload.factsHash");
	      if (!/^[a-f0-9]{64}$/i.test(String(payload.factsHash).trim())) throw new TypeError("payload.factsHash must be 64-hex");

	      if (jobBefore.status !== "COMPLETED") throw new TypeError("settlement hold forfeiture can only happen before settlement");

	      const proofPolicy = jobBefore.booking?.policySnapshot?.proofPolicy ?? null;
	      const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
	      const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";
	      if (gateMode === "warn") throw new TypeError("settlement hold forfeiture requires strict/holdback proof gating");

	      const completionChainHash = findLatestCompletionChainHash(eventsBefore);
	      if (!completionChainHash) throw new TypeError("settlement hold forfeiture requires a completion anchor");
	      if (payload.evaluatedAtChainHash !== completionChainHash) throw new TypeError("payload.evaluatedAtChainHash must match latest completion anchor");

	      const current = computeCurrentProofFactsHash({ completionChainHash });
	      if (!current?.factsHash) throw new TypeError("settlement hold forfeiture requires a current factsHash");
	      if (payload.factsHash !== current.factsHash) throw new TypeError("payload.factsHash must match current factsHash");

	      const proofEvent = findMatchingProofEvaluatedEvent({
	        events: eventsBefore,
	        evaluatedAtChainHash: completionChainHash,
	        customerPolicyHash: current?.customerPolicyHash ?? null,
	        factsHash: current.factsHash
	      });
	      if (!proofEvent) throw new TypeError("settlement hold forfeiture requires a matching PROOF_EVALUATED");
	      const proofStatus = proofEvent?.payload?.status === null || proofEvent?.payload?.status === undefined ? null : String(proofEvent.payload.status).trim();
	      if (proofStatus !== "INSUFFICIENT_EVIDENCE") throw new TypeError("settlement hold forfeiture requires INSUFFICIENT_EVIDENCE proof");

	      const hold = findHoldState(eventsBefore, payload.holdId);
	      if (hold.status !== "HELD") throw new TypeError("settlement hold must be active to forfeit");
	      if (hold.heldFactsHash && hold.heldFactsHash !== payload.factsHash) throw new TypeError("settlement hold forfeiture requires matching held factsHash");

	      // Governance: forfeits should be backed by an auditable decision record.
	      const decisionEventRef = payload.decisionEventRef ?? null;
	      const decisionRef = payload.decisionRef ?? null;
	      if (!decisionEventRef && !decisionRef) throw new TypeError("payload.decisionEventRef or payload.decisionRef is required");
	      if (decisionEventRef) {
	        const decisionEventId = typeof decisionEventRef.decisionEventId === "string" ? decisionEventRef.decisionEventId : null;
	        const decisionEvent = decisionEventId ? eventsBefore.find((e) => e?.id === decisionEventId) ?? null : null;
	        if (!decisionEvent || decisionEvent.type !== "DECISION_RECORDED") throw new TypeError("payload.decisionEventRef must reference DECISION_RECORDED");
	        const expected = decisionEventRefFromDecisionEvent(decisionEvent);
	        if (!expected || !decisionEventRefMatches({ expected, actual: decisionEventRef })) {
	          throw new TypeError("payload.decisionEventRef must match referenced DECISION_RECORDED");
	        }
	        if (expected.kind !== "SETTLEMENT_FORFEIT") throw new TypeError("referenced decision kind must be SETTLEMENT_FORFEIT");
	        if (expected.holdId !== payload.holdId) throw new TypeError("referenced decision holdId must match payload.holdId");
	        if (expected.forfeitureReason !== payload.forfeitureReason) throw new TypeError("referenced decision forfeitureReason must match payload.forfeitureReason");
	      }
	    }

	    if (type === "DECISION_RECORDED") {
	      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
	      assertJobPayloadId(payload.jobId, jobBefore.id);
	      if (payload.decidedAt !== event.at) throw new TypeError("payload.decidedAt must match event.at");
	      assertNonEmptyString(payload.decisionId, "payload.decisionId");
	      assertNonEmptyString(payload.kind, "payload.kind");

	      if (jobBefore.status !== "COMPLETED") throw new TypeError("decision can only be recorded after completion and before settlement");

	      const allowedKinds = new Set(["SETTLEMENT_FORFEIT"]);
	      if (!allowedKinds.has(String(payload.kind))) throw new TypeError("payload.kind is not supported");

	      const already = eventsBefore.some((e) => e?.type === "DECISION_RECORDED" && e?.payload?.decisionId === payload.decisionId);
	      if (already) {
	        const err = new Error("decision already recorded");
	        err.code = "DECISION_ALREADY_RECORDED";
	        throw err;
	      }

	      if (payload.kind === "SETTLEMENT_FORFEIT") {
	        assertNonEmptyString(payload.holdId, "payload.holdId");
	        assertNonEmptyString(payload.forfeitureReason, "payload.forfeitureReason");
	        const hold = findHoldState(eventsBefore, payload.holdId);
	        if (hold.status !== "HELD") throw new TypeError("forfeit decision requires an active hold");
	      }

	      if (payload.reasonCodes !== undefined && payload.reasonCodes !== null) {
	        if (!Array.isArray(payload.reasonCodes)) throw new TypeError("payload.reasonCodes must be an array");
	        for (const r of payload.reasonCodes) assertNonEmptyString(r, "payload.reasonCodes[]");
	      }
	      if (payload.evidenceRefs !== undefined && payload.evidenceRefs !== null) {
	        if (!Array.isArray(payload.evidenceRefs)) throw new TypeError("payload.evidenceRefs must be an array");
	        for (const r of payload.evidenceRefs) assertNonEmptyString(r, "payload.evidenceRefs[]");
	      }
	      if (payload.policyHash !== undefined && payload.policyHash !== null) assertNonEmptyString(payload.policyHash, "payload.policyHash");
	    }

	    if (type === "DISPUTE_OPENED") {
	      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
	      assertJobPayloadId(payload.jobId, jobBefore.id);
	      if (payload.openedAt !== event.at) throw new TypeError("payload.openedAt must match event.at");
      assertNonEmptyString(payload.disputeId, "payload.disputeId");
      if (jobBefore.status !== "SETTLED") throw new TypeError("dispute can only be opened after settlement");
      const alreadyOpen = eventsBefore.some((e) => e?.type === "DISPUTE_OPENED" && e?.payload?.disputeId === payload.disputeId) &&
        !eventsBefore.some((e) => e?.type === "DISPUTE_CLOSED" && e?.payload?.disputeId === payload.disputeId);
      if (alreadyOpen) {
        const err = new Error("dispute already open");
        err.code = "DISPUTE_ALREADY_OPEN";
        throw err;
      }
    }

    if (type === "DISPUTE_CLOSED") {
      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.closedAt !== event.at) throw new TypeError("payload.closedAt must match event.at");
      assertNonEmptyString(payload.disputeId, "payload.disputeId");
      if (jobBefore.status !== "SETTLED") throw new TypeError("dispute close can only occur after settlement");
      const isOpen =
        eventsBefore.some((e) => e?.type === "DISPUTE_OPENED" && e?.payload?.disputeId === payload.disputeId) &&
        !eventsBefore.some((e) => e?.type === "DISPUTE_CLOSED" && e?.payload?.disputeId === payload.disputeId);
      if (!isOpen) throw new TypeError("dispute is not open");
    }

    // Risk (v1.6)
    if (type === "RISK_SCORED") {
      validateRiskScoredPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.scoredAt !== event.at) throw new TypeError("payload.scoredAt must match event.at");

      const basis = payload.basis;
      const sourceEventId = payload.sourceEventId;
      const exists = eventsBefore.some((e) => e?.type === "RISK_SCORED" && e.payload?.basis === basis && e.payload?.sourceEventId === sourceEventId);
      if (exists) throw new TypeError("risk already scored for this source event");

      const expectedTemplateId = jobBefore.templateId ?? null;
      if (expectedTemplateId && payload.features?.templateId !== expectedTemplateId) {
        throw new TypeError("payload.features.templateId must match job.templateId");
      }

      if (basis === RISK_BASIS.QUOTE) {
        if (!jobBefore.quote) throw new TypeError("risk scoring requires a quote");
        if (jobBefore.status !== "QUOTED") throw new TypeError("risk scoring (QUOTE) requires QUOTED status");

        const expectedEnvTier = jobBefore.quote?.inputs?.environmentTier ?? null;
        if (expectedEnvTier && payload.features?.environmentTier !== expectedEnvTier) {
          throw new TypeError("payload.features.environmentTier must match quote environmentTier");
        }
        const expectedCoverage = jobBefore.quote?.inputs?.requiresOperatorCoverage;
        if (typeof expectedCoverage === "boolean" && payload.features?.requiresOperatorCoverage !== expectedCoverage) {
          throw new TypeError("payload.features.requiresOperatorCoverage must match quote requiresOperatorCoverage");
        }
        const expectedZoneId = jobBefore.quote?.inputs?.zoneId ?? null;
        if (expectedZoneId && payload.features?.zoneId !== expectedZoneId) {
          throw new TypeError("payload.features.zoneId must match quote zoneId");
        }
        const expectedSiteId = jobBefore.quote?.inputs?.siteId ?? null;
        if (expectedSiteId && payload.features?.siteId !== expectedSiteId) {
          throw new TypeError("payload.features.siteId must match quote siteId");
        }

        let lastQuoteEventId = null;
        for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
          const e = eventsBefore[i];
          if (e?.type === "QUOTE_PROPOSED") {
            lastQuoteEventId = e.id ?? null;
            break;
          }
        }
        if (!lastQuoteEventId) throw new TypeError("risk scoring requires a prior QUOTE_PROPOSED event");
        if (sourceEventId !== lastQuoteEventId) throw new TypeError("payload.sourceEventId must match last QUOTE_PROPOSED event id");
      }

      if (basis === RISK_BASIS.BOOK) {
        if (!jobBefore.booking) throw new TypeError("risk scoring (BOOK) requires a booking");
        if (jobBefore.status !== "BOOKED") throw new TypeError("risk scoring (BOOK) requires BOOKED status");

        const expectedEnvTier = jobBefore.booking?.environmentTier ?? null;
        if (expectedEnvTier && payload.features?.environmentTier !== expectedEnvTier) {
          throw new TypeError("payload.features.environmentTier must match booking environmentTier");
        }
        const expectedCoverage = jobBefore.booking?.requiresOperatorCoverage;
        if (typeof expectedCoverage === "boolean" && payload.features?.requiresOperatorCoverage !== expectedCoverage) {
          throw new TypeError("payload.features.requiresOperatorCoverage must match booking requiresOperatorCoverage");
        }
        const expectedZoneId = jobBefore.booking?.zoneId ?? null;
        if (expectedZoneId && payload.features?.zoneId !== expectedZoneId) {
          throw new TypeError("payload.features.zoneId must match booking zoneId");
        }
        const expectedSiteId = jobBefore.booking?.siteId ?? null;
        if (expectedSiteId && payload.features?.siteId !== expectedSiteId) {
          throw new TypeError("payload.features.siteId must match booking siteId");
        }
        const expectedPolicyHash = jobBefore.booking?.policyHash ?? null;
        if (expectedPolicyHash && payload.policyHash !== expectedPolicyHash) {
          throw new TypeError("payload.policyHash must match booking.policyHash");
        }

        let lastBookedEventId = null;
        for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
          const e = eventsBefore[i];
          if (e?.type === "BOOKED") {
            lastBookedEventId = e.id ?? null;
            break;
          }
        }
        if (!lastBookedEventId) throw new TypeError("risk scoring requires a prior BOOKED event");
        if (sourceEventId !== lastBookedEventId) throw new TypeError("payload.sourceEventId must match last BOOKED event id");
      }
    }

    // Dispatch
    if (type === "DISPATCH_REQUESTED") {
      validateDispatchRequestedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.requestedAt !== event.at) throw new TypeError("payload.requestedAt must match event.at");
      if (!jobBefore.booking) throw new TypeError("dispatch requires a booking");
      if (jobBefore.status !== "BOOKED") throw new TypeError("dispatch can only be requested from BOOKED");
    }

    if (type === "DISPATCH_EVALUATED") {
      validateDispatchEvaluatedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.evaluatedAt !== event.at) throw new TypeError("payload.evaluatedAt must match event.at");
      if (!jobBefore.booking) throw new TypeError("dispatch evaluation requires a booking");
      if (jobBefore.status !== "BOOKED") throw new TypeError("dispatch evaluation requires BOOKED status");
    }

    if (type === "DISPATCH_CONFIRMED") {
      validateDispatchConfirmedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.confirmedAt !== event.at) throw new TypeError("payload.confirmedAt must match event.at");
      if (!jobBefore.reservation) throw new TypeError("dispatch confirmation requires a robot reservation");
      if (jobBefore.booking?.requiresOperatorCoverage && jobBefore.operatorCoverage?.status !== "reserved") {
        throw new TypeError("dispatch confirmation requires operator coverage reservation");
      }
    }

    if (type === "DISPATCH_FAILED") {
      validateDispatchFailedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.failedAt !== event.at) throw new TypeError("payload.failedAt must match event.at");
      if (!jobBefore.booking) throw new TypeError("dispatch failure requires a booking");
      if (jobBefore.status !== "BOOKED") throw new TypeError("dispatch failure requires BOOKED status");
    }

	    if (type === "MATCHED") {
	      if (!payload || typeof payload !== "object") throw new TypeError("payload is required");
	      const robotId = payload.robotId;
	      assertNonEmptyString(robotId, "payload.robotId");
	      if (!jobBefore.booking) throw new TypeError("cannot match before booking");
	      const robot = store.robots.get(robotStoreKey(jobTenantId, robotId));
	      if (!robot) throw new TypeError("unknown robotId");
	      if (robot.status && robot.status !== "active") throw new TypeError("robot is not active");
	      if (jobBefore.booking) {
	        const jobZoneId = normalizeZoneId(jobBefore.booking.zoneId ?? jobBefore.constraints?.zoneId);
	        const robotZoneId = normalizeZoneId(robot.currentZoneId ?? robot.homeZoneId);
	        if (robotZoneId !== jobZoneId) throw new TypeError("robot is not in the job zone");
	      }

	      const operatorContractHash = payload.operatorContractHash ?? null;
	      const operatorPolicyHash = payload.operatorPolicyHash ?? null;
	      const operatorCompilerId = payload.operatorCompilerId ?? null;
	      if (operatorContractHash !== null || operatorPolicyHash !== null || operatorCompilerId !== null) {
	        if (operatorContractHash === null || operatorPolicyHash === null) {
	          throw new TypeError("payload.operatorContractHash and payload.operatorPolicyHash must be provided together");
	        }
	        if (typeof operatorContractHash !== "string" || !/^[a-f0-9]{64}$/i.test(operatorContractHash)) {
	          throw new TypeError("payload.operatorContractHash must be a 64-byte hex sha256");
	        }
	        if (typeof operatorPolicyHash !== "string" || !/^[a-f0-9]{64}$/i.test(operatorPolicyHash)) {
	          throw new TypeError("payload.operatorPolicyHash must be a 64-byte hex sha256");
	        }
	        if (operatorCompilerId !== null) {
	          if (typeof operatorCompilerId !== "string" || operatorCompilerId.trim() === "") {
	            throw new TypeError("payload.operatorCompilerId must be a non-empty string");
	          }
	        }
	      }
	    }

    if (type === "RESERVED") {
      validateReservedPayload(payload ?? {});
      assertNotTerminal(jobBefore);
      const robotId = payload.robotId;

      const booked = jobBefore.booking;
      if (!booked) throw new TypeError("cannot reserve robot before booking");
      if (Date.parse(payload.startAt) < Date.parse(booked.startAt) || Date.parse(payload.endAt) > Date.parse(booked.endAt)) {
        throw new TypeError("reservation window must be within booked window");
      }

      const matchedRobotId = jobBefore.match?.robotId ?? null;
      if (matchedRobotId && matchedRobotId !== robotId) {
        throw new TypeError("reservation robotId must match matched robotId");
      }

      const robot = store.robots.get(robotStoreKey(jobTenantId, robotId));
      if (!robot) throw new TypeError("unknown robotId");
      if (!robotIsAvailableForWindow(robot, { startAt: payload.startAt, endAt: payload.endAt })) {
        throw new TypeError("robot is not available for reservation window");
      }

      for (const other of store.jobs.values()) {
        if (!other?.id || other.id === jobBefore.id) continue;
        const otherTenant = normalizeTenant(other.tenantId ?? DEFAULT_TENANT_ID);
        if (otherTenant !== jobTenantId) continue;
        const resv = other.reservation;
        if (!resv || resv.robotId !== robotId) continue;
        if (other.status === "ABORTED" || other.status === "SETTLED") continue;
        if (bookingWindowsOverlap(resv, payload)) {
          throw new TypeError("robot is already reserved for an overlapping window");
        }
      }
    }

    if (type === "OPERATOR_COVERAGE_RESERVED") {
      validateOperatorCoverageReservedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      assertNotTerminal(jobBefore);

      if (!jobBefore.booking) throw new TypeError("operator coverage requires a booking");
      if (jobBefore.booking.requiresOperatorCoverage !== true) throw new TypeError("operator coverage reservation is not required for this job");
      if (jobBefore.status !== "RESERVED") throw new TypeError("operator coverage reservation requires RESERVED status");
      if (!jobBefore.reservation) throw new TypeError("operator coverage reservation requires a robot reservation");

      if (payload.startAt !== jobBefore.reservation.startAt || payload.endAt !== jobBefore.reservation.endAt) {
        throw new TypeError("operator coverage window must match robot reservation window");
      }

      const operatorId = payload.operatorId;
      const operator = store.operators.get(operatorStoreKey(jobTenantId, operatorId));
      if (!operator) throw new TypeError("unknown operatorId");
      if (operator.shift?.status !== "open") throw new TypeError("operator is not on shift");

      const jobZoneId = normalizeZoneId(jobBefore.booking.zoneId ?? jobBefore.constraints?.zoneId);
      const operatorZoneId = normalizeZoneId(operator.shift?.zoneId);
      if (operatorZoneId !== jobZoneId) throw new TypeError("operator is not on shift for the job zone");

      const window = { startAt: payload.startAt, endAt: payload.endAt };
      const maxConcurrentJobs = operator.shift?.maxConcurrentJobs ?? 1;
      let activeCoverageCount = 0;
      for (const other of store.jobs.values()) {
        if (!other?.id || other.id === jobBefore.id) continue;
        const otherTenant = normalizeTenant(other.tenantId ?? DEFAULT_TENANT_ID);
        if (otherTenant !== jobTenantId) continue;
        if (other.status === "ABORTED" || other.status === "SETTLED") continue;
        const cov = other.operatorCoverage;
        if (!cov || cov.status !== "reserved") continue;
        if (cov.operatorId !== operatorId) continue;
        if (bookingWindowsOverlap({ startAt: cov.startAt, endAt: cov.endAt }, window)) activeCoverageCount += 1;
      }
      if (activeCoverageCount >= maxConcurrentJobs) throw new TypeError("operator has no remaining coverage capacity for this window");
    }

    if (type === "OPERATOR_COVERAGE_RELEASED") {
      validateOperatorCoverageReleasedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.releasedAt !== event.at) throw new TypeError("payload.releasedAt must match event.at");
      if (jobBefore.operatorCoverage?.reservationId !== payload.reservationId) {
        throw new TypeError("operator coverage release reservationId does not match current reservation");
      }
    }

    if (type === "SKILL_LICENSED") {
      validateSkillLicensedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      assertNotTerminal(jobBefore);
      if (jobBefore.status === "EXECUTING" || jobBefore.status === "ASSISTED") {
        throw new TypeError("cannot license skills after execution start");
      }
      const licenseId = payload.licenseId;
      if (jobBefore.skillLicenses.some((l) => l.licenseId === licenseId)) {
        throw new TypeError("licenseId already exists for this job");
      }
    }

    if (type === "SKILL_USED") {
      validateSkillUsedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status !== "EXECUTING" && jobBefore.status !== "ASSISTED") {
        throw new TypeError("skill usage is only allowed during execution");
      }
      const licenseId = payload.licenseId;
      const license = jobBefore.skillLicenses.find((l) => l.licenseId === licenseId);
      if (!license) throw new TypeError("skill used without license");
    }

    // Rescheduling
    if (type === "JOB_RESCHEDULED") {
      validateJobRescheduledPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);

      const allowedStatuses = new Set(["BOOKED", "MATCHED", "RESERVED"]);
      if (!allowedStatuses.has(jobBefore.status)) throw new TypeError("job is not reschedulable");
      if (!jobBefore.booking) throw new TypeError("job booking is required for reschedule");

      if (jobBefore.booking.startAt !== payload.oldWindow.startAt || jobBefore.booking.endAt !== payload.oldWindow.endAt) {
        throw new TypeError("payload.oldWindow must match current booking window");
      }

      if (payload.requiresRequote === true) {
        throw new TypeError("requiresRequote is not supported in v0.6");
      }
    }

    // Cancellation
    if (type === "JOB_CANCELLED") {
      validateJobCancelledPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.cancelledAt !== event.at) throw new TypeError("payload.cancelledAt must match event.at");
      assertNotTerminal(jobBefore);
    }

    // Incidents
    if (type === "INCIDENT_REPORTED") {
      validateIncidentReportedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status === "CREATED" || jobBefore.status === "QUOTED") {
        throw new TypeError("cannot report incident before job is booked");
      }
      if (incidentIdExists(payload.incidentId)) throw new TypeError("incidentId already exists for this job");
      if (event.actor.type !== "operator" && payload.reportedBy === undefined) {
        throw new TypeError("payload.reportedBy is required for server-side incident reports");
      }
    }

    if (type === "INCIDENT_DETECTED") {
      validateIncidentDetectedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const allowedStatuses = new Set(["EN_ROUTE", "ACCESS_GRANTED", "EXECUTING", "ASSISTED", "ABORTING_SAFE_EXIT"]);
      if (!allowedStatuses.has(jobBefore.status)) throw new TypeError("incident detection is only allowed once the job is en route");
      if (incidentIdExists(payload.incidentId)) throw new TypeError("incidentId already exists for this job");
    }

    // Evidence
    if (type === "EVIDENCE_CAPTURED") {
      validateEvidenceCapturedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (!incidentIdExists(payload.incidentId)) throw new TypeError("evidence must reference an existing incidentId");
      const exists = eventsBefore.some((e) => e.type === "EVIDENCE_CAPTURED" && e.payload?.evidenceId === payload.evidenceId);
      if (exists) throw new TypeError("evidenceId already exists for this job");

      const privacyMode = jobBefore.constraints?.privacyMode ?? null;
      if (privacyMode === "minimal" && payload.kind === "VIDEO_CLIP") {
        const incident = findIncidentById(payload.incidentId);
        const sev = incident?.severity ?? null;
        if (!Number.isSafeInteger(sev) || sev < 4) {
          throw new TypeError("video evidence is not allowed in privacyMode=minimal unless incident severity >= 4");
        }
      }

      if (evidenceContentTypeAllowlist) {
        const ct = payload.contentType ?? null;
        if (typeof ct !== "string" || ct.trim() === "" || !evidenceContentTypeAllowlist.has(ct)) {
          const err = new Error("evidence contentType is not allowed");
          err.code = "EVIDENCE_CONTENT_TYPE_FORBIDDEN";
          throw err;
        }
      }

      if (evidenceRequireSizeBytes && (payload.sizeBytes === null || payload.sizeBytes === undefined)) {
        const err = new Error("payload.sizeBytes is required");
        err.code = "EVIDENCE_SIZE_REQUIRED";
        throw err;
      }

      if (Number.isSafeInteger(evidenceMaxSizeBytes) && evidenceMaxSizeBytes > 0 && Number.isSafeInteger(payload.sizeBytes) && payload.sizeBytes > evidenceMaxSizeBytes) {
        const err = new Error("payload.sizeBytes exceeds maximum");
        err.code = "EVIDENCE_TOO_LARGE";
        throw err;
      }

      const cfg = getTenantConfig(jobTenantId) ?? {};
      const requestedLimit = cfg?.quotas?.maxEvidenceRefsPerJob ?? 0;
      const limit = clampQuota({ tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0, defaultLimit: 0, maxLimit: quotaPlatformMaxEvidenceRefsPerJob });
      if (limit > 0) {
        const evidence = Array.isArray(jobBefore.evidence) ? jobBefore.evidence : [];
        const activeCount = evidence.filter((e) => e && typeof e === "object" && !e.expiredAt).length;
        if (isQuotaExceeded({ current: activeCount, limit })) {
          const err = new Error("tenant quota exceeded");
          err.code = "TENANT_QUOTA_EXCEEDED";
          err.quota = { kind: "evidence_refs_per_job", limit, current: activeCount };
          throw err;
        }
      }
    }

    if (type === "EVIDENCE_VIEWED") {
      validateEvidenceViewedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.viewedAt !== event.at) throw new TypeError("payload.viewedAt must match event.at");

      const captured = eventsBefore.find((e) => e.type === "EVIDENCE_CAPTURED" && e.payload?.evidenceId === payload.evidenceId) ?? null;
      if (!captured) throw new TypeError("evidenceId not found for this job");
      if ((captured.payload?.evidenceRef ?? null) !== payload.evidenceRef) {
        throw new TypeError("payload.evidenceRef does not match captured evidenceRef");
      }
    }

    if (type === "EVIDENCE_EXPIRED") {
      validateEvidenceExpiredPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.expiredAt !== event.at) throw new TypeError("payload.expiredAt must match event.at");

      const captured = eventsBefore.find((e) => e.type === "EVIDENCE_CAPTURED" && e.payload?.evidenceId === payload.evidenceId) ?? null;
      if (!captured) throw new TypeError("evidenceId not found for this job");
      if ((captured.payload?.evidenceRef ?? null) !== payload.evidenceRef) {
        throw new TypeError("payload.evidenceRef does not match captured evidenceRef");
      }

      const already = eventsBefore.some((e) => e.type === "EVIDENCE_EXPIRED" && e.payload?.evidenceId === payload.evidenceId);
      if (already) throw new TypeError("evidence already expired");

      const expectedPolicyHash = jobBefore.booking?.policyHash ?? null;
      if (expectedPolicyHash && payload.policyHash !== expectedPolicyHash) {
        throw new TypeError("payload.policyHash must match booking.policyHash");
      }
    }

    // Claims
    if (type === "CLAIM_OPENED") {
      validateClaimOpenedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status === "CREATED" || jobBefore.status === "QUOTED") {
        throw new TypeError("cannot open claim before job is booked");
      }
      if (!incidentIdExists(payload.incidentId)) throw new TypeError("claim must reference an existing incidentId");
      const openedAlready = eventsBefore.some((e) => e.type === "CLAIM_OPENED" && e.payload?.claimId === payload.claimId);
      if (openedAlready) throw new TypeError("claimId already exists for this job");
    }

    if (type === "CLAIM_TRIAGED") {
      validateClaimTriagedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const claim = getClaimState(payload.claimId);
      if (!claim.exists) throw new TypeError("unknown claimId");
      if (claim.status === "APPROVED" || claim.status === "DENIED" || claim.status === "PAID") {
        throw new TypeError("cannot triage a decided claim");
      }
    }

    if (type === "CLAIM_APPROVED") {
      validateClaimApprovedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const claim = getClaimState(payload.claimId);
      if (!claim.exists) throw new TypeError("unknown claimId");
      if (claim.status === "APPROVED" || claim.status === "DENIED" || claim.status === "PAID") {
        throw new TypeError("claim is already decided");
      }

      if (jobBefore.status !== "COMPLETED" && jobBefore.status !== "ABORTED" && jobBefore.status !== "SETTLED") {
        throw new TypeError("claim approval is only allowed after the job is completed/aborted");
      }

      const incidentId = claim.incidentId;
      if (!incidentId) throw new TypeError("claim is missing incidentId");
      const incident = findIncidentById(incidentId);
      if (!incident) throw new TypeError("claim incidentId not found");
      const requiresExecution = incident.type !== "ACCESS_FAILURE";
      if (requiresExecution && !eventsBefore.some((e) => e.type === "EXECUTION_STARTED" || e.type === "JOB_EXECUTION_STARTED")) {
        throw new TypeError("cannot approve claim: job never reached execution");
      }

      const payoutCents = payload.amounts?.payoutCents ?? 0;
      const refundCents = payload.amounts?.refundCents ?? 0;
      const total = computeClaimTotalCents({ payoutCents, refundCents });
      const maxAutoApproveCents = 10_000;
      const isElevated = event.actor?.type === "system" && event.actor?.id === "proxy_admin";
      if (total > maxAutoApproveCents && !isElevated) throw new TypeError("claim approval exceeds policy max without elevated actor");

      if (refundCents) {
        const jobAmount = jobBefore.quote?.amountCents;
        if (!Number.isSafeInteger(jobAmount) || jobAmount <= 0) throw new TypeError("job quote is required for refund adjustments");
        if (refundCents > jobAmount) throw new TypeError("refundCents exceeds job amount");
      }
    }

    if (type === "CLAIM_DENIED") {
      validateClaimDeniedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const claim = getClaimState(payload.claimId);
      if (!claim.exists) throw new TypeError("unknown claimId");
      if (claim.status === "APPROVED" || claim.status === "DENIED" || claim.status === "PAID") {
        throw new TypeError("claim is already decided");
      }
      if (jobBefore.status !== "COMPLETED" && jobBefore.status !== "ABORTED" && jobBefore.status !== "SETTLED") {
        throw new TypeError("claim denial is only allowed after the job is completed/aborted");
      }
    }

    if (type === "JOB_ADJUSTED") {
      validateJobAdjustedPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const claim = getClaimState(payload.claimId);
      if (!claim.exists) throw new TypeError("unknown claimId");
      if (claim.status !== "APPROVED") throw new TypeError("job adjustment requires an approved claim");
      if (claim.adjusted) throw new TypeError("claim is already adjusted");
      if (jobBefore.status !== "SETTLED") throw new TypeError("job adjustment is only allowed after settlement");
    }

    if (type === "CLAIM_PAID") {
      validateClaimPaidPayload(payload);
      assertJobPayloadId(payload.jobId, jobBefore.id);
      const claim = getClaimState(payload.claimId);
      if (!claim.exists) throw new TypeError("unknown claimId");
      if (claim.status !== "APPROVED") throw new TypeError("claim must be approved before it can be paid");
      if (!claim.adjusted) throw new TypeError("claim must be adjusted before it can be paid");
      const approvedAmounts = claim.approved?.amounts ?? null;
      const payoutCents = approvedAmounts?.payoutCents ?? 0;
      const refundCents = approvedAmounts?.refundCents ?? 0;
      const expected = computeClaimTotalCents({ payoutCents, refundCents });
      if (payload.amountCents !== expected) throw new TypeError("payload.amountCents must equal approved total");
    }

    // Execution gating
    if (type === "EXECUTION_STARTED" || type === "JOB_EXECUTION_STARTED") {
      if (type === "JOB_EXECUTION_STARTED") {
        validateJobExecutionStartedPayload(payload ?? {});
        assertJobPayloadId(payload.jobId, jobBefore.id);
        if (payload.startedAt !== event.at) throw new TypeError("payload.startedAt must match event.at");
        if (event.actor.type === "robot" && payload.robotId !== event.actor.id) {
          throw new TypeError("payload.robotId must match event.actor.id");
        }
      }

      const plan = jobBefore.accessPlan;
      if (!plan) throw new TypeError("cannot start execution without an access plan");
      if (jobBefore.access.status !== "granted") throw new TypeError("cannot start execution without access granted");
      if (!isWithinAccessWindow({ at: event.at, validFrom: plan.validFrom, validTo: plan.validTo })) {
        throw new TypeError("execution start is outside access plan window");
      }
    }

    if (type === "JOB_HEARTBEAT") {
      validateJobHeartbeatPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.t !== event.at) throw new TypeError("payload.t must match event.at");
      if (event.actor.type !== "robot") throw new TypeError("job heartbeat requires actor.type=robot");
      if (payload.robotId !== event.actor.id) throw new TypeError("payload.robotId must match event.actor.id");

      const allowedStatuses = new Set(["EXECUTING", "ASSISTED", "STALLED", "ABORTING_SAFE_EXIT"]);
      if (!allowedStatuses.has(jobBefore.status)) throw new TypeError("job heartbeat is only allowed during execution/safe-exit");

      const expectedRobotId = jobBefore.reservation?.robotId ?? jobBefore.match?.robotId ?? jobBefore.execution?.robotId ?? null;
      if (expectedRobotId && expectedRobotId !== event.actor.id) throw new TypeError("heartbeat rejected: robotId does not match job robotId");
    }

    if (type === "JOB_EXECUTION_STALLED") {
      validateJobExecutionStalledPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.detectedAt !== event.at) throw new TypeError("payload.detectedAt must match event.at");

      const allowedStatuses = new Set(["EXECUTING", "ASSISTED"]);
      if (!allowedStatuses.has(jobBefore.status)) throw new TypeError("stall is only allowed during execution");

      const { heartbeatIntervalMs, stallAfterMs } = computeLivenessPolicy({ environmentTier: jobBefore.booking?.environmentTier });
      if (payload.policy?.heartbeatIntervalMs !== heartbeatIntervalMs) throw new TypeError("payload.policy.heartbeatIntervalMs mismatch");
      if (payload.policy?.stallAfterMs !== stallAfterMs) throw new TypeError("payload.policy.stallAfterMs mismatch");

      const startedAt = jobBefore.execution?.startedAt ?? null;
      if (!startedAt) throw new TypeError("stall requires execution startedAt");
      const lastHeartbeatAt = jobBefore.execution?.lastHeartbeatAt ?? startedAt;
      if (payload.lastHeartbeatAt !== lastHeartbeatAt) throw new TypeError("payload.lastHeartbeatAt must match projected last heartbeat");

      const nowMs = Date.parse(event.at);
      const lastMs = Date.parse(lastHeartbeatAt);
      if (!Number.isFinite(nowMs) || !Number.isFinite(lastMs)) throw new TypeError("stall timing is invalid");
      if (nowMs - lastMs <= stallAfterMs) throw new TypeError("stall rejected: heartbeat is not past stall threshold");

      const expectedRobotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? null;
      if (expectedRobotId && payload.robotId !== expectedRobotId) throw new TypeError("payload.robotId must match execution robotId");
    }

    if (type === "JOB_EXECUTION_RESUMED") {
      validateJobExecutionResumedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.resumedAt !== event.at) throw new TypeError("payload.resumedAt must match event.at");

      if (jobBefore.status !== "STALLED") throw new TypeError("resume is only allowed from STALLED");
      const expectedRobotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? null;
      if (expectedRobotId && payload.robotId !== expectedRobotId) throw new TypeError("payload.robotId must match execution robotId");

      if (event.actor.type === "robot" && payload.robotId !== event.actor.id) {
        throw new TypeError("payload.robotId must match event.actor.id");
      }

      // If the server resumes a job, require evidence the robot is alive again.
      if (event.actor.type !== "robot") {
        const stalledAt = jobBefore.execution?.stalledAt ?? null;
        const lastHeartbeatAt = jobBefore.execution?.lastHeartbeatAt ?? null;
        if (!stalledAt) throw new TypeError("server resume requires execution.stalledAt");
        if (!lastHeartbeatAt) throw new TypeError("server resume requires a heartbeat");
        if (Date.parse(lastHeartbeatAt) <= Date.parse(stalledAt)) {
          throw new TypeError("server resume requires heartbeat after stall");
        }
      }
    }

    if (type === "JOB_EXECUTION_ABORTED") {
      validateJobExecutionAbortedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.abortedAt !== event.at) throw new TypeError("payload.abortedAt must match event.at");

      const expectedRobotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? null;
      if (expectedRobotId && payload.robotId !== expectedRobotId) throw new TypeError("payload.robotId must match execution robotId");
      if (event.actor.type === "robot" && payload.robotId !== event.actor.id) {
        throw new TypeError("payload.robotId must match event.actor.id");
      }
    }

    // Assist queue
    if (type === "ASSIST_REQUESTED") {
      validateAssistRequestedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.requestedAt !== event.at) throw new TypeError("payload.requestedAt must match event.at");
      if (event.actor.type !== "robot") throw new TypeError("assist requests require actor.type=robot");
      if (payload.robotId !== event.actor.id) throw new TypeError("payload.robotId must match event.actor.id");
      const allowedStatuses = new Set(["EXECUTING", "ASSISTED", "STALLED"]);
      if (!allowedStatuses.has(jobBefore.status)) throw new TypeError("assist requests are only allowed during execution/stall");
    }

    if (type === "ASSIST_QUEUED") {
      validateAssistQueuedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.queuedAt !== event.at) throw new TypeError("payload.queuedAt must match event.at");
    }

    if (type === "ASSIST_ASSIGNED") {
      validateAssistAssignedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.assignedAt !== event.at) throw new TypeError("payload.assignedAt must match event.at");
      const operator = store.operators.get(operatorStoreKey(jobTenantId, payload.operatorId));
      if (!operator) throw new TypeError("unknown operatorId");
      if (operator.shift?.status !== "open") throw new TypeError("operator is not on shift");
    }

    if (type === "ASSIST_ACCEPTED") {
      validateAssistAcceptedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.acceptedAt !== event.at) throw new TypeError("payload.acceptedAt must match event.at");
      if (event.actor.type !== "operator") throw new TypeError("assist accepted requires actor.type=operator");
      if (payload.operatorId !== event.actor.id) throw new TypeError("payload.operatorId must match event.actor.id");
    }

    if (type === "ASSIST_DECLINED") {
      validateAssistDeclinedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.declinedAt !== event.at) throw new TypeError("payload.declinedAt must match event.at");
      if (event.actor.type !== "operator") throw new TypeError("assist declined requires actor.type=operator");
      if (payload.operatorId !== event.actor.id) throw new TypeError("payload.operatorId must match event.actor.id");
    }

    if (type === "ASSIST_TIMEOUT") {
      validateAssistTimeoutPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (payload.timedOutAt !== event.at) throw new TypeError("payload.timedOutAt must match event.at");
    }

    if (type === "CHECKPOINT_REACHED") {
      if (jobBefore.status !== "EXECUTING" && jobBefore.status !== "ASSISTED") {
        throw new TypeError("checkpoint is only allowed during execution");
      }
      if (jobBefore.access.status === "revoked" || jobBefore.access.status === "expired") {
        throw new TypeError("checkpoint rejected: access is revoked/expired");
      }
    }

    if (type === "EXECUTION_COMPLETED" || type === "JOB_EXECUTION_COMPLETED") {
      if (type === "JOB_EXECUTION_COMPLETED") {
        validateJobExecutionCompletedPayload(payload ?? {});
        assertJobPayloadId(payload.jobId, jobBefore.id);
        if (payload.completedAt !== event.at) throw new TypeError("payload.completedAt must match event.at");
        if (event.actor.type === "robot" && payload.robotId !== event.actor.id) {
          throw new TypeError("payload.robotId must match event.actor.id");
        }
      }
      if (jobBefore.access.status === "revoked" || jobBefore.access.status === "expired") {
        throw new TypeError("cannot complete execution after access is revoked/expired");
      }
    }

    if (jobBefore.status === "ABORTING_SAFE_EXIT") {
      const forbiddenDuringSafeExit = new Set(["CHECKPOINT_REACHED", "SKILL_USED", "SKILL_METER_REPORTED", "EXECUTION_COMPLETED", "JOB_EXECUTION_COMPLETED"]);
      if (forbiddenDuringSafeExit.has(type)) {
        throw new TypeError("event rejected during safe-exit");
      }
    }

    const getLastSettledEventId = () => {
      for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
        const e = eventsBefore[i];
        if (e?.type === "SETTLED") return e.id ?? null;
      }
      return null;
    };

    // Operator cost + SLA (v0.8.1 / v0.8.2)
    if (type === "OPERATOR_COST_RECORDED") {
      validateOperatorCostRecordedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status !== "SETTLED") throw new TypeError("operator cost can only be recorded after settlement");

      const lastSettledEventId = getLastSettledEventId();
      if (!lastSettledEventId) throw new TypeError("operator cost requires prior SETTLED event");
      if (payload.settledEventId !== lastSettledEventId) throw new TypeError("payload.settledEventId must match last SETTLED event id");

      const already = eventsBefore.some((e) => e.type === "OPERATOR_COST_RECORDED" && e.payload?.settledEventId === payload.settledEventId);
      if (already) throw new TypeError("operator cost already recorded for this settlement");

      const expectedZoneId = normalizeZoneId(jobBefore.booking?.zoneId ?? jobBefore.constraints?.zoneId);
      if (payload.zoneId !== null && payload.zoneId !== undefined && normalizeZoneId(payload.zoneId) !== expectedZoneId) {
        throw new TypeError("payload.zoneId must match job zone");
      }
    }

    if (type === "SLA_BREACH_DETECTED") {
      validateSlaBreachDetectedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status !== "SETTLED") throw new TypeError("SLA breach detection can only be recorded after settlement");
      if (payload.detectedAt !== event.at) throw new TypeError("payload.detectedAt must match event.at");

      const lastSettledEventId = getLastSettledEventId();
      if (!lastSettledEventId) throw new TypeError("SLA breach requires prior SETTLED event");
      if (payload.settledEventId !== lastSettledEventId) throw new TypeError("payload.settledEventId must match last SETTLED event id");

      const already = eventsBefore.some((e) => e.type === "SLA_BREACH_DETECTED" && e.payload?.settledEventId === payload.settledEventId);
      if (already) throw new TypeError("SLA breach already recorded for this settlement");

      const booking = jobBefore.booking;
      if (!booking) throw new TypeError("SLA breach requires a booking");
      if (payload.window.startAt !== booking.startAt || payload.window.endAt !== booking.endAt) {
        throw new TypeError("payload.window must match booking window");
      }
      const expectedPolicy = booking.sla ?? null;
      if (!expectedPolicy) throw new TypeError("SLA breach requires booking.sla");
      if (canonicalJsonStringify(payload.policy) !== canonicalJsonStringify(expectedPolicy)) {
        throw new TypeError("payload.policy must match booking.sla");
      }
      const expectedPolicyHash = booking.policyHash ?? null;
      if (expectedPolicyHash && payload.policyHash !== expectedPolicyHash) {
        throw new TypeError("payload.policyHash must match booking.policyHash");
      }
    }

    if (type === "SLA_CREDIT_ISSUED") {
      validateSlaCreditIssuedPayload(payload ?? {});
      assertJobPayloadId(payload.jobId, jobBefore.id);
      if (jobBefore.status !== "SETTLED") throw new TypeError("SLA credit can only be issued after settlement");
      if (payload.issuedAt !== event.at) throw new TypeError("payload.issuedAt must match event.at");

      const creditPolicy = jobBefore.booking?.creditPolicy ?? null;
      const enabled = creditPolicy?.enabled === true;
      if (!enabled) throw new TypeError("SLA credits are disabled");

      const lastSettledEventId = getLastSettledEventId();
      if (!lastSettledEventId) throw new TypeError("SLA credit requires prior SETTLED event");
      if (payload.settledEventId !== lastSettledEventId) throw new TypeError("payload.settledEventId must match last SETTLED event id");

      const hasBreach = eventsBefore.some((e) => e.type === "SLA_BREACH_DETECTED" && e.payload?.settledEventId === payload.settledEventId);
      if (!hasBreach) throw new TypeError("SLA credit requires a recorded SLA breach");

      const exists = eventsBefore.some((e) => e.type === "SLA_CREDIT_ISSUED" && (e.payload?.creditId === payload.creditId || e.payload?.settledEventId === payload.settledEventId));
      if (exists) throw new TypeError("SLA credit already issued for this settlement");

      const maxCents = creditPolicy?.maxAmountCents;
      if (Number.isSafeInteger(maxCents) && maxCents > 0 && payload.amountCents > maxCents) {
        throw new TypeError("SLA credit exceeds configured maximum");
      }
      const expectedPolicyHash = jobBefore.booking?.policyHash ?? null;
      if (expectedPolicyHash && payload.policyHash !== expectedPolicyHash) {
        throw new TypeError("payload.policyHash must match booking.policyHash");
      }
    }

    function findLatestCompletionChainHash(events) {
      if (!Array.isArray(events)) return null;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
        const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
        if (ch) return ch;
      }
      return null;
    }

    function findMatchingProofEvaluatedEvent({ events, evaluatedAtChainHash, customerPolicyHash, factsHash }) {
      if (!Array.isArray(events)) return null;
      if (typeof evaluatedAtChainHash !== "string" || !evaluatedAtChainHash.trim()) return null;
      if (typeof factsHash !== "string" || !factsHash.trim()) return null;
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i];
        if (e?.type !== "PROOF_EVALUATED") continue;
        const p = e.payload ?? null;
        if (!p || typeof p !== "object") continue;
        if (p.evaluatedAtChainHash !== evaluatedAtChainHash) continue;
        if (p.factsHash !== factsHash) continue;
        if (customerPolicyHash && p.customerPolicyHash !== customerPolicyHash) continue;
        return e;
      }
      return null;
    }

    function computeCurrentProofFactsHash({ completionChainHash }) {
      if (!completionChainHash) return null;
      const anchorIdx = eventsBefore.findIndex((e) => e?.chainHash === completionChainHash);
      if (anchorIdx === -1) return null;
      const anchorSlice = eventsBefore.slice(0, anchorIdx + 1);
      const jobAtAnchor = reduceJob(anchorSlice);
      if (!jobAtAnchor) return null;
      const current = verifyZoneCoverageProofV1({
        job: jobAtAnchor,
        events: eventsBefore,
        evaluatedAtChainHash: completionChainHash,
        customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
        operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
      });
      return {
        factsHash: current?.factsHash ?? null,
        customerPolicyHash: current?.anchors?.customerPolicyHash ?? (jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null),
        operatorPolicyHash: current?.anchors?.operatorPolicyHash ?? (jobAtAnchor.operatorPolicyHash ?? null)
      };
    }

	    function proofRefFromProofEvent(proofEvent, { statusOverride = null, forfeit = null } = {}) {
	      if (!proofEvent || typeof proofEvent !== "object") return null;
	      const p = proofEvent.payload ?? null;
	      if (!p || typeof p !== "object") return null;
	      const ref = {
	        proofEventId: proofEvent.id ?? null,
	        proofEventAt: p.evaluatedAt ?? proofEvent.at ?? null,
	        proofEventChainHash: proofEvent.chainHash ?? null,
	        proofEventPayloadHash: proofEvent.payloadHash ?? null,
	        proofEventSignerKeyId: proofEvent.signerKeyId ?? null,
	        proofEventSignature: proofEvent.signature ?? null,
	        evaluationId: p.evaluationId ?? null,
	        evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
	        status: statusOverride ?? (p.status ?? null),
	        reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
	        requiredZonesHash: p.requiredZonesHash ?? null,
	        customerPolicyHash: p.customerPolicyHash ?? null,
	        operatorPolicyHash: p.operatorPolicyHash ?? null,
	        factsHash: p.factsHash ?? null,
	        metrics: p.metrics ?? null
	      };
	      if (forfeit && typeof forfeit === "object") ref.forfeit = forfeit;
	      return ref;
	    }

	    function decisionEventRefFromDecisionEvent(decisionEvent) {
	      if (!decisionEvent || typeof decisionEvent !== "object") return null;
	      const p = decisionEvent.payload ?? null;
	      if (!p || typeof p !== "object") return null;
	      return {
	        decisionEventId: decisionEvent.id ?? null,
	        decisionEventAt: p.decidedAt ?? decisionEvent.at ?? null,
	        decisionEventChainHash: decisionEvent.chainHash ?? null,
	        decisionEventPayloadHash: decisionEvent.payloadHash ?? null,
	        decisionEventSignerKeyId: decisionEvent.signerKeyId ?? null,
	        decisionEventSignature: decisionEvent.signature ?? null,
	        decisionId: p.decisionId ?? null,
	        kind: p.kind ?? null,
	        holdId: p.holdId ?? null,
	        forfeitureReason: p.forfeitureReason ?? null,
	        reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
	        evidenceRefs: Array.isArray(p.evidenceRefs) ? p.evidenceRefs : [],
	        policyHash: p.policyHash ?? null
	      };
	    }

	    function decisionEventRefMatches({ expected, actual }) {
	      if (!expected || typeof expected !== "object") return false;
	      if (!actual || typeof actual !== "object") return false;
	      const keys = ["decisionEventId", "decisionEventChainHash", "decisionEventPayloadHash", "decisionId", "kind", "holdId", "forfeitureReason", "policyHash"];
	      for (const k of keys) {
	        const ev = expected[k] ?? null;
	        const av = actual[k] ?? null;
	        if (ev !== av) return false;
	      }
	      const expReasons = Array.isArray(expected.reasonCodes) ? expected.reasonCodes : [];
	      const actReasons = Array.isArray(actual.reasonCodes) ? actual.reasonCodes : [];
	      if (expReasons.length !== actReasons.length || expReasons.some((v, i) => actReasons[i] !== v)) return false;
	      const expEvidence = Array.isArray(expected.evidenceRefs) ? expected.evidenceRefs : [];
	      const actEvidence = Array.isArray(actual.evidenceRefs) ? actual.evidenceRefs : [];
	      if (expEvidence.length !== actEvidence.length || expEvidence.some((v, i) => actEvidence[i] !== v)) return false;
	      return true;
	    }

		    function settlementProofRefMatches({ expected, actual }) {
	      if (!expected || typeof expected !== "object") return false;
	      if (!actual || typeof actual !== "object") return false;
      const keys = [
        "proofEventId",
        "proofEventChainHash",
        "proofEventPayloadHash",
        "evaluatedAtChainHash",
        "customerPolicyHash",
        "factsHash",
        "status"
      ];
	      for (const k of keys) {
	        const ev = expected[k] ?? null;
	        const av = actual[k] ?? null;
	        if (ev !== av) return false;
	      }
	      const expForfeit = expected.forfeit ?? null;
	      if (expForfeit && typeof expForfeit === "object") {
	        const actForfeit = actual.forfeit ?? null;
	        if (!actForfeit || typeof actForfeit !== "object") return false;
	        const fKeys = ["holdId", "forfeitureReason", "forfeitEventId", "forfeitEventChainHash", "forfeitEventPayloadHash"];
	        for (const k of fKeys) {
	          const ev = expForfeit[k] ?? null;
	          const av = actForfeit[k] ?? null;
	          if (ev !== av) return false;
	        }
	      }
		      return true;
		    }

		    function proofRefMatches({ expected, actual }) {
		      if (!expected || typeof expected !== "object") return false;
		      if (!actual || typeof actual !== "object") return false;
		      const keys = ["proofEventId", "proofEventChainHash", "proofEventPayloadHash", "evaluatedAtChainHash", "customerPolicyHash", "factsHash", "status"];
		      for (const k of keys) {
		        const ev = expected[k] ?? null;
		        const av = actual[k] ?? null;
		        if (ev !== av) return false;
		      }
		      return true;
		    }

    // Settlement safety: must not settle if event stream contains unlicensed usage.
    if (type === "SETTLED") {
      const used = eventsBefore.filter((e) => e.type === "SKILL_USED");
      for (const e of used) {
        const licId = e.payload?.licenseId;
        if (!licId) continue;
        const ok = jobBefore.skillLicenses.some((l) => l.licenseId === licId);
        if (!ok) throw new TypeError("cannot settle: unlicensed skill usage exists");
      }

      // Proof gating: in strict/holdback mode, settlement is a privileged transition that must point at a fresh proof.
      // Semantics:
      // - PASS -> settle as billable
      // - FAIL -> settle as non-billable (no-charge), but still financially final
      // - INSUFFICIENT_EVIDENCE -> do not settle (move into hold state via separate primitive)
      // (ABORTED settlements are refunds and are intentionally exempt.)
      const proofPolicy = jobBefore.booking?.policySnapshot?.proofPolicy ?? null;
      const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
      const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";
      if (jobBefore.status === "COMPLETED" && gateMode !== "warn") {
        const completionChainHash = findLatestCompletionChainHash(eventsBefore);
        if (!completionChainHash) {
          const err = new Error("cannot settle: missing completion anchor");
          err.code = "PROOF_REQUIRED";
          throw err;
        }

        const current = computeCurrentProofFactsHash({ completionChainHash });
        const expectedFactsHash = current?.factsHash ?? null;
        if (!expectedFactsHash) {
          const err = new Error("cannot settle: proof factsHash missing (stale-proof protection)");
          err.code = "PROOF_STALE";
          throw err;
        }

        const expectedCustomerPolicyHash = current?.customerPolicyHash ?? null;
        const proofEvent = findMatchingProofEvaluatedEvent({
          events: eventsBefore,
          evaluatedAtChainHash: completionChainHash,
          customerPolicyHash: expectedCustomerPolicyHash,
          factsHash: expectedFactsHash
        });
        if (!proofEvent) {
          const hasAny = eventsBefore.some((e) => e?.type === "PROOF_EVALUATED" && e?.payload?.evaluatedAtChainHash === completionChainHash);
          const err = new Error(hasAny ? "cannot settle: proof is stale (matching PROOF_EVALUATED missing)" : "cannot settle: proof verdict is required (PROOF_EVALUATED missing)");
          err.code = hasAny ? "PROOF_STALE" : "PROOF_REQUIRED";
          throw err;
        }

        const proofStatus = proofEvent?.payload?.status === null || proofEvent?.payload?.status === undefined ? null : String(proofEvent.payload.status).trim();
        if (!proofStatus) {
          const err = new Error("cannot settle: proof verdict is required (PROOF_EVALUATED missing status)");
          err.code = "PROOF_REQUIRED";
          throw err;
        }
	        let expectedRef = null;
	        if (proofStatus === "INSUFFICIENT_EVIDENCE") {
	          // Strict-mode finality: settlement can only proceed from INSUFFICIENT_EVIDENCE after an explicit forfeiture decision.
	          let holdId = null;
	          for (let i = eventsBefore.length - 1; i >= 0; i -= 1) {
	            const e = eventsBefore[i];
	            if (e?.type !== "SETTLEMENT_HELD") continue;
	            const p = e.payload ?? null;
	            if (!p || typeof p !== "object") continue;
	            if (p.evaluatedAtChainHash !== completionChainHash) continue;
	            if (p.factsHash !== expectedFactsHash) continue;
	            if (typeof p.holdId === "string" && p.holdId.trim()) {
	              holdId = p.holdId;
	              break;
	            }
	          }

	          const forfeitEvent =
	            holdId &&
	            eventsBefore
	              .slice()
	              .reverse()
	              .find((e) => e?.type === "SETTLEMENT_FORFEITED" && e?.payload?.holdId === holdId && e?.payload?.factsHash === expectedFactsHash);

	          if (!forfeitEvent) {
	            const err = new Error("cannot settle: proof verdict is INSUFFICIENT_EVIDENCE");
	            err.code = "PROOF_INSUFFICIENT";
	            err.proofStatus = proofStatus;
	            throw err;
	          }

	          const fp = forfeitEvent.payload ?? null;
	          expectedRef = proofRefFromProofEvent(proofEvent, {
	            statusOverride: "FAIL",
	            forfeit: {
	              holdId,
	              forfeitureReason: fp?.forfeitureReason ?? null,
	              forfeitEventId: forfeitEvent.id ?? null,
	              forfeitEventChainHash: forfeitEvent.chainHash ?? null,
	              forfeitEventPayloadHash: forfeitEvent.payloadHash ?? null
	            }
	          });
	        } else {
	          expectedRef = proofRefFromProofEvent(proofEvent);
	        }

	        const actualRef = event.payload?.settlementProofRef ?? null;
	        if (!settlementProofRefMatches({ expected: expectedRef, actual: actualRef })) {
	          const err = new Error("cannot settle: settlementProofRef must reference the fresh proof used for settlement");
	          err.code = "SETTLEMENT_PROOF_REF_REQUIRED";
	          throw err;
	        }
	      }

      // Month-close immutability: prevent posting settlement into a closed month unless reopened.
      try {
        const t = Date.parse(event.at);
        if (Number.isFinite(t) && store.months instanceof Map) {
          const d = new Date(t);
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, "0");
          const settledMonth = `${y}-${m}`;
          const monthId = makeMonthCloseStreamId({ month: settledMonth, basis: MONTH_CLOSE_BASIS.SETTLED_AT });
          const monthClose = store.months.get(monthStoreKey(jobTenantId, monthId)) ?? null;
          if (monthClose?.status === "CLOSED") throw new TypeError("cannot settle: month is closed");
        }
      } catch (err) {
        if (err?.message === "cannot settle: month is closed") throw err;
      }
    }
  }

  function parseRequestId(req) {
    const header = req?.headers?.["x-request-id"] ?? req?.headers?.["X-Request-Id"] ?? null;
    const raw = header === null || header === undefined ? "" : String(header).trim();
    if (raw && raw.length <= 128 && /^[a-zA-Z0-9._-]+$/.test(raw)) return raw;
    return createId("req");
  }

  function routeLabelFor({ method, path }) {
    const m = String(method ?? "").toUpperCase();
    const p = String(path ?? "");
    if (m === "GET" && p === "/health") return "/health";
    if (m === "GET" && p === "/healthz") return "/healthz";
    if (m === "GET" && p === "/metrics") return "/metrics";
    if (m === "GET" && p === "/capabilities") return "/capabilities";
    if (m === "GET" && p === "/openapi.json") return "/openapi.json";
    if (m === "POST" && p === "/ingest/proxy") return "/ingest/proxy";
    if (m === "POST" && p === "/exports/ack") return "/exports/ack";
    if (m === "GET" && p === "/evidence/download") return "/evidence/download";
    if (p === "/jobs") return "/jobs";
    if (/^\/jobs\/[^/]+\/events$/.test(p)) return "/jobs/:jobId/events";
    if (/^\/jobs\/[^/]+\/audit$/.test(p)) return "/jobs/:jobId/audit";
    if (/^\/jobs\/[^/]+$/.test(p)) return "/jobs/:jobId";
    if (/^\/robots\/[^/]+\/events$/.test(p)) return "/robots/:robotId/events";
    if (/^\/robots\/[^/]+$/.test(p)) return "/robots/:robotId";
    if (/^\/operators\/[^/]+\/events$/.test(p)) return "/operators/:operatorId/events";
    if (p.startsWith("/ops")) return "/ops/*";
    return "other";
  }

  function logLevelForStatus(statusCode) {
    if (!Number.isFinite(statusCode) || statusCode <= 0) return "error";
    if (statusCode >= 500) return "error";
    if (statusCode >= 400) return "warn";
    return "info";
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const requestId = parseRequestId(req);
    const route = routeLabelFor({ method: req.method, path });
    try {
      res.setHeader("x-request-id", requestId);
    } catch {
      // ignore
    }
    setProtocolResponseHeaders(res);

    return withLogContext({ requestId, route, method: req.method, path }, async () => {
      const startedMs = Date.now();
      let tenantId = "tenant_default";
      let principalId = "anon";
      try {
        try {
          tenantId = normalizeTenantId(req.headers?.["x-proxy-tenant-id"]);
        } catch (err) {
          return sendError(res, 400, "invalid tenant", { message: err?.message }, { code: "SCHEMA_INVALID" });
        }
        if (typeof store.ensureTenant === "function") store.ensureTenant(tenantId);
        try {
          principalId = normalizePrincipalId(req.headers);
        } catch (err) {
          return sendError(res, 400, "invalid principal", { message: err?.message }, { code: "SCHEMA_INVALID" });
        }

        const rateLimitExempt = (req.method === "GET" && path === "/health") || (req.method === "GET" && path === "/healthz");
        if (!rateLimitExempt) {
          const rate = takeRateLimitToken({ tenantId });
          if (!rate.ok) {
            metricInc("rate_limited_total", null, 1);
            try {
              res.setHeader("retry-after", String(rate.retryAfterSeconds));
            } catch {
              // ignore
            }
            return sendError(res, 429, "rate limit exceeded", null, { code: "RATE_LIMITED" });
          }
        }

        const authExempt =
          (req.method === "GET" && path === "/health") ||
          (req.method === "GET" && path === "/healthz") ||
          (req.method === "GET" && path === "/capabilities") ||
          (req.method === "GET" && path === "/openapi.json") ||
          (req.method === "POST" && path === "/ingest/proxy") ||
          (req.method === "POST" && path === "/exports/ack");

        const auth = authExempt
          ? { ok: false, tenantId, principalId, scopes: new Set(), method: "exempt" }
          : await authenticateRequest({ req, store, tenantId, legacyTokenScopes: opsTokenScopes, nowIso });
        if (!authExempt && !auth.ok) return sendError(res, 403, "forbidden", null, { code: "FORBIDDEN" });
        if (auth.ok && auth.principalId) principalId = auth.principalId;

        try {
          const ctx = getLogContext();
          if (ctx && typeof ctx === "object") {
            ctx.tenantId = tenantId;
            ctx.principalId = principalId;
            ctx.actorKeyId = auth.ok ? (auth.keyId ?? null) : null;
          }
        } catch {}

        function makeOpsAudit({ action, targetType = null, targetId = null, details = null } = {}) {
          return makeOpsAuditRecord({
            tenantId,
            actorKeyId: auth.ok ? (auth.keyId ?? null) : null,
            actorPrincipalId: principalId,
            requestId,
            action: String(action ?? "OPS_HTTP_WRITE"),
            targetType,
            targetId,
            at: nowIso(),
            details
          });
        }

        function readIdempotency({ method, requestPath, expectedPrevChainHash, body }) {
          const idempotencyKey = req.headers["x-idempotency-key"] ? String(req.headers["x-idempotency-key"]) : null;
          if (!idempotencyKey) return { idempotencyKey: null, idemStoreKey: null, idemRequestHash: null };

          const endpoint = makeIdempotencyEndpoint({ method, path: requestPath });
          const idemStoreKey = makeIdempotencyStoreKey({ tenantId, principalId, endpoint, idempotencyKey });
          const idemRequestHash = computeIdempotencyRequestHash({ method, path: requestPath, expectedPrevChainHash, body });
          return { idempotencyKey, idemStoreKey, idemRequestHash };
        }

        if (req.method === "GET" && path === "/health") {
          return sendJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && path === "/capabilities") {
          return sendJson(res, 200, {
            ok: true,
            protocol: {
              current: protocolPolicy.current,
              supported: protocolPolicy.supported,
              min: protocolPolicy.min,
              max: protocolPolicy.max,
              requireHeader: protocolPolicy.requireHeader
            },
            contracts: {
              apis: [
                {
                  id: "legacy-v1",
                  basePath: "/ops/contracts",
                  semantics: "mutable policy upsert (back-compat)"
                },
                {
                  id: "contracts-v2",
                  basePath: "/ops/contracts-v2",
                  semantics: "contracts-as-code (hash-addressed docs + compile/activate)"
                }
              ],
              documents: { supported: [CONTRACT_DOCUMENT_TYPE_V1] },
              compilers: { supported: [CONTRACT_COMPILER_ID] }
            },
            connect: {
              supported: true,
              allocations: true,
              splitPlanVersions: ["SplitPlan.v1"],
              partyRoles: ["platform", "operator", "customer", "subcontractor", "insurer"]
            },
            events: {
              envelopeVersion: 1,
              schemaVersionsByType: Object.fromEntries(listKnownEventTypes().map((t) => [t, [1]]))
            },
            artifacts: {
              supportedTypes: Object.values(ARTIFACT_TYPE).sort()
            }
          });
        }

        if (req.method === "GET" && path === "/openapi.json") {
          return sendJson(res, 200, buildOpenApiSpec());
        }

      if (req.method === "GET" && path === "/healthz") {
        const signals = {
          ok: true,
          dbOk: true,
          dbLatencyMs: null,
          outboxPending: null,
          deliveriesPending: null,
          deliveriesFailed: null,
          ingestRejected: null,
          autotickLastTickAt: store?.__autotickLastTickAt ?? null,
          autotickLastSuccessAt: store?.__autotickLastSuccessAt ?? null
        };

        if (store?.kind === "pg" && store?.pg?.pool) {
          const started = Date.now();
          try {
            await store.pg.pool.query("SELECT 1");
            signals.dbOk = true;
            signals.dbLatencyMs = Date.now() - started;
          } catch (err) {
            signals.dbOk = false;
            signals.dbLatencyMs = Date.now() - started;
            logger.error("healthz.db_failed", { err });
          }

          try {
            const outboxRes = await store.pg.pool.query("SELECT COUNT(*)::bigint AS count FROM outbox WHERE processed_at IS NULL");
            const n = Number(outboxRes.rows?.[0]?.count ?? 0);
            signals.outboxPending = Number.isFinite(n) ? n : null;
          } catch {}
          try {
            const deliveriesRes = await store.pg.pool.query(
              "SELECT state, COUNT(*)::bigint AS count FROM deliveries WHERE state IN ('pending','failed') GROUP BY state"
            );
            let pending = 0;
            let failed = 0;
            for (const row of deliveriesRes.rows ?? []) {
              const state = row?.state ? String(row.state) : "";
              const n = Number(row?.count ?? 0);
              const count = Number.isFinite(n) ? n : 0;
              if (state === "pending") pending = count;
              if (state === "failed") failed = count;
            }
            signals.deliveriesPending = pending;
            signals.deliveriesFailed = failed;
          } catch {}
          try {
            const ingestRes = await store.pg.pool.query("SELECT COUNT(*)::bigint AS count FROM ingest_records WHERE status = 'rejected'");
            const n = Number(ingestRes.rows?.[0]?.count ?? 0);
            signals.ingestRejected = Number.isFinite(n) ? n : null;
          } catch {}
        } else {
          const cursor = Number.isSafeInteger(store?.outboxCursor) ? store.outboxCursor : 0;
          signals.outboxPending = Array.isArray(store?.outbox) ? Math.max(0, store.outbox.length - cursor) : 0;

          if (store?.deliveries instanceof Map) {
            let pending = 0;
            let failed = 0;
            for (const d of store.deliveries.values()) {
              if (!d || typeof d !== "object") continue;
              if (d.state === "pending") pending += 1;
              if (d.state === "failed") failed += 1;
            }
            signals.deliveriesPending = pending;
            signals.deliveriesFailed = failed;
          } else {
            signals.deliveriesPending = 0;
            signals.deliveriesFailed = 0;
          }

          if (store?.ingestRecords instanceof Map) {
            let rejected = 0;
            for (const r of store.ingestRecords.values()) {
              if (r?.status === "rejected") rejected += 1;
            }
            signals.ingestRejected = rejected;
          } else {
            signals.ingestRejected = 0;
          }
        }

        signals.ok = Boolean(signals.dbOk);
        return sendJson(res, signals.ok ? 200 : 503, signals);
      }

	      if (!authExempt && !path.startsWith("/ops")) {
	        const isRead = req.method === "GET" || req.method === "HEAD";
	        const isAuditExport = req.method === "GET" && /^\/jobs\/[^/]+\/audit$/.test(path);
	        const requiredScope =
	          path === "/evidence/download"
	            ? OPS_SCOPES.AUDIT_READ
	            : isAuditExport
	              ? OPS_SCOPES.AUDIT_READ
	              : isRead
	                ? OPS_SCOPES.OPS_READ
	                : OPS_SCOPES.OPS_WRITE;

	        // Special-case: selected job mutation endpoints include both ops-facing and finance-facing flows; allow either scope and enforce per-route/per-event below.
	        if (
	          !isRead &&
	          req.method === "POST" &&
	          (/^\/jobs\/[^/]+\/events$/.test(path) || /^\/jobs\/[^/]+\/dispute\/(open|close)$/.test(path))
	        ) {
	          const ok = requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
	          if (!ok) return sendError(res, 403, "forbidden");
	        } else {
	          if (!requireScope(auth.scopes, requiredScope)) return sendError(res, 403, "forbidden");
	        }
	      }

      if (req.method === "GET" && path === "/metrics") {
        await refreshAlertGauges({ tenantId });
        return sendText(res, 200, metrics.renderPrometheusText(), { contentType: "text/plain; version=0.0.4; charset=utf-8" });
      }

      if (req.method === "POST" && path === "/ingest/proxy") {
        if (ingestTokenValue && String(req.headers?.["x-proxy-ingest-token"] ?? "") !== String(ingestTokenValue)) {
          return sendError(res, 403, "forbidden");
        }
        if (!requireProtocolHeaderForWrite(req, res)) return;

        const body = await readJsonBody(req);
        if (!body || typeof body !== "object") return sendError(res, 400, "json body is required");

        const source = body?.source ? String(body.source) : null;
        if (!source) return sendError(res, 400, "source is required");

        const { idempotencyKey, idemStoreKey, idemRequestHash } = readIdempotency({
          method: "POST",
          requestPath: path,
          expectedPrevChainHash: null,
          body
        });
        if (!idempotencyKey) return sendError(res, 400, "x-idempotency-key is required");

        if (idemStoreKey) {
          const existingIdem = store.idempotency.get(idemStoreKey);
          if (existingIdem) {
            if (existingIdem.requestHash !== idemRequestHash) {
              return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
            }
            return sendJson(res, existingIdem.statusCode, existingIdem.body);
          }
        }

        const siteId = body?.siteId ?? null;
        const correlationKey = body?.correlationKey ?? null;
        let jobId = body?.jobId ?? null;

        if (!jobId) {
          if (!siteId || !correlationKey) return sendError(res, 400, "jobId or (siteId + correlationKey) is required");
          if (typeof store.lookupCorrelation !== "function") return sendError(res, 501, "correlation lookup not supported");
          const hit = await store.lookupCorrelation({ tenantId, siteId: String(siteId), correlationKey: String(correlationKey) });
          if (!hit?.jobId) return sendError(res, 404, "correlationKey not found");
          jobId = hit.jobId;
        }

        if (typeof jobId !== "string" || jobId.trim() === "") return sendError(res, 400, "invalid jobId");

        const existing = getJobEvents(tenantId, jobId);
        if (!existing.length) return sendError(res, 404, "job not found");
        const jobBefore = reduceJob(existing);
        if (!jobBefore) return sendError(res, 404, "job not found");

        {
          const cfg = getTenantConfig(tenantId) ?? {};
          const requestedLimit = cfg?.quotas?.maxIngestDlqDepth ?? 0;
          const limit = clampQuota({
            tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0,
            defaultLimit: 0,
            maxLimit: quotaPlatformMaxIngestDlqDepth
          });
          if (limit > 0) {
            let rejected = 0;
            if (store?.kind === "pg" && store?.pg?.pool) {
              try {
                const res = await store.pg.pool.query(
                  "SELECT COUNT(*)::int AS count FROM ingest_records WHERE tenant_id = $1 AND status = 'rejected'",
                  [tenantId]
                );
                rejected = Number(res.rows[0]?.count ?? 0);
              } catch {
                rejected = 0;
              }
            } else if (store?.ingestRecords instanceof Map) {
              for (const r of store.ingestRecords.values()) {
                if (!r || typeof r !== "object") continue;
                if (normalizeTenantId(r.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
                if (r.status === "rejected") rejected += 1;
              }
            }
            if (isQuotaExceeded({ current: rejected, limit })) {
              return sendError(
                res,
                429,
                "tenant quota exceeded",
                { kind: "ingest_dlq_depth", limit, current: rejected },
                { code: "TENANT_QUOTA_EXCEEDED" }
              );
            }
          }
        }

        const inputEvents = Array.isArray(body?.events) ? body.events : null;
        if (!inputEvents || inputEvents.length === 0) return sendError(res, 400, "events[] is required");
        const ingestMaxEventsRaw = typeof process !== "undefined" ? process.env.PROXY_INGEST_MAX_EVENTS : null;
        const ingestMaxEvents = ingestMaxEventsRaw ? Number(ingestMaxEventsRaw) : 200;
        if (!Number.isFinite(ingestMaxEvents) || ingestMaxEvents <= 0) return sendError(res, 500, "invalid PROXY_INGEST_MAX_EVENTS");
        if (inputEvents.length > ingestMaxEvents) return sendError(res, 413, "too many events in request");

        const receivedAt = nowIso();
        const ingestRetentionDays = clampRetentionDays({
          tenantDays: Number.isSafeInteger(getTenantConfig(tenantId)?.retention?.ingestRecordsDays)
            ? getTenantConfig(tenantId).retention.ingestRecordsDays
            : 0,
          defaultDays: 0,
          maxDays: ingestRecordsRetentionMaxDays
        });
        const ingestExpiresAt = computeExpiresAtIso({ at: receivedAt, retentionDays: ingestRetentionDays });
        const nowMs = Date.parse(receivedAt);
        const maxFutureSkewMs = 5 * 60_000;
        const lateAfterMs = 15 * 60_000;

        let events = existing;
        let workingJob = jobBefore;
        const appended = [];
        const results = [];
        const ingestRecords = [];
        const outboxMessages = [];
        const seenExternalIds = new Set();

        for (const e of inputEvents) {
          const type = e?.type ? String(e.type) : null;
          if (!type) return sendError(res, 400, "event.type is required");

          const externalEventId = e?.externalEventId ? String(e.externalEventId) : null;
          if (!externalEventId) return sendError(res, 400, "event.externalEventId is required");
          if (seenExternalIds.has(externalEventId)) {
            metricInc("ingest_events_total", { result: "duplicate" }, 1);
            results.push({
              externalEventId,
              status: "duplicate",
              acceptedEventId: null,
              reason: "duplicate externalEventId in request",
              reasonCode: null,
              late: null
            });
            continue;
          }
          seenExternalIds.add(externalEventId);

          let prior = null;
          try {
            if (typeof store.getIngestRecord === "function") {
              prior = await store.getIngestRecord({ tenantId, source, externalEventId });
            }
          } catch {
            // Ignore: best-effort dedupe is handled by storage.
          }
          if (prior) {
            metricInc("ingest_events_total", { result: "duplicate" }, 1);
            results.push({
              externalEventId,
              status: "duplicate",
              acceptedEventId: prior.acceptedEventId ?? prior.eventId ?? null,
              reason: null,
              reasonCode: null,
              late: prior.late ?? null
            });
            continue;
          }

          const signerKind = requiredSignerKindForEventType(type);
          if (signerKind !== SIGNER_KIND.SERVER) {
            const reason = `unsupported signerKind=${signerKind}`;
            const reasonCode = inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late: null });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at: e?.at ?? null,
              receivedAt,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          const actor = e?.actor ?? { type: "ingest", id: principalId };
          if (actor?.type === "robot" || actor?.type === "operator") {
            const reason = "ingest cannot spoof robot/operator actors";
            const reasonCode = inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late: null });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at: e?.at ?? null,
              receivedAt,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          const at = e?.at ?? nowIso();
          try {
            assertIsoDate(at, "event.at");
          } catch (err) {
            const reason = err?.message ?? "invalid at";
            const reasonCode = inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late: null });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at,
              receivedAt,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          const atMs = Date.parse(at);
          if (Number.isFinite(atMs) && Number.isFinite(nowMs) && atMs > nowMs + maxFutureSkewMs) {
            const reason = "event.at is too far in the future";
            const reasonCode = inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late: null });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at,
              receivedAt,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          const late = Number.isFinite(atMs) && Number.isFinite(nowMs) ? atMs < nowMs - lateAfterMs : null;

          const draft = createChainedEvent({
            streamId: jobId,
            type,
            at,
            actor,
            payload: e?.payload ?? null
          });
          const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind, event });
            validateDomainEvent({ jobBefore: workingJob, event, eventsBefore: events });
          } catch (err) {
            const reason = err?.message ?? "event rejected";
            const reasonCode = typeof err?.code === "string" && err.code.trim() ? err.code : inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at,
              receivedAt,
              late,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          events = nextEvents;
          appended.push(event);
          try {
            workingJob = reduceJob(events);
          } catch (err) {
            const reason = err?.message ?? "job transition rejected";
            const reasonCode = inferIngestReasonCode(reason);
            metricInc("ingest_events_total", { result: "rejected" }, 1);
            metricInc("ingest_rejected_total", { reason: reasonCode }, 1);
            results.push({ externalEventId, status: "rejected", acceptedEventId: null, reason, reasonCode, late });
            ingestRecords.push({
              tenantId,
              source,
              externalEventId,
              status: "rejected",
              reason,
              reasonCode,
              jobId,
              siteId: siteId ? String(siteId) : null,
              correlationKey: correlationKey ? String(correlationKey) : null,
              type,
              at,
              receivedAt,
              late,
              expiresAt: ingestExpiresAt
            });
            continue;
          }

          // Ledger posting (best-effort): only for server-signed job events.
          try {
            const eventsBefore = events.slice(0, -1);
            const jobBefore = reduceJob(eventsBefore);
            const entries = ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore });
            for (const entry of entries) {
              if (!entry) continue;
              outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: event.id, entry });
            }
          } catch {
            // ignore
          }

          metricInc("ingest_events_total", { result: "accepted" }, 1);
          results.push({ externalEventId, status: "accepted", acceptedEventId: event.id, reason: null, reasonCode: null, late });
          ingestRecords.push({
            tenantId,
            source,
            externalEventId,
            status: "accepted",
            reason: null,
            reasonCode: null,
            acceptedEventId: event.id,
            jobId,
            siteId: siteId ? String(siteId) : null,
            correlationKey: correlationKey ? String(correlationKey) : null,
            type,
            at,
            receivedAt,
            late,
            expiresAt: ingestExpiresAt
          });
        }

        try {
          const summary = { accepted: 0, duplicate: 0, rejected: 0 };
          const rejectedByReason = {};
          for (const r of results) {
            if (r?.status === "accepted") summary.accepted += 1;
            else if (r?.status === "duplicate") summary.duplicate += 1;
            else if (r?.status === "rejected") {
              summary.rejected += 1;
              const code = typeof r?.reasonCode === "string" && r.reasonCode.trim() ? r.reasonCode : "UNKNOWN";
              rejectedByReason[code] = (rejectedByReason[code] ?? 0) + 1;
            }
          }
          logger.info("ingest.proxy", { tenantId, principalId, jobId, source, counts: summary, rejectedByReason });
        } catch {
          // ignore
        }

        const responseBody = { job: workingJob, results, events: appended };
        const ops = [];
        if (appended.length) ops.push({ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appended });
        if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });
        if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } });
        if (ingestRecords.length) ops.push({ kind: "INGEST_RECORDS_PUT", tenantId, records: ingestRecords });

        if (ops.length) await commitTx(ops);
        return sendJson(res, 200, responseBody);
      }

      if (req.method === "POST" && path === "/exports/ack") {
        const destinationId = req.headers["x-proxy-destination-id"] ? String(req.headers["x-proxy-destination-id"]) : null;
        const timestamp = req.headers["x-proxy-timestamp"] ? String(req.headers["x-proxy-timestamp"]) : null;
        const signature = req.headers["x-proxy-signature"] ? String(req.headers["x-proxy-signature"]) : null;
        if (!destinationId || !timestamp || !signature) {
          return sendError(res, 400, "missing required headers", "x-proxy-destination-id, x-proxy-timestamp, x-proxy-signature are required");
        }

        const tsMs = Date.parse(timestamp);
        const nowMs = Date.parse(nowIso());
        const maxSkewMs = 5 * 60_000;
        if (Number.isFinite(tsMs) && Number.isFinite(nowMs) && Math.abs(tsMs - nowMs) > maxSkewMs) {
          return sendError(res, 400, "timestamp skew too large");
        }

        const dest = listDestinationsForTenant(tenantId).find((d) => d.destinationId === destinationId) ?? null;
        if (!dest) return sendError(res, 404, "destination not found");

        const body = await readJsonBody(req);
        if (!body || typeof body !== "object") return sendError(res, 400, "json body is required");

        let destinationSecret = dest.secret ?? null;
        if (!destinationSecret && dest.secretRef) {
          try {
            destinationSecret = (await store.secrets.getSecret({ tenantId, ref: String(dest.secretRef) }))?.value ?? null;
          } catch (err) {
            return sendError(res, 500, "destination secret unavailable", { message: err?.message }, { code: "SECRET_READ_FAILED" });
          }
        }
        if (!destinationSecret) return sendError(res, 500, "destination secret unavailable", null, { code: "SECRET_NOT_FOUND" });

        const expected = hmacSignArtifact({ secret: destinationSecret, timestamp, bodyJson: body });
        if (String(signature) !== expected) return sendError(res, 403, "forbidden");

        const deliveryIdRaw = body?.deliveryId ?? body?.id ?? null;
        const artifactHash = body?.artifactHash ?? null;
        const receivedAt = body?.receivedAt ?? null;
        if (!deliveryIdRaw) return sendError(res, 400, "deliveryId is required");

        if (typeof store.ackDelivery !== "function") return sendError(res, 501, "delivery receipts not supported for this store");

        try {
          if (store.kind === "pg") {
            const id = Number(deliveryIdRaw);
            if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 400, "invalid deliveryId");
            const result = await store.ackDelivery({ tenantId, id, destinationId, artifactHash: artifactHash ?? null, receivedAt: receivedAt ?? null });
            if (!result) return sendError(res, 404, "delivery not found");
            return sendJson(res, 200, { ok: true, ...result });
          }

          const deliveryId = String(deliveryIdRaw);
          const result = await store.ackDelivery({ tenantId, deliveryId, destinationId, artifactHash: artifactHash ?? null, receivedAt: receivedAt ?? null });
          if (!result) return sendError(res, 404, "delivery not found");
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, "invalid ack", { message: err?.message });
        }
      }

      if (req.method === "GET" && path === "/evidence/download") {
        const queryTenantId = url.searchParams.get("tenantId");
        const evidenceTenantId = normalizeTenantId(queryTenantId ?? tenantId);
        if (typeof store.ensureTenant === "function") store.ensureTenant(evidenceTenantId);

        const jobId = url.searchParams.get("jobId");
        const evidenceId = url.searchParams.get("evidenceId");
        const evidenceRef = url.searchParams.get("evidenceRef");
        const expiresAt = url.searchParams.get("expiresAt");
        const sig = url.searchParams.get("sig");

        if (!jobId || !evidenceId || !evidenceRef || !expiresAt || !sig) {
          return sendError(res, 400, "missing required query params");
        }

        const nowMs = Date.parse(nowIso());
        const verify = verifyEvidenceDownload({
          secret: evidenceSigningSecret,
          tenantId: evidenceTenantId,
          jobId,
          evidenceId,
          evidenceRef,
          expiresAt,
          sig,
          nowMs: Number.isFinite(nowMs) ? nowMs : Date.now()
        });
        if (!verify.ok) return sendError(res, 403, "forbidden", verify.error);

        const events = getJobEvents(evidenceTenantId, jobId);
        if (!events.length) return sendError(res, 404, "job not found");

        const jobBefore = reduceJob(events);
        if (!jobBefore) return sendError(res, 404, "job not found");

        const captured = events.find((e) => e?.type === "EVIDENCE_CAPTURED" && e?.payload?.evidenceId === evidenceId) ?? null;
        if (!captured) return sendError(res, 404, "evidence not found");
        if ((captured.payload?.evidenceRef ?? null) !== evidenceRef) return sendError(res, 404, "evidence not found");
        const expired = events.some((e) => e?.type === "EVIDENCE_EXPIRED" && e?.payload?.evidenceId === evidenceId);
        if (expired) return sendError(res, 410, "evidence expired", null, { code: "EVIDENCE_EXPIRED" });

        const refSafety = checkUrlSafetySync(evidenceRef, { allowPrivate: false, allowLoopback: false });
        if (!refSafety.ok) {
          return sendError(res, 400, "unsafe evidenceRef", { code: refSafety.code }, { code: refSafety.code });
        }

        // Audit log is required: evidence retrieval must be view-audited.
        try {
          const viewedAt = nowIso();
          const draft = createChainedEvent({
            streamId: jobId,
            type: "EVIDENCE_VIEWED",
            at: viewedAt,
            actor: { type: "ops", id: principalId },
            payload: { jobId, evidenceId, evidenceRef, viewedAt }
          });
          const nextEvents = appendChainedEvent({ events, event: draft, signer: serverSigner });
          const viewEvent = nextEvents[nextEvents.length - 1];
          enforceSignaturePolicy({ tenantId: evidenceTenantId, signerKind: requiredSignerKindForEventType(viewEvent.type), event: viewEvent });
          validateDomainEvent({ jobBefore, event: viewEvent, eventsBefore: events });
          reduceJob(nextEvents);
          await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId: evidenceTenantId, jobId, events: [viewEvent] }]);
        } catch (err) {
          return sendError(res, 500, "failed to audit evidence view", { message: err?.message }, { code: "AUDIT_LOG_FAILED" });
        }

        // External evidence refs (https://...) are redirected after DNS/IP safety checks.
        if (typeof evidenceRef === "string" && (evidenceRef.startsWith("https://") || evidenceRef.startsWith("http://"))) {
          const safe = await checkUrlSafety(evidenceRef, { allowPrivate: false, allowLoopback: false });
          if (!safe.ok) {
            return sendError(res, 400, "unsafe evidenceRef", { code: safe.code, message: safe.message }, { code: safe.code });
          }
          res.statusCode = 302;
          res.setHeader("location", evidenceRef);
          res.setHeader("cache-control", "no-store");
          res.end();
          return;
        }

        if (typeof evidenceRef !== "string" || !evidenceRef.startsWith("obj://")) {
          return sendError(res, 400, "unsupported evidenceRef");
        }
        if (!store.evidenceStore) {
          return sendError(res, 501, "evidence store not configured");
        }

        const expMs = Date.parse(expiresAt);
        const computedExpires = Number.isFinite(expMs) && Number.isFinite(nowMs) ? Math.max(1, Math.ceil((expMs - nowMs) / 1000)) : 60;
        const maxPresignSecondsRaw = typeof process !== "undefined" ? process.env.PROXY_EVIDENCE_PRESIGN_MAX_SECONDS : null;
        const maxPresignSeconds = maxPresignSecondsRaw && String(maxPresignSecondsRaw).trim() !== "" ? Number(maxPresignSecondsRaw) : 300;
        const safeMaxPresignSeconds =
          Number.isFinite(maxPresignSeconds) && maxPresignSeconds > 0 ? Math.min(3600, Math.floor(maxPresignSeconds)) : 300;
        const expiresInSeconds = Math.min(computedExpires, safeMaxPresignSeconds);

        if (typeof store.evidenceStore.getPresignedDownloadUrl === "function") {
          let presigned;
          try {
            presigned = await store.evidenceStore.getPresignedDownloadUrl({ tenantId: evidenceTenantId, evidenceRef, expiresInSeconds });
          } catch (err) {
            return sendError(res, 500, "failed to presign evidence download", { message: err?.message });
          }

          const allowPrivateUrls =
            typeof process !== "undefined" &&
            (process.env.PROXY_ALLOW_PRIVATE_URLS === "1" || process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
          const allowLoopbackUrls =
            typeof process !== "undefined" &&
            (process.env.PROXY_ALLOW_LOOPBACK_URLS === "1" || process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
          const presignedSafety = await checkUrlSafety(presigned, { allowPrivate: allowPrivateUrls, allowLoopback: allowLoopbackUrls });
          if (!presignedSafety.ok) {
            return sendError(res, 500, "unsafe evidence download URL", { code: presignedSafety.code, message: presignedSafety.message }, { code: presignedSafety.code });
          }

          res.statusCode = 302;
          res.setHeader("location", presigned);
          res.setHeader("cache-control", "no-store");
          res.end();
          return;
        }

        if (typeof store.evidenceStore.readEvidence !== "function") {
          return sendError(res, 501, "evidence store not configured");
        }

        let data;
        try {
          ({ data } = await store.evidenceStore.readEvidence({ tenantId: evidenceTenantId, evidenceRef }));
        } catch (err) {
          if (err?.code === "ENOENT") return sendError(res, 404, "evidence object not found");
          throw err;
        }

        res.statusCode = 200;
        res.setHeader("content-type", String(captured.payload?.contentType ?? "application/octet-stream"));
        res.setHeader("content-disposition", `attachment; filename="evidence_${String(evidenceId).replaceAll(/[^a-zA-Z0-9._-]/g, "_")}"`);
        res.end(data);
        return;
      }

      if (path.startsWith("/ops")) {
        if (!auth.ok) return sendError(res, 403, "forbidden");
        if (store.kind === "pg" && typeof store.refreshFromDb === "function") {
          await store.refreshFromDb();
          if (typeof store.ensureTenant === "function") store.ensureTenant(tenantId);
        }

        const parts = path.split("/").filter(Boolean);
        if (parts.length === 1 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          return sendJson(res, 200, { ok: true });
        }

        if (parts[1] === "config" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const cfg = getTenantConfig(tenantId) ?? {};
          return sendJson(res, 200, {
            tenantId,
            config: {
              evidenceRetentionMaxDays: Number.isSafeInteger(cfg.evidenceRetentionMaxDays) ? cfg.evidenceRetentionMaxDays : 365
            }
          });
        }

        // NOTE: /ops/contracts is a legacy contract upsert surface used by existing tests/integrations.
        // Contracts-as-code v1 lives under /ops/contracts-v2 to avoid breaking legacy payloads.
        if (parts[1] === "contracts-v2" && parts[2] === "simulate" && parts.length === 3 && req.method === "POST") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);
          const doc = body?.doc && typeof body.doc === "object" ? body.doc : body;
          try {
            validateContractDocumentV1(doc);
          } catch (err) {
            return sendError(res, 400, "invalid contract document", { message: err?.message }, { code: "SCHEMA_INVALID" });
          }
          const contractHash = hashContractDocumentV1(doc);
          const compiled = compileContractPolicyTemplate({ contractDoc: doc });
          return sendJson(res, 200, {
            contractHash,
            policyHash: compiled.policyHash,
            compilerId: compiled.compilerId,
            policyTemplate: compiled.policyTemplate
          });
        }

        if (parts[1] === "contracts-v2" && parts.length === 2 && req.method === "GET") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listContractsV2 !== "function") return sendError(res, 501, "contracts v2 not supported for this store");
          const status = url.searchParams.get("status");
          const contracts = await store.listContractsV2({ tenantId, status: status ?? null, limit: 200, offset: 0 });
          return sendJson(res, 200, { contracts });
        }

        if (parts[1] === "contracts-v2" && parts.length === 2 && req.method === "POST") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.createContractDraftV2 !== "function") return sendError(res, 501, "contracts v2 not supported for this store");
          const body = await readJsonBody(req);
          const raw = body?.doc && typeof body.doc === "object" ? body.doc : body;

          const contractId = raw?.contractId ? String(raw.contractId) : createId("ctr");
          const contractVersion = raw?.contractVersion !== undefined ? Number(raw.contractVersion) : 1;
          const name = raw?.name ? String(raw.name) : contractId;

          const doc = {
            ...raw,
            type: CONTRACT_DOCUMENT_TYPE_V1,
            v: 1,
            contractId,
            contractVersion,
            name
          };

          try {
            validateContractDocumentV1(doc);
          } catch (err) {
            return sendError(res, 400, "invalid contract document", { message: err?.message }, { code: "SCHEMA_INVALID" });
          }

          let record;
          try {
            record = await store.createContractDraftV2({
              tenantId,
              contractId,
              contractVersion,
              doc,
              audit: makeOpsAudit({ action: "CONTRACT_DRAFT_UPSERT", targetType: "contract", targetId: `${contractId}@${contractVersion}`, details: null })
            });
          } catch (err) {
            if (err?.code === "CONTRACT_NOT_EDITABLE") return sendError(res, 409, "contract is not editable");
            return sendError(res, 400, "failed to upsert contract draft", { message: err?.message });
          }
          return sendJson(res, 201, { contract: record });
        }

        if (parts[1] === "contracts-v2" && parts[2] && parts.length === 3 && req.method === "GET") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const contractId = String(parts[2]);
          if (typeof store.getContractV2 !== "function" || typeof store.getLatestContractV2 !== "function") {
            return sendError(res, 501, "contracts v2 not supported for this store");
          }
          const vRaw = url.searchParams.get("v") ?? url.searchParams.get("contractVersion");
          const v = vRaw === null ? null : Number(vRaw);
          const record =
            v === null || v === undefined
              ? await store.getLatestContractV2({ tenantId, contractId })
              : await store.getContractV2({ tenantId, contractId, contractVersion: v });
          if (!record) return sendError(res, 404, "contract not found");
          return sendJson(res, 200, { contract: record });
        }

        if (parts[1] === "contracts-v2" && parts[2] && parts[3] === "publish" && parts.length === 4 && req.method === "POST") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.publishContractV2 !== "function" || typeof store.getContractV2 !== "function") {
            return sendError(res, 501, "contracts v2 not supported for this store");
          }
          const contractId = String(parts[2]);
          const body = (await readJsonBody(req)) ?? {};
          const contractVersion = body?.contractVersion !== undefined ? Number(body.contractVersion) : 1;
          const existing = await store.getContractV2({ tenantId, contractId, contractVersion });
          if (!existing) return sendError(res, 404, "contract not found");
          const doc = existing.doc ?? null;
          if (!doc || typeof doc !== "object") return sendError(res, 500, "contract doc missing");
          const contractHash = hashContractDocumentV1(doc);
          let record;
          try {
            record = await store.publishContractV2({
              tenantId,
              contractId,
              contractVersion,
              contractHash,
              audit: makeOpsAudit({ action: "CONTRACT_PUBLISH", targetType: "contract", targetId: `${contractId}@${contractVersion}`, details: { contractHash } })
            });
          } catch (err) {
            if (err?.code === "CONTRACT_HASH_MISMATCH") return sendError(res, 409, "contract hash mismatch", null, { code: "CONTRACT_HASH_MISMATCH" });
            if (err?.code === "CONTRACT_NOT_PUBLISHABLE") return sendError(res, 409, "contract not publishable");
            return sendError(res, 400, "failed to publish contract", { message: err?.message });
          }
          return sendJson(res, 200, { contract: record });
        }

        if (parts[1] === "contracts-v2" && parts[2] && parts[3] === "sign" && parts.length === 4 && req.method === "POST") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.getSignerKey !== "function" || typeof store.putContractSignatureV2 !== "function" || typeof store.getContractV2 !== "function") {
            return sendError(res, 501, "contracts v2 not supported for this store");
          }
          const contractId = String(parts[2]);
          const body = (await readJsonBody(req)) ?? {};
          const contractVersion = body?.contractVersion !== undefined ? Number(body.contractVersion) : 1;
          const partyRole = body?.partyRole ? String(body.partyRole) : null;
          const signerKeyId = body?.signerKeyId ? String(body.signerKeyId) : null;
          const signature = body?.signature ? String(body.signature) : null;
          if (!partyRole) return sendError(res, 400, "partyRole is required");
          if (!signerKeyId) return sendError(res, 400, "signerKeyId is required");
          if (!signature) return sendError(res, 400, "signature is required");
          const contract = await store.getContractV2({ tenantId, contractId, contractVersion });
          if (!contract) return sendError(res, 404, "contract not found");
          const contractHash = contract.contractHash ?? hashContractDocumentV1(contract.doc);
          const signerKey = await store.getSignerKey({ tenantId, keyId: signerKeyId });
          if (!signerKey) return sendError(res, 404, "signer key not found");
          if (String(signerKey.status ?? "") !== "active") return sendError(res, 409, "signer key is not active", null, { code: "SIGNER_REVOKED" });
          const ok = verifyHashHexEd25519({ hashHex: contractHash, signatureBase64: signature, publicKeyPem: signerKey.publicKeyPem });
          if (!ok) return sendError(res, 400, "invalid signature", null, { code: "SIG_INVALID" });
          await store.putContractSignatureV2({
            tenantId,
            contractHash,
            partyRole,
            signerKeyId,
            signature,
            audit: makeOpsAudit({
              action: "CONTRACT_SIGN",
              targetType: "contract",
              targetId: `${contractId}@${contractVersion}`,
              details: { contractHash, partyRole, signerKeyId }
            })
          });
          return sendJson(res, 200, { ok: true });
        }

        if (parts[1] === "contracts-v2" && parts[2] && parts[3] === "activate" && parts.length === 4 && req.method === "POST") {
          metricInc("ops_contracts_v2_requests_total");
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (
            typeof store.getContractV2 !== "function" ||
            typeof store.activateContractV2 !== "function" ||
            typeof store.listContractSignaturesV2 !== "function"
          ) {
            return sendError(res, 501, "contracts v2 not supported for this store");
          }
          const contractId = String(parts[2]);
          const body = (await readJsonBody(req)) ?? {};
          const contractVersion = body?.contractVersion !== undefined ? Number(body.contractVersion) : 1;
          const contract = await store.getContractV2({ tenantId, contractId, contractVersion });
          if (!contract) return sendError(res, 404, "contract not found");
          const doc = contract.doc ?? null;
          if (!doc || typeof doc !== "object") return sendError(res, 500, "contract doc missing");
          const contractHash = contract.contractHash ?? hashContractDocumentV1(doc);

          const sigs = await store.listContractSignaturesV2({ tenantId, contractHash });
          const signedRoles = new Set((sigs ?? []).map((s) => String(s.partyRole ?? "")));

          const requiredRoles = [];
          if (doc.parties && typeof doc.parties === "object") {
            for (const [role, party] of Object.entries(doc.parties)) {
              if (party?.requiresSignature === true) requiredRoles.push(String(role));
            }
          } else {
            requiredRoles.push("platform");
          }
          for (const role of requiredRoles) {
            if (!signedRoles.has(role)) return sendError(res, 409, "missing required signature", { partyRole: role }, { code: "SIGNATURE_REQUIRED" });
          }

          const compiled = compileContractPolicyTemplate({ contractDoc: doc });
          let updated;
          try {
            updated = await store.activateContractV2({
              tenantId,
              contractId,
              contractVersion,
              policyHash: compiled.policyHash,
              compilerId: compiled.compilerId,
              audit: makeOpsAudit({
                action: "CONTRACT_ACTIVATE",
                targetType: "contract",
                targetId: `${contractId}@${contractVersion}`,
                details: { contractHash, policyHash: compiled.policyHash, compilerId: compiled.compilerId }
              })
            });
          } catch (err) {
            if (err?.code === "CONTRACT_NOT_ACTIVATABLE") return sendError(res, 409, "contract not activatable");
            return sendError(res, 400, "failed to activate contract", { message: err?.message });
          }
          return sendJson(res, 200, { contract: updated, contractHash, policyHash: compiled.policyHash, compilerId: compiled.compilerId });
        }

        if (parts[1] === "parties" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listParties !== "function") return sendError(res, 501, "parties not supported for this store");
          const role = url.searchParams.get("role");
          const status = url.searchParams.get("status");
          const parties = await store.listParties({ tenantId, role: role ?? null, status: status ?? null, limit: 200, offset: 0 });
          return sendJson(res, 200, { parties });
        }

        if (parts[1] === "parties" && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.upsertParty !== "function") return sendError(res, 501, "parties not supported for this store");
          const body = (await readJsonBody(req)) ?? {};
          const partyId = body?.partyId ? String(body.partyId) : createId("pty");
          const partyRole = body?.partyRole ? String(body.partyRole) : null;
          const displayName = body?.displayName ? String(body.displayName) : partyId;
          const status = body?.status ? String(body.status) : "active";
          if (!partyRole) return sendError(res, 400, "partyRole is required");
          const record = await store.upsertParty({
            tenantId,
            party: { partyId, partyRole, displayName, status },
            audit: makeOpsAudit({
              action: "PARTY_UPSERT",
              targetType: "party",
              targetId: partyId,
              details: { partyId, partyRole, status }
            })
          });
          return sendJson(res, 201, { party: record });
        }

        if (parts[1] === "parties" && parts[2] && parts.length === 3 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.getParty !== "function") return sendError(res, 501, "parties not supported for this store");
          const partyId = String(parts[2]);
          const party = await store.getParty({ tenantId, partyId });
          if (!party) return sendError(res, 404, "party not found");
          return sendJson(res, 200, { party });
        }

	        if (parts[1] === "parties" && parts[2] && parts.length === 3 && req.method === "PATCH") {
	          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
	          if (typeof store.upsertParty !== "function" || typeof store.getParty !== "function") return sendError(res, 501, "parties not supported for this store");
	          const partyId = String(parts[2]);
	          const existing = await store.getParty({ tenantId, partyId });
	          if (!existing) return sendError(res, 404, "party not found");
          const body = (await readJsonBody(req)) ?? {};
          const next = {
            partyId,
            partyRole: body?.partyRole ? String(body.partyRole) : existing.partyRole,
            displayName: body?.displayName ? String(body.displayName) : existing.displayName,
            status: body?.status ? String(body.status) : existing.status
          };
          const record = await store.upsertParty({
            tenantId,
            party: next,
            audit: makeOpsAudit({
              action: "PARTY_UPDATE",
              targetType: "party",
              targetId: partyId,
              details: { partyId, status: next.status }
            })
          });
	          return sendJson(res, 200, { party: record });
	        }

	        if (parts[1] === "party-statements" && parts.length === 2 && req.method === "GET") {
	          if (!(requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE))) {
	            return sendError(res, 403, "forbidden");
	          }
	          if (typeof store.listPartyStatements !== "function") return sendError(res, 501, "party statements not supported for this store");
	          const period = url.searchParams.get("period");
	          if (!period) return sendError(res, 400, "period is required");
	          const status = url.searchParams.get("status");
	          const partyId = url.searchParams.get("partyId");
	          const statements = await store.listPartyStatements({
	            tenantId,
	            period,
	            partyId: partyId ?? null,
	            status: status ?? null,
	            limit: 500,
	            offset: 0
	          });
	          return sendJson(res, 200, { statements });
	        }

	        if (parts[1] === "party-statements" && parts.length === 4 && req.method === "GET") {
	          if (!(requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE))) {
	            return sendError(res, 403, "forbidden");
	          }
	          if (typeof store.getPartyStatement !== "function") return sendError(res, 501, "party statements not supported for this store");
	          const partyId = String(parts[2]);
	          const period = String(parts[3]);
	          const record = await store.getPartyStatement({ tenantId, partyId, period });
	          if (!record) return sendError(res, 404, "party statement not found");
	          let artifact = null;
	          if (typeof store.getArtifact === "function") {
	            try {
	              artifact = await store.getArtifact({ tenantId, artifactId: record.artifactId });
	            } catch {
	              artifact = null;
	            }
	          }
	          return sendJson(res, 200, { statement: record, artifact });
	        }

	        if (parts[1] === "payouts" && parts.length === 5 && parts[4] === "enqueue" && req.method === "POST") {
	          if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
	          if (typeof store.getPartyStatement !== "function" || typeof store.getArtifact !== "function") {
	            return sendError(res, 501, "payouts not supported for this store");
	          }
	          const partyId = String(parts[2]);
	          const period = String(parts[3]);
	          const record = await store.getPartyStatement({ tenantId, partyId, period });
	          if (!record) return sendError(res, 404, "party statement not found");

	          const monthId = makeMonthCloseStreamId({ month: period, basis: MONTH_CLOSE_BASIS.SETTLED_AT });
	          let monthEvents = getMonthEvents(tenantId, monthId);
	          if (!monthEvents.length && typeof store.listAggregateEvents === "function") {
	            try {
	              monthEvents = await store.listAggregateEvents({ tenantId, aggregateType: "month", aggregateId: monthId });
	            } catch {
	              monthEvents = [];
	            }
	          }
	          if (!monthEvents.length) return sendError(res, 409, "month close not found");
	          const monthClose = reduceMonthClose(monthEvents);
	          if (!monthClose || monthClose.status !== "CLOSED") return sendError(res, 409, "month is not closed");

	          const partyArtifact = await store.getArtifact({ tenantId, artifactId: record.artifactId });
	          const partyStatementBody = partyArtifact?.statement ?? null;
	          const partyRole = partyArtifact?.partyRole ?? null;
	          if (!partyStatementBody || typeof partyStatementBody !== "object") return sendError(res, 409, "party statement artifact missing statement body");
	          if (typeof partyRole !== "string" || !partyRole.trim()) return sendError(res, 409, "party statement artifact missing partyRole");

	          const payoutAmountCents = computePayoutAmountCentsForStatement({ partyRole, statement: partyStatementBody });
	          if (!Number.isSafeInteger(payoutAmountCents) || payoutAmountCents <= 0) {
	            return sendJson(res, 200, { ok: true, enqueued: false, reason: "no_payout_due" });
	          }

	          const statementHash = record.artifactHash;
	          const payoutKey = payoutKeyFor({ tenantId, partyId, period, statementHash });
	          const payoutArtifactId = `payout_${tenantId}_${partyId}_${period}_${statementHash}`;
	          const generatedAt = monthClose.requestedAt ?? record.closedAt ?? nowIso();
	          const payoutBody = buildPayoutInstructionV1({
	            tenantId,
	            partyId,
	            partyRole,
	            period,
	            statementHash,
	            payoutKey,
	            currency: "USD",
	            amountCents: payoutAmountCents,
	            destinationRef: null,
	            events: monthEvents,
	            artifactId: payoutArtifactId,
	            generatedAt
	          });
	          const payoutCore = { ...payoutBody, sourceEventId: monthClose.lastEventId ?? null, atChainHash: monthClose.lastChainHash ?? null };
	          const payoutHash = computeArtifactHash(payoutCore);
	          const payoutArtifact = { ...payoutCore, artifactHash: payoutHash };
	          await store.putArtifact({ tenantId, artifact: payoutArtifact });

	          const destinations = listDestinationsForTenant(tenantId).filter((d) => {
	            const allowed = Array.isArray(d.artifactTypes) && d.artifactTypes.length ? d.artifactTypes : null;
	            return !allowed || allowed.includes(ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1);
	          });
	          for (const dest of destinations) {
	            const dedupeKey = `${tenantId}:${dest.destinationId}:${ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1}:${payoutKey}:${payoutArtifact.artifactHash}`;
	            const scopeKey = `payout:${partyId}:period:${period}`;
	            const orderSeq = 0;
	            const priority = 95;
	            const orderKey = `${scopeKey}\n${String(orderSeq)}\n${String(priority)}\n${payoutArtifact.artifactId}`;
	            try {
	              await store.createDelivery({
	                tenantId,
	                delivery: {
	                  destinationId: dest.destinationId,
	                  artifactType: ARTIFACT_TYPE.PAYOUT_INSTRUCTION_V1,
	                  artifactId: payoutArtifact.artifactId,
	                  artifactHash: payoutArtifact.artifactHash,
	                  dedupeKey,
	                  scopeKey,
	                  orderSeq,
	                  priority,
	                  orderKey
	                }
	              });
	            } catch {
	              // best-effort
	            }
	          }

	          return sendJson(res, 201, { ok: true, payout: { payoutKey, artifactId: payoutArtifact.artifactId, artifactHash: payoutArtifact.artifactHash } });
	        }

          // Finance Pack v1: tenant-scoped account map + GLBatch CSV export.
          if (parts[1] === "finance" && parts[2] === "account-map" && parts.length === 3 && req.method === "GET") {
            if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
            if (typeof store.getFinanceAccountMap !== "function") return sendError(res, 501, "finance account map not supported for this store");
            const mapping = await store.getFinanceAccountMap({ tenantId });
            return sendJson(res, 200, { mapping });
          }

          if (parts[1] === "finance" && parts[2] === "account-map" && parts.length === 3 && req.method === "PUT") {
            if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
            if (typeof store.putFinanceAccountMap !== "function") return sendError(res, 501, "finance account map not supported for this store");
            const body = (await readJsonBody(req)) ?? {};
            const mapping = body?.mapping ?? body;
            try {
              validateFinanceAccountMapV1(mapping);
            } catch (err) {
              return sendError(res, 400, "invalid finance account map", { message: err?.message }, { code: "INVALID_FINANCE_ACCOUNT_MAP" });
            }
            const result = await store.putFinanceAccountMap({
              tenantId,
              mapping,
              audit: makeOpsAudit({
                action: "FINANCE_ACCOUNT_MAP_UPSERT",
                targetType: "finance_account_map",
                targetId: "default",
                details: { schemaVersion: mapping?.schemaVersion ?? null }
              })
            });
            return sendJson(res, 200, { ok: true, mappingHash: result?.mappingHash ?? null });
          }

          if (parts[1] === "finance" && parts[2] === "gl-batch" && parts.length === 3 && req.method === "GET") {
            if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
            if (typeof store.listArtifacts !== "function") return sendError(res, 501, "artifacts not supported for this store");
            const period = url.searchParams.get("period") ?? url.searchParams.get("month");
            if (!period) return sendError(res, 400, "period is required");
            const artifacts = await store.listArtifacts({ tenantId });
            const candidates = artifacts.filter((a) => a?.artifactType === ARTIFACT_TYPE.GL_BATCH_V1 && String(a?.period ?? "") === String(period));
            if (!candidates.length) return sendError(res, 404, "GL batch not found");
            candidates.sort((a, b) => String(a?.generatedAt ?? "").localeCompare(String(b?.generatedAt ?? "")));
            const artifact = candidates[candidates.length - 1];
            return sendJson(res, 200, { artifact });
          }

          if (parts[1] === "finance" && parts[2] === "gl-batch.csv" && parts.length === 3 && req.method === "GET") {
            if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
            if (typeof store.listArtifacts !== "function" || typeof store.getFinanceAccountMap !== "function") {
              return sendError(res, 501, "finance export not supported for this store");
            }
            const period = url.searchParams.get("period") ?? url.searchParams.get("month");
            if (!period) return sendError(res, 400, "period is required");

            const artifacts = await store.listArtifacts({ tenantId });
            const candidates = artifacts.filter((a) => a?.artifactType === ARTIFACT_TYPE.GL_BATCH_V1 && String(a?.period ?? "") === String(period));
            if (!candidates.length) return sendError(res, 404, "GL batch not found");
            candidates.sort((a, b) => String(a?.generatedAt ?? "").localeCompare(String(b?.generatedAt ?? "")));
            const glBatch = candidates[candidates.length - 1];

            const accountMap = await store.getFinanceAccountMap({ tenantId });
            if (!accountMap) return sendError(res, 409, "finance account map not configured", null, { code: "FINANCE_ACCOUNT_MAP_REQUIRED" });

            let csv;
            try {
              ({ csv } = renderJournalCsvV1({ glBatchArtifact: glBatch, accountMap }));
            } catch (err) {
              const code = typeof err?.code === "string" && err.code.trim() ? err.code : "FINANCE_EXPORT_FAILED";
              return sendError(res, 409, "failed to render journal CSV", { message: err?.message }, { code });
            }

            res.setHeader("content-type", "text/csv; charset=utf-8");
            return res.end(csv);
          }

	        if (parts[1] === "status" && parts.length === 2 && req.method === "GET") {
	          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");

	          const backlog = await computeOpsBacklogSummary({ tenantId, includeOutbox: true });
	          const retentionInfo = await fetchMaintenanceRetentionRunInfo({ tenantId });
          const lastRetention = retentionInfo?.last ?? null;
          const snapshot = (() => {
            try {
              return metrics.snapshot();
            } catch {
              return null;
            }
          })();
          const topAppendRejectReasons = parseTopReasonCodesFromMetrics({ metricPrefix: "append_rejected_total", snapshot, topN: 10 });
          const topIngestRejectReasons = parseTopReasonCodesFromMetrics({ metricPrefix: "ingest_rejected_total", snapshot, topN: 10 });

          return sendJson(res, 200, {
            ok: true,
            tenantId,
            process: {
              startedAt: apiStartedAtIso,
              uptimeSeconds: Math.floor((Date.now() - apiStartedAtMs) / 1000)
            },
            backlog,
            maintenance: {
              retentionCleanup: lastRetention
                ? {
                    at: lastRetention.at ?? null,
                    outcome: lastRetention?.details?.outcome ?? null,
                    dryRun: lastRetention?.details?.dryRun ?? null,
                    runtimeMs: lastRetention?.details?.runtimeMs ?? null,
                    purged: lastRetention?.details?.purged ?? null,
                    code: lastRetention?.details?.code ?? null,
                    requestId: lastRetention.requestId ?? null,
                    auditId: lastRetention.id ?? null
                  }
                : null
            },
            reasons: {
              topAppendRejected: topAppendRejectReasons,
              topIngestRejected: topIngestRejectReasons
            }
          });
        }

        if (parts[1] === "maintenance" && parts[2] === "retention" && parts[3] === "run" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.appendOpsAudit !== "function") return sendError(res, 501, "ops audit not supported for this store");

          const body = (await readJsonBody(req)) ?? {};
          const bodyDryRun = typeof body?.dryRun === "boolean" ? body.dryRun : null;
          const dryRun = bodyDryRun === null ? retentionCleanupDefaultDryRun : bodyDryRun;

          const batchRaw = body?.batchSize ?? body?.maxRows ?? null;
          const maxRows = batchRaw === null ? retentionCleanupDefaultBatchSize : Number(batchRaw);
          if (!Number.isSafeInteger(maxRows) || maxRows <= 0) return sendError(res, 400, "invalid batchSize", null, { code: "SCHEMA_INVALID" });

          const maxMillisRaw = body?.maxMillis ?? null;
          const maxMillis = maxMillisRaw === null ? retentionCleanupDefaultMaxMillis : Number(maxMillisRaw);
          if (!Number.isSafeInteger(maxMillis) || maxMillis <= 0) return sendError(res, 400, "invalid maxMillis", null, { code: "SCHEMA_INVALID" });

          let result;
          let outcome = "ok";
          try {
            result = await tickRetentionCleanup({ tenantId, maxRows, maxMillis, dryRun, requireLock: true });
            if (!result?.ok && result?.code === "MAINTENANCE_ALREADY_RUNNING") outcome = "already_running";
          } catch (err) {
            outcome = "error";
            result = { ok: false, scope: "tenant", tenantId, dryRun: Boolean(dryRun), maxRows, maxMillis, runtimeMs: null };
            try {
              await store.appendOpsAudit({
                tenantId,
                audit: makeOpsAudit({
                  action: "MAINTENANCE_RETENTION_RUN",
                  targetType: "maintenance",
                  targetId: "retention",
                  details: {
                    path: "/ops/maintenance/retention/run",
                    outcome,
                    dryRun: Boolean(dryRun),
                    maxRows,
                    maxMillis,
                    error: err?.message ?? String(err)
                  }
                })
              });
            } catch {}
            return sendError(res, 500, "maintenance run failed", { message: err?.message });
          }

          try {
            await store.appendOpsAudit({
              tenantId,
              audit: makeOpsAudit({
                action: "MAINTENANCE_RETENTION_RUN",
                targetType: "maintenance",
                targetId: "retention",
                details: {
                  path: "/ops/maintenance/retention/run",
                  outcome,
                  scope: result?.scope ?? "tenant",
                  dryRun: Boolean(result?.dryRun),
                  maxRows: Number(result?.maxRows ?? maxRows),
                  maxMillis: Number(result?.maxMillis ?? maxMillis),
                  runtimeMs: result?.runtimeMs ?? null,
                  timedOut: result?.timedOut === true,
                  purged: result?.purged ?? null,
                  code: result?.code ?? null
                }
              })
            });
          } catch (err) {
            return sendError(res, 500, "failed to write audit record", { message: err?.message }, { code: "AUDIT_LOG_FAILED" });
          }

          if (!result?.ok && result?.code === "MAINTENANCE_ALREADY_RUNNING") {
            return sendError(res, 409, "maintenance already running", null, { code: "MAINTENANCE_ALREADY_RUNNING" });
          }

          return sendJson(res, 200, {
            ok: true,
            dryRun: Boolean(result?.dryRun),
            runtimeMs: result?.runtimeMs ?? null,
            timedOut: result?.timedOut === true,
            purged: result?.purged ?? { ingest_records: 0, deliveries: 0, delivery_receipts: 0 }
          });
        }

        const opsSubresource = parts[1] ?? null;
        const isAuthKeyResource = opsSubresource === "auth-keys" || opsSubresource === "api-keys";

        if (opsSubresource === "audit" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listOpsAudit !== "function") return sendError(res, 501, "ops audit not supported for this store");
          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;
          let records;
          try {
            records = await store.listOpsAudit({ tenantId, limit, offset });
          } catch (err) {
            return sendError(res, 400, "invalid audit query", { message: err?.message });
          }
          return sendJson(res, 200, { audit: records });
        }

        if (isAuthKeyResource && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listAuthKeys !== "function") return sendError(res, 501, "auth keys not supported for this store");
          const keys = await store.listAuthKeys({ tenantId });
          const redacted = keys.map((k) => ({
            tenantId: normalizeTenantId(k?.tenantId ?? tenantId),
            keyId: k?.keyId ?? null,
            status: k?.status ?? null,
            scopes: Array.isArray(k?.scopes) ? k.scopes : [],
            description: k?.description ?? null,
            expiresAt: k?.expiresAt ?? null,
            createdAt: k?.createdAt ?? null,
            updatedAt: k?.updatedAt ?? null,
            lastUsedAt: k?.lastUsedAt ?? null,
            rotatedAt: k?.rotatedAt ?? null,
            revokedAt: k?.revokedAt ?? null
          }));
          return sendJson(res, 200, opsSubresource === "api-keys" ? { apiKeys: redacted } : { authKeys: redacted });
        }

        if (isAuthKeyResource && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.putAuthKey !== "function") return sendError(res, 501, "auth keys not supported for this store");
          const body = await readJsonBody(req);

          const requestedScopes = normalizeScopes(body?.scopes ?? []);
          if (requestedScopes.length === 0) return sendError(res, 400, "scopes[] is required");
          for (const s of requestedScopes) {
            if (!ALL_OPS_SCOPES.has(s)) return sendError(res, 400, "unknown scope", { scope: s });
          }

          const keyId = body?.keyId ? String(body.keyId) : authKeyId();
          if (keyId.includes(".") || keyId.includes(" ") || keyId.includes("\n") || keyId.includes("\r")) return sendError(res, 400, "invalid keyId");
          const secret = authKeySecret();
          const secretHash = hashAuthKeySecret(secret);
          const expiresAt = body?.expiresAt ?? null;
          const description = body?.description ?? null;
          const at = nowIso();

          await store.putAuthKey({
            tenantId,
            authKey: {
              keyId,
              secretHash,
              scopes: requestedScopes,
              status: "active",
              expiresAt,
              description,
              createdAt: at
            },
            audit: makeOpsAudit({
              action: "API_KEY_CREATE",
              targetType: "auth_key",
              targetId: keyId,
              details: { scopes: requestedScopes, expiresAt, description }
            })
          });

          return sendJson(res, 201, { tenantId, keyId, secret, scopes: requestedScopes, expiresAt, description });
        }

        if (isAuthKeyResource && parts[2] && parts[3] === "revoke" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.setAuthKeyStatus !== "function") return sendError(res, 501, "auth keys not supported for this store");
          const keyId = String(parts[2]);
          const updated = await store.setAuthKeyStatus({
            tenantId,
            keyId,
            status: normalizeAuthKeyStatus("revoked"),
            at: nowIso(),
            audit: makeOpsAudit({ action: "API_KEY_REVOKE", targetType: "auth_key", targetId: keyId, details: null })
          });
          if (!updated) return sendError(res, 404, "auth key not found");
          return sendJson(res, 200, { authKey: { ...updated, secretHash: undefined } });
        }

        if (isAuthKeyResource && parts[2] && parts[3] === "rotate" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.rotateAuthKey !== "function") {
            return sendError(res, 501, "auth keys not supported for this store");
          }
          const oldKeyId = String(parts[2]);
          const rotatedAt = nowIso();
          const newKeyId = authKeyId();
          if (newKeyId.includes(".") || newKeyId.includes(" ") || newKeyId.includes("\n") || newKeyId.includes("\r")) return sendError(res, 500, "invalid authKeyId()");
          const secret = authKeySecret();
          const secretHash = hashAuthKeySecret(secret);
          try {
            const rotated = await store.rotateAuthKey({
              tenantId,
              oldKeyId,
              newAuthKey: { keyId: newKeyId, secretHash },
              rotatedAt,
              audit: makeOpsAudit({
                action: "API_KEY_ROTATE",
                targetType: "auth_key",
                targetId: oldKeyId,
                details: { oldKeyId, newKeyId }
              })
            });
            if (!rotated) return sendError(res, 404, "auth key not found");
            if (!rotated.newKey) return sendError(res, 500, "failed to create rotated key");
            return sendJson(res, 201, {
              tenantId,
              rotatedAt: rotated.rotatedAt ?? rotatedAt,
              oldKeyId,
              newKeyId,
              secret,
              scopes: Array.isArray(rotated.newKey.scopes) ? rotated.newKey.scopes : []
            });
          } catch (err) {
            if (err?.code === "AUTH_KEY_REVOKED") return sendError(res, 409, "auth key is revoked");
            return sendError(res, 400, "auth key rotation failed", { message: err?.message });
          }
        }

        if (parts[1] === "signer-keys" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listSignerKeys !== "function") return sendError(res, 501, "signer keys not supported for this store");
          const keys = await store.listSignerKeys({ tenantId });
          return sendJson(res, 200, { signerKeys: keys });
        }

        if (parts[1] === "signer-keys" && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.putSignerKey !== "function") return sendError(res, 501, "signer keys not supported for this store");
          const body = await readJsonBody(req);
          const publicKeyPem = body?.publicKeyPem ? String(body.publicKeyPem) : null;
          if (!publicKeyPem) return sendError(res, 400, "publicKeyPem is required");
          const derivedKeyId = keyIdFromPublicKeyPem(publicKeyPem);
          if (body?.keyId && String(body.keyId) !== derivedKeyId) return sendError(res, 400, "keyId does not match publicKeyPem");

          const purpose = body?.purpose ? normalizeSignerKeyPurpose(body.purpose) : SIGNER_KEY_PURPOSE.ROBOT;
          const status = body?.status ? normalizeSignerKeyStatus(body.status) : SIGNER_KEY_STATUS.ACTIVE;
          const nowAt = nowIso();

          const record = await store.putSignerKey({
            tenantId,
            signerKey: {
              keyId: derivedKeyId,
              publicKeyPem,
              purpose,
              status,
              description: body?.description ?? null,
              validFrom: body?.validFrom ?? null,
              validTo: body?.validTo ?? null,
              createdAt: nowAt
            },
            audit: makeOpsAudit({
              action: "SIGNER_KEY_REGISTER",
              targetType: "signer_key",
              targetId: derivedKeyId,
              details: { purpose, status, description: body?.description ?? null, validFrom: body?.validFrom ?? null, validTo: body?.validTo ?? null }
            })
          });
          return sendJson(res, 201, { signerKey: record });
        }

        if (parts[1] === "signer-keys" && parts[2] && parts[3] === "revoke" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.setSignerKeyStatus !== "function") return sendError(res, 501, "signer keys not supported for this store");
          const keyId = String(parts[2]);
          const updated = await store.setSignerKeyStatus({
            tenantId,
            keyId,
            status: SIGNER_KEY_STATUS.REVOKED,
            at: nowIso(),
            audit: makeOpsAudit({ action: "SIGNER_KEY_REVOKE", targetType: "signer_key", targetId: keyId, details: null })
          });
          if (!updated) return sendError(res, 404, "signer key not found");
          return sendJson(res, 200, { signerKey: updated });
        }

        if (parts[1] === "signer-keys" && parts[2] && parts[3] === "rotate" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          if (typeof store.setSignerKeyStatus !== "function") return sendError(res, 501, "signer keys not supported for this store");
          const keyId = String(parts[2]);
          const updated = await store.setSignerKeyStatus({
            tenantId,
            keyId,
            status: SIGNER_KEY_STATUS.ROTATED,
            at: nowIso(),
            audit: makeOpsAudit({ action: "SIGNER_KEY_ROTATE", targetType: "signer_key", targetId: keyId, details: null })
          });
          if (!updated) return sendError(res, 404, "signer key not found");
          return sendJson(res, 200, { signerKey: updated });
        }

        if (parts[1] === "jobs" && parts.length === 2 && req.method === "GET") {
          if (!(requireScope(auth.scopes, OPS_SCOPES.OPS_READ) || requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ))) {
            return sendError(res, 403, "forbidden");
          }
          const status = url.searchParams.get("status");
          const zoneRaw = url.searchParams.get("zoneId");
          const zoneId = zoneRaw ? normalizeZoneId(zoneRaw) : null;
          const environmentTier = url.searchParams.get("environmentTier");
          const templateId = url.searchParams.get("templateId");

          let jobs = listJobs({ tenantId });
          if (status) jobs = jobs.filter((j) => j?.status === status);
          if (zoneId) {
            jobs = jobs.filter((j) => normalizeZoneId(j?.booking?.zoneId ?? j?.constraints?.zoneId) === zoneId);
          }
          if (environmentTier) jobs = jobs.filter((j) => j?.booking?.environmentTier === environmentTier);
          if (templateId) jobs = jobs.filter((j) => j?.templateId === templateId);

          jobs.sort((a, b) => {
            const at = Date.parse(a?.updatedAt ?? a?.createdAt ?? 0);
            const bt = Date.parse(b?.updatedAt ?? b?.createdAt ?? 0);
            if (Number.isFinite(bt) && Number.isFinite(at) && bt !== at) return bt - at;
            return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
          });

          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;
          const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(1000, limit) : 200;
          const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;

          const page = jobs.slice(safeOffset, safeOffset + safeLimit);
          return sendJson(res, 200, { jobs: page, total: jobs.length, offset: safeOffset, limit: safeLimit });
        }

        if (parts[1] === "robots" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const zoneRaw = url.searchParams.get("zoneId");
          const zoneId = zoneRaw ? normalizeZoneId(zoneRaw) : null;
          const status = url.searchParams.get("status");
          const quarantinedOnly = url.searchParams.get("quarantined") === "1";

          let robots = listRobots({ tenantId });
          if (zoneId) robots = robots.filter((r) => normalizeZoneId(r?.currentZoneId ?? r?.homeZoneId) === zoneId);
          if (status) robots = robots.filter((r) => r?.status === status);
          if (quarantinedOnly) robots = robots.filter((r) => r?.status === "quarantined");

          robots.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
          return sendJson(res, 200, { robots });
        }

        if (parts[1] === "operators" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const zoneRaw = url.searchParams.get("zoneId");
          const zoneId = zoneRaw ? normalizeZoneId(zoneRaw) : null;
          const shiftStatus = url.searchParams.get("shiftStatus");

          let operators = listOperators({ tenantId });
          if (zoneId) operators = operators.filter((o) => normalizeZoneId(o?.shift?.zoneId) === zoneId);
          if (shiftStatus) operators = operators.filter((o) => o?.shift?.status === shiftStatus);

          operators.sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
          return sendJson(res, 200, { operators });
        }

        if (parts[1] === "operator-queue" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const items = [];
          for (const job of listJobs({ tenantId })) {
            const status = job.assist?.status ?? "none";
            if (status !== "requested" && status !== "queued" && status !== "assigned" && status !== "accepted" && status !== "timeout") continue;
            items.push({
              jobId: job.id,
              jobStatus: job.status,
              zoneId: normalizeZoneId(job.booking?.zoneId ?? job.constraints?.zoneId),
              assist: job.assist
            });
          }
          items.sort((a, b) => String(a.jobId).localeCompare(String(b.jobId)));
          return sendJson(res, 200, { queue: items });
        }

        if (parts[1] === "notifications" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listNotifications !== "function") return sendError(res, 501, "notifications not supported for this store");

          const topic = url.searchParams.get("topic");
          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;

          let notifications;
          try {
            notifications = await store.listNotifications({ tenantId, topic, limit, offset });
          } catch (err) {
            return sendError(res, 400, "invalid notifications query", { message: err?.message });
          }

          return sendJson(res, 200, { notifications });
        }

        if (parts[1] === "deliveries" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listDeliveries !== "function") return sendError(res, 501, "deliveries not supported for this store");

          const state = url.searchParams.get("state");
          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;

          let deliveries;
          try {
            deliveries = await store.listDeliveries({ tenantId, state: state ?? null, limit, offset });
          } catch (err) {
            return sendError(res, 400, "invalid deliveries query", { message: err?.message });
          }

          return sendJson(res, 200, { deliveries });
        }

        if (parts[1] === "deliveries" && parts[2] && parts[3] === "requeue" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const idRaw = parts[2];
          if (!idRaw) return sendError(res, 400, "delivery id is required");

          if (store.kind === "pg") {
            const id = Number(idRaw);
            if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 400, "invalid delivery id");
            if (typeof store.requeueDelivery !== "function") return sendError(res, 501, "requeue not supported");
            await store.requeueDelivery({
              tenantId,
              id,
              audit: makeOpsAudit({ action: "DELIVERY_REQUEUE", targetType: "delivery", targetId: String(id), details: null })
            });
            return sendJson(res, 200, { ok: true });
          }

          if (typeof store.requeueDelivery !== "function") return sendError(res, 501, "requeue not supported");
          const updated = await store.requeueDelivery({ tenantId, deliveryId: idRaw });
          if (!updated) return sendError(res, 404, "delivery not found");
          try {
            if (typeof store.appendOpsAudit === "function") {
              await store.appendOpsAudit({
                tenantId,
                audit: makeOpsAudit({ action: "DELIVERY_REQUEUE", targetType: "delivery", targetId: idRaw, details: null })
              });
            }
          } catch {}
          return sendJson(res, 200, { delivery: updated });
        }

        if (parts[1] === "dlq" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          const type = url.searchParams.get("type") ?? null;
          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;

          const out = {};
          if (!type || type === "delivery") {
            if (typeof store.listDeliveries !== "function") return sendError(res, 501, "deliveries not supported for this store");
            const deliveries = await store.listDeliveries({ tenantId, state: "failed", limit, offset });
            out.deliveries = deliveries;
          }
          if (!type || type === "ingest") {
            if (typeof store.listIngestRecords !== "function") return sendError(res, 501, "ingest records not supported for this store");
            const ingest = await store.listIngestRecords({ tenantId, status: "rejected", limit, offset });
            out.ingest = ingest;
          }

          return sendJson(res, 200, out);
        }

        if (parts[1] === "dlq" && parts[2] === "deliveries" && parts[3] && parts[4] === "requeue" && parts.length === 5 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const idRaw = parts[3];
          if (!idRaw) return sendError(res, 400, "delivery id is required");
          // Alias to /ops/deliveries/:id/requeue.
          if (store.kind === "pg") {
            const id = Number(idRaw);
            if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 400, "invalid delivery id");
            if (typeof store.requeueDelivery !== "function") return sendError(res, 501, "requeue not supported");
            await store.requeueDelivery({
              tenantId,
              id,
              audit: makeOpsAudit({ action: "DELIVERY_REQUEUE", targetType: "delivery", targetId: String(id), details: { alias: true } })
            });
            return sendJson(res, 200, { ok: true });
          }
          if (typeof store.requeueDelivery !== "function") return sendError(res, 501, "requeue not supported");
          const updated = await store.requeueDelivery({ tenantId, deliveryId: idRaw });
          if (!updated) return sendError(res, 404, "delivery not found");
          try {
            if (typeof store.appendOpsAudit === "function") {
              await store.appendOpsAudit({
                tenantId,
                audit: makeOpsAudit({ action: "DELIVERY_REQUEUE", targetType: "delivery", targetId: idRaw, details: { alias: true } })
              });
            }
          } catch {}
          return sendJson(res, 200, { delivery: updated });
        }

        if (parts[1] === "correlations" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          if (typeof store.listCorrelations !== "function") return sendError(res, 501, "correlations listing not supported for this store");
          const siteId = url.searchParams.get("siteId");
          const jobId = url.searchParams.get("jobId");
          const limitRaw = url.searchParams.get("limit");
          const offsetRaw = url.searchParams.get("offset");
          const limit = limitRaw ? Number(limitRaw) : 200;
          const offset = offsetRaw ? Number(offsetRaw) : 0;
          let correlations;
          try {
            correlations = await store.listCorrelations({ tenantId, siteId: siteId ?? null, jobId: jobId ?? null, limit, offset });
          } catch (err) {
            return sendError(res, 400, "invalid correlations query", { message: err?.message });
          }
          return sendJson(res, 200, { correlations });
        }

        if (parts[1] === "correlations" && parts[2] === "link" && parts.length === 3 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);
          const jobId = body?.jobId ? String(body.jobId) : null;
          const siteId = body?.siteId ? String(body.siteId) : null;
          const correlationKey = body?.correlationKey ? String(body.correlationKey) : null;
          const expiresAt = body?.expiresAt ?? null;
          const forceRelink = body?.forceRelink === true;
          if (!jobId || !siteId || !correlationKey) return sendError(res, 400, "jobId, siteId, and correlationKey are required");

          const existing = getJobEvents(tenantId, jobId);
          if (!existing.length) return sendError(res, 404, "job not found");
          const jobBefore = reduceJob(existing);
          if (!jobBefore) return sendError(res, 404, "job not found");

          let previousJobId = null;
          if (typeof store.lookupCorrelation === "function") {
            const current = await store.lookupCorrelation({ tenantId, siteId, correlationKey });
            if (current?.jobId && String(current.jobId) !== String(jobId)) {
              if (!forceRelink) return sendError(res, 409, "correlation key already linked", { existingJobId: current.jobId });
              previousJobId = String(current.jobId);
            }
          }

          const linkedAt = nowIso();
          const payload = { jobId, siteId, correlationKey, linkedAt, expiresAt, previousJobId: previousJobId ?? null, forceRelink };
          const draft = createChainedEvent({
            streamId: jobId,
            type: previousJobId ? "CORRELATION_RELINKED" : "CORRELATION_LINKED",
            at: linkedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          try {
            reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job update rejected", { message: err?.message });
          }

          await commitTx([{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }]);

          // Update correlation index synchronously so ingest can use it immediately.
          try {
            if (typeof store.upsertCorrelation === "function") {
              await store.upsertCorrelation({ tenantId, siteId, correlationKey, jobId, expiresAt, force: forceRelink });
            }
          } catch (err) {
            return sendError(res, 409, "correlation apply failed", { message: err?.message, existingJobId: err?.existingJobId });
          }

          return sendJson(res, 201, { event });
        }

        if (parts[1] === "month-close" && parts.length === 2 && req.method === "GET") {
          if (!(requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE))) {
            return sendError(res, 403, "forbidden");
          }
          const month = url.searchParams.get("month");
          if (!month) return sendError(res, 400, "month is required");
          const basis = url.searchParams.get("basis") ?? MONTH_CLOSE_BASIS.SETTLED_AT;
          let monthId;
          try {
            monthId = makeMonthCloseStreamId({ month, basis });
          } catch (err) {
            return sendError(res, 400, "invalid month close query", { message: err?.message });
          }

          const events = getMonthEvents(tenantId, monthId);
          if (!events.length) return sendError(res, 404, "month close not found");
          const monthClose = reduceMonthClose(events);
          if (!monthClose) return sendError(res, 404, "month close not found");

          let statementArtifact = null;
          if (monthClose.status === "CLOSED" && monthClose.statementArtifactId && typeof store.getArtifact === "function") {
            try {
              statementArtifact = await store.getArtifact({ tenantId, artifactId: monthClose.statementArtifactId });
            } catch {
              statementArtifact = null;
            }
          }

          return sendJson(res, 200, { monthClose, statementArtifact });
        }

        if (parts[1] === "month-close" && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const month = body?.month ? String(body.month) : null;
          const basis = body?.basis ? String(body.basis) : MONTH_CLOSE_BASIS.SETTLED_AT;
          if (!month) return sendError(res, 400, "month is required");
          let monthId;
          try {
            monthId = makeMonthCloseStreamId({ month, basis });
          } catch (err) {
            return sendError(res, 400, "invalid month close request", { message: err?.message });
          }

          const existing = getMonthEvents(tenantId, monthId);
          const monthBefore = existing.length ? reduceMonthClose(existing) : null;
          if (monthBefore?.status === "CLOSED") {
            const responseBody = { monthClose: monthBefore };
            if (idemStoreKey) {
              await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } }]);
            }
            return sendJson(res, 200, responseBody);
          }

          const pending = existing.length ? getPendingMonthCloseRequestEvent(existing) : null;
          if (pending) {
            // Ensure a worker sees the request even if the previous outbox message was lost.
            await commitTx([
              {
                kind: "OUTBOX_ENQUEUE",
                messages: [{ type: "MONTH_CLOSE_REQUESTED", tenantId, month, basis, monthId, sourceEventId: pending.id, at: pending.at ?? null }]
              }
            ]);
            const responseBody = { event: pending };
            if (idemStoreKey) {
              await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 202, body: responseBody } }]);
            }
            return sendJson(res, 202, responseBody);
          }

          const requestedAt = nowIso();
          const requestedPayload = { tenantId, month, basis, requestedAt };
          try {
            validateMonthCloseRequestedPayload(requestedPayload);
          } catch (err) {
            return sendError(res, 400, "invalid month close request", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: monthId,
            type: "MONTH_CLOSE_REQUESTED",
            at: requestedAt,
            actor: { type: "ops", id: principalId },
            payload: requestedPayload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          const outboxMessages = [
            { type: "MONTH_CLOSE_REQUESTED", tenantId, month, basis, monthId, sourceEventId: event.id, at: requestedAt }
          ];

          const ops = [
            { kind: "MONTH_EVENTS_APPENDED", tenantId, monthId, events: [event] },
            { kind: "OUTBOX_ENQUEUE", messages: outboxMessages }
          ];
          if (idemStoreKey) {
            ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 202, body: { event } } });
          }

          await commitTx(ops);
          return sendJson(res, 202, { event });
        }

        if (parts[1] === "month-close" && parts[2] === "reopen" && parts.length === 3 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);
          const month = body?.month ? String(body.month) : null;
          const basis = body?.basis ? String(body.basis) : MONTH_CLOSE_BASIS.SETTLED_AT;
          const reason = body?.reason ?? null;
          if (!month) return sendError(res, 400, "month is required");
          let monthId;
          try {
            monthId = makeMonthCloseStreamId({ month, basis });
          } catch (err) {
            return sendError(res, 400, "invalid month close reopen request", { message: err?.message });
          }

          const existing = getMonthEvents(tenantId, monthId);
          if (!existing.length) return sendError(res, 404, "month close not found");
          const monthBefore = reduceMonthClose(existing);
          if (!monthBefore) return sendError(res, 404, "month close not found");
          if (monthBefore.status !== "CLOSED") return sendError(res, 409, "month is not closed");

          const reopenedAt = nowIso();
          const payload = { tenantId, month, basis, reopenedAt, reason };
          try {
            validateMonthCloseReopenedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid month close reopen request", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: monthId,
            type: "MONTH_CLOSE_REOPENED",
            at: reopenedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          await commitTx([{ kind: "MONTH_EVENTS_APPENDED", tenantId, monthId, events: [event] }]);
          return sendJson(res, 201, { event });
        }

        if (parts[1] === "governance" && parts[2] === "events" && parts.length === 3 && req.method === "GET") {
          const scope = url.searchParams.get("scope") ?? "tenant";
          if (scope === "global") {
            const ok =
              requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_GLOBAL_READ) ||
              requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_GLOBAL_WRITE) ||
              requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ) ||
              requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE);
            if (!ok) return sendError(res, 403, "forbidden");
          } else {
            const ok =
              requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_TENANT_READ) ||
              requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_TENANT_WRITE) ||
              requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ) ||
              requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
            if (!ok) return sendError(res, 403, "forbidden");
          }
          const targetTenantId = scope === "global" ? DEFAULT_TENANT_ID : tenantId;
          const events = getMonthEvents(targetTenantId, GOVERNANCE_STREAM_ID);
          return sendJson(res, 200, { tenantId: targetTenantId, streamId: GOVERNANCE_STREAM_ID, events });
        }

        if (parts[1] === "governance" && parts[2] === "events" && parts.length === 3 && req.method === "POST") {
          const body = await readJsonBody(req);
          const type = body?.type ? String(body.type) : null;
          if (!type) return sendError(res, 400, "type is required");
          const scope = body?.scope ? String(body.scope) : "tenant";
          if (scope === "global") {
            const ok = requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_GLOBAL_WRITE) || requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE);
            if (!ok) return sendError(res, 403, "forbidden");
          } else {
            const ok = requireScope(auth.scopes, OPS_SCOPES.GOVERNANCE_TENANT_WRITE) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
            if (!ok) return sendError(res, 403, "forbidden");
          }
          const targetTenantId = scope === "global" ? DEFAULT_TENANT_ID : tenantId;
          const nowAt = nowIso();

          // Scope guards:
          // - Server signer key lifecycle is global governance only.
          // - Tenant policy updates are tenant governance only.
          if (type.startsWith("SERVER_SIGNER_KEY_") && scope !== "global") {
            return sendError(res, 400, "invalid governance scope", null, { code: "GOVERNANCE_SCOPE_REQUIRED_GLOBAL" });
          }
          if (type === "TENANT_POLICY_UPDATED" && scope !== "tenant") {
            return sendError(res, 400, "invalid governance scope", null, { code: "GOVERNANCE_SCOPE_REQUIRED_TENANT" });
          }

          // Governance events must be written with an optimistic concurrency precondition to avoid forked streams.
          const existingForPrecondition = getMonthEvents(targetTenantId, GOVERNANCE_STREAM_ID);
          const currentPrevChainHash = getCurrentPrevChainHash(existingForPrecondition);
          const expectedHeader = parseExpectedPrevChainHashHeader(req);
          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          // Governance writes must be idempotent.
          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({
              method: "POST",
              requestPath: path,
              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
              body
            }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (!idemStoreKey) return sendError(res, 400, "x-idempotency-key is required");
          {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          let payload;
          try {
            if (type === "TENANT_POLICY_UPDATED") {
              payload = validateTenantPolicyUpdatedPayload({
                tenantId: targetTenantId,
                policyId: createId("pol"),
                effectiveFrom: body?.payload?.effectiveFrom ? String(body.payload.effectiveFrom) : nowAt,
                updatedAt: nowAt,
                policy: body?.payload?.policy ?? {},
                reason: body?.payload?.reason ?? null
              });
            } else if (type === "SERVER_SIGNER_KEY_REGISTERED") {
              payload = validateServerSignerKeyRegisteredPayload({
                tenantId: targetTenantId,
                keyId: body?.payload?.keyId ? String(body.payload.keyId) : "",
                publicKeyPem: body?.payload?.publicKeyPem ? String(body.payload.publicKeyPem) : "",
                registeredAt: body?.payload?.registeredAt ? String(body.payload.registeredAt) : nowAt,
                reason: body?.payload?.reason ?? null
              });
            } else if (type === "SERVER_SIGNER_KEY_ROTATED") {
              payload = validateServerSignerKeyRotatedPayload({
                tenantId: targetTenantId,
                oldKeyId: body?.payload?.oldKeyId ? String(body.payload.oldKeyId) : "",
                newKeyId: body?.payload?.newKeyId ? String(body.payload.newKeyId) : "",
                newPublicKeyPem: body?.payload?.newPublicKeyPem ? String(body.payload.newPublicKeyPem) : "",
                rotatedAt: body?.payload?.rotatedAt ? String(body.payload.rotatedAt) : nowAt,
                reason: body?.payload?.reason ?? null
              });
            } else if (type === "SERVER_SIGNER_KEY_REVOKED") {
              payload = validateServerSignerKeyRevokedPayload({
                tenantId: targetTenantId,
                keyId: body?.payload?.keyId ? String(body.payload.keyId) : "",
                revokedAt: body?.payload?.revokedAt ? String(body.payload.revokedAt) : nowAt,
                reason: body?.payload?.reason ?? null
              });
            } else {
              return sendError(res, 400, "unsupported governance event type", null, { code: "UNSUPPORTED_EVENT_TYPE" });
            }
          } catch (err) {
            return sendError(res, 400, "invalid governance payload", { message: err?.message });
          }

          const existing = existingForPrecondition;

          // Governance semantic uniqueness:
          // For policy updates, enforce 1 update per effectiveFrom per scope.
          if (type === "TENANT_POLICY_UPDATED") {
            const effectiveFrom = typeof payload?.effectiveFrom === "string" && payload.effectiveFrom.trim() ? String(payload.effectiveFrom) : null;
            if (effectiveFrom) {
              const prior = existing.find((e) => e?.type === "TENANT_POLICY_UPDATED" && String(e?.payload?.effectiveFrom ?? "") === effectiveFrom) ?? null;
              if (prior) {
                const priorPolicy = prior?.payload?.policy ?? null;
                const nextPolicy = payload?.policy ?? null;
                const samePolicy = canonicalJsonStringify(priorPolicy ?? {}) === canonicalJsonStringify(nextPolicy ?? {});
                if (!samePolicy) {
                  return sendError(res, 409, "governance effectiveFrom conflict", { existingEventId: prior.id ?? null }, { code: "GOVERNANCE_EFFECTIVE_FROM_CONFLICT" });
                }
                const responseBody = { event: prior, alreadyExists: true };
                await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } }]);
                return sendJson(res, 200, responseBody);
              }
            }
          }

          if (type === "SERVER_SIGNER_KEY_REGISTERED") {
            const keyId = typeof payload?.keyId === "string" ? String(payload.keyId) : null;
            if (keyId) {
              const prior =
                existing.find((e) => e?.type === "SERVER_SIGNER_KEY_REGISTERED" && String(e?.payload?.keyId ?? "") === keyId) ??
                existing.find((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.newKeyId ?? "") === keyId) ??
                null;
              if (prior) {
                const priorPem = prior?.payload?.publicKeyPem ?? prior?.payload?.newPublicKeyPem ?? null;
                const nextPem = payload?.publicKeyPem ?? null;
                const same = typeof priorPem === "string" && typeof nextPem === "string" && priorPem === nextPem;
                if (!same) {
                  return sendError(res, 409, "server signer key already exists", { existingEventId: prior.id ?? null, keyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                }
                const responseBody = { event: prior, alreadyExists: true };
                await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } }]);
                return sendJson(res, 200, responseBody);
              }
            }
          }

          if (type === "SERVER_SIGNER_KEY_ROTATED") {
            const oldKeyId = typeof payload?.oldKeyId === "string" ? String(payload.oldKeyId) : null;
            const newKeyId = typeof payload?.newKeyId === "string" ? String(payload.newKeyId) : null;
            if (oldKeyId) {
              const prior = existing.find((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.oldKeyId ?? "") === oldKeyId) ?? null;
              if (prior) {
                const same =
                  String(prior?.payload?.newKeyId ?? "") === String(newKeyId ?? "") &&
                  String(prior?.payload?.rotatedAt ?? "") === String(payload?.rotatedAt ?? "") &&
                  String(prior?.payload?.newPublicKeyPem ?? "") === String(payload?.newPublicKeyPem ?? "");
                if (!same) {
                  return sendError(res, 409, "server signer key rotation conflict", { existingEventId: prior.id ?? null, oldKeyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                }
                const responseBody = { event: prior, alreadyExists: true };
                await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } }]);
                return sendJson(res, 200, responseBody);
              }
            }
          }

          if (type === "SERVER_SIGNER_KEY_REVOKED") {
            const keyId = typeof payload?.keyId === "string" ? String(payload.keyId) : null;
            if (keyId) {
              const prior = existing.find((e) => e?.type === "SERVER_SIGNER_KEY_REVOKED" && String(e?.payload?.keyId ?? "") === keyId) ?? null;
              if (prior) {
                const same = String(prior?.payload?.revokedAt ?? "") === String(payload?.revokedAt ?? "");
                if (!same) {
                  return sendError(res, 409, "server signer key revocation conflict", { existingEventId: prior.id ?? null, keyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                }
                const responseBody = { event: prior, alreadyExists: true };
                await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body: responseBody } }]);
                return sendJson(res, 200, responseBody);
              }
            }
          }

          const draft = createChainedEvent({
            streamId: GOVERNANCE_STREAM_ID,
            type,
            at: payload?.updatedAt ?? payload?.rotatedAt ?? payload?.revokedAt ?? payload?.registeredAt ?? nowAt,
            actor: { type: "finance", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId: targetTenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          const responseBody = { event };
          try {
            await commitTx([
              { kind: "MONTH_EVENTS_APPENDED", tenantId: targetTenantId, monthId: GOVERNANCE_STREAM_ID, events: [event] },
              { kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } }
            ]);
            return sendJson(res, 201, responseBody);
          } catch (err) {
            // If we lost a race (prevChainHash mismatch) or hit a DB uniqueness constraint, re-load the latest
            // governance stream and apply semantic uniqueness rules (idempotent success vs typed conflict).
            const code = err?.code ?? null;
            if (code === "PREV_CHAIN_HASH_MISMATCH" || code === "23505") {
              let latest = null;
              try {
                if (typeof store.listAggregateEvents === "function") {
                  latest = await store.listAggregateEvents({ tenantId: targetTenantId, aggregateType: "month", aggregateId: GOVERNANCE_STREAM_ID });
                } else {
                  latest = getMonthEvents(targetTenantId, GOVERNANCE_STREAM_ID);
                }
              } catch {
                latest = null;
              }
              const stream = Array.isArray(latest) ? latest : existing;

              const respondAlreadyExists = async (priorEvent) => {
                const body = { event: priorEvent, alreadyExists: true };
                await commitTx([{ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 200, body } }]);
                return sendJson(res, 200, body);
              };

              if (type === "TENANT_POLICY_UPDATED") {
                const effectiveFrom = typeof payload?.effectiveFrom === "string" && payload.effectiveFrom.trim() ? String(payload.effectiveFrom) : null;
                const prior = effectiveFrom
                  ? stream.find((e) => e?.type === "TENANT_POLICY_UPDATED" && String(e?.payload?.effectiveFrom ?? "") === effectiveFrom) ?? null
                  : null;
                if (prior) {
                  const priorPolicy = prior?.payload?.policy ?? null;
                  const nextPolicy = payload?.policy ?? null;
                  const samePolicy = canonicalJsonStringify(priorPolicy ?? {}) === canonicalJsonStringify(nextPolicy ?? {});
                  if (!samePolicy) {
                    return sendError(res, 409, "governance effectiveFrom conflict", { existingEventId: prior.id ?? null }, { code: "GOVERNANCE_EFFECTIVE_FROM_CONFLICT" });
                  }
                  return await respondAlreadyExists(prior);
                }
              }

              if (type === "SERVER_SIGNER_KEY_REGISTERED") {
                const keyId = typeof payload?.keyId === "string" ? String(payload.keyId) : null;
                const prior = keyId
                  ? stream.find((e) => e?.type === "SERVER_SIGNER_KEY_REGISTERED" && String(e?.payload?.keyId ?? "") === keyId) ??
                    stream.find((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.newKeyId ?? "") === keyId) ??
                    null
                  : null;
                if (prior) {
                  const priorPem = prior?.payload?.publicKeyPem ?? prior?.payload?.newPublicKeyPem ?? null;
                  const nextPem = payload?.publicKeyPem ?? null;
                  const same = typeof priorPem === "string" && typeof nextPem === "string" && priorPem === nextPem;
                  if (!same) {
                    return sendError(res, 409, "server signer key already exists", { existingEventId: prior.id ?? null, keyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                  }
                  return await respondAlreadyExists(prior);
                }
              }

              if (type === "SERVER_SIGNER_KEY_ROTATED") {
                const oldKeyId = typeof payload?.oldKeyId === "string" ? String(payload.oldKeyId) : null;
                const newKeyId = typeof payload?.newKeyId === "string" ? String(payload.newKeyId) : null;
                const prior = oldKeyId ? stream.find((e) => e?.type === "SERVER_SIGNER_KEY_ROTATED" && String(e?.payload?.oldKeyId ?? "") === oldKeyId) ?? null : null;
                if (prior) {
                  const same =
                    String(prior?.payload?.newKeyId ?? "") === String(newKeyId ?? "") &&
                    String(prior?.payload?.rotatedAt ?? "") === String(payload?.rotatedAt ?? "") &&
                    String(prior?.payload?.newPublicKeyPem ?? "") === String(payload?.newPublicKeyPem ?? "");
                  if (!same) {
                    return sendError(res, 409, "server signer key rotation conflict", { existingEventId: prior.id ?? null, oldKeyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                  }
                  return await respondAlreadyExists(prior);
                }
              }

              if (type === "SERVER_SIGNER_KEY_REVOKED") {
                const keyId = typeof payload?.keyId === "string" ? String(payload.keyId) : null;
                const prior = keyId ? stream.find((e) => e?.type === "SERVER_SIGNER_KEY_REVOKED" && String(e?.payload?.keyId ?? "") === keyId) ?? null : null;
                if (prior) {
                  const same = String(prior?.payload?.revokedAt ?? "") === String(payload?.revokedAt ?? "");
                  if (!same) {
                    return sendError(res, 409, "server signer key revocation conflict", { existingEventId: prior.id ?? null, keyId }, { code: "GOVERNANCE_KEY_CONFLICT" });
                  }
                  return await respondAlreadyExists(prior);
                }
              }

              // Fallback: preserve the original typed append conflict semantics.
              if (code === "PREV_CHAIN_HASH_MISMATCH") {
                return sendError(res, 409, "event append conflict", {
                  expectedPrevChainHash: err.expectedPrevChainHash ?? null,
                  gotPrevChainHash: err.gotPrevChainHash ?? null
                });
              }
            }

            throw err;
          }
        }

        if (parts[1] === "insurer-reimbursements" && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const insurerId = body?.insurerId ? String(body.insurerId) : null;
          const month = body?.month ? String(body.month) : null;
          const amountCents = body?.amountCents;
          const reference = body?.reference ?? null;
          const recordedAt = body?.recordedAt ? String(body.recordedAt) : nowIso();

          const reimbursementPayload = {
            tenantId,
            reimbursementId: createId("reimb"),
            insurerId,
            amountCents,
            currency: "USD",
            month,
            recordedAt,
            reference
          };
          try {
            validateInsurerReimbursementRecordedPayload(reimbursementPayload);
          } catch (err) {
            return sendError(res, 400, "invalid reimbursement", { message: err?.message });
          }

          const financeStreamId = FINANCE_STREAM_ID;
          const existing = getMonthEvents(tenantId, financeStreamId);

          const draft = createChainedEvent({
            streamId: financeStreamId,
            type: "INSURER_REIMBURSEMENT_RECORDED",
            at: reimbursementPayload.recordedAt,
            actor: { type: "finance", id: principalId },
            payload: reimbursementPayload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          let ledgerEntries = [];
          try {
            ledgerEntries = ledgerEntriesForFinanceEvent({ event });
          } catch (err) {
            return sendError(res, 400, "ledger posting rejected", { message: err?.message });
          }

          const outboxMessages = [];
          for (const entry of ledgerEntries) {
            if (!entry) continue;
            outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId: null, sourceEventId: event.id, entry });
          }

          const responseBody = { event, ledgerEntryIds: ledgerEntries.map((e) => e?.id).filter(Boolean) };

          const ops = [{ kind: "MONTH_EVENTS_APPENDED", tenantId, monthId: financeStreamId, events: [event] }];
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });
          if (idemStoreKey) {
            ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          }

          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (parts[1] === "receivables" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ)) return sendError(res, 403, "forbidden");
          const month = url.searchParams.get("month");

          let asOf = nowIso();
          if (month) {
            try {
              const period = parseYearMonth(month);
              asOf = period.endAt;
            } catch (err) {
              return sendError(res, 400, "invalid month", { message: err?.message });
            }
          }
          const asOfMs = Date.parse(asOf);

          const byInsurer = new Map();
          const add = (insurerId, field, cents) => {
            if (!insurerId) return;
            if (!Number.isSafeInteger(cents) || cents === 0) return;
            const row = byInsurer.get(insurerId) ?? { insurerId, creditsRecoverableCents: 0, reimbursementsCents: 0, balanceCents: 0 };
            row[field] += cents;
            byInsurer.set(insurerId, row);
          };

          for (const jobSnap of listJobs({ tenantId })) {
            if (!jobSnap?.id) continue;
            const coveragePolicy = jobSnap.booking?.policySnapshot?.coveragePolicy ?? null;
            if (coveragePolicy?.creditFundingModel !== CREDIT_FUNDING_MODEL.INSURER_RECOVERABLE) continue;
            const insurerId = typeof coveragePolicy?.insurerId === "string" && coveragePolicy.insurerId.trim() !== "" ? coveragePolicy.insurerId : null;
            if (!insurerId) continue;

            const pctRaw = coveragePolicy?.recoverablePercent ?? 100;
            const recoverablePercent = Number.isSafeInteger(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 100;

            const events = getJobEvents(tenantId, jobSnap.id);
            for (const e of events) {
              if (e?.type !== "SLA_CREDIT_ISSUED") continue;
              const t = Date.parse(e.at);
              if (Number.isFinite(asOfMs) && Number.isFinite(t) && t >= asOfMs) continue;
              const amountCents = e.payload?.amountCents ?? null;
              if (!Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
              const recoverableCents = Math.floor((amountCents * recoverablePercent) / 100);
              add(insurerId, "creditsRecoverableCents", recoverableCents);
            }
          }

          const financeEvents = getMonthEvents(tenantId, FINANCE_STREAM_ID);
          for (const e of financeEvents) {
            if (e?.type !== "INSURER_REIMBURSEMENT_RECORDED") continue;
            const t = Date.parse(e.at);
            if (Number.isFinite(asOfMs) && Number.isFinite(t) && t >= asOfMs) continue;
            const insurerId = typeof e.payload?.insurerId === "string" && e.payload.insurerId.trim() !== "" ? e.payload.insurerId : null;
            const amountCents = e.payload?.amountCents ?? null;
            if (!insurerId || !Number.isSafeInteger(amountCents) || amountCents <= 0) continue;
            add(insurerId, "reimbursementsCents", amountCents);
          }

          const receivables = Array.from(byInsurer.values())
            .map((r) => ({
              ...r,
              balanceCents: r.creditsRecoverableCents - r.reimbursementsCents
            }))
            .sort((a, b) => String(a.insurerId).localeCompare(String(b.insurerId)));

          const totalBalanceCents = receivables.reduce((sum, r) => sum + (Number.isSafeInteger(r.balanceCents) ? r.balanceCents : 0), 0);

          return sendJson(res, 200, { month: month ?? null, asOf, receivables, totalBalanceCents });
        }

	        if (parts[1] === "statements" && parts.length === 2 && req.method === "GET") {
          if (!(requireScope(auth.scopes, OPS_SCOPES.OPS_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
            return sendError(res, 403, "forbidden");
          }
          const customerId = url.searchParams.get("customerId");
          const siteId = url.searchParams.get("siteId");
          const month = url.searchParams.get("month");
          if (!month) return sendError(res, 400, "month is required");
          const format = url.searchParams.get("format") ?? "json";

          let statement;
          try {
            if ((customerId === null || customerId === "") && (siteId === null || siteId === "") && store.months instanceof Map && typeof store.getArtifact === "function") {
              const monthId = makeMonthCloseStreamId({ month, basis: MONTH_CLOSE_BASIS.SETTLED_AT });
              const snap = store.months.get(monthStoreKey(tenantId, monthId)) ?? null;
              if (snap?.status === "CLOSED" && snap.statementArtifactId) {
                const art = await store.getArtifact({ tenantId, artifactId: snap.statementArtifactId });
                if (art?.statement) statement = art.statement;
              }
            }
          } catch {
            statement = null;
          }
          if (!statement) try {
            let ledgerEntries = [];
            try {
              ledgerEntries = await listAllLedgerEntriesForTenant({ tenantId });
            } catch {
              ledgerEntries = [];
            }
            statement = computeMonthlyStatement({
              tenantId,
              customerId: customerId ?? null,
              siteId: siteId ?? null,
              month,
              jobs: listJobs({ tenantId }),
              getEventsForJob: (jobId) => getJobEvents(tenantId, jobId),
              ledgerEntries,
              nowIso
            });
          } catch (err) {
            return sendError(res, 400, "invalid statement query", { message: err?.message });
          }

          if (format === "csv") {
            const csv = statementToCsv(statement);
            res.statusCode = 200;
            res.setHeader("content-type", "text/csv; charset=utf-8");
            res.end(csv);
            return;
          }

          if (format && format !== "json") return sendError(res, 400, "unsupported format");
	          return sendJson(res, 200, { statement });
	        }

		        if (parts[1] === "holds" && parts.length === 2 && req.method === "GET") {
		          if (!(requireScope(auth.scopes, OPS_SCOPES.OPS_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
		            return sendError(res, 403, "forbidden");
		          }

		          const status = (url.searchParams.get("status") ?? "HELD").toUpperCase();
		          const minAgeSeconds = url.searchParams.get("minAgeSeconds");
		          const limitRaw = url.searchParams.get("limit");
		          const offsetRaw = url.searchParams.get("offset");
		          const customerId = url.searchParams.get("customerId");
		          const siteId = url.searchParams.get("siteId");
		          const robotId = url.searchParams.get("robotId");
		          const operatorId = url.searchParams.get("operatorId");
		          const reasonCode = url.searchParams.get("reasonCode");

		          const minAge = minAgeSeconds !== null && minAgeSeconds !== "" ? Number(minAgeSeconds) : null;
		          if (minAge !== null && (!Number.isFinite(minAge) || minAge < 0)) return sendError(res, 400, "minAgeSeconds must be a non-negative number");

		          const limit = limitRaw !== null && limitRaw !== "" ? Number(limitRaw) : 200;
		          const offset = offsetRaw !== null && offsetRaw !== "" ? Number(offsetRaw) : 0;
		          if (!Number.isSafeInteger(limit) || limit <= 0) return sendError(res, 400, "limit must be a positive integer");
		          if (!Number.isSafeInteger(offset) || offset < 0) return sendError(res, 400, "offset must be a non-negative integer");
		          const safeLimit = Math.min(1000, limit);

		          const nowAt = nowIso();
		          const nowMs = Date.parse(nowAt);

		          const holds = [];
		          for (const job of listJobs({ tenantId })) {
	            if (!job?.id) continue;
	            const hold = job.settlementHold ?? null;
	            if (!hold || typeof hold !== "object") continue;
		            const holdStatus = typeof hold.status === "string" ? hold.status.toUpperCase() : "NONE";
		            if (status && status !== "ALL" && holdStatus !== status) continue;
		            if (customerId !== null && customerId !== "" && String(job.booking?.customerId ?? job.customerId ?? "") !== String(customerId)) continue;
		            if (siteId !== null && siteId !== "" && String(job.booking?.siteId ?? job.siteId ?? "") !== String(siteId)) continue;
		            if (robotId !== null && robotId !== "" && String(job.reservation?.robotId ?? job.match?.robotId ?? "") !== String(robotId)) continue;
		            if (operatorId !== null && operatorId !== "" && String(job.operatorCoverage?.operatorId ?? "") !== String(operatorId)) continue;

			            const heldAt = hold.heldAt ?? null;
			            const heldAtMs = heldAt ? Date.parse(String(heldAt)) : NaN;
			            const ageSeconds = Number.isFinite(nowMs) && Number.isFinite(heldAtMs) ? Math.max(0, Math.floor((nowMs - heldAtMs) / 1000)) : null;
			            if (minAge !== null && ageSeconds !== null && ageSeconds < minAge) continue;

			            const eventsBefore = getJobEvents(tenantId, job.id);
			            const exposure = (() => {
			              try {
			                return computeHoldExposureV1({ job, eventsBefore });
			              } catch {
			                return null;
			              }
			            })();
			            const quoteEvent =
			              [...eventsBefore].reverse().find((e) => e?.type === "QUOTE_PROPOSED" && typeof e?.id === "string" && e.id.trim()) ?? null;
			            const expectedExposure = hold?.expectedExposure ?? exposure?.expected ?? null;
			            const heldExposure = hold?.heldExposure ?? exposure?.held ?? null;
			            const holdPolicy = hold?.holdPolicy ?? exposure?.holdPolicy ?? null;
			            const currency =
			              hold?.currency ??
			              expectedExposure?.currency ??
			              heldExposure?.currency ??
			              (typeof job.quote?.currency === "string" && job.quote.currency.trim() ? job.quote.currency : "USD");
			            const pricingAnchor =
			              hold?.pricingAnchor ??
			              ({
			                quoteEventId: quoteEvent?.id ?? null,
			                quoteEventChainHash: quoteEvent?.chainHash ?? null,
			                quoteEventPayloadHash: quoteEvent?.payloadHash ?? null,
			                customerPolicyHash: hold?.triggeringProofRef?.customerPolicyHash ?? job.customerPolicyHash ?? job.booking?.policyHash ?? null,
			                operatorPolicyHash: hold?.triggeringProofRef?.operatorPolicyHash ?? job.operatorPolicyHash ?? null,
			                evaluatedAtChainHash: hold?.evaluatedAtChainHash ?? null
			              });

			            const expectedAmountCents =
			              (Number.isSafeInteger(expectedExposure?.amountGrossCents) ? expectedExposure.amountGrossCents : null) ??
			              (Number.isSafeInteger(job.quote?.amountCents) ? job.quote.amountCents : 0);
			            const expectedCoverageFeeCents =
			              (Number.isSafeInteger(expectedExposure?.coverageFeeCents) ? expectedExposure.coverageFeeCents : null) ??
			              (Number.isSafeInteger(job.quote?.breakdown?.coverageFeeCents) && job.quote.breakdown.coverageFeeCents > 0 ? job.quote.breakdown.coverageFeeCents : 0);
			            const expectedServiceAmountCents =
			              (Number.isSafeInteger(expectedExposure?.amountNetCents) ? expectedExposure.amountNetCents : null) ??
			              (Number.isSafeInteger(expectedAmountCents) && Number.isSafeInteger(expectedCoverageFeeCents)
			                ? Math.max(0, expectedAmountCents - expectedCoverageFeeCents)
			                : 0);
			            const expectedTotalCents = expectedAmountCents;

		            const reasonCodes = Array.isArray(hold.reasonCodes) ? hold.reasonCodes : [];
		            if (reasonCode !== null && reasonCode !== "" && !reasonCodes.includes(String(reasonCode))) continue;

		            const missingEvidence = Array.isArray(hold.missingEvidence) ? hold.missingEvidence : [];
		            const releaseHint =
		              holdStatus === "HELD"
		                ? missingEvidence.length
		                  ? { kind: "MISSING_EVIDENCE", missingEvidence }
		                  : { kind: "REPROOF_REQUIRED" }
		                : null;

			            holds.push({
			              tenantId,
			              jobId: job.id,
		              holdId: hold.holdId ?? null,
		              status: holdStatus,
		              heldAt,
		              lastUpdatedAt: hold.lastUpdatedAt ?? null,
		              ageSeconds,
		              agingBucket:
		                ageSeconds === null
		                  ? null
		                  : ageSeconds < 7 * 24 * 60 * 60
		                    ? "0_7d"
		                    : ageSeconds < 30 * 24 * 60 * 60
		                      ? "8_30d"
		                      : ageSeconds < 90 * 24 * 60 * 60
		                        ? "31_90d"
		                        : "90d_plus",
		              evaluatedAtChainHash: hold.evaluatedAtChainHash ?? null,
		              factsHash: hold.factsHash ?? null,
		              releasedAt: hold.releasedAt ?? null,
		              releaseReason: hold.releaseReason ?? null,
		              forfeitedAt: hold.forfeitedAt ?? null,
		              forfeitureReason: hold.forfeitureReason ?? null,
		              decisionRef: hold.decisionRef ?? null,
		              decisionEventRef: hold.decisionEventRef ?? null,
					              reasonCodes,
					              missingEvidence,
					              releaseHint,
					              currency,
					              pricingAnchor,
					              triggeringProofRef: hold.triggeringProofRef ?? null,
					              releasingProofRef: hold.releasingProofRef ?? null,
					              expectedAmountCents,
				              expectedCoverageFeeCents,
				              expectedTotalCents,
				              expectedServiceAmountCents,
			              expectedSplits: expectedExposure?.splits ?? exposure?.expected?.splits ?? null,
			              expectedExposure: expectedExposure ?? null,
			              holdPolicy: holdPolicy ?? null,
			              heldExposure: heldExposure ?? null,
			              customerId: job.booking?.customerId ?? job.customerId ?? null,
			              siteId: job.booking?.siteId ?? job.siteId ?? null,
			              templateId: job.templateId ?? null,
			              robotId: job.reservation?.robotId ?? job.match?.robotId ?? null,
		              operatorId: job.operatorCoverage?.operatorId ?? null
		            });
		          }

		          holds.sort((a, b) => (Number(b.ageSeconds) || 0) - (Number(a.ageSeconds) || 0) || String(a.jobId).localeCompare(String(b.jobId)));

		          const page = holds.slice(offset, offset + safeLimit);
		          return sendJson(res, 200, { now: nowAt, holds: page, count: holds.length, limit: safeLimit, offset });
		        }

	        if (parts[1] === "settlements" && parts[2] === "export" && parts.length === 3 && req.method === "GET") {
          if (!(requireScope(auth.scopes, OPS_SCOPES.OPS_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
            return sendError(res, 403, "forbidden");
          }
          const month = url.searchParams.get("month");
          if (!month) return sendError(res, 400, "month is required");
          const customerId = url.searchParams.get("customerId");
          const siteId = url.searchParams.get("siteId");

          let statement;
          try {
            let ledgerEntries = [];
            try {
              ledgerEntries = await listAllLedgerEntriesForTenant({ tenantId });
            } catch {
              ledgerEntries = [];
            }
            statement = computeMonthlyStatement({
              tenantId,
              customerId: customerId ?? null,
              siteId: siteId ?? null,
              month,
              jobs: listJobs({ tenantId }),
              getEventsForJob: (jobId) => getJobEvents(tenantId, jobId),
              ledgerEntries,
              nowIso
            });
          } catch (err) {
            return sendError(res, 400, "invalid statement query", { message: err?.message });
          }

          const headers = [
            "jobId",
            "customerId",
            "siteId",
            "templateId",
            "zoneId",
            "environmentTier",
            "settledAt",
            "grossAmountCents",
            "slaCreditsCents",
            "claimsPaidCents",
            "operatorCostCents",
            "netDueCents",
            "workCertificateId",
            "settlementStatementId"
          ];
          const rows = [];
          rows.push(headers.join(","));
          for (const j of statement.jobs ?? []) {
            const netDueCents = (Number.isSafeInteger(j.amountCents) ? j.amountCents : 0) - (Number.isSafeInteger(j.slaCreditsCents) ? j.slaCreditsCents : 0);

            // Best-effort artifact refs (deterministic fallback).
            const artifacts = typeof store.listArtifacts === "function" ? await store.listArtifacts({ tenantId, jobId: j.jobId, limit: 50, offset: 0 }) : [];
            const latestByType = new Map();
            for (const a of artifacts) {
              const t = a?.artifactType ?? a?.schemaVersion ?? null;
              if (!t) continue;
              const prev = latestByType.get(t);
              const at = Date.parse(a?.generatedAt ?? a?.createdAt ?? 0);
              const bt = Date.parse(prev?.generatedAt ?? prev?.createdAt ?? 0);
              if (!prev || (Number.isFinite(at) && Number.isFinite(bt) && at > bt)) latestByType.set(t, a);
            }

            const workCertId =
              latestByType.get("WorkCertificate.v1")?.artifactId ?? "";
            const settlementId =
              latestByType.get("SettlementStatement.v1")?.artifactId ?? "";

            const line = [
              j.jobId ?? "",
              j.customerId ?? "",
              j.siteId ?? "",
              j.templateId ?? "",
              j.zoneId ?? "",
              j.environmentTier ?? "",
              j.settledAt ?? "",
              j.amountCents ?? 0,
              j.slaCreditsCents ?? 0,
              j.claimsPaidCents ?? 0,
              j.operatorCostCents ?? 0,
              netDueCents,
              workCertId,
              settlementId
            ]
              .map((v) => {
                const s = v === null || v === undefined ? "" : String(v);
                if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
                  return `"${s.replaceAll('"', '""')}"`;
                }
                return s;
              })
              .join(",");
            rows.push(line);
          }

          res.statusCode = 200;
          res.setHeader("content-type", "text/csv; charset=utf-8");
          res.end(rows.join("\n") + "\n");
          return;
        }

        if (parts[1] === "contracts" && parts.length === 2 && req.method === "GET") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
          metricInc("ops_contracts_v1_requests_total");
          const customerId = url.searchParams.get("customerId");
          const siteId = url.searchParams.get("siteId");
          const templateId = url.searchParams.get("templateId");

          let contracts = listContracts({ tenantId });
          if (customerId) contracts = contracts.filter((c) => String(c.customerId ?? "") === customerId);
          if (siteId) contracts = contracts.filter((c) => String(c.siteId ?? "") === siteId);
          if (templateId) contracts = contracts.filter((c) => String(c.templateId ?? "") === templateId);

          return sendJson(res, 200, { contracts });
        }

        if (parts[1] === "contracts" && parts.length === 2 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);
          const nowAt = nowIso();

          metricInc("ops_contracts_v1_requests_total");
          if (body?.type === CONTRACT_DOCUMENT_TYPE_V1 && body?.v !== undefined) {
            return sendError(res, 400, "contracts-as-code documents must be sent to /ops/contracts-v2", null, { code: "SCHEMA_INVALID" });
          }

          const contractId = body?.contractId ? String(body.contractId) : createId("contract");
          const key = makeScopedKey({ tenantId, id: contractId });
          const existing = store.contracts instanceof Map ? store.contracts.get(key) : null;
          const nextContractVersion = Number.isSafeInteger(existing?.contractVersion) && existing.contractVersion > 0 ? existing.contractVersion + 1 : 1;

          const mergedPolicies = {
            slaOverridesByEnvironmentTier: {
              ...(existing?.policies?.slaOverridesByEnvironmentTier ?? {}),
              ...(body?.policies?.slaOverridesByEnvironmentTier ?? {})
            },
	            proofPolicy: (() => {
	              const defaultProofPolicy = createDefaultContract({ tenantId, nowIso })?.policies?.proofPolicy ?? {
	                gateMode: "warn",
	                zoneCoverage: { thresholdPct: 95, allowExtraZones: false, excuseIncidentTypes: ["BLOCKED_ZONE"] },
	                insufficientEvidenceBehavior: { mode: "ALLOW", holdPercent: 0 },
	                disputeWindowDays: 0,
	                allowReproofAfterSettlementWithinDisputeWindow: false
	              };
	              const prev = existing?.policies?.proofPolicy ?? defaultProofPolicy;
	              const nextRaw = body?.policies?.proofPolicy ?? null;
	              const next = nextRaw && typeof nextRaw === "object" ? nextRaw : {};
              const prevZone = prev?.zoneCoverage && typeof prev.zoneCoverage === "object" ? prev.zoneCoverage : {};
              const nextZone = next?.zoneCoverage && typeof next.zoneCoverage === "object" ? next.zoneCoverage : {};
              const prevIeb =
                prev?.insufficientEvidenceBehavior && typeof prev.insufficientEvidenceBehavior === "object" ? prev.insufficientEvidenceBehavior : {};
              const nextIeb =
                next?.insufficientEvidenceBehavior && typeof next.insufficientEvidenceBehavior === "object" ? next.insufficientEvidenceBehavior : {};

	              return {
	                gateMode: next.gateMode ?? prev.gateMode ?? defaultProofPolicy.gateMode ?? "warn",
	                zoneCoverage: { ...prevZone, ...nextZone },
	                insufficientEvidenceBehavior: { ...prevIeb, ...nextIeb },
	                disputeWindowDays: next.disputeWindowDays ?? prev.disputeWindowDays ?? defaultProofPolicy.disputeWindowDays ?? 0,
	                allowReproofAfterSettlementWithinDisputeWindow:
	                  next.allowReproofAfterSettlementWithinDisputeWindow ??
	                  prev.allowReproofAfterSettlementWithinDisputeWindow ??
	                  defaultProofPolicy.allowReproofAfterSettlementWithinDisputeWindow ??
	                  false
	              };
	            })(),
            creditPolicy: {
              ...(existing?.policies?.creditPolicy ?? { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" }),
              ...(body?.policies?.creditPolicy ?? {})
            },
            evidencePolicy: { ...(existing?.policies?.evidencePolicy ?? { retentionDays: 0 }), ...(body?.policies?.evidencePolicy ?? {}) },
            claimPolicy: {
              ...(existing?.policies?.claimPolicy ?? { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 }),
              ...(body?.policies?.claimPolicy ?? {})
            },
            coveragePolicy: {
              ...(existing?.policies?.coveragePolicy ?? {
                required: false,
                coverageTierId: null,
                feeModel: COVERAGE_FEE_MODEL.PER_JOB,
                feeCentsPerJob: 0,
                creditFundingModel: CREDIT_FUNDING_MODEL.PLATFORM_EXPENSE,
                reserveFundPercent: 100,
                insurerId: null,
                recoverablePercent: 100,
                recoverableTerms: null,
                responseSlaSeconds: 0,
                includedAssistSeconds: 0,
                overageRateCentsPerMinute: 0
              }),
              ...(body?.policies?.coveragePolicy ?? {})
            }
          };

          const contract = {
            tenantId,
            contractId,
            contractVersion: nextContractVersion,
            name: body?.name ? String(body.name) : existing?.name ?? contractId,
            customerId: body?.customerId ?? existing?.customerId ?? null,
            siteId: body?.siteId ?? existing?.siteId ?? null,
            templateId: body?.templateId ?? existing?.templateId ?? null,
            isDefault: body?.isDefault ?? existing?.isDefault ?? false,
            policies: mergedPolicies,
            createdAt: existing?.createdAt ?? nowAt,
            updatedAt: nowAt
          };

          try {
            validateContract(contract);
          } catch (err) {
            return sendError(res, 400, "invalid contract", { message: err?.message });
          }

          const retentionDays = contract.policies?.evidencePolicy?.retentionDays ?? 0;
          const retentionMaxDays = Number(getTenantConfig(tenantId)?.evidenceRetentionMaxDays ?? 365);
          if (!Number.isSafeInteger(retentionMaxDays) || retentionMaxDays <= 0) {
            return sendError(res, 500, "invalid tenant evidence retention config");
          }
          if (retentionDays > 0 && retentionDays > retentionMaxDays) {
            return sendError(res, 400, "invalid contract", {
              message: `evidencePolicy.retentionDays must be <= ${retentionMaxDays} for this tenant (or 0 to retain forever)`
            });
          }

          const ops = [];

          if (contract.isDefault === true && store.contracts instanceof Map) {
            for (const c of listContracts({ tenantId })) {
              if (c?.isDefault !== true) continue;
              if (String(c.contractId) === contractId) continue;
              ops.push({
                kind: "CONTRACT_UPSERT",
                tenantId,
                contract: {
                  ...c,
                  contractVersion:
                    Number.isSafeInteger(c?.contractVersion) && c.contractVersion > 0 ? c.contractVersion + 1 : 1,
                  isDefault: false,
                  updatedAt: nowAt
                }
              });
            }
          }

          ops.push({ kind: "CONTRACT_UPSERT", tenantId, contract });
          await commitTx(ops);

          return sendJson(res, 201, { contract });
        }

        if (parts[1] === "jobs" && parts[2] && parts[3] === "timeline" && parts.length === 4 && req.method === "GET") {
          if (!(requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
            return sendError(res, 403, "forbidden");
          }
          const jobId = parts[2];
          const events = getJobEvents(tenantId, jobId);
          if (!events.length) return sendError(res, 404, "job not found");
          const job = reduceJob(events);
          if (!job) return sendError(res, 404, "job not found");

          const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
          let ledgerEntries = [];
          const memoPrefix = `job:${jobId} `;
          if (typeof store.listLedgerEntries === "function") {
            try {
              ledgerEntries = await store.listLedgerEntries({ tenantId, memoPrefix, limit: 5000, offset: 0 });
            } catch {
              ledgerEntries = [];
            }
          } else {
            ledgerEntries = (ledger?.entries ?? []).filter((e) => typeof e?.memo === "string" && e.memo.startsWith(memoPrefix));
          }
          return sendJson(res, 200, { job, events, ledgerEntries, ledgerBalances: Object.fromEntries(ledger?.balances ?? []) });
        }

        if (parts[1] === "robots" && parts[2] && parts[3] === "quarantine" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const robotId = parts[2];
          const body = await readJsonBody(req);

          const existing = getRobotEvents(tenantId, robotId);
          if (!existing.length) return sendError(res, 404, "robot not found");

          const robotBefore = reduceRobot(existing);
          if (!robotBefore) return sendError(res, 404, "robot not found");
          if (robotBefore.status === "quarantined") return sendError(res, 409, "robot already quarantined");

          const quarantinedAt = nowIso();
          const payload = {
            robotId,
            quarantinedAt,
            reason: body?.reason ?? "MANUAL",
            manualClearRequired: body?.manualClearRequired ?? true,
            incidentId: body?.incidentId ?? null,
            jobId: body?.jobId ?? null,
            notes: body?.notes ?? null,
            until: body?.until ?? null
          };
          try {
            validateRobotQuarantinedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: robotId,
            type: "ROBOT_QUARANTINED",
            at: quarantinedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          let robotAfter;
          try {
            robotAfter = reduceRobot(nextEvents);
          } catch (err) {
            return sendError(res, 400, "robot update rejected", { message: err?.message });
          }

          await commitTx([{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }]);
          return sendJson(res, 201, { event, robot: robotAfter });
        }

        if (parts[1] === "robots" && parts[2] && parts[3] === "quarantine" && parts[4] === "clear" && parts.length === 5 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const robotId = parts[2];
          const body = await readJsonBody(req);

          const existing = getRobotEvents(tenantId, robotId);
          if (!existing.length) return sendError(res, 404, "robot not found");

          const robotBefore = reduceRobot(existing);
          if (!robotBefore) return sendError(res, 404, "robot not found");
          if (robotBefore.status !== "quarantined") return sendError(res, 409, "robot is not quarantined");

          const clearedAt = nowIso();
          const payload = {
            robotId,
            clearedAt,
            reason: body?.reason ?? "MANUAL",
            notes: body?.notes ?? null,
            maintenanceId: body?.maintenanceId ?? null
          };
          try {
            validateRobotQuarantineClearedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: robotId,
            type: "ROBOT_QUARANTINE_CLEARED",
            at: clearedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            enforceSignaturePolicy({ tenantId, signerKind: requiredSignerKindForEventType(event.type), event });
          } catch (err) {
            return sendError(res, 400, "signature policy rejected", { message: err?.message });
          }

          let robotAfter;
          try {
            robotAfter = reduceRobot(nextEvents);
          } catch (err) {
            return sendError(res, 400, "robot update rejected", { message: err?.message });
          }

          await commitTx([{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }]);
          return sendJson(res, 201, { event, robot: robotAfter });
        }

        if (parts[1] === "jobs" && parts[2] && parts[3] === "redispatch" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const jobId = parts[2];
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const existing = getJobEvents(tenantId, jobId);
          if (!existing.length) return sendError(res, 404, "job not found");
          const jobBefore = reduceJob(existing);
          if (!jobBefore) return sendError(res, 404, "job not found");

          const allowed = new Set(["BOOKED", "MATCHED", "RESERVED"]);
          if (!allowed.has(jobBefore.status)) return sendError(res, 409, "job is not redispatchable");
          if (!jobBefore.booking) return sendError(res, 400, "job booking is required");

          const oldWindow = { startAt: jobBefore.booking.startAt, endAt: jobBefore.booking.endAt };
          const newWindow = { ...oldWindow };

          const rescheduledAt = nowIso();
          const reschedulePayload = {
            jobId,
            oldWindow,
            newWindow,
            reason: "OPS",
            requestedBy: principalId,
            requiresRequote: false
          };
          try {
            validateJobRescheduledPayload(reschedulePayload);
          } catch (err) {
            return sendError(res, 400, "invalid reschedule payload", { message: err?.message });
          }

          const rescheduleDraft = createChainedEvent({
            streamId: jobId,
            type: "JOB_RESCHEDULED",
            at: rescheduledAt,
            actor: { type: "ops", id: principalId },
            payload: reschedulePayload
          });
          let events = appendChainedEvent({ events: existing, event: rescheduleDraft, signer: serverSigner });
          const rescheduleEvent = events[events.length - 1];

          const dispatchAt = nowIso();
          const dispatchPayload = { jobId, requestedAt: dispatchAt, trigger: "OPS_REDISPATCH" };
          const dispatchDraft = createChainedEvent({
            streamId: jobId,
            type: "DISPATCH_REQUESTED",
            at: dispatchAt,
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: dispatchPayload
          });
          events = appendChainedEvent({ events, event: dispatchDraft, signer: serverSigner });
          const dispatchRequestedEvent = events[events.length - 1];

          try {
            validateDomainEvent({ jobBefore, event: rescheduleEvent, eventsBefore: existing });
            const jobAfterReschedule = reduceJob([...existing, rescheduleEvent]);
            validateDomainEvent({ jobBefore: jobAfterReschedule, event: dispatchRequestedEvent, eventsBefore: [...existing, rescheduleEvent] });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          const jobAfter = reduceJob(events);
          const outboxMessages = [{ type: "DISPATCH_REQUESTED", tenantId, jobId, sourceEventId: dispatchRequestedEvent.id, at: dispatchRequestedEvent.at }];
          if (jobBefore.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: jobBefore.status, toStatus: jobAfter.status, at: rescheduleEvent.at });
          }

          const responseBody = { events: [rescheduleEvent, dispatchRequestedEvent], job: jobAfter };
          const ops = [
            { kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [rescheduleEvent, dispatchRequestedEvent] },
            { kind: "OUTBOX_ENQUEUE", messages: outboxMessages }
          ];
          if (idemStoreKey) {
            ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          }
          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (parts[1] === "jobs" && parts[2] && parts[3] === "cancel" && parts.length === 4 && req.method === "POST") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const jobId = parts[2];
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const existing = getJobEvents(tenantId, jobId);
          if (!existing.length) return sendError(res, 404, "job not found");
          const jobBefore = reduceJob(existing);
          if (!jobBefore) return sendError(res, 404, "job not found");

          const cancelledAt = nowIso();
          const payload = {
            jobId,
            cancelledAt,
            reason: body?.reason ?? "OPS",
            requestedBy: principalId
          };
          try {
            validateJobCancelledPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: jobId,
            type: "JOB_CANCELLED",
            at: cancelledAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            validateDomainEvent({ jobBefore, event, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          const outboxMessages = [];
          if (jobBefore.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: jobBefore.status, toStatus: jobAfter.status, at: event.at });
          }

          const responseBody = { event, job: jobAfter };
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (parts[1] === "jobs" && parts[2] && parts[3] === "abort" && parts.length === 4 && req.method === "POST") {
          const jobId = parts[2];
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const existing = getJobEvents(tenantId, jobId);
          if (!existing.length) return sendError(res, 404, "job not found");
          const jobBefore = reduceJob(existing);
          if (!jobBefore) return sendError(res, 404, "job not found");

          const robotId = jobBefore.execution?.robotId ?? jobBefore.reservation?.robotId ?? jobBefore.match?.robotId ?? null;
          if (!robotId) return sendError(res, 409, "job has no robot to abort");

          const abortedAt = nowIso();
          const payload = {
            jobId,
            robotId,
            abortedAt,
            reason: body?.reason ?? "OPS_ABORT"
          };
          try {
            validateJobExecutionAbortedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: jobId,
            type: "JOB_EXECUTION_ABORTED",
            at: abortedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            validateDomainEvent({ jobBefore, event, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          const outboxMessages = [];
          if (jobBefore.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: jobBefore.status, toStatus: jobAfter.status, at: event.at });
          }

          const responseBody = { event, job: jobAfter };
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (parts[1] === "jobs" && parts[2] && parts[3] === "sla-credit" && parts.length === 4 && req.method === "POST") {
          const jobId = parts[2];
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const existing = getJobEvents(tenantId, jobId);
          if (!existing.length) return sendError(res, 404, "job not found");
          const jobBefore = reduceJob(existing);
          if (!jobBefore) return sendError(res, 404, "job not found");

          const settledEventId = (() => {
            for (let i = existing.length - 1; i >= 0; i -= 1) {
              const e = existing[i];
              if (e?.type === "SETTLED") return e.id ?? null;
            }
            return null;
          })();
          if (!settledEventId) return sendError(res, 409, "job is not settled");

          const policyHash = jobBefore.booking?.policyHash ?? null;

          const breachEvent = (() => {
            for (let i = existing.length - 1; i >= 0; i -= 1) {
              const e = existing[i];
              if (e?.type !== "SLA_BREACH_DETECTED") continue;
              if (e?.payload?.settledEventId !== settledEventId) continue;
              return e;
            }
            return null;
          })();

          let trigger = body?.trigger ?? null;
          if (trigger === null || trigger === undefined) {
            if (
              breachEvent &&
              breachEvent.id &&
              breachEvent.payload?.window?.startAt &&
              breachEvent.payload?.window?.endAt &&
              breachEvent.payload?.policy &&
              Array.isArray(breachEvent.payload?.breaches) &&
              breachEvent.payload.breaches.length
            ) {
              trigger = {
                type: SLA_CREDIT_TRIGGER_TYPE.SLA_BREACH,
                breachEventId: breachEvent.id,
                detectedAt: breachEvent.payload?.detectedAt ?? breachEvent.at,
                window: breachEvent.payload.window,
                policy: breachEvent.payload.policy,
                breaches: breachEvent.payload.breaches
              };
            }
          }

          const issuedAt = nowIso();
          const payload = {
            jobId,
            creditId: createId("cred"),
            issuedAt,
            amountCents: body?.amountCents,
            currency: "USD",
            reason: "SLA_BREACH",
            settledEventId,
            policyHash,
            trigger
          };
          try {
            validateSlaCreditIssuedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const draft = createChainedEvent({
            streamId: jobId,
            type: "SLA_CREDIT_ISSUED",
            at: issuedAt,
            actor: { type: "ops", id: principalId },
            payload
          });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          try {
            validateDomainEvent({ jobBefore, event, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          let ledgerEntries = [];
          try {
            ledgerEntries = ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "ledger posting rejected", { message: err?.message });
          }

          const outboxMessages = [];
          for (const entry of ledgerEntries) {
            if (!entry) continue;
            outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: event.id, entry });
          }

          const responseBody = {
            event,
            job: jobAfter,
            ledgerEntryId: ledgerEntries.length ? ledgerEntries[0]?.id ?? null : null,
            ledgerEntryIds: ledgerEntries.map((e) => e?.id).filter(Boolean)
          };
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        return sendError(res, 404, "not found");
      }

      if (path.startsWith("/pilot")) {
        if (!requireScope(auth.scopes, OPS_SCOPES.OPS_READ)) return sendError(res, 403, "forbidden");
        if (store.kind === "pg" && typeof store.refreshFromDb === "function") {
          await store.refreshFromDb();
          if (typeof store.ensureTenant === "function") store.ensureTenant(tenantId);
        }

        const parts = path.split("/").filter(Boolean);
        if (req.method === "GET" && parts.length === 2 && parts[0] === "pilot" && parts[1] === "templates") {
          return sendJson(res, 200, { templates: listPilotTemplates() });
        }

        if (req.method === "POST" && parts.length === 2 && parts[0] === "pilot" && parts[1] === "jobs") {
          if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
          const body = await readJsonBody(req);

          let idemStoreKey = null;
          let idemRequestHash = null;
          try {
            ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
          } catch (err) {
            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
          }
          if (idemStoreKey) {
            const existingIdem = store.idempotency.get(idemStoreKey);
            if (existingIdem) {
              if (existingIdem.requestHash !== idemRequestHash) {
                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
              }
              return sendJson(res, existingIdem.statusCode, existingIdem.body);
            }
          }

          const cfg = getTenantConfig(tenantId) ?? {};
          const requestedLimit = cfg?.quotas?.maxOpenJobs ?? 0;
          const limit = clampQuota({ tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0, defaultLimit: 0, maxLimit: quotaPlatformMaxOpenJobs });
          if (limit > 0) {
            const open = countOpenJobsForTenant(tenantId);
            if (isQuotaExceeded({ current: open, limit })) {
              return sendError(res, 429, "tenant quota exceeded", { kind: "open_jobs", limit, current: open }, { code: "TENANT_QUOTA_EXCEEDED" });
            }
          }

          const pilotTemplateId = body?.pilotTemplateId ?? "managed_common_area_reset_l1";
          const pilotTemplate = getPilotTemplate(pilotTemplateId);
          if (!pilotTemplate) return sendError(res, 400, "unknown pilotTemplateId");

          const startAt = body?.startAt;
          const startMs = Date.parse(startAt);
          if (!Number.isFinite(startMs)) return sendError(res, 400, "invalid startAt");
          const endAt = new Date(startMs + pilotTemplate.windowMinutes * 60_000).toISOString();

          const jobTemplateId = pilotTemplate.jobTemplateId;
          const environmentTier = pilotTemplate.environmentTier;
          const zoneId = normalizeZoneId(body?.zoneId ?? pilotTemplate.defaultZoneId);
          const requiresOperatorCoverage = pilotTemplate.requiresOperatorCoverage === true || environmentTier === ENV_TIER.ENV_IN_HOME;
          const window = { startAt, endAt };

          const activeOperators = listAvailableOperators({ tenantId, zoneId, window }).length;
          if (requiresOperatorCoverage && activeOperators <= 0) {
            return sendError(res, 409, "insufficient operator coverage");
          }

          const availableRobots = listAvailableRobots({ tenantId, zoneId, window }).length;
          if (availableRobots <= 0) return sendError(res, 409, "no available robots for window");

          const jobId = createId("job");
          const customerId = body?.customerId ?? null;
          const siteId = body?.siteId ?? null;
          const requestedContractId = body?.contractId ?? null;

          const contracts = listContracts({ tenantId });
          let contract = null;
          if (requestedContractId) {
            contract = contracts.find((c) => c?.contractId === requestedContractId) ?? null;
            if (!contract) return sendError(res, 400, "unknown contractId");
          } else {
            contract = selectBestContract(contracts, { customerId, siteId, templateId: jobTemplateId });
          }
          if (!contract) contract = createDefaultContract({ tenantId, nowIso });

          const constraints = {
            ...(body?.constraints ?? {}),
            zoneId,
            pilotTemplateId,
            allowedAccessMethods: pilotTemplate.allowedAccessMethods,
            skillBundle: pilotTemplate.skillBundle,
            environmentTier
          };

          const createdDraft = createChainedEvent({
            streamId: jobId,
            type: "JOB_CREATED",
            actor: { type: "system", id: "proxy" },
            payload: { tenantId, customerId, siteId, contractId: contract.contractId, templateId: jobTemplateId, constraints },
            at: nowIso()
          });
          let events = appendChainedEvent({ events: [], event: createdDraft, signer: serverSigner });

          const coveragePolicy = contract.policies?.coveragePolicy ?? null;
          const coverageRequired = coveragePolicy?.required === true;
          const coverageFeeModel = coveragePolicy?.feeModel ?? COVERAGE_FEE_MODEL.PER_JOB;
          const coverageFeeCentsPerJob =
            Number.isSafeInteger(coveragePolicy?.feeCentsPerJob) && coveragePolicy.feeCentsPerJob > 0 ? coveragePolicy.feeCentsPerJob : 0;
          const coverageFeeCents =
            coverageRequired && coverageFeeCentsPerJob > 0
              ? coverageFeeModel === COVERAGE_FEE_MODEL.PER_JOB
                ? coverageFeeCentsPerJob
                : 0
              : 0;

          const quote = computeQuote({
            templateId: jobTemplateId,
            currency: "USD",
            environmentTier,
            requiresOperatorCoverage,
            coverageFeeCents,
            availableRobots,
            activeOperators
          });
          const baseSla = computeSlaPolicy({ environmentTier });
          const sla = applyContractSlaOverrides({ sla: baseSla, environmentTier, contract });
          const quotePayload = {
            ...quote,
            sla,
            inputs: {
              startAt,
              endAt,
              environmentTier,
              requiresOperatorCoverage,
              zoneId,
              customerId,
              siteId,
              contractId: contract.contractId,
              contractVersion:
                Number.isSafeInteger(contract?.contractVersion) && contract.contractVersion > 0 ? contract.contractVersion : 1
            }
          };
          const quoteDraft = createChainedEvent({
            streamId: jobId,
            type: "QUOTE_PROPOSED",
            actor: { type: "pricing", id: "pricing_v0" },
            payload: quotePayload,
            at: nowIso()
          });
          events = appendChainedEvent({ events, event: quoteDraft, signer: serverSigner });

          const autoBook = body?.autoBook !== false;
          const outboxMessages = [];

          if (autoBook) {
            const contractVersion =
              Number.isSafeInteger(contract?.contractVersion) && contract.contractVersion > 0 ? contract.contractVersion : 1;
            const creditPolicy =
              contract.policies?.creditPolicy ?? { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" };
            const evidencePolicy = contract.policies?.evidencePolicy ?? { retentionDays: 0 };
            const claimPolicy =
              contract.policies?.claimPolicy ?? { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 };
            const coveragePolicy =
              contract.policies?.coveragePolicy ?? {
                required: false,
                coverageTierId: null,
                feeModel: COVERAGE_FEE_MODEL.PER_JOB,
                feeCentsPerJob: 0,
                creditFundingModel: CREDIT_FUNDING_MODEL.PLATFORM_EXPENSE,
                reserveFundPercent: 100,
                insurerId: null,
                recoverablePercent: 100,
                recoverableTerms: null,
                responseSlaSeconds: 0,
                includedAssistSeconds: 0,
                overageRateCentsPerMinute: 0
              };

            const contractDoc = contractDocumentV1FromLegacyContract({ ...contract, contractVersion });
            const customerContractHash = hashContractDocumentV1(contractDoc);
            const { policySnapshot, policyHash, compilerId } = compileBookingPolicySnapshot({
              contractDoc,
              environmentTier,
              requiresOperatorCoverage,
              sla,
              creditPolicy,
              evidencePolicy,
              claimPolicy,
              coveragePolicy
            });

            const requiredZonesInput = body?.requiredZones ?? null;
            const requiredZones =
              requiredZonesInput && typeof requiredZonesInput === "object"
                ? requiredZonesInput
                : {
                    schemaVersion: "ZoneSet.v1",
                    zoneSetId: `zones_${jobId}`,
                    zones: [{ zoneId: String(zoneId), label: String(zoneId) }]
                  };
            let requiredZonesHash;
            try {
              validateZoneSetV1(requiredZones);
              requiredZonesHash = computeZoneSetHash(requiredZones);
            } catch (err) {
              return sendError(res, 400, "invalid requiredZones", { message: err?.message });
            }

            const bookingPayload = {
              paymentHoldId: body?.paymentHoldId ?? "pilot_hold",
              startAt,
              endAt,
              environmentTier,
              requiresOperatorCoverage,
              zoneId,
              requiredZones,
              requiredZonesHash,
              sla,
              customerId,
              siteId,
              contractId: contract.contractId,
              contractVersion,
              customerContractHash,
              customerCompilerId: compilerId,
              creditPolicy,
              evidencePolicy,
              policySnapshot,
              policyHash
            };
            try {
              validateBookedPayload(bookingPayload);
            } catch (err) {
              return sendError(res, 400, "invalid booking", { message: err?.message });
            }

            const bookedDraft = createChainedEvent({
              streamId: jobId,
              type: "BOOKED",
              actor: { type: "requester", id: body?.requesterId ?? "pilot_requester" },
              payload: bookingPayload,
              at: nowIso()
            });
            events = appendChainedEvent({ events, event: bookedDraft, signer: serverSigner });
            const bookedEvent = events[events.length - 1];

            let ledgerEntries = [];
            try {
              // jobBefore for BOOKED is the job after quote.
              const jobBeforeBook = reduceJob(events.slice(0, -1));
              ledgerEntries = ledgerEntriesForJobEvent({ jobBefore: jobBeforeBook, event: bookedEvent, eventsBefore: events.slice(0, -1) });
            } catch (err) {
              return sendError(res, 400, "ledger posting rejected", { message: err?.message });
            }
            for (const entry of ledgerEntries) {
              if (!entry) continue;
              outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: bookedEvent.id, entry });
            }

            const requestedAt = nowIso();
            const dispatchDraft = createChainedEvent({
              streamId: jobId,
              type: "DISPATCH_REQUESTED",
              actor: { type: "dispatch", id: "dispatch_v1" },
              payload: { jobId, requestedAt, trigger: "BOOKED" },
              at: requestedAt
            });
            events = appendChainedEvent({ events, event: dispatchDraft, signer: serverSigner });
            const dispatchRequestedEvent = events[events.length - 1];
            outboxMessages.push({ type: "DISPATCH_REQUESTED", tenantId, jobId, sourceEventId: dispatchRequestedEvent.id, at: dispatchRequestedEvent.at });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(events);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          const responseBody = { job: jobAfter, events, outboxQueued: outboxMessages.length };
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        return sendError(res, 404, "not found");
      }

      if (req.method === "GET" && path === "/jobs") {
        return sendJson(res, 200, { jobs: listJobs({ tenantId }) });
      }

      if (req.method === "POST" && path === "/jobs") {
        const body = await readJsonBody(req);
        let idemStoreKey = null;
        let idemRequestHash = null;
        try {
          ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
        } catch (err) {
          return sendError(res, 400, "invalid idempotency key", { message: err?.message });
        }
        if (idemStoreKey) {
          const existing = store.idempotency.get(idemStoreKey);
          if (existing) {
            if (existing.requestHash !== idemRequestHash) {
              return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
            }
            return sendJson(res, existing.statusCode, existing.body);
          }
        }

        {
          const cfg = getTenantConfig(tenantId) ?? {};
          const requestedLimit = cfg?.quotas?.maxOpenJobs ?? 0;
          const limit = clampQuota({ tenantLimit: Number.isSafeInteger(requestedLimit) ? requestedLimit : 0, defaultLimit: 0, maxLimit: quotaPlatformMaxOpenJobs });
          if (limit > 0) {
            const open = countOpenJobsForTenant(tenantId);
            if (isQuotaExceeded({ current: open, limit })) {
              return sendError(res, 429, "tenant quota exceeded", { kind: "open_jobs", limit, current: open }, { code: "TENANT_QUOTA_EXCEEDED" });
            }
          }
        }

        const templateId = body?.templateId;
        if (!templateId) return sendError(res, 400, "templateId is required");

        const jobId = createId("job");

        const createdEvent = createChainedEvent({
          streamId: jobId,
          type: "JOB_CREATED",
          actor: { type: "system", id: "proxy" },
          payload: {
            tenantId,
            customerId: body?.customerId ?? null,
            siteId: body?.siteId ?? null,
            contractId: body?.contractId ?? null,
            templateId,
            constraints: body?.constraints ?? {}
          },
          at: nowIso()
        });
        const events = appendChainedEvent({ events: [], event: createdEvent, signer: serverSigner });
        const jobWithHead = reduceJob(events);

        const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events }];
        if (idemStoreKey) {
          const responseBody = { job: jobWithHead };
          ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
        }

        const responseBody = { job: jobWithHead };
        await commitTx(ops);
        return sendJson(res, 201, responseBody);
      }

      if (req.method === "GET" && path === "/robots") {
        return sendJson(res, 200, { robots: listRobots({ tenantId }) });
      }

      if (req.method === "POST" && path === "/robots/register") {
        const body = await readJsonBody(req);
        let idemStoreKey = null;
        let idemRequestHash = null;
        try {
          ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
        } catch (err) {
          return sendError(res, 400, "invalid idempotency key", { message: err?.message });
        }
        if (idemStoreKey) {
          const existing = store.idempotency.get(idemStoreKey);
          if (existing) {
            if (existing.requestHash !== idemRequestHash) {
              return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
            }
            return sendJson(res, existing.statusCode, existing.body);
          }
        }

        const robotId = body?.robotId ?? createId("rob");
        const publicKeyPem = body?.publicKeyPem ?? null;

        let keyId = null;
        if (publicKeyPem) {
          keyId = keyIdFromPublicKeyPem(publicKeyPem);
        }

        if (store.robots.has(robotStoreKey(tenantId, robotId)) && !idemStoreKey) {
          return sendError(res, 409, "robot already exists");
        }

        const registeredEvent = createChainedEvent({
          streamId: robotId,
          type: "ROBOT_REGISTERED",
          actor: { type: "system", id: "proxy" },
          payload: {
            robotId,
            tenantId,
            ownerId: body?.ownerId ?? null,
            name: body?.name ?? null,
            capabilities: body?.capabilities ?? {},
            trustScore: body?.trustScore ?? 0.5,
            signerKeyId: keyId,
            homeZoneId: body?.homeZoneId ?? null,
            currentZoneId: body?.currentZoneId ?? null
          },
          at: nowIso()
        });

        const robotEvents = appendChainedEvent({ events: [], event: registeredEvent, signer: serverSigner });
        const robot = reduceRobot(robotEvents);
        if (!robot) return sendError(res, 500, "failed to register robot");

        const responseBody = { robot, keyId };
        const ops = [{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: robotEvents }];
        if (keyId && publicKeyPem) {
          ops.push({ kind: "PUBLIC_KEY_PUT", keyId, publicKeyPem });
          ops.push({
            kind: "SIGNER_KEY_UPSERT",
            tenantId,
            signerKey: { keyId, publicKeyPem, purpose: SIGNER_KEY_PURPOSE.ROBOT, status: SIGNER_KEY_STATUS.ACTIVE, description: `robot:${robotId}`, createdAt: registeredEvent.at }
          });
        }
        if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });

        await commitTx(ops);

        return sendJson(res, 201, responseBody);
      }

      if (req.method === "GET" && path === "/operators") {
        return sendJson(res, 200, { operators: listOperators({ tenantId }) });
      }

      if (req.method === "POST" && path === "/operators/register") {
        const body = await readJsonBody(req);
        let idemStoreKey = null;
        let idemRequestHash = null;
        try {
          ({ idemStoreKey, idemRequestHash } = readIdempotency({ method: "POST", requestPath: path, expectedPrevChainHash: null, body }));
        } catch (err) {
          return sendError(res, 400, "invalid idempotency key", { message: err?.message });
        }
        if (idemStoreKey) {
          const existing = store.idempotency.get(idemStoreKey);
          if (existing) {
            if (existing.requestHash !== idemRequestHash) {
              return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
            }
            return sendJson(res, existing.statusCode, existing.body);
          }
        }

        const operatorId = body?.operatorId ?? createId("op");
        const publicKeyPem = body?.publicKeyPem ?? null;
        if (!publicKeyPem) return sendError(res, 400, "publicKeyPem is required");

        const keyId = keyIdFromPublicKeyPem(publicKeyPem);

        if (store.operators.has(operatorStoreKey(tenantId, operatorId)) && !idemStoreKey) {
          return sendError(res, 409, "operator already exists");
        }

        const registeredEvent = createChainedEvent({
          streamId: operatorId,
          type: "OPERATOR_REGISTERED",
          actor: { type: "system", id: "proxy" },
          payload: {
            operatorId,
            tenantId,
            name: body?.name ?? null,
            signerKeyId: keyId
          },
          at: nowIso()
        });

        const operatorEvents = appendChainedEvent({ events: [], event: registeredEvent, signer: serverSigner });
        const operator = reduceOperator(operatorEvents);
        if (!operator) return sendError(res, 500, "failed to register operator");

        const responseBody = { operator, keyId };
        const ops = [
          { kind: "OPERATOR_EVENTS_APPENDED", tenantId, operatorId, events: operatorEvents },
          { kind: "PUBLIC_KEY_PUT", keyId, publicKeyPem },
          {
            kind: "SIGNER_KEY_UPSERT",
            tenantId,
            signerKey: { keyId, publicKeyPem, purpose: SIGNER_KEY_PURPOSE.OPERATOR, status: SIGNER_KEY_STATUS.ACTIVE, description: `operator:${operatorId}`, createdAt: registeredEvent.at }
          }
        ];
        if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });

        await commitTx(ops);

        return sendJson(res, 201, responseBody);
      }

      const parts = path.split("/").filter(Boolean);

      if (parts[0] === "outbox" && parts.length === 1 && req.method === "GET") {
        return sendJson(res, 200, { outbox: store.outbox });
      }

      if (parts[0] === "robots" && parts[1] && parts[1] !== "register") {
        const robotId = parts[1];
        const robot = store.robots.get(robotStoreKey(tenantId, robotId));
        if (!robot) return sendError(res, 404, "robot not found");

        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, { robot });
        }

        if (parts[2] === "events") {
          if (req.method === "GET" && parts.length === 3) {
            return sendJson(res, 200, { events: getRobotEvents(tenantId, robotId) });
          }

          if (req.method === "POST" && parts.length === 3) {
            if (!requireProtocolHeaderForWrite(req, res)) return;
            const body = await readJsonBody(req);
	            {
	              const schemaCheck = parseEventSchemaVersionFromBody(body);
	              if (!schemaCheck.ok) return sendError(res, schemaCheck.statusCode ?? 400, schemaCheck.message, schemaCheck.details ?? null, { code: schemaCheck.code });
	            }
	            const type = body?.type;
	            if (!type) return sendError(res, 400, "type is required");
	            res.__settldEventType = type;
            const supported = new Set([
              "ROBOT_HEARTBEAT",
              "ROBOT_UNHEALTHY",
              "ROBOT_QUARANTINED",
              "ROBOT_QUARANTINE_CLEARED",
              "MAINTENANCE_REQUESTED",
              "MAINTENANCE_COMPLETED"
            ]);
            if (!supported.has(type)) return sendError(res, 400, "unsupported robot event type");

            const signerKind = requiredSignerKindForEventType(type);
            const existing = getRobotEvents(tenantId, robotId);
            const currentPrevChainHash = getCurrentPrevChainHash(existing);

            const isClientFinalized = Boolean(body?.payloadHash || body?.chainHash || body?.signature || body?.signerKeyId || body?.prevChainHash);

            // Client-finalized events are used for robot-signed types.
            if (isClientFinalized) {
              const event = {
                v: body?.v ?? 1,
                id: body?.id,
                at: body?.at,
                streamId: body?.streamId,
                type,
                actor: body?.actor ?? null,
                payload: body?.payload ?? null,
                payloadHash: body?.payloadHash ?? null,
                prevChainHash: body?.prevChainHash ?? null,
                chainHash: body?.chainHash ?? null,
                signature: body?.signature ?? null,
                signerKeyId: body?.signerKeyId ?? null
              };

              try {
                if (event.v !== 1) throw new TypeError("event.v must be 1");
                assertNonEmptyString(event.id, "event.id");
                assertIsoDate(event.at, "event.at");
                assertNonEmptyString(event.streamId, "event.streamId");
                if (event.streamId !== robotId) throw new TypeError("event.streamId must match robotId");
                assertActor(event.actor);
                if (event.actor.type !== "robot") throw new TypeError("robot client-finalized events require actor.type=robot");
                if (event.actor.id !== robotId) throw new TypeError("event.actor.id must match robotId");
                assertNonEmptyString(event.payloadHash, "event.payloadHash");
                assertNonEmptyString(event.chainHash, "event.chainHash");
              } catch (err) {
                return sendError(res, 400, "invalid event envelope", { message: err?.message });
              }

              {
                const atMs = Date.parse(event.at);
                const nowMs = Date.parse(nowIso());
                const maxSkewMs = 5 * 60_000;
                if (Number.isFinite(atMs) && Number.isFinite(nowMs) && atMs > nowMs + maxSkewMs) {
                  return sendError(res, 400, "event.at is too far in the future");
                }
              }

              if (event.prevChainHash !== currentPrevChainHash) {
                return sendError(res, 409, "event append conflict", {
                  expectedPrevChainHash: currentPrevChainHash,
                  gotPrevChainHash: event.prevChainHash
                });
              }

              const nextEvents = [...existing, event];
              const verify = verifyChainedEvents(nextEvents, { publicKeyByKeyId: store.publicKeyByKeyId });
              if (!verify.ok) return sendError(res, 400, "event chain verification failed", verify.error);

              try {
                enforceSignaturePolicy({ tenantId, signerKind, event });
              } catch (err) {
                return sendError(res, 400, "signature policy rejected", { message: err?.message });
              }

              let robotAfter;
              try {
                robotAfter = reduceRobot(nextEvents);
              } catch (err) {
                return sendError(res, 400, "robot update rejected", { message: err?.message });
              }

              const responseBody = { event, robot: robotAfter };
              await commitTx([{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }]);
              return sendJson(res, 201, responseBody);
            }

            // Server-driven robot events (e.g., quarantine/maintenance) require precondition header.
            const expectedHeader = parseExpectedPrevChainHashHeader(req);
            if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");
            if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
              return sendError(res, 409, "event append conflict", {
                expectedPrevChainHash: currentPrevChainHash,
                gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
              });
            }

            if (body?.actor?.type === "robot" || body?.actor?.type === "operator") {
              return sendError(res, 400, "robot/operator actors must use signer-enforced event types");
            }

            // Basic payload shape validation for server-created robot events.
            try {
              const p = body?.payload ?? null;
              if (type === "ROBOT_UNHEALTHY") validateRobotUnhealthyPayload(p ?? {});
              if (type === "ROBOT_QUARANTINED") validateRobotQuarantinedPayload(p ?? {});
              if (type === "ROBOT_QUARANTINE_CLEARED") validateRobotQuarantineClearedPayload(p ?? {});
              if (type === "MAINTENANCE_REQUESTED") validateMaintenanceRequestedPayload(p ?? {});
              if (type === "MAINTENANCE_COMPLETED") validateMaintenanceCompletedPayload(p ?? {});
            } catch (err) {
              return sendError(res, 400, "invalid payload", { message: err?.message });
            }

            const draft = createChainedEvent({
              streamId: robotId,
              type,
              actor: body?.actor ?? { type: "system", id: "proxy" },
              payload: body?.payload ?? null,
              at: nowIso()
            });
            const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
            const event = nextEvents[nextEvents.length - 1];

            try {
              enforceSignaturePolicy({ tenantId, signerKind, event });
            } catch (err) {
              return sendError(res, 400, "signature policy rejected", { message: err?.message });
            }

            let robotAfter;
            try {
              robotAfter = reduceRobot(nextEvents);
            } catch (err) {
              return sendError(res, 400, "robot update rejected", { message: err?.message });
	            }
	
	            const responseBody = { event, robot: robotAfter };
	            await commitTx([{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }]);
	            return sendJson(res, 201, responseBody);
	          }
	        }

        if (req.method === "POST" && parts[2] === "availability" && parts.length === 3) {
	          const body = await readJsonBody(req);
	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

          const payload = { robotId, availability: body?.availability, timezone: body?.timezone };
          try {
            validateRobotAvailabilitySetPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const existing = getRobotEvents(tenantId, robotId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const draft = createChainedEvent({ streamId: robotId, type: "ROBOT_AVAILABILITY_SET", actor: { type: "system", id: "proxy" }, payload, at: nowIso() });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          let robotAfter;
          try {
            robotAfter = reduceRobot(nextEvents);
          } catch (err) {
            return sendError(res, 400, "robot update rejected", { message: err?.message });
          }

          const responseBody = { event, robot: robotAfter };
          const ops = [{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          await commitTx(ops);

          return sendJson(res, 201, responseBody);
        }

        if (req.method === "POST" && parts[2] === "status" && parts.length === 3) {
          const body = await readJsonBody(req);
          const expectedHeader = parseExpectedPrevChainHashHeader(req);
          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

          const payload = { robotId, status: body?.status, reason: body?.reason };
          try {
            validateRobotStatusChangedPayload(payload);
          } catch (err) {
            return sendError(res, 400, "invalid payload", { message: err?.message });
          }

          const existing = getRobotEvents(tenantId, robotId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const draft = createChainedEvent({ streamId: robotId, type: "ROBOT_STATUS_CHANGED", actor: { type: "system", id: "proxy" }, payload, at: nowIso() });
          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = nextEvents[nextEvents.length - 1];

          let robotAfter;
          try {
            robotAfter = reduceRobot(nextEvents);
          } catch (err) {
            return sendError(res, 400, "robot update rejected", { message: err?.message });
          }

          const responseBody = { event, robot: robotAfter };
          await commitTx([{ kind: "ROBOT_EVENTS_APPENDED", tenantId, robotId, events: [event] }]);
          return sendJson(res, 201, responseBody);
        }
      }

      if (parts[0] === "operators" && parts[1] && parts[1] !== "register") {
        const operatorId = parts[1];
        const operator = store.operators.get(operatorStoreKey(tenantId, operatorId));
        if (!operator) return sendError(res, 404, "operator not found");

        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, { operator });
        }

        if (parts[2] === "events") {
          if (req.method === "GET" && parts.length === 3) {
            return sendJson(res, 200, { events: getOperatorEvents(tenantId, operatorId) });
          }

          if (req.method === "POST" && parts.length === 3) {
            if (!requireProtocolHeaderForWrite(req, res)) return;
            const body = await readJsonBody(req);
            {
              const schemaCheck = parseEventSchemaVersionFromBody(body);
              if (!schemaCheck.ok) return sendError(res, schemaCheck.statusCode ?? 400, schemaCheck.message, schemaCheck.details ?? null, { code: schemaCheck.code });
            }
            const type = body?.type;
            if (!type) return sendError(res, 400, "type is required");
            if (type !== "OPERATOR_SHIFT_OPENED" && type !== "OPERATOR_SHIFT_CLOSED") {
              return sendError(res, 400, "unsupported operator event type");
            }

            const signerKind = requiredSignerKindForEventType(type);
            const existing = getOperatorEvents(tenantId, operatorId);
            const currentPrevChainHash = getCurrentPrevChainHash(existing);
            const isClientFinalized = Boolean(body?.payloadHash || body?.chainHash || body?.signature || body?.signerKeyId || body?.prevChainHash);
            if (!isClientFinalized) return sendError(res, 400, "event must be client-finalized and signed for this type");

            const event = {
              v: body?.v ?? 1,
              id: body?.id,
              at: body?.at,
              streamId: body?.streamId,
              type,
              actor: body?.actor ?? null,
              payload: body?.payload ?? null,
              payloadHash: body?.payloadHash ?? null,
              prevChainHash: body?.prevChainHash ?? null,
              chainHash: body?.chainHash ?? null,
              signature: body?.signature ?? null,
              signerKeyId: body?.signerKeyId ?? null
            };

            try {
              if (event.v !== 1) throw new TypeError("event.v must be 1");
              assertNonEmptyString(event.id, "event.id");
              assertIsoDate(event.at, "event.at");
              assertNonEmptyString(event.streamId, "event.streamId");
              if (event.streamId !== operatorId) throw new TypeError("event.streamId must match operatorId");
              assertActor(event.actor);
              if (event.actor.type !== "operator") throw new TypeError("operator events require actor.type=operator");
              if (event.actor.id !== operatorId) throw new TypeError("event.actor.id must match operatorId");
              assertNonEmptyString(event.payloadHash, "event.payloadHash");
              assertNonEmptyString(event.chainHash, "event.chainHash");
            } catch (err) {
              return sendError(res, 400, "invalid event envelope", { message: err?.message });
            }

            {
              const atMs = Date.parse(event.at);
              const nowMs = Date.parse(nowIso());
              const maxSkewMs = 5 * 60_000;
              if (Number.isFinite(atMs) && Number.isFinite(nowMs) && atMs > nowMs + maxSkewMs) {
                return sendError(res, 400, "event.at is too far in the future");
              }
            }

            if (event.prevChainHash !== currentPrevChainHash) {
              return sendError(res, 409, "event append conflict", {
                expectedPrevChainHash: currentPrevChainHash,
                gotPrevChainHash: event.prevChainHash
              });
            }

            if (type === "OPERATOR_SHIFT_OPENED") {
              try {
                validateOperatorShiftOpenedPayload(event.payload ?? {});
                if (event.payload?.operatorId !== operatorId) throw new TypeError("payload.operatorId must match operatorId");
              } catch (err) {
                return sendError(res, 400, "invalid payload", { message: err?.message });
              }
            }
            if (type === "OPERATOR_SHIFT_CLOSED") {
              try {
                validateOperatorShiftClosedPayload(event.payload ?? {});
                if (event.payload?.operatorId !== operatorId) throw new TypeError("payload.operatorId must match operatorId");
              } catch (err) {
                return sendError(res, 400, "invalid payload", { message: err?.message });
              }
            }

            const nextEvents = [...existing, event];
            const verify = verifyChainedEvents(nextEvents, { publicKeyByKeyId: store.publicKeyByKeyId });
            if (!verify.ok) return sendError(res, 400, "event chain verification failed", verify.error);

            try {
              enforceSignaturePolicy({ tenantId, signerKind, event });
            } catch (err) {
              return sendError(res, 400, "signature policy rejected", { message: err?.message });
            }

            let operatorAfter;
            try {
              operatorAfter = reduceOperator(nextEvents);
            } catch (err) {
              return sendError(res, 400, "operator update rejected", { message: err?.message });
            }

            const responseBody = { event, operator: operatorAfter };
            await commitTx([{ kind: "OPERATOR_EVENTS_APPENDED", tenantId, operatorId, events: [event] }]);
            return sendJson(res, 201, responseBody);
          }
        }
      }

      if (parts[0] === "jobs" && parts[1]) {
        const jobId = parts[1];
        const needsFreshForExport =
          req.method === "GET" && (parts[2] === "audit" || parts[2] === "evidence") && store.kind === "pg" && typeof store.refreshFromDb === "function";
        if (needsFreshForExport) await store.refreshFromDb();

        const events = getJobEvents(tenantId, jobId);
        const job = reduceJob(events);
        if (!job) return sendError(res, 404, "job not found");
        if (normalizeTenant(job.tenantId ?? DEFAULT_TENANT_ID) !== normalizeTenant(tenantId)) return sendError(res, 404, "job not found");

        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, { job });
        }

        if (req.method === "GET" && parts[2] === "audit" && parts.length === 3) {
          if (!requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ)) return sendError(res, 403, "forbidden");
          const audit = buildAuditExport({ job, events });
          return sendJson(res, 200, { audit });
        }

	        if (req.method === "GET" && parts[2] === "evidence" && parts.length === 3) {
	          if (!requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ)) return sendError(res, 403, "forbidden");
	          const evidenceExport = buildEvidenceExport({ job });

          const at = nowIso();
          const nowMs = Date.parse(at);
          const ttlMs = 5 * 60_000;
          const expiresAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + ttlMs).toISOString();

          const evidence = Array.isArray(evidenceExport.evidence) ? evidenceExport.evidence : [];
          const withUrls = evidence.map((e) => {
            const evidenceId = e?.evidenceId ?? null;
            const evidenceRef = e?.evidenceRef ?? null;
            if (e?.expiredAt) return e;
            if (typeof evidenceId !== "string" || !evidenceId) return e;
            if (typeof evidenceRef !== "string" || !evidenceRef.startsWith("obj://")) return e;
            const downloadUrl = buildEvidenceDownloadUrl({
              tenantId,
              jobId,
              evidenceId,
              evidenceRef,
              expiresAt,
              secret: evidenceSigningSecret
            });
            return { ...e, downloadUrl, downloadExpiresAt: expiresAt };
          });

	          return sendJson(res, 200, { evidence: { ...evidenceExport, evidence: withUrls } });
	        }

	        if (req.method === "GET" && parts[2] === "artifacts" && parts[3] === "effective" && parts.length === 4) {
	          if (!(requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
	            return sendError(res, 403, "forbidden");
	          }
	          if (typeof store.listArtifacts !== "function") return sendError(res, 501, "artifacts not supported for this store");

	          const artifactType = url.searchParams.get("type");
	          if (!artifactType || String(artifactType).trim() === "") return sendError(res, 400, "type is required");

	          const settledEventId = job?.settlement?.settledEventId ?? null;
	          if (typeof settledEventId === "string" && settledEventId.trim() !== "") {
	            const artifacts = await store.listArtifacts({
	              tenantId,
	              jobId,
	              artifactType: String(artifactType),
	              sourceEventId: String(settledEventId),
	              limit: 10,
	              offset: 0
	            });
	            if (!artifacts.length) return sendError(res, 404, "effective artifact not found", { settledEventId });
	            if (artifacts.length > 1) {
	              return sendError(res, 500, "multiple settlement-backed artifacts found", { settledEventId, count: artifacts.length });
	            }
	            return sendJson(res, 200, {
	              artifact: artifacts[0],
	              selection: { kind: "SETTLED_EVENT", sourceEventId: settledEventId }
	            });
	          }

	          // Unsettled jobs: choose an anchor based on the current proof for the latest completion anchor.
	          // NOTE: For WorkCertificate/SettlementStatement/ProofReceipt, artifacts are anchored to PROOF_EVALUATED.
	          const completionTypes = new Set(["EXECUTION_COMPLETED", "JOB_EXECUTION_COMPLETED", "EXECUTION_ABORTED", "JOB_EXECUTION_ABORTED"]);
	          const completion = [...events].reverse().find((e) => completionTypes.has(e?.type) && typeof e?.chainHash === "string" && e.chainHash.trim() !== "");
	          const completionChainHash = completion?.chainHash ?? null;
	          if (!completionChainHash) return sendError(res, 409, "job has no completion anchor yet");

	          let proofEvent = null;
	          let proofFreshness = "none";
	          let expectedFactsHash = null;
	          try {
	            const anchorIdx = events.findIndex((e) => e?.chainHash === completionChainHash);
	            const anchorSlice = anchorIdx === -1 ? null : events.slice(0, anchorIdx + 1);
	            const jobAtAnchor = anchorSlice ? reduceJob(anchorSlice) : null;
	            if (jobAtAnchor) {
	              const current = verifyZoneCoverageProofV1({
	                job: jobAtAnchor,
	                events,
	                evaluatedAtChainHash: completionChainHash,
	                customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
	                operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
	              });
	              const factsHash = current?.factsHash ?? null;
	              const customerPolicyHash = current?.anchors?.customerPolicyHash ?? (jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null);
	              if (factsHash && customerPolicyHash) {
	                proofEvent =
	                  [...events]
	                    .reverse()
	                    .find(
	                      (e) =>
	                        e?.type === "PROOF_EVALUATED" &&
	                        e?.payload?.evaluatedAtChainHash === completionChainHash &&
	                        e?.payload?.customerPolicyHash === customerPolicyHash &&
	                        e?.payload?.factsHash === factsHash &&
	                        typeof e?.id === "string" &&
	                        e.id.trim() !== ""
	                    ) ?? null;
	                if (proofEvent) {
	                  proofFreshness = "fresh";
	                } else {
	                  proofFreshness = "stale";
	                  expectedFactsHash = factsHash;
	                  proofEvent =
	                    [...events]
	                      .reverse()
	                      .find(
	                        (e) =>
	                          e?.type === "PROOF_EVALUATED" &&
	                          e?.payload?.evaluatedAtChainHash === completionChainHash &&
	                          typeof e?.id === "string" &&
	                          e.id.trim() !== ""
	                      ) ?? null;
	                }
	              }
	            }
	          } catch {
	            // ignore, fall back below
	          }

	          if (!proofEvent) {
	            proofEvent = [...events].reverse().find((e) => e?.type === "PROOF_EVALUATED" && typeof e?.id === "string" && e.id.trim() !== "") ?? null;
	          }
	          if (!proofEvent?.id) return sendError(res, 409, "effective proof not available yet");

	          const artifacts = await store.listArtifacts({
	            tenantId,
	            jobId,
	            artifactType: String(artifactType),
	            sourceEventId: String(proofEvent.id),
	            limit: 10,
	            offset: 0
	          });
	          if (!artifacts.length) {
	            return sendError(res, 409, "effective artifact not available yet", { sourceEventId: proofEvent.id });
	          }
	          if (artifacts.length > 1) {
	            return sendError(res, 500, "multiple artifacts found for effective source event", { sourceEventId: proofEvent.id, count: artifacts.length });
	          }
	          return sendJson(res, 200, {
	            artifact: artifacts[0],
	            selection: {
	              kind: "PROOF_EVENT",
	              sourceEventId: proofEvent.id,
	              proofFreshness,
	              expectedFactsHash
	            }
	          });
	        }

	        if (req.method === "GET" && parts[2] === "artifacts" && parts.length === 3) {
	          if (!(requireScope(auth.scopes, OPS_SCOPES.AUDIT_READ) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_READ))) {
	            return sendError(res, 403, "forbidden");
	          }
	          if (typeof store.listArtifacts !== "function") return sendError(res, 501, "artifacts not supported for this store");

	          const type = url.searchParams.get("type");
	          const sourceEventId = url.searchParams.get("sourceEventId");
	          const cursor = url.searchParams.get("cursor");
	          const limitRaw = url.searchParams.get("limit");
	          const offsetRaw = url.searchParams.get("offset");
	          const limit = limitRaw ? Number(limitRaw) : 200;
	          const offset = offsetRaw ? Number(offsetRaw) : 0;

	          if (cursor && String(cursor).trim() !== "" && offsetRaw && String(offsetRaw).trim() !== "") {
	            return sendError(res, 400, "invalid artifacts query", { message: "cursor and offset cannot be used together" }, { code: "INVALID_PAGINATION" });
	          }

	          if (cursor && String(cursor).trim() !== "") {
	            if (store.kind !== "pg") {
	              return sendError(res, 501, "cursor pagination not supported for this store", null, { code: "CURSOR_PAGINATION_UNSUPPORTED" });
	            }
	            const CURSOR_VERSION = 1;
	            const CURSOR_ORDER = "created_at_desc_artifact_id_desc";
	            const isCursorTimestampV1 = (s) => {
	              if (typeof s !== "string") return false;
	              // RFC3339 UTC with microseconds: 2026-01-01T00:00:00.123456Z
	              // (We require microseconds for v1 to preserve Postgres timestamptz precision.)
	              return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(s);
	            };
	            const decodeCursor = (raw) => {
	              try {
	                const buf = Buffer.from(String(raw), "base64url");
	                const parsed = JSON.parse(buf.toString("utf8"));
	                const vRaw = parsed?.v ?? null;
	                const v = vRaw === null || vRaw === undefined ? CURSOR_VERSION : Number(vRaw);
	                if (!Number.isFinite(v) || !Number.isSafeInteger(v)) throw new Error("cursor.v must be an integer");
	                if (v !== CURSOR_VERSION) throw new Error(`unsupported cursor version: ${v}`);

	                const order = parsed?.order ?? null;
	                if (order !== null && String(order) !== CURSOR_ORDER) throw new Error(`unsupported cursor order: ${String(order)}`);

	                const createdAt = parsed?.createdAt ?? null;
	                const artifactId = parsed?.artifactId ?? null;
	                if (typeof createdAt !== "string" || !createdAt.trim()) throw new Error("cursor.createdAt is required");
	                if (typeof artifactId !== "string" || !artifactId.trim()) throw new Error("cursor.artifactId is required");
	                if (!isCursorTimestampV1(createdAt)) throw new Error("cursor.createdAt must be an RFC3339 UTC timestamp with microseconds");
	                return { createdAt, artifactId };
	              } catch (err) {
	                const e = new Error(`invalid cursor: ${err?.message ?? "parse failed"}`);
	                e.code = "INVALID_CURSOR";
	                throw e;
	              }
	            };
	            const encodeCursor = ({ createdAt, artifactId }) => {
	              if (!isCursorTimestampV1(createdAt)) throw new Error("internal: createdAt must be RFC3339 UTC with microseconds");
	              const body = JSON.stringify({ v: CURSOR_VERSION, order: CURSOR_ORDER, createdAt, artifactId });
	              return Buffer.from(body, "utf8").toString("base64url");
	            };

	            let cur;
	            try {
	              cur = decodeCursor(cursor);
	            } catch (err) {
	              return sendError(res, 400, "invalid artifacts query", { message: err?.message }, { code: err?.code ?? "INVALID_CURSOR" });
	            }

	            const pageSize = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
	            let rows;
	            try {
	              rows = await store.listArtifacts({
	                tenantId,
	                jobId,
	                artifactType: type && String(type).trim() !== "" ? String(type) : null,
	                sourceEventId: sourceEventId && String(sourceEventId).trim() !== "" ? String(sourceEventId) : null,
	                beforeCreatedAt: cur.createdAt,
	                beforeArtifactId: cur.artifactId,
	                includeDbMeta: true,
	                limit: pageSize + 1,
	                offset: 0
	              });
	            } catch (err) {
	              return sendError(res, 400, "invalid artifacts query", { message: err?.message });
	            }

	            const hasMore = rows.length > pageSize;
	            const page = rows.slice(0, pageSize);
	            const artifacts = page.map((r) => r?.artifact ?? null).filter(Boolean);
	            const last = page.length ? page[page.length - 1] : null;
	            const nextCursor = hasMore && last?.db?.createdAt && last?.db?.artifactId ? encodeCursor(last.db) : null;
	            return sendJson(res, 200, { artifacts, nextCursor, hasMore, limit: pageSize });
	          }

	          let artifacts;
	          try {
	            artifacts = await store.listArtifacts({
	              tenantId,
	              jobId,
	              artifactType: type && String(type).trim() !== "" ? String(type) : null,
	              sourceEventId: sourceEventId && String(sourceEventId).trim() !== "" ? String(sourceEventId) : null,
	              limit,
	              offset
	            });
	          } catch (err) {
	            return sendError(res, 400, "invalid artifacts query", { message: err?.message });
	          }
	          return sendJson(res, 200, { artifacts });
	        }

        const getWindowZoneId = (windowZoneId) => normalizeZoneId(windowZoneId ?? job.booking?.zoneId ?? job.constraints?.zoneId);

        if (req.method === "POST" && parts[2] === "quote" && parts.length === 3) {
          const body = await readJsonBody(req);

	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

          if (job.status !== "CREATED") return sendError(res, 400, "job is not quoteable");

          const quoteCustomerId = body?.customerId ?? job.customerId ?? null;
          const quoteSiteId = body?.siteId ?? job.siteId ?? null;
          const quoteContractId = body?.contractId ?? job.contractId ?? null;

          const quoteInput = {
            startAt: body?.startAt,
            endAt: body?.endAt,
            environmentTier: body?.environmentTier,
            requiresOperatorCoverage: body?.requiresOperatorCoverage,
            customerId: quoteCustomerId,
            siteId: quoteSiteId,
            contractId: quoteContractId
          };
          try {
            validateBookingWindowInput(quoteInput);
          } catch (err) {
            return sendError(res, 400, "invalid quote input", { message: err?.message });
          }

          const zoneId = getWindowZoneId(quoteInput.zoneId);
          const window = { startAt: quoteInput.startAt, endAt: quoteInput.endAt };

          const activeOperators = listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobId }).length;
          const requiresOperatorCoverage =
            quoteInput.requiresOperatorCoverage === true || quoteInput.environmentTier === ENV_TIER.ENV_IN_HOME;
          if (requiresOperatorCoverage && activeOperators <= 0) {
            return sendError(res, 409, "insufficient operator coverage");
          }

          const availableRobotList = listAvailableRobots({ tenantId, zoneId, window, ignoreJobId: jobId });
          const availableRobots = availableRobotList.length;
          if (availableRobots <= 0) return sendError(res, 409, "no available robots for window");
          let avgAvailableRobotTrustScoreBps = 0;
          if (availableRobots > 0) {
            let sum = 0;
            for (const r of availableRobotList) {
              const score = typeof r?.trustScore === "number" && Number.isFinite(r.trustScore) ? r.trustScore : 0;
              sum += Math.max(0, Math.min(1, score));
            }
            avgAvailableRobotTrustScoreBps = Math.max(0, Math.min(10_000, Math.round((sum / availableRobots) * 10_000)));
          }

          const contracts = listContracts({ tenantId });
          let contract = null;
          if (quoteContractId) {
            contract = contracts.find((c) => c?.contractId === quoteContractId) ?? null;
            if (!contract) return sendError(res, 400, "unknown contractId");
          } else {
            contract = selectBestContract(contracts, { customerId: quoteCustomerId, siteId: quoteSiteId, templateId: job.templateId });
          }
          if (!contract) contract = createDefaultContract({ tenantId, nowIso });

          const contractVersion =
            Number.isSafeInteger(contract?.contractVersion) && contract.contractVersion > 0 ? contract.contractVersion : 1;

          const baseSla = computeSlaPolicy({ environmentTier: quoteInput.environmentTier });
          const sla = applyContractSlaOverrides({ sla: baseSla, environmentTier: quoteInput.environmentTier, contract });
          const creditPolicy =
            contract.policies?.creditPolicy ?? { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" };

          const coveragePolicy = contract.policies?.coveragePolicy ?? null;
          const coverageRequired = coveragePolicy?.required === true;
          const coverageFeeModel = coveragePolicy?.feeModel ?? COVERAGE_FEE_MODEL.PER_JOB;
          const coverageFeeCentsPerJob =
            Number.isSafeInteger(coveragePolicy?.feeCentsPerJob) && coveragePolicy.feeCentsPerJob > 0 ? coveragePolicy.feeCentsPerJob : 0;
          const coverageFeeCents =
            coverageRequired && coverageFeeCentsPerJob > 0
              ? coverageFeeModel === COVERAGE_FEE_MODEL.PER_JOB
                ? coverageFeeCentsPerJob
                : 0
              : 0;

          const quote = computeQuote({
            templateId: job.templateId,
            currency: "USD",
            environmentTier: quoteInput.environmentTier,
            requiresOperatorCoverage,
            coverageFeeCents,
            availableRobots,
            activeOperators
          });
          const payload = {
            ...quote,
            sla,
            inputs: {
              ...quoteInput,
              requiresOperatorCoverage,
              zoneId,
              customerId: quoteCustomerId,
              siteId: quoteSiteId,
              contractId: contract.contractId,
              contractVersion
            }
          };
          const existing = getJobEvents(tenantId, jobId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const draft = createChainedEvent({
            streamId: jobId,
            type: "QUOTE_PROPOSED",
            actor: { type: "pricing", id: "pricing_v0" },
            payload,
            at: nowIso()
          });
          const eventsAfterQuote = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const event = eventsAfterQuote[eventsAfterQuote.length - 1];

          let jobAfterQuote;
          try {
            jobAfterQuote = reduceJob(eventsAfterQuote);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          let riskEvent = null;
          let nextEvents = eventsAfterQuote;
          let jobAfter = jobAfterQuote;
          try {
            const scoredAt = nowIso();
            const assessment = computeRiskAssessment({
              basis: RISK_BASIS.QUOTE,
              templateId: job.templateId,
              environmentTier: quoteInput.environmentTier,
              requiresOperatorCoverage,
              zoneId,
              siteId: quoteSiteId,
              customerId: quoteCustomerId,
              availableRobots,
              activeOperators,
              avgAvailableRobotTrustScoreBps,
              creditPolicy,
              policyHash: null,
              jobs: listJobs({ tenantId }),
              getEventsForJob: (id) => getJobEvents(tenantId, id),
              nowIso
            });
            const riskPayload = {
              jobId,
              basis: RISK_BASIS.QUOTE,
              scoredAt,
              sourceEventId: event.id,
              ...assessment
            };
            const riskDraft = createChainedEvent({
              streamId: jobId,
              type: "RISK_SCORED",
              actor: { type: "risk", id: "risk_v1" },
              payload: riskPayload,
              at: scoredAt
            });
            nextEvents = appendChainedEvent({ events: eventsAfterQuote, event: riskDraft, signer: serverSigner });
            riskEvent = nextEvents[nextEvents.length - 1];
            validateDomainEvent({ jobBefore: jobAfterQuote, event: riskEvent, eventsBefore: eventsAfterQuote });
            jobAfter = reduceJob(nextEvents);
          } catch {
            // Best-effort: risk scoring should not block quoting.
            riskEvent = null;
            nextEvents = eventsAfterQuote;
            jobAfter = jobAfterQuote;
          }

          let ledgerEntries = [];
          try {
            ledgerEntries = ledgerEntriesForJobEvent({ jobBefore: job, event, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "ledger posting rejected", { message: err?.message });
          }

          const responseBody = {
            event,
            job: jobAfter,
            ledgerEntryId: ledgerEntries.length ? ledgerEntries[0]?.id ?? null : null,
            ledgerEntryIds: ledgerEntries.map((e) => e?.id).filter(Boolean)
          };

          const outboxMessages = [];
          for (const entry of ledgerEntries) {
            if (!entry) continue;
            outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: event.id, entry });
          }
          if (job.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: job.status, toStatus: jobAfter.status, at: event.at });
          }

          const appended = riskEvent ? [event, riskEvent] : [event];
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appended }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });
          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (req.method === "POST" && parts[2] === "book" && parts.length === 3) {
          const body = await readJsonBody(req);

	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

          if (job.status !== "QUOTED") return sendError(res, 400, "job is not bookable");

          const bookingCustomerId = body?.customerId ?? job.customerId ?? null;
          const bookingSiteId = body?.siteId ?? job.siteId ?? null;
          const bookingContractId = body?.contractId ?? job.contractId ?? null;

          const contracts = listContracts({ tenantId });
          let contract = null;
          if (bookingContractId) {
            contract = contracts.find((c) => c?.contractId === bookingContractId) ?? null;
            if (!contract) return sendError(res, 400, "unknown contractId");
          } else {
            contract = selectBestContract(contracts, { customerId: bookingCustomerId, siteId: bookingSiteId, templateId: job.templateId });
          }
          if (!contract) contract = createDefaultContract({ tenantId, nowIso });

          const bookingInput = {
            paymentHoldId: body?.paymentHoldId,
            startAt: body?.startAt,
            endAt: body?.endAt,
            environmentTier: body?.environmentTier,
            requiresOperatorCoverage: body?.requiresOperatorCoverage,
            zoneId: body?.zoneId,
            customerId: bookingCustomerId,
            siteId: bookingSiteId,
            contractId: contract.contractId
          };
          try {
            validateBookingWindowInput(bookingInput);
          } catch (err) {
            return sendError(res, 400, "invalid booking", { message: err?.message });
          }

          const derivedRequiresOperatorCoverage =
            bookingInput.requiresOperatorCoverage === true || bookingInput.environmentTier === ENV_TIER.ENV_IN_HOME;

          const quotedInputs = job.quote?.inputs ?? null;
          const zoneId = normalizeZoneId(bookingInput.zoneId ?? quotedInputs?.zoneId ?? job.constraints?.zoneId);
          if (quotedInputs) {
            if (quotedInputs.startAt !== bookingInput.startAt || quotedInputs.endAt !== bookingInput.endAt) {
              return sendError(res, 409, "booking window differs from quoted window");
            }
            if (quotedInputs.environmentTier && quotedInputs.environmentTier !== bookingInput.environmentTier) {
              return sendError(res, 409, "booking environment tier differs from quoted tier");
            }
            if (
              typeof quotedInputs.requiresOperatorCoverage === "boolean" &&
              quotedInputs.requiresOperatorCoverage !== derivedRequiresOperatorCoverage
            ) {
              return sendError(res, 409, "booking operator coverage differs from quoted coverage");
            }
            if (quotedInputs.zoneId && normalizeZoneId(quotedInputs.zoneId) !== zoneId) {
              return sendError(res, 409, "booking zone differs from quoted zone");
            }
            if (quotedInputs.customerId !== undefined && quotedInputs.customerId !== bookingCustomerId) {
              return sendError(res, 409, "booking customer differs from quoted customer");
            }
            if (quotedInputs.siteId !== undefined && quotedInputs.siteId !== bookingSiteId) {
              return sendError(res, 409, "booking site differs from quoted site");
            }
            if (quotedInputs.contractId !== undefined && quotedInputs.contractId !== contract.contractId) {
              return sendError(res, 409, "booking contract differs from quoted contract");
            }
          }

          const contractVersion =
            Number.isSafeInteger(contract?.contractVersion) && contract.contractVersion > 0 ? contract.contractVersion : 1;
          if (quotedInputs && quotedInputs.contractVersion !== undefined && quotedInputs.contractVersion !== contractVersion) {
            return sendError(res, 409, "booking contract version differs from quoted contract version");
          }

          const baseSla = computeSlaPolicy({ environmentTier: bookingInput.environmentTier });
          const sla = applyContractSlaOverrides({ sla: baseSla, environmentTier: bookingInput.environmentTier, contract });
          const window = { startAt: bookingInput.startAt, endAt: bookingInput.endAt };

          const activeOperatorsList = listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobId });
          const activeOperators = activeOperatorsList.length;
          if (derivedRequiresOperatorCoverage && activeOperators <= 0) {
            return sendError(res, 409, "insufficient operator coverage");
          }

          const availableRobotList = listAvailableRobots({ tenantId, zoneId, window, ignoreJobId: jobId });
          const availableRobots = availableRobotList.length;
          if (availableRobots <= 0) return sendError(res, 409, "no available robots for window");
          let avgAvailableRobotTrustScoreBps = 0;
          if (availableRobots > 0) {
            let sum = 0;
            for (const r of availableRobotList) {
              const score = typeof r?.trustScore === "number" && Number.isFinite(r.trustScore) ? r.trustScore : 0;
              sum += Math.max(0, Math.min(1, score));
            }
            avgAvailableRobotTrustScoreBps = Math.max(0, Math.min(10_000, Math.round((sum / availableRobots) * 10_000)));
          }

          const creditPolicy =
            contract.policies?.creditPolicy ?? { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" };
          const evidencePolicy = contract.policies?.evidencePolicy ?? { retentionDays: 0 };
          const claimPolicy = contract.policies?.claimPolicy ?? { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 };
          const coveragePolicy =
            contract.policies?.coveragePolicy ?? {
              required: false,
              coverageTierId: null,
              feeModel: COVERAGE_FEE_MODEL.PER_JOB,
              feeCentsPerJob: 0,
              creditFundingModel: CREDIT_FUNDING_MODEL.PLATFORM_EXPENSE,
              reserveFundPercent: 100,
              insurerId: null,
              recoverablePercent: 100,
              recoverableTerms: null,
              responseSlaSeconds: 0,
              includedAssistSeconds: 0,
              overageRateCentsPerMinute: 0
            };

          const contractDoc = contractDocumentV1FromLegacyContract({ ...contract, contractVersion });
          const customerContractHash = hashContractDocumentV1(contractDoc);
          const { policySnapshot, policyHash, compilerId } = compileBookingPolicySnapshot({
            contractDoc,
            environmentTier: bookingInput.environmentTier,
            requiresOperatorCoverage: derivedRequiresOperatorCoverage,
            sla,
            creditPolicy,
            evidencePolicy,
            claimPolicy,
            coveragePolicy
          });

          const requiredZonesInput = body?.requiredZones ?? null;
          const requiredZones =
            requiredZonesInput && typeof requiredZonesInput === "object"
              ? requiredZonesInput
              : {
                  schemaVersion: "ZoneSet.v1",
                  zoneSetId: `zones_${jobId}`,
                  zones: [{ zoneId: String(zoneId), label: String(zoneId) }]
                };
          let requiredZonesHash;
          try {
            validateZoneSetV1(requiredZones);
            requiredZonesHash = computeZoneSetHash(requiredZones);
          } catch (err) {
            return sendError(res, 400, "invalid requiredZones", { message: err?.message });
          }

          const bookingPayload = {
            paymentHoldId: bookingInput.paymentHoldId,
            startAt: bookingInput.startAt,
            endAt: bookingInput.endAt,
            environmentTier: bookingInput.environmentTier,
            requiresOperatorCoverage: derivedRequiresOperatorCoverage,
            zoneId,
            requiredZones,
            requiredZonesHash,
            sla,
            customerId: bookingCustomerId,
            siteId: bookingSiteId,
            contractId: contract.contractId,
            contractVersion,
            customerContractHash,
            customerCompilerId: compilerId,
            creditPolicy,
            evidencePolicy,
            policySnapshot,
            policyHash
          };
          try {
            validateBookedPayload(bookingPayload);
          } catch (err) {
            return sendError(res, 400, "invalid booking", { message: err?.message });
          }

          const existing = getJobEvents(tenantId, jobId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const draft = createChainedEvent({
            streamId: jobId,
            type: "BOOKED",
            actor: { type: "requester", id: body?.requesterId ?? "requester_demo" },
            payload: bookingPayload,
            at: nowIso()
          });
          const eventsAfterBook = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
          const bookedEvent = eventsAfterBook[eventsAfterBook.length - 1];

          try {
            validateDomainEvent({ jobBefore: job, event: bookedEvent, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfterBook;
          try {
            jobAfterBook = reduceJob(eventsAfterBook);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          // Risk scoring is best-effort and should not block booking.
          let riskEvent = null;
          let eventsBeforeDispatch = eventsAfterBook;
          let jobBeforeDispatch = jobAfterBook;
          try {
            const scoredAt = bookedEvent.at;
            const assessment = computeRiskAssessment({
              basis: RISK_BASIS.BOOK,
              templateId: job.templateId,
              environmentTier: bookingInput.environmentTier,
              requiresOperatorCoverage: derivedRequiresOperatorCoverage,
              zoneId,
              siteId: bookingSiteId,
              customerId: bookingCustomerId,
              availableRobots,
              activeOperators,
              avgAvailableRobotTrustScoreBps,
              creditPolicy,
              policyHash,
              jobs: listJobs({ tenantId }),
              getEventsForJob: (id) => getJobEvents(tenantId, id),
              nowIso
            });
            const riskPayload = {
              jobId,
              basis: RISK_BASIS.BOOK,
              scoredAt,
              sourceEventId: bookedEvent.id,
              ...assessment
            };
            const riskDraft = createChainedEvent({
              streamId: jobId,
              type: "RISK_SCORED",
              actor: { type: "risk", id: "risk_v1" },
              payload: riskPayload,
              at: scoredAt
            });
            const eventsAfterRisk = appendChainedEvent({ events: eventsAfterBook, event: riskDraft, signer: serverSigner });
            riskEvent = eventsAfterRisk[eventsAfterRisk.length - 1];
            validateDomainEvent({ jobBefore: jobAfterBook, event: riskEvent, eventsBefore: eventsAfterBook });
            jobBeforeDispatch = reduceJob(eventsAfterRisk);
            eventsBeforeDispatch = eventsAfterRisk;
          } catch {
            riskEvent = null;
            eventsBeforeDispatch = eventsAfterBook;
            jobBeforeDispatch = jobAfterBook;
          }

          const requestedAt = nowIso();
          const dispatchRequestDraft = createChainedEvent({
            streamId: jobId,
            type: "DISPATCH_REQUESTED",
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: { jobId, requestedAt, trigger: "BOOKED" },
            at: requestedAt
          });
          const nextEvents = appendChainedEvent({ events: eventsBeforeDispatch, event: dispatchRequestDraft, signer: serverSigner });
          const dispatchRequestedEvent = nextEvents[nextEvents.length - 1];

          try {
            validateDomainEvent({ jobBefore: jobBeforeDispatch, event: dispatchRequestedEvent, eventsBefore: eventsBeforeDispatch });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          let ledgerEntries = [];
          try {
            ledgerEntries = ledgerEntriesForJobEvent({ jobBefore: job, event: bookedEvent, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "ledger posting rejected", { message: err?.message });
          }

          const responseBody = {
            event: bookedEvent,
            job: jobAfter,
            ledgerEntryId: ledgerEntries.length ? ledgerEntries[0]?.id ?? null : null,
            ledgerEntryIds: ledgerEntries.map((e) => e?.id).filter(Boolean),
            dispatchRequestedEventId: dispatchRequestedEvent.id
          };

          const outboxMessages = [];
          for (const entry of ledgerEntries) {
            if (!entry) continue;
            outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: bookedEvent.id, entry });
          }
          if (job.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: job.status, toStatus: jobAfter.status, at: bookedEvent.at });
          }
          outboxMessages.push({ type: "DISPATCH_REQUESTED", tenantId, jobId, sourceEventId: dispatchRequestedEvent.id, at: dispatchRequestedEvent.at });

          const appended = riskEvent ? [bookedEvent, riskEvent, dispatchRequestedEvent] : [bookedEvent, dispatchRequestedEvent];
          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appended }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });
          await commitTx(ops);
          return sendJson(res, 201, responseBody);
        }

        if (req.method === "POST" && parts[2] === "dispatch" && parts.length === 3) {
          const body = await readJsonBody(req);

	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

          if (job.status !== "BOOKED") return sendError(res, 400, "job is not dispatchable");
          if (!job.booking?.startAt || !job.booking?.endAt) return sendError(res, 400, "job booking window is missing");

          const requiresOperatorCoverage =
            job.booking.requiresOperatorCoverage === true || job.booking.environmentTier === ENV_TIER.ENV_IN_HOME;

          const window = { startAt: job.booking.startAt, endAt: job.booking.endAt };
          const zoneId = getJobZoneId(job);

          const availableOperators = listAvailableOperators({ tenantId, zoneId, window, ignoreJobId: jobId });
          if (requiresOperatorCoverage && availableOperators.length <= 0) {
            return sendError(res, 409, "insufficient operator coverage");
          }

          const robotsInZone = listAvailableRobots({ tenantId, zoneId, window, ignoreJobId: jobId });
          const { selected, candidates } = selectRobotForJob({
            robots: robotsInZone,
            window,
            reservations: (robotId, win) => robotHasOverlappingReservation({ tenantId, robotId, window: win, ignoreJobId: jobId }),
            minTrustScore: 0
          });
          if (!selected) return sendError(res, 409, "no available robots for window");

          const existing = getJobEvents(tenantId, jobId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const evaluatedAt = nowIso();
          const evalPayload = {
            jobId,
            evaluatedAt,
            window,
            zoneId,
            requiresOperatorCoverage,
            candidates: candidates.map((c) => ({ robotId: c.robotId, score: c.score, reasons: ["candidate"], rejected: false })).slice(0, 10),
            selected: { robotId: selected.robotId, operatorId: requiresOperatorCoverage ? availableOperators[0].id : null }
          };
          const evalDraft = createChainedEvent({
            streamId: jobId,
            type: "DISPATCH_EVALUATED",
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: evalPayload,
            at: evaluatedAt
          });
          const eventsAfterEval = appendChainedEvent({ events: existing, event: evalDraft, signer: serverSigner });
          const evalEvent = eventsAfterEval[eventsAfterEval.length - 1];

          try {
            validateDomainEvent({ jobBefore: job, event: evalEvent, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfterEval;
          try {
            jobAfterEval = reduceJob(eventsAfterEval);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

	          const matchDraft = createChainedEvent({
	            streamId: jobId,
	            type: "MATCHED",
	            actor: { type: "dispatch", id: "dispatch_v1" },
	            payload: {
	              robotId: selected.robotId,
	              score: selected.score,
	              algorithm: "trustScore_v2",
	              operatorContractHash: job.booking?.customerContractHash ?? null,
	              operatorPolicyHash: job.booking?.policyHash ?? null,
	              operatorCompilerId: job.booking?.customerCompilerId ?? null
	            },
	            at: nowIso()
	          });
          const eventsAfterMatch = appendChainedEvent({ events: eventsAfterEval, event: matchDraft, signer: serverSigner });
          const matchEvent = eventsAfterMatch[eventsAfterMatch.length - 1];

          try {
            validateDomainEvent({ jobBefore: jobAfterEval, event: matchEvent, eventsBefore: eventsAfterEval });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfterMatch;
          try {
            jobAfterMatch = reduceJob(eventsAfterMatch);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          const reservationPayload = {
            robotId: selected.robotId,
            startAt: window.startAt,
            endAt: window.endAt,
            reservationId: createId("rsv"),
            reservedUntil: window.startAt
          };
          const reserveDraft = createChainedEvent({
            streamId: jobId,
            type: "RESERVED",
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: reservationPayload,
            at: nowIso()
          });
          const nextEvents = appendChainedEvent({ events: eventsAfterMatch, event: reserveDraft, signer: serverSigner });
          const reservedEvent = nextEvents[nextEvents.length - 1];

          try {
            validateDomainEvent({ jobBefore: jobAfterMatch, event: reservedEvent, eventsBefore: eventsAfterMatch });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfter;
          try {
            jobAfter = reduceJob(nextEvents);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          let eventsFinal = nextEvents;
          const appendedEvents = [evalEvent, matchEvent, reservedEvent];

          if (requiresOperatorCoverage) {
            const operatorId = availableOperators[0].id;
            const coveragePayload = {
              jobId,
              operatorId,
              startAt: window.startAt,
              endAt: window.endAt,
              reservationId: createId("opcov"),
              zoneId
            };
            const coverageDraft = createChainedEvent({
              streamId: jobId,
              type: "OPERATOR_COVERAGE_RESERVED",
              actor: { type: "dispatch", id: "dispatch_v1" },
              payload: coveragePayload,
              at: nowIso()
            });
            eventsFinal = appendChainedEvent({ events: eventsFinal, event: coverageDraft, signer: serverSigner });
            const coverageEvent = eventsFinal[eventsFinal.length - 1];

            try {
              validateDomainEvent({ jobBefore: jobAfter, event: coverageEvent, eventsBefore: nextEvents });
            } catch (err) {
              return sendError(res, 400, "event rejected", { message: err?.message });
            }

            appendedEvents.push(coverageEvent);
            jobAfter = reduceJob(eventsFinal);
          }

          const confirmedAt = nowIso();
          const confirmDraft = createChainedEvent({
            streamId: jobId,
            type: "DISPATCH_CONFIRMED",
            actor: { type: "dispatch", id: "dispatch_v1" },
            payload: { jobId, confirmedAt },
            at: confirmedAt
          });
          eventsFinal = appendChainedEvent({ events: eventsFinal, event: confirmDraft, signer: serverSigner });
          const confirmEvent = eventsFinal[eventsFinal.length - 1];
          try {
            validateDomainEvent({ jobBefore: jobAfter, event: confirmEvent, eventsBefore: eventsFinal.slice(0, -1) });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }
          appendedEvents.push(confirmEvent);
          jobAfter = reduceJob(eventsFinal);

          const responseBody = { events: appendedEvents, job: jobAfter };
          const outboxMessages = [];
          if (job.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: job.status, toStatus: jobAfter.status, at: confirmedAt });
          }

          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appendedEvents }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });
          await commitTx(ops);

          return sendJson(res, 201, responseBody);
        }

	        if (req.method === "POST" && parts[2] === "reschedule" && parts.length === 3) {
          const body = await readJsonBody(req);

	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

          if (job.status !== "BOOKED" && job.status !== "MATCHED" && job.status !== "RESERVED") {
            return sendError(res, 400, "job is not reschedulable");
          }

          const booking = job.booking;
          if (!booking) return sendError(res, 400, "job is missing booking");

          const reschedulePayload = {
            jobId,
            oldWindow: { startAt: booking.startAt, endAt: booking.endAt },
            newWindow: { startAt: body?.startAt, endAt: body?.endAt },
            reason: body?.reason ?? "CUSTOMER_REQUEST",
            requestedBy: body?.requestedBy ?? "customer",
            requiresRequote: false
          };
          try {
            validateJobRescheduledPayload(reschedulePayload);
          } catch (err) {
            return sendError(res, 400, "invalid reschedule", { message: err?.message });
          }

          const newWindow = reschedulePayload.newWindow;

          const zoneId = getJobZoneId(job);
          const requiresOperatorCoverage = booking.requiresOperatorCoverage === true;
          const availableOperators = requiresOperatorCoverage ? listAvailableOperators({ tenantId, zoneId, window: newWindow, ignoreJobId: jobId }) : [];
          if (requiresOperatorCoverage && availableOperators.length <= 0) {
            return sendError(res, 409, "insufficient operator coverage");
          }

          const robotsInZone = listAvailableRobots({ tenantId, zoneId, window: newWindow, ignoreJobId: jobId });
          if (robotsInZone.length <= 0) return sendError(res, 409, "no available robots for window");

          const existing = getJobEvents(tenantId, jobId);
          const currentPrevChainHash = getCurrentPrevChainHash(existing);
          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
            return sendError(res, 409, "event append conflict", {
              expectedPrevChainHash: currentPrevChainHash,
              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
            });
          }

          const rescheduleDraft = createChainedEvent({
            streamId: jobId,
            type: "JOB_RESCHEDULED",
            at: nowIso(),
            actor: { type: "scheduler", id: "scheduler_v0" },
            payload: reschedulePayload
          });
          const eventsAfterReschedule = appendChainedEvent({ events: existing, event: rescheduleDraft, signer: serverSigner });
          const rescheduleEvent = eventsAfterReschedule[eventsAfterReschedule.length - 1];

          try {
            validateDomainEvent({ jobBefore: job, event: rescheduleEvent, eventsBefore: existing });
          } catch (err) {
            return sendError(res, 400, "event rejected", { message: err?.message });
          }

          let jobAfterReschedule;
          try {
            jobAfterReschedule = reduceJob(eventsAfterReschedule);
          } catch (err) {
            return sendError(res, 400, "job transition rejected", { message: err?.message });
          }

          let nextEvents = eventsAfterReschedule;
          const appendedEvents = [rescheduleEvent];
          let jobAfter = jobAfterReschedule;

          // If previously reserved, re-dispatch/reserve atomically (or fail).
          if (job.reservation) {
            const selection = selectRobotForJob({
              robots: robotsInZone,
              window: newWindow,
              reservations: (robotId, win) => robotHasOverlappingReservation({ tenantId, robotId, window: win, ignoreJobId: jobId }),
              minTrustScore: 0
            });
            const selected = selection.selected;
            if (!selected) return sendError(res, 409, "no available robots for window");

	            const matchDraft = createChainedEvent({
	              streamId: jobId,
	              type: "MATCHED",
	              at: nowIso(),
	              actor: { type: "dispatch", id: "dispatch_v1" },
	              payload: {
	                robotId: selected.robotId,
	                score: selected.score,
	                algorithm: "trustScore_v2",
	                operatorContractHash: jobAfterReschedule.booking?.customerContractHash ?? null,
	                operatorPolicyHash: jobAfterReschedule.booking?.policyHash ?? null,
	                operatorCompilerId: jobAfterReschedule.booking?.customerCompilerId ?? null
	              }
	            });
            const eventsAfterMatch = appendChainedEvent({ events: nextEvents, event: matchDraft, signer: serverSigner });
            const matchEvent = eventsAfterMatch[eventsAfterMatch.length - 1];

            try {
              validateDomainEvent({ jobBefore: jobAfterReschedule, event: matchEvent, eventsBefore: nextEvents });
            } catch (err) {
              return sendError(res, 400, "event rejected", { message: err?.message });
            }

            let jobAfterMatch;
            try {
              jobAfterMatch = reduceJob(eventsAfterMatch);
            } catch (err) {
              return sendError(res, 400, "job transition rejected", { message: err?.message });
            }

            const reservationPayload = {
              robotId: selected.robotId,
              startAt: newWindow.startAt,
              endAt: newWindow.endAt,
              reservationId: createId("rsv"),
              reservedUntil: newWindow.startAt
            };
            const reserveDraft = createChainedEvent({
              streamId: jobId,
              type: "RESERVED",
              at: nowIso(),
              actor: { type: "dispatch", id: "dispatch_v1" },
              payload: reservationPayload
            });
            const eventsAfterReserve = appendChainedEvent({ events: eventsAfterMatch, event: reserveDraft, signer: serverSigner });
            const reservedEvent = eventsAfterReserve[eventsAfterReserve.length - 1];

            try {
              validateDomainEvent({ jobBefore: jobAfterMatch, event: reservedEvent, eventsBefore: eventsAfterMatch });
            } catch (err) {
              return sendError(res, 400, "event rejected", { message: err?.message });
            }

            try {
              jobAfter = reduceJob(eventsAfterReserve);
            } catch (err) {
              return sendError(res, 400, "job transition rejected", { message: err?.message });
            }

            nextEvents = eventsAfterReserve;
            appendedEvents.push(matchEvent, reservedEvent);

            if (requiresOperatorCoverage) {
              const operatorId = availableOperators[0].id;
              const coveragePayload = {
                jobId,
                operatorId,
                startAt: newWindow.startAt,
                endAt: newWindow.endAt,
                reservationId: createId("opcov"),
                zoneId
              };
              const coverageDraft = createChainedEvent({
                streamId: jobId,
                type: "OPERATOR_COVERAGE_RESERVED",
                actor: { type: "dispatch", id: "dispatch_v1" },
                payload: coveragePayload,
                at: nowIso()
              });
              const eventsAfterCoverage = appendChainedEvent({ events: nextEvents, event: coverageDraft, signer: serverSigner });
              const coverageEvent = eventsAfterCoverage[eventsAfterCoverage.length - 1];

              try {
                validateDomainEvent({ jobBefore: jobAfter, event: coverageEvent, eventsBefore: nextEvents });
              } catch (err) {
                return sendError(res, 400, "event rejected", { message: err?.message });
              }

              try {
                jobAfter = reduceJob(eventsAfterCoverage);
              } catch (err) {
                return sendError(res, 400, "job transition rejected", { message: err?.message });
              }

              nextEvents = eventsAfterCoverage;
              appendedEvents.push(coverageEvent);
            }
          }

          const responseBody = { events: appendedEvents, job: jobAfter };
          const outboxMessages = [];
          if (job.status !== jobAfter.status) {
            outboxMessages.push({ type: "JOB_STATUS_CHANGED", tenantId, jobId, fromStatus: job.status, toStatus: jobAfter.status, at: rescheduleEvent.at });
          }

          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: appendedEvents }];
          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
          if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

          await commitTx(ops);

	          return sendJson(res, 201, responseBody);
	        }

	        if (req.method === "POST" && parts[2] === "dispute" && parts[3] === "open" && parts.length === 4) {
	          const body = await readJsonBody(req);
	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          const ok = requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
	          if (!ok) return sendError(res, 403, "forbidden");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

	          const existing = getJobEvents(tenantId, jobId);
	          const currentPrevChainHash = getCurrentPrevChainHash(existing);
	          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
	            return sendError(res, 409, "event append conflict", {
	              expectedPrevChainHash: currentPrevChainHash,
	              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
	            });
	          }

	          const disputeId = body?.disputeId ?? createId("dsp");
	          const openedAt = nowIso();
	          const payload = { jobId, disputeId, openedAt, reason: body?.reason ?? null };
	          const draft = createChainedEvent({
	            streamId: jobId,
	            type: "DISPUTE_OPENED",
	            actor: { type: "ops", id: principalId },
	            payload,
	            at: openedAt
	          });
	          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
	          const event = nextEvents[nextEvents.length - 1];

	          try {
	            validateDomainEvent({ jobBefore: reduceJob(existing), event, eventsBefore: existing });
	          } catch (err) {
	            return sendError(res, 400, "event rejected", { message: err?.message }, { code: err?.code ?? null });
	          }

	          let jobAfter;
	          try {
	            jobAfter = reduceJob(nextEvents);
	          } catch (err) {
	            return sendError(res, 400, "job transition rejected", { message: err?.message });
	          }

	          const responseBody = { event, job: jobAfter };
	          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
	          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
	          await commitTx(ops);
	          return sendJson(res, 201, responseBody);
	        }

	        if (req.method === "POST" && parts[2] === "dispute" && parts[3] === "close" && parts.length === 4) {
	          const body = await readJsonBody(req);
	          const expectedHeader = parseExpectedPrevChainHashHeader(req);
	          if (!expectedHeader.ok) return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");

	          const ok = requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
	          if (!ok) return sendError(res, 403, "forbidden");

	          let idemStoreKey = null;
	          let idemRequestHash = null;
	          try {
	            ({ idemStoreKey, idemRequestHash } = readIdempotency({
	              method: "POST",
	              requestPath: path,
	              expectedPrevChainHash: expectedHeader.expectedPrevChainHash,
	              body
	            }));
	          } catch (err) {
	            return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	          }
	          if (idemStoreKey) {
	            const existingIdem = store.idempotency.get(idemStoreKey);
	            if (existingIdem) {
	              if (existingIdem.requestHash !== idemRequestHash) {
	                return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
	              }
	              return sendJson(res, existingIdem.statusCode, existingIdem.body);
	            }
	          }

	          const existing = getJobEvents(tenantId, jobId);
	          const currentPrevChainHash = getCurrentPrevChainHash(existing);
	          if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
	            return sendError(res, 409, "event append conflict", {
	              expectedPrevChainHash: currentPrevChainHash,
	              gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
	            });
	          }

	          const disputeId = body?.disputeId ?? null;
	          if (typeof disputeId !== "string" || disputeId.trim() === "") return sendError(res, 400, "disputeId is required");

	          const closedAt = nowIso();
	          const payload = { jobId, disputeId, closedAt, resolution: body?.resolution ?? null };
	          const draft = createChainedEvent({
	            streamId: jobId,
	            type: "DISPUTE_CLOSED",
	            actor: { type: "ops", id: principalId },
	            payload,
	            at: closedAt
	          });
	          const nextEvents = appendChainedEvent({ events: existing, event: draft, signer: serverSigner });
	          const event = nextEvents[nextEvents.length - 1];

	          try {
	            validateDomainEvent({ jobBefore: reduceJob(existing), event, eventsBefore: existing });
	          } catch (err) {
	            return sendError(res, 400, "event rejected", { message: err?.message }, { code: err?.code ?? null });
	          }

	          let jobAfter;
	          try {
	            jobAfter = reduceJob(nextEvents);
	          } catch (err) {
	            return sendError(res, 400, "job transition rejected", { message: err?.message });
	          }

	          const responseBody = { event, job: jobAfter };
	          const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
	          if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
	          await commitTx(ops);
	          return sendJson(res, 201, responseBody);
	        }

	        if (parts[2] === "events") {
	          if (req.method === "GET" && parts.length === 3) {
	            return sendJson(res, 200, { events: getJobEvents(tenantId, jobId) });
	          }

          if (req.method === "POST" && parts.length === 3) {
            if (!requireProtocolHeaderForWrite(req, res)) return;
            const body = await readJsonBody(req);
            {
              const schemaCheck = parseEventSchemaVersionFromBody(body);
              if (!schemaCheck.ok) return sendError(res, schemaCheck.statusCode ?? 400, schemaCheck.message, schemaCheck.details ?? null, { code: schemaCheck.code });
            }
	            const type = body?.type;
	            if (!type) return sendError(res, 400, "type is required");

	            {
	              const financeOnly = new Set(["SETTLED", "SETTLEMENT_FORFEITED", "DECISION_RECORDED"]);
	              const dispute = new Set(["DISPUTE_OPENED", "DISPUTE_CLOSED"]);
	              if (financeOnly.has(type)) {
	                if (!requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE)) return sendError(res, 403, "forbidden");
	              } else if (dispute.has(type)) {
	                const ok = requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE) || requireScope(auth.scopes, OPS_SCOPES.FINANCE_WRITE);
	                if (!ok) return sendError(res, 403, "forbidden");
	              } else {
	                if (!requireScope(auth.scopes, OPS_SCOPES.OPS_WRITE)) return sendError(res, 403, "forbidden");
	              }
	            }

	            const signerKind = requiredSignerKindForEventType(type);
	            const existing = getJobEvents(tenantId, jobId);
	            const jobBefore = reduceJob(existing);
		            if (!jobBefore) return sendError(res, 404, "job not found");
	            const currentPrevChainHash = getCurrentPrevChainHash(existing);

	            const expectedHeader = parseExpectedPrevChainHashHeader(req);
	            let idemStoreKey = null;
	            let idemRequestHash = null;
	            try {
	              ({ idemStoreKey, idemRequestHash } = readIdempotency({
	                method: "POST",
	                requestPath: path,
	                expectedPrevChainHash: expectedHeader.ok ? expectedHeader.expectedPrevChainHash : null,
	                body
	              }));
	            } catch (err) {
	              return sendError(res, 400, "invalid idempotency key", { message: err?.message });
	            }
	            if (idemStoreKey) {
	              const existingIdem = store.idempotency.get(idemStoreKey);
	              if (existingIdem) {
	                if (existingIdem.requestHash !== idemRequestHash) {
	                  return sendError(res, 409, "idempotency key conflict", "request differs from initial use of this key");
                }
                return sendJson(res, existingIdem.statusCode, existingIdem.body);
              }
            }

            // If a client supplies hash/signature, treat it as a finalized (agent-signed) event.
            const isClientFinalized = Boolean(body?.payloadHash || body?.chainHash || body?.signature || body?.signerKeyId || body?.prevChainHash);

            let nextEvents;
            let event;

            if (isClientFinalized) {
              event = {
                v: body?.v ?? 1,
                id: body?.id,
                at: body?.at,
                streamId: body?.streamId,
                type,
                actor: body?.actor ?? null,
                payload: body?.payload ?? null,
                payloadHash: body?.payloadHash ?? null,
                prevChainHash: body?.prevChainHash ?? null,
                chainHash: body?.chainHash ?? null,
                signature: body?.signature ?? null,
                signerKeyId: body?.signerKeyId ?? null
              };

              try {
                if (event.v !== 1) throw new TypeError("event.v must be 1");
                assertNonEmptyString(event.id, "event.id");
                assertIsoDate(event.at, "event.at");
                assertNonEmptyString(event.streamId, "event.streamId");
                if (event.streamId !== jobId) throw new TypeError("event.streamId must match jobId");
                assertActor(event.actor);
                assertNonEmptyString(event.type, "event.type");
                assertNonEmptyString(event.payloadHash, "event.payloadHash");
                assertNonEmptyString(event.chainHash, "event.chainHash");
              } catch (err) {
                return sendError(res, 400, "invalid event envelope", { message: err?.message });
              }

              {
                const atMs = Date.parse(event.at);
                const nowMs = Date.parse(nowIso());
                const maxSkewMs = 5 * 60_000;
                if (Number.isFinite(atMs) && Number.isFinite(nowMs) && atMs > nowMs + maxSkewMs) {
                  return sendError(res, 400, "event.at is too far in the future");
                }
              }

              if (event.prevChainHash !== currentPrevChainHash) {
                return sendError(res, 409, "event append conflict", {
                  expectedPrevChainHash: currentPrevChainHash,
                  gotPrevChainHash: event.prevChainHash
                });
              }

              nextEvents = [...existing, event];
              const verify = verifyChainedEvents(nextEvents, { publicKeyByKeyId: store.publicKeyByKeyId });
              if (!verify.ok) return sendError(res, 400, "event chain verification failed", verify.error);

              try {
                enforceSignaturePolicy({ tenantId, signerKind, event });
              } catch (err) {
                return sendError(res, 400, "signature policy rejected", { message: err?.message });
              }
            } else {
              try {
                assertActor(body?.actor);
              } catch (err) {
                return sendError(res, 400, "invalid actor", { message: err?.message });
              }

              if (
                signerKind === SIGNER_KIND.ROBOT ||
                signerKind === SIGNER_KIND.OPERATOR ||
                signerKind === SIGNER_KIND.ROBOT_OR_OPERATOR
              ) {
                return sendError(res, 400, "event must be client-finalized and signed for this type");
              }
              if (body.actor.type === "robot" || body.actor.type === "operator") {
                return sendError(res, 400, "robot/operator actors must use signer-enforced event types");
              }

              if (!expectedHeader.ok) {
                return sendError(res, 428, "missing precondition", "x-proxy-expected-prev-chain-hash is required");
              }
              if (expectedHeader.expectedPrevChainHash !== currentPrevChainHash) {
                return sendError(res, 409, "event append conflict", {
                  expectedPrevChainHash: currentPrevChainHash,
                  gotExpectedPrevChainHash: expectedHeader.expectedPrevChainHash
                });
              }

	              let serverPayload = body?.payload ?? null;
	              if (type === "DECISION_RECORDED") {
	                const base = serverPayload && typeof serverPayload === "object" && !Array.isArray(serverPayload) ? serverPayload : {};
	                const decisionId = typeof base.decisionId === "string" && base.decisionId.trim() ? base.decisionId : createId("dec");
	                const kind = typeof base.kind === "string" && base.kind.trim() ? base.kind : "SETTLEMENT_FORFEIT";

	                // Best-effort: infer holdId from the current active hold if omitted.
	                let holdId = typeof base.holdId === "string" && base.holdId.trim() ? base.holdId : null;
	                if (!holdId) {
	                  for (let i = existing.length - 1; i >= 0; i -= 1) {
	                    const e = existing[i];
	                    if (e?.type !== "SETTLEMENT_HELD") continue;
	                    const hp = e.payload ?? null;
	                    if (!hp || typeof hp !== "object") continue;
	                    if (typeof hp.holdId === "string" && hp.holdId.trim()) {
	                      holdId = hp.holdId;
	                      break;
	                    }
	                  }
	                }

	                serverPayload = {
	                  jobId,
	                  decisionId,
	                  decidedAt: nowIso(),
	                  kind,
	                  holdId,
	                  forfeitureReason: base.forfeitureReason ?? base.reason ?? null,
	                  reasonCodes: Array.isArray(base.reasonCodes) ? base.reasonCodes : [],
	                  evidenceRefs: Array.isArray(base.evidenceRefs) ? base.evidenceRefs : [],
	                  policyHash: base.policyHash ?? jobBefore?.booking?.policyHash ?? jobBefore?.customerPolicyHash ?? null
	                };
	              }
	              if (type === "SETTLED") {
                const proofPolicy = jobBefore.booking?.policySnapshot?.proofPolicy ?? null;
                const gateModeRaw = typeof proofPolicy?.gateMode === "string" ? proofPolicy.gateMode : "warn";
                const gateMode = gateModeRaw === "strict" || gateModeRaw === "holdback" ? gateModeRaw : "warn";

                if (jobBefore.status === "COMPLETED" && gateMode !== "warn") {
                  let completionChainHash = null;
                  for (let i = existing.length - 1; i >= 0; i -= 1) {
                    const e = existing[i];
                    if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
                    const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
                    if (!ch) continue;
                    completionChainHash = ch;
                    break;
                  }

                  const anchorIdx = completionChainHash ? existing.findIndex((e) => e?.chainHash === completionChainHash) : -1;
                  const anchorSlice = anchorIdx === -1 ? null : existing.slice(0, anchorIdx + 1);
                  const jobAtAnchor = anchorSlice ? reduceJob(anchorSlice) : null;
                  const current =
                    jobAtAnchor && completionChainHash
                      ? verifyZoneCoverageProofV1({
                          job: jobAtAnchor,
                          events: existing,
                          evaluatedAtChainHash: completionChainHash,
                          customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
                          operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
                        })
                      : null;
                  const expectedFactsHash = current?.factsHash ?? null;
                  const expectedCustomerPolicyHash = current?.anchors?.customerPolicyHash ?? (jobAtAnchor?.customerPolicyHash ?? jobAtAnchor?.booking?.policyHash ?? null);

                  let proofEvent = null;
                  if (completionChainHash && expectedFactsHash) {
                    for (let i = existing.length - 1; i >= 0; i -= 1) {
                      const e = existing[i];
                      if (e?.type !== "PROOF_EVALUATED") continue;
                      const p = e.payload ?? null;
                      if (!p || typeof p !== "object") continue;
                      if (p.evaluatedAtChainHash !== completionChainHash) continue;
                      if (p.factsHash !== expectedFactsHash) continue;
                      if (expectedCustomerPolicyHash && p.customerPolicyHash !== expectedCustomerPolicyHash) continue;
                      proofEvent = e;
                      break;
                    }
                  }

	                  if (proofEvent) {
	                    const p = proofEvent.payload ?? {};
	                    const proofStatus = p.status === null || p.status === undefined ? null : String(p.status).trim();
	
	                    let forfeit = null;
	                    if (proofStatus === "INSUFFICIENT_EVIDENCE") {
	                      let holdId = null;
	                      for (let i = existing.length - 1; i >= 0; i -= 1) {
	                        const e = existing[i];
	                        if (e?.type !== "SETTLEMENT_HELD") continue;
	                        const hp = e.payload ?? null;
	                        if (!hp || typeof hp !== "object") continue;
	                        if (hp.evaluatedAtChainHash !== completionChainHash) continue;
	                        if (hp.factsHash !== expectedFactsHash) continue;
	                        if (typeof hp.holdId === "string" && hp.holdId.trim()) {
	                          holdId = hp.holdId;
	                          break;
	                        }
	                      }
	
	                      const forfeitEvent =
	                        holdId &&
	                        existing
	                          .slice()
	                          .reverse()
	                          .find((e) => e?.type === "SETTLEMENT_FORFEITED" && e?.payload?.holdId === holdId && e?.payload?.factsHash === expectedFactsHash);
	                      if (forfeitEvent) {
	                        const fp = forfeitEvent.payload ?? null;
	                        forfeit = {
	                          holdId,
	                          forfeitureReason: fp?.forfeitureReason ?? null,
	                          forfeitEventId: forfeitEvent.id ?? null,
	                          forfeitEventChainHash: forfeitEvent.chainHash ?? null,
	                          forfeitEventPayloadHash: forfeitEvent.payloadHash ?? null
	                        };
	                      }
	                    }
	
	                    if (proofStatus !== "INSUFFICIENT_EVIDENCE" || forfeit) {
	                      const settlementProofRef = {
	                        proofEventId: proofEvent.id ?? null,
	                        proofEventAt: p.evaluatedAt ?? proofEvent.at ?? null,
	                        proofEventChainHash: proofEvent.chainHash ?? null,
	                        proofEventPayloadHash: proofEvent.payloadHash ?? null,
	                        proofEventSignerKeyId: proofEvent.signerKeyId ?? null,
	                        proofEventSignature: proofEvent.signature ?? null,
	                        evaluationId: p.evaluationId ?? null,
	                        evaluatedAtChainHash: p.evaluatedAtChainHash ?? null,
	                        status: forfeit ? "FAIL" : proofStatus,
	                        reasonCodes: Array.isArray(p.reasonCodes) ? p.reasonCodes : [],
	                        requiredZonesHash: p.requiredZonesHash ?? null,
	                        customerPolicyHash: p.customerPolicyHash ?? null,
	                        operatorPolicyHash: p.operatorPolicyHash ?? null,
	                        factsHash: p.factsHash ?? null,
	                        metrics: p.metrics ?? null,
	                        ...(forfeit ? { forfeit } : null)
	                      };

	                      const base = serverPayload && typeof serverPayload === "object" && !Array.isArray(serverPayload) ? serverPayload : {};
	                      serverPayload = { ...base, settlementProofRef };
	                    }
	                  }
	                }
	              }

	              if (type === "SETTLEMENT_FORFEITED") {
	                const base = serverPayload && typeof serverPayload === "object" && !Array.isArray(serverPayload) ? serverPayload : {};
	                let completionChainHash = null;
	                for (let i = existing.length - 1; i >= 0; i -= 1) {
	                  const e = existing[i];
	                  if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
	                  const ch = typeof e?.chainHash === "string" ? e.chainHash.trim() : "";
	                  if (!ch) continue;
	                  completionChainHash = ch;
	                  break;
	                }
	
	                const anchorIdx = completionChainHash ? existing.findIndex((e) => e?.chainHash === completionChainHash) : -1;
	                const anchorSlice = anchorIdx === -1 ? null : existing.slice(0, anchorIdx + 1);
	                const jobAtAnchor = anchorSlice ? reduceJob(anchorSlice) : null;
	                const current =
	                  jobAtAnchor && completionChainHash
	                    ? verifyZoneCoverageProofV1({
	                        job: jobAtAnchor,
	                        events: existing,
	                        evaluatedAtChainHash: completionChainHash,
	                        customerPolicyHash: jobAtAnchor.customerPolicyHash ?? jobAtAnchor.booking?.policyHash ?? null,
	                        operatorPolicyHash: jobAtAnchor.operatorPolicyHash ?? null
	                      })
	                    : null;
	                const expectedFactsHash = current?.factsHash ?? null;
	
	                let holdId = typeof base.holdId === "string" && base.holdId.trim() ? base.holdId : null;
	                if (!holdId && completionChainHash && expectedFactsHash) {
	                  for (let i = existing.length - 1; i >= 0; i -= 1) {
	                    const e = existing[i];
	                    if (e?.type !== "SETTLEMENT_HELD") continue;
	                    const hp = e.payload ?? null;
	                    if (!hp || typeof hp !== "object") continue;
	                    if (hp.evaluatedAtChainHash !== completionChainHash) continue;
	                    if (hp.factsHash !== expectedFactsHash) continue;
	                    if (typeof hp.holdId === "string" && hp.holdId.trim()) {
	                      holdId = hp.holdId;
	                      break;
	                    }
	                  }
	                }
	
	                serverPayload = {
	                  ...base,
	                  jobId,
	                  holdId,
	                  forfeitedAt: nowIso(),
	                  forfeitureReason: base.forfeitureReason ?? base.reason ?? "MANUAL",
	                  decisionRef: base.decisionRef ?? null,
	                  evaluatedAtChainHash: completionChainHash,
	                  factsHash: expectedFactsHash
	                };

	                // Prefer a verifiable, signed decision event reference when present.
	                let decisionEvent = null;
	                const decisionEventIdRaw = typeof base.decisionEventId === "string" && base.decisionEventId.trim() ? base.decisionEventId : null;
	                const decisionIdRaw = typeof base.decisionId === "string" && base.decisionId.trim() ? base.decisionId : null;

	                if (decisionEventIdRaw) {
	                  decisionEvent = existing.find((e) => e?.id === decisionEventIdRaw) ?? null;
	                } else if (decisionIdRaw) {
	                  decisionEvent =
	                    existing
	                      .slice()
	                      .reverse()
	                      .find((e) => e?.type === "DECISION_RECORDED" && e?.payload?.decisionId === decisionIdRaw) ?? null;
	                } else {
	                  decisionEvent =
	                    existing
	                      .slice()
	                      .reverse()
	                      .find(
	                        (e) =>
	                          e?.type === "DECISION_RECORDED" &&
	                          e?.payload?.kind === "SETTLEMENT_FORFEIT" &&
	                          e?.payload?.holdId === holdId &&
	                          e?.payload?.forfeitureReason === (serverPayload.forfeitureReason ?? null)
	                      ) ?? null;
	                }

	                if (decisionEvent && decisionEvent.type === "DECISION_RECORDED") {
	                  const p = decisionEvent.payload ?? null;
	                  serverPayload = {
	                    ...serverPayload,
	                    decisionEventRef: {
	                      decisionEventId: decisionEvent.id ?? null,
	                      decisionEventAt: p?.decidedAt ?? decisionEvent.at ?? null,
	                      decisionEventChainHash: decisionEvent.chainHash ?? null,
	                      decisionEventPayloadHash: decisionEvent.payloadHash ?? null,
	                      decisionEventSignerKeyId: decisionEvent.signerKeyId ?? null,
	                      decisionEventSignature: decisionEvent.signature ?? null,
	                      decisionId: p?.decisionId ?? null,
	                      kind: p?.kind ?? null,
	                      holdId: p?.holdId ?? null,
	                      forfeitureReason: p?.forfeitureReason ?? null,
	                      reasonCodes: Array.isArray(p?.reasonCodes) ? p.reasonCodes : [],
	                      evidenceRefs: Array.isArray(p?.evidenceRefs) ? p.evidenceRefs : [],
	                      policyHash: p?.policyHash ?? null
	                    }
	                  };
	                }
	              }

	              event = createChainedEvent({
	                streamId: jobId,
	                type,
                actor: body?.actor,
                payload: serverPayload,
                at: nowIso()
              });
              nextEvents = appendChainedEvent({ events: existing, event, signer: serverSigner });
              event = nextEvents[nextEvents.length - 1];
            }

            try {
              validateDomainEvent({ jobBefore, event, eventsBefore: existing });
            } catch (err) {
              if (err?.code === "TENANT_QUOTA_EXCEEDED") {
                return sendError(res, 429, "tenant quota exceeded", err?.quota ?? { message: err?.message }, { code: "TENANT_QUOTA_EXCEEDED" });
              }
              return sendError(res, 400, "event rejected", { message: err?.message }, { code: err?.code ?? null });
            }

            let jobAfter;
            try {
              jobAfter = reduceJob(nextEvents);
            } catch (err) {
              return sendError(res, 400, "job transition rejected", {
                name: err?.name,
                message: err?.message,
                fromStatus: err?.fromStatus,
                eventType: err?.eventType
              });
            }

            let ledgerEntries = [];
            try {
              ledgerEntries = ledgerEntriesForJobEvent({ jobBefore, event, eventsBefore: existing });
            } catch (err) {
              return sendError(res, 400, "ledger posting rejected", { message: err?.message });
            }

            const responseBody = {
              event,
              job: jobAfter,
              ledgerEntryId: ledgerEntries.length ? ledgerEntries[0]?.id ?? null : null,
              ledgerEntryIds: ledgerEntries.map((e) => e?.id).filter(Boolean)
            };

            const outboxMessages = [];
            for (const entry of ledgerEntries) {
              if (!entry) continue;
              outboxMessages.push({ type: "LEDGER_ENTRY_APPLY", tenantId, jobId, sourceEventId: event.id, entry });
            }
            if (jobBefore?.status !== jobAfter?.status) {
              outboxMessages.push({
                type: "JOB_STATUS_CHANGED",
                tenantId,
                jobId,
                fromStatus: jobBefore.status,
                toStatus: jobAfter.status,
                at: event.at
              });
            }
            if (event.type === "SETTLED") {
              outboxMessages.push({ type: "JOB_SETTLED", tenantId, jobId, settledEventId: event.id, at: event.at, sourceEventId: event.id });
            }
            if (event.type === "INCIDENT_DETECTED" || event.type === "INCIDENT_REPORTED") {
              const robotId = jobAfter.execution?.robotId ?? jobAfter.reservation?.robotId ?? jobAfter.match?.robotId ?? null;
              if (robotId) {
                outboxMessages.push({
                  type: "INCIDENT_RECORDED",
                  tenantId,
                  jobId,
                  robotId,
                  incidentId: event.payload?.incidentId ?? null,
                  incidentType: event.payload?.type ?? null,
                  severity: event.payload?.severity ?? null,
                  at: event.at,
                  sourceEventId: event.id
                });
              }
            }

	            // Proof re-evaluation: if evidence that affects proof arrives after completion, enqueue a re-eval for the completion anchor.
	            if (event.type === "ZONE_COVERAGE_REPORTED" || event.type === "INCIDENT_DETECTED" || event.type === "INCIDENT_REPORTED") {
	              if (jobAfter?.status === "COMPLETED") {
	                let completionChainHash = null;
                for (let i = nextEvents.length - 1; i >= 0; i -= 1) {
                  const e = nextEvents[i];
                  if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
                  if (typeof e.chainHash === "string" && e.chainHash.trim()) {
                    completionChainHash = e.chainHash;
                    break;
                  }
                }
	                if (completionChainHash) {
	                  outboxMessages.push({
	                    type: "PROOF_EVAL_ENQUEUE",
	                    tenantId,
	                    jobId,
	                    sourceEventId: event.id,
	                    evaluatedAtChainHash: completionChainHash,
	                    sourceAt: event.at ?? null
	                  });
	                }
	              }

	              // Post-settlement proof re-evaluation is governed: only allow if a dispute is open,
	              // or within the configured dispute window (if explicitly enabled).
	              if (jobAfter?.status === "SETTLED") {
	                const disputeOpen = jobAfter?.dispute?.status === "OPEN";
	                const proofPolicy = jobAfter?.booking?.policySnapshot?.proofPolicy ?? null;
	                const disputeWindowDays = Number.isSafeInteger(proofPolicy?.disputeWindowDays) ? proofPolicy.disputeWindowDays : 0;
	                const allowWindow = proofPolicy?.allowReproofAfterSettlementWithinDisputeWindow === true && disputeWindowDays > 0;
	                const settledAtMs = jobAfter?.settlement?.settledAt ? Date.parse(String(jobAfter.settlement.settledAt)) : NaN;
	                const atMs = event.at ? Date.parse(String(event.at)) : NaN;
	                const withinWindow = allowWindow && Number.isFinite(settledAtMs) && Number.isFinite(atMs) && atMs <= settledAtMs + disputeWindowDays * 24 * 60 * 60_000;

	                if (disputeOpen || withinWindow) {
	                  let completionChainHash = null;
	                  for (let i = nextEvents.length - 1; i >= 0; i -= 1) {
	                    const e = nextEvents[i];
	                    if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
	                    if (typeof e.chainHash === "string" && e.chainHash.trim()) {
	                      completionChainHash = e.chainHash;
	                      break;
	                    }
	                  }
	                  if (completionChainHash) {
	                    outboxMessages.push({
	                      type: "PROOF_EVAL_ENQUEUE",
	                      tenantId,
	                      jobId,
	                      sourceEventId: event.id,
	                      evaluatedAtChainHash: completionChainHash,
	                      sourceAt: event.at ?? null
	                    });
	                  }
	                } else {
	                  try {
	                    store.metrics?.incCounter?.("proof_reeval_skipped_total", { reason: "job_settled" }, 1);
	                  } catch {}
	                }
	              }
	            }

	            if (event.type === "DISPUTE_OPENED") {
	              let completionChainHash = null;
	              for (let i = nextEvents.length - 1; i >= 0; i -= 1) {
	                const e = nextEvents[i];
	                if (e?.type !== "EXECUTION_COMPLETED" && e?.type !== "JOB_EXECUTION_COMPLETED") continue;
	                if (typeof e.chainHash === "string" && e.chainHash.trim()) {
	                  completionChainHash = e.chainHash;
	                  break;
	                }
	              }
	              if (completionChainHash) {
	                outboxMessages.push({
	                  type: "PROOF_EVAL_ENQUEUE",
	                  tenantId,
	                  jobId,
	                  sourceEventId: event.id,
	                  evaluatedAtChainHash: completionChainHash,
	                  sourceAt: event.at ?? null
	                });
	              }
	            }

            const ops = [{ kind: "JOB_EVENTS_APPENDED", tenantId, jobId, events: [event] }];
            if (idemStoreKey) ops.push({ kind: "IDEMPOTENCY_PUT", key: idemStoreKey, value: { requestHash: idemRequestHash, statusCode: 201, body: responseBody } });
            if (outboxMessages.length) ops.push({ kind: "OUTBOX_ENQUEUE", messages: outboxMessages });

            await commitTx(ops);

            return sendJson(res, 201, responseBody);
          }
        }
      }

      return sendError(res, 404, "not found");
    } catch (err) {
      const statusCode = Number(err?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return sendError(res, statusCode, err?.message ?? "bad request");
      }
      return sendError(res, 500, "internal error", { message: err?.message });
    } finally {
      const statusCode = Number(res?.statusCode ?? 0);
      const durationMs = Date.now() - startedMs;
      metricInc("http_requests_total", { route, method: String(req.method ?? ""), status: String(statusCode) }, 1);

	      if (
	        req.method === "POST" &&
	        (route === "/jobs/:jobId/events" || route === "/robots/:robotId/events" || route === "/operators/:operatorId/events") &&
	        statusCode >= 400
	      ) {
	        const reason = typeof res?.__settldErrorCode === "string" && res.__settldErrorCode.trim() ? res.__settldErrorCode : "UNKNOWN";
	        metricInc("append_rejected_total", { reason }, 1);
	      }

	      if (req.method === "POST" && route === "/jobs/:jobId/events") {
	        const eventType = typeof res?.__settldEventType === "string" ? res.__settldEventType : null;
	        const reason = typeof res?.__settldErrorCode === "string" && res.__settldErrorCode.trim() ? res.__settldErrorCode : "UNKNOWN";
	        if (eventType === "SETTLED" && statusCode >= 400) metricInc("settlement_rejected_total", { reason }, 1);
	        if (eventType === "SETTLEMENT_HELD" && statusCode === 201) metricInc("settlement_held_total", {}, 1);
	        if (eventType === "SETTLEMENT_RELEASED" && statusCode === 201) metricInc("settlement_released_total", {}, 1);
	      }

      const level = logLevelForStatus(statusCode);
      logger[level]("http.request", {
        tenantId,
        principalId,
        requestId,
        route,
        method: req.method,
        path,
        statusCode,
        durationMs,
        code: res?.__settldErrorCode ?? null
      });
    }
    });
  }

  const { tickArtifacts } = createArtifactWorker({
    store,
    nowIso,
    getJobEvents,
    listDestinationsForTenant
  });
  const { tickProof } = createProofWorker({
    store,
    nowIso,
    getJobEvents,
    serverSigner,
    validateDomainEvent,
    commitTx
  });
  const { tickDeliveries } = createDeliveryWorker({
    store,
    nowIso,
    listDestinationsForTenant,
    maxAttempts: deliveryMaxAttempts,
    backoffBaseMs: deliveryBackoffBaseMs,
    backoffMaxMs: deliveryBackoffMaxMs,
    random: deliveryRandom,
    fetchFn
  });

  return {
    store,
    handle,
    tickLiveness,
    tickMonthClose,
    tickDispatch,
    tickOperatorQueue,
    tickRobotHealth,
    tickJobAccounting,
    tickEvidenceRetention,
    tickRetentionCleanup,
    tickProof,
    tickArtifacts,
    tickDeliveries
  };
}
