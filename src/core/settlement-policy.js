import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const VERIFICATION_METHOD_SCHEMA_VERSION = "VerificationMethod.v1";
export const SETTLEMENT_POLICY_SCHEMA_VERSION = "SettlementPolicy.v1";

export const VERIFICATION_METHOD_MODE = Object.freeze({
  DETERMINISTIC: "deterministic",
  ATTESTED: "attested",
  DISCRETIONARY: "discretionary"
});

export const SETTLEMENT_POLICY_MODE = Object.freeze({
  AUTOMATIC: "automatic",
  MANUAL_REVIEW: "manual-review"
});

const ALLOWED_METHOD_MODES = new Set(Object.values(VERIFICATION_METHOD_MODE));
const ALLOWED_POLICY_MODES = new Set(Object.values(SETTLEMENT_POLICY_MODE));
const ALLOWED_VERIFICATION_STATUSES = new Set(["green", "amber", "red"]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeOptionalSafeInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("expected a safe integer");
  if (parsed < min || parsed > max) throw new TypeError(`expected integer in range ${min}..${max}`);
  return parsed;
}

function normalizeReleaseRatePct(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new TypeError("releaseRatePct must be an integer within 0..100");
  }
  return parsed;
}

export function normalizeVerificationMethod(input, { defaultMode = VERIFICATION_METHOD_MODE.DETERMINISTIC } = {}) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const modeRaw = normalizeNullableString(raw.mode);
  const mode = (modeRaw ?? String(defaultMode)).toLowerCase();
  if (!ALLOWED_METHOD_MODES.has(mode)) {
    throw new TypeError("verificationMethod.mode must be deterministic|attested|discretionary");
  }
  const method = normalizeForCanonicalJson(
    {
      schemaVersion: VERIFICATION_METHOD_SCHEMA_VERSION,
      mode,
      source: normalizeNullableString(raw.source),
      attestor: normalizeNullableString(raw.attestor),
      notes: normalizeNullableString(raw.notes)
    },
    { path: "$" }
  );
  return method;
}

export function normalizeSettlementPolicy(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const modeRaw = normalizeNullableString(raw.mode);
  const mode = (modeRaw ?? SETTLEMENT_POLICY_MODE.AUTOMATIC).toLowerCase();
  if (!ALLOWED_POLICY_MODES.has(mode)) {
    throw new TypeError("policy.mode must be automatic|manual-review");
  }

  const policyVersionRaw = raw.policyVersion ?? raw.version ?? 1;
  const policyVersion = normalizeOptionalSafeInt(policyVersionRaw, { min: 1 });
  if (policyVersion === null) throw new TypeError("policyVersion must be a positive safe integer");

  const rulesRaw = raw.rules && typeof raw.rules === "object" && !Array.isArray(raw.rules) ? raw.rules : {};
  const policy = normalizeForCanonicalJson(
    {
      schemaVersion: SETTLEMENT_POLICY_SCHEMA_VERSION,
      policyVersion,
      mode,
      rules: {
        requireDeterministicVerification: rulesRaw.requireDeterministicVerification === true,
        autoReleaseOnGreen: rulesRaw.autoReleaseOnGreen !== false,
        autoReleaseOnAmber: rulesRaw.autoReleaseOnAmber === true,
        autoReleaseOnRed: rulesRaw.autoReleaseOnRed === true,
        greenReleaseRatePct: normalizeReleaseRatePct(rulesRaw.greenReleaseRatePct, 100),
        amberReleaseRatePct: normalizeReleaseRatePct(rulesRaw.amberReleaseRatePct, 50),
        redReleaseRatePct: normalizeReleaseRatePct(rulesRaw.redReleaseRatePct, 0),
        maxAutoReleaseAmountCents: normalizeOptionalSafeInt(rulesRaw.maxAutoReleaseAmountCents, { min: 1 }),
        disputeWindowHours: normalizeOptionalSafeInt(rulesRaw.disputeWindowHours, { min: 1, max: 24 * 365 }),
        manualReason: normalizeNullableString(rulesRaw.manualReason)
      }
    },
    { path: "$" }
  );
  return policy;
}

export function computeSettlementPolicyHash(policy) {
  assertPlainObject(policy, "policy");
  if (policy.schemaVersion !== SETTLEMENT_POLICY_SCHEMA_VERSION) {
    throw new TypeError(`policy.schemaVersion must be ${SETTLEMENT_POLICY_SCHEMA_VERSION}`);
  }
  return sha256Hex(canonicalJsonStringify(policy));
}

