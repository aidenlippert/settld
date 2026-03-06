import { normalizeSignerKeyStatus, SIGNER_KEY_STATUS } from "../../core/signer-keys.js";

export const IDENTITY_SIGNER_LIFECYCLE_REASON_CODES = Object.freeze({
  SIGNER_KEY_ID_MISSING: "IDENTITY_SIGNER_KEY_ID_MISSING",
  SIGNER_EVENT_TIME_INVALID: "IDENTITY_SIGNER_EVENT_TIME_INVALID",
  SIGNER_KEY_STATUS_INVALID: "IDENTITY_SIGNER_KEY_STATUS_INVALID",
  SIGNER_KEY_LIFECYCLE_INVALID: "IDENTITY_SIGNER_KEY_LIFECYCLE_INVALID",
  SIGNER_KEY_NOT_REGISTERED: "IDENTITY_SIGNER_KEY_NOT_REGISTERED",
  SIGNER_KEY_NOT_ACTIVE: "IDENTITY_SIGNER_KEY_NOT_ACTIVE",
  SIGNER_KEY_NOT_YET_VALID: "IDENTITY_SIGNER_KEY_NOT_YET_VALID",
  SIGNER_KEY_EXPIRED: "IDENTITY_SIGNER_KEY_EXPIRED",
  SIGNER_KEY_ROTATED: "IDENTITY_SIGNER_KEY_ROTATED",
  SIGNER_KEY_REVOKED: "IDENTITY_SIGNER_KEY_REVOKED"
});

export const IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES = Object.freeze({
  KEY_ID_MISSING: "KEY_ID_MISSING",
  KEY_EVENT_TIME_INVALID: "KEY_EVENT_TIME_INVALID",
  KEY_STATUS_INVALID: "KEY_STATUS_INVALID",
  KEY_LIFECYCLE_INVALID: "KEY_LIFECYCLE_INVALID",
  KEY_NOT_REGISTERED: "KEY_NOT_REGISTERED",
  KEY_NOT_ACTIVE: "KEY_NOT_ACTIVE",
  KEY_NOT_YET_VALID: "KEY_NOT_YET_VALID",
  KEY_EXPIRED: "KEY_EXPIRED",
  KEY_ROTATED: "KEY_ROTATED",
  KEY_REVOKED: "KEY_REVOKED"
});

const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const LEGACY_TO_CANONICAL_REASON_CODE = Object.freeze({
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_ID_MISSING]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_ID_MISSING,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_EVENT_TIME_INVALID]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_EVENT_TIME_INVALID,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_STATUS_INVALID]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_STATUS_INVALID,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_LIFECYCLE_INVALID]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_LIFECYCLE_INVALID,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_REGISTERED]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_NOT_REGISTERED,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_ACTIVE]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_NOT_ACTIVE,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_YET_VALID]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_NOT_YET_VALID,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_EXPIRED]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_EXPIRED,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_ROTATED]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_ROTATED,
  [IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_REVOKED]: IDENTITY_SIGNER_LIFECYCLE_CANONICAL_REASON_CODES.KEY_REVOKED
});

function buildLifecycleDecision({
  ok,
  code = null,
  error = null,
  signerStatus = null,
  validFrom = null,
  validTo = null,
  rotatedAt = null,
  revokedAt = null
} = {}) {
  const legacyCode = code;
  const canonicalCode = legacyCode ? LEGACY_TO_CANONICAL_REASON_CODE[legacyCode] ?? null : null;
  return {
    ok,
    code: legacyCode,
    legacyCode,
    canonicalCode,
    error,
    signerStatus,
    validFrom,
    validTo,
    rotatedAt,
    revokedAt
  };
}

function normalizeIsoDate(value, fieldName) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value !== "string") throw new TypeError(`${fieldName} must be an ISO date-time`);
  const iso = String(value).trim();
  if (!ISO_DATE_TIME_PATTERN.test(iso)) throw new TypeError(`${fieldName} must be an ISO date-time`);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new TypeError(`${fieldName} must be an ISO date-time`);
  return { iso, ms };
}