export function computeVerificationMethodHash(method) {
  assertPlainObject(method, "verificationMethod");
  if (method.schemaVersion !== VERIFICATION_METHOD_SCHEMA_VERSION) {
    throw new TypeError(`verificationMethod.schemaVersion must be ${VERIFICATION_METHOD_SCHEMA_VERSION}`);
  }
  return sha256Hex(canonicalJsonStringify(method));
}

function computeReleaseAmounts({ amountCents, releaseRatePct }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("amountCents must be a positive safe integer");
  if (!Number.isSafeInteger(releaseRatePct) || releaseRatePct < 0 || releaseRatePct > 100) {
    throw new TypeError("releaseRatePct must be an integer within 0..100");
  }
  const releaseAmountCents = releaseRatePct <= 0 ? 0 : Math.min(amountCents, Math.floor((amountCents * releaseRatePct) / 100));
  const refundAmountCents = amountCents - releaseAmountCents;
  return { releaseAmountCents, refundAmountCents };
}

export function evaluateSettlementPolicy({ policy, verificationMethod, verificationStatus, runStatus, amountCents }) {
  const normalizedPolicy = normalizeSettlementPolicy(policy);
  const normalizedMethod = normalizeVerificationMethod(verificationMethod);
  const status = String(verificationStatus ?? "").trim().toLowerCase();
  if (!ALLOWED_VERIFICATION_STATUSES.has(status)) {
    throw new TypeError("verificationStatus must be green|amber|red");
  }
  const normalizedRunStatus = String(runStatus ?? "").trim().toLowerCase();
  if (normalizedRunStatus !== "completed" && normalizedRunStatus !== "failed") {
    throw new TypeError("runStatus must be completed|failed");
  }
  if (!Number.isSafeInteger(Number(amountCents)) || Number(amountCents) <= 0) {
    throw new TypeError("amountCents must be a positive safe integer");
  }
  const settlementAmountCents = Number(amountCents);

  const reasons = [];
  if (normalizedPolicy.mode === SETTLEMENT_POLICY_MODE.MANUAL_REVIEW) {
    reasons.push("policy_mode_manual_review");
  }
  if (
    normalizedPolicy.rules.requireDeterministicVerification &&
    normalizedMethod.mode !== VERIFICATION_METHOD_MODE.DETERMINISTIC
  ) {
    reasons.push("verification_method_not_deterministic");
  }
  if (
    normalizedPolicy.rules.maxAutoReleaseAmountCents !== null &&
    settlementAmountCents > normalizedPolicy.rules.maxAutoReleaseAmountCents
  ) {
    reasons.push("amount_exceeds_auto_release_limit");
  }

  let releaseRatePct;
  if (status === "green") releaseRatePct = normalizedPolicy.rules.greenReleaseRatePct;
  else if (status === "amber") releaseRatePct = normalizedPolicy.rules.amberReleaseRatePct;
  else releaseRatePct = normalizedPolicy.rules.redReleaseRatePct;

  const autoEnabled =
    status === "green"
      ? normalizedPolicy.rules.autoReleaseOnGreen
      : status === "amber"
        ? normalizedPolicy.rules.autoReleaseOnAmber
        : normalizedPolicy.rules.autoReleaseOnRed;
  if (!autoEnabled) {
    reasons.push(`auto_release_disabled_for_${status}`);
  }

  if (normalizedRunStatus === "failed") {
    releaseRatePct = 0;
  }

  const { releaseAmountCents, refundAmountCents } = computeReleaseAmounts({
    amountCents: settlementAmountCents,
    releaseRatePct
  });

  const shouldAutoResolve = reasons.length === 0;
  return {
    policy: normalizedPolicy,
    verificationMethod: normalizedMethod,
    decisionMode: shouldAutoResolve ? SETTLEMENT_POLICY_MODE.AUTOMATIC : SETTLEMENT_POLICY_MODE.MANUAL_REVIEW,
    shouldAutoResolve,
    reasonCodes: reasons,
    releaseRatePct,
    releaseAmountCents,
    refundAmountCents,
    settlementStatus: releaseAmountCents > 0 ? "released" : "refunded",
    verificationStatus: status,
    runStatus: normalizedRunStatus
  };
}