function validateLifecycleWindow({ validFrom, validTo } = {}) {
  if (validFrom && validTo && validFrom.ms > validTo.ms) {
    throw new TypeError("signerKey.validFrom must be less than or equal to signerKey.validTo");
  }
}

export function evaluateSignerLifecycleForContinuity({ signerKey = null, at = null, requireRegistered = true } = {}) {
  if (!signerKey || typeof signerKey !== "object" || Array.isArray(signerKey)) {
    if (requireRegistered) {
      return buildLifecycleDecision({
        ok: false,
        code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_REGISTERED,
        error: "signer key is not registered"
      });
    }
    return buildLifecycleDecision({
      ok: true,
      code: null
    });
  }

  const atIso = typeof at === "string" && at.trim() !== "" ? at.trim() : null;
  if (!atIso) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_EVENT_TIME_INVALID,
      error: "evaluation time is required"
    });
  }
  if (!ISO_DATE_TIME_PATTERN.test(atIso)) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_EVENT_TIME_INVALID,
      error: "evaluation time must be an ISO date-time"
    });
  }
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_EVENT_TIME_INVALID,
      error: "evaluation time must be an ISO date-time"
    });
  }

  let signerStatus = null;
  let validFrom = null;
  let validTo = null;
  let rotatedAt = null;
  let revokedAt = null;
  try {
    signerStatus = normalizeSignerKeyStatus(signerKey.status ?? SIGNER_KEY_STATUS.ACTIVE);
  } catch {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_STATUS_INVALID,
      error: "signer key status is invalid"
    });
  }

  try {
    validFrom = normalizeIsoDate(signerKey.validFrom ?? null, "signerKey.validFrom");
    validTo = normalizeIsoDate(signerKey.validTo ?? null, "signerKey.validTo");
    rotatedAt = normalizeIsoDate(signerKey.rotatedAt ?? null, "signerKey.rotatedAt");
    revokedAt = normalizeIsoDate(signerKey.revokedAt ?? null, "signerKey.revokedAt");
    validateLifecycleWindow({ validFrom, validTo });
  } catch (err) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_LIFECYCLE_INVALID,
      error: err?.message ?? "signer key lifecycle fields are invalid",
      signerStatus
    });
  }

  if (signerStatus !== SIGNER_KEY_STATUS.ACTIVE) {
    if (signerStatus === SIGNER_KEY_STATUS.ROTATED) {
      return buildLifecycleDecision({
        ok: false,
        code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_ROTATED,
        error: "signer key is rotated",
        signerStatus,
        rotatedAt: rotatedAt?.iso ?? null
      });
    }
    if (signerStatus === SIGNER_KEY_STATUS.REVOKED) {
      return buildLifecycleDecision({
        ok: false,
        code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_REVOKED,
        error: "signer key is revoked",
        signerStatus,
        revokedAt: revokedAt?.iso ?? null
      });
    }
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_ACTIVE,
      error: "signer key is not active",
      signerStatus
    });
  }

  if (validFrom && atMs < validFrom.ms) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_NOT_YET_VALID,
      error: "signer key is not yet valid",
      signerStatus,
      validFrom: validFrom.iso
    });
  }
  if (validTo && atMs > validTo.ms) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_EXPIRED,
      error: "signer key is expired",
      signerStatus,
      validTo: validTo.iso
    });
  }
  if (rotatedAt && atMs >= rotatedAt.ms) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_ROTATED,
      error: "signer key is rotated at evaluation time",
      signerStatus,
      rotatedAt: rotatedAt.iso
    });
  }
  if (revokedAt && atMs >= revokedAt.ms) {
    return buildLifecycleDecision({
      ok: false,
      code: IDENTITY_SIGNER_LIFECYCLE_REASON_CODES.SIGNER_KEY_REVOKED,
      error: "signer key is revoked at evaluation time",
      signerStatus,
      revokedAt: revokedAt.iso
    });
  }

  return buildLifecycleDecision({
    ok: true,
    code: null,
    signerStatus,
    validFrom: validFrom?.iso ?? null,
    validTo: validTo?.iso ?? null,
    rotatedAt: rotatedAt?.iso ?? null,
    revokedAt: revokedAt?.iso ?? null
  });
}
