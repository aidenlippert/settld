import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const SETTLEMENT_VERIFICATION_STATUS = Object.freeze({
  GREEN: "green",
  AMBER: "amber",
  RED: "red"
});

export const SETTLEMENT_VERIFIER_SOURCE = Object.freeze({
  DETERMINISTIC_LATENCY_THRESHOLD_V1: "verifier://settld/deterministic/latency-threshold-v1",
  DETERMINISTIC_SCHEMA_CHECK_V1: "verifier://settld/deterministic/schema-check-v1",
  // Deprecated alias retained for backward compatibility with pre-release adopters.
  DETERMINISTIC_JSONSCHEMA_V1: "verifier://settld/deterministic/jsonschema-v1"
});

const ALLOWED_STATUSES = new Set(Object.values(SETTLEMENT_VERIFICATION_STATUS));

const DEFAULT_VERIFIER_REF = Object.freeze({
  verifierId: "settld.policy-engine",
  verifierVersion: "v1",
  verifierHash: null
});

const DETERMINISTIC_LATENCY_VERIFIER = Object.freeze({
  source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_LATENCY_THRESHOLD_V1,
  verifierId: "settld.deterministic.latency-threshold",
  verifierVersion: "v1",
  modality: "deterministic"
});

const DETERMINISTIC_SCHEMA_CHECK_VERIFIER = Object.freeze({
  source: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_SCHEMA_CHECK_V1,
  legacySource: SETTLEMENT_VERIFIER_SOURCE.DETERMINISTIC_JSONSCHEMA_V1,
  verifierId: "settld.deterministic.schema-check",
  verifierVersion: "v1",
  modality: "deterministic"
});

function normalizeNullableLowerString(value) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim().toLowerCase();
  return out === "" ? null : out;
}

function normalizeVerificationStatus(value, fallback = SETTLEMENT_VERIFICATION_STATUS.AMBER) {
  const normalized = normalizeNullableLowerString(value);
  if (normalized && ALLOWED_STATUSES.has(normalized)) return normalized;
  return fallback;
}

function normalizeVerifierSource(value) {
  const normalized = normalizeNullableLowerString(value);
  if (!normalized) return null;
  return normalized.replace(/\/+$/, "");
}

function normalizeVerifierSourceBase(value) {
  const normalized = normalizeVerifierSource(value);
  if (!normalized) return null;
  const [withoutQuery] = normalized.split("?");
  const [withoutFragment] = String(withoutQuery ?? "").split("#");
  return String(withoutFragment ?? "").replace(/\/+$/, "") || null;
}

function toSafeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function parseDeterministicSchemaCheckConfig(source) {
  const defaults = {
    latencyMaxMs: 1200,
    requireSettlementReleaseRatePct: false
  };
  if (!source) return defaults;
  try {
    const parsed = new URL(source);
    const latencyMaxRaw = parsed.searchParams.get("latencymaxms");
    const latencyMaxMs = toSafeNonNegativeInt(latencyMaxRaw);
    const requireReleaseRateRaw = String(parsed.searchParams.get("requiresettlementreleaseratepct") ?? "")
      .trim()
      .toLowerCase();
    const requireSettlementReleaseRatePct =
      requireReleaseRateRaw === "1" || requireReleaseRateRaw === "true" || requireReleaseRateRaw === "yes";
    return {
      latencyMaxMs: latencyMaxMs ?? defaults.latencyMaxMs,
      requireSettlementReleaseRatePct
    };
  } catch {
    return defaults;
  }
}

function computeVerifierHash({ verifierId, verifierVersion, source }) {
  const descriptor = normalizeForCanonicalJson(
    {
      schemaVersion: "SettlementVerifierDescriptor.v1",
      verifierId: String(verifierId),
      verifierVersion: String(verifierVersion),
      source: String(source)
    },
    { path: "$" }
  );
  return sha256Hex(canonicalJsonStringify(descriptor));
}

function evaluateDeterministicLatencyThreshold({ run, verification }) {
  const runStatus = normalizeNullableLowerString(run?.status);
  if (runStatus === "failed") {
    return {
      verificationStatus: SETTLEMENT_VERIFICATION_STATUS.RED,
      reasonCodes: ["verifier_plugin_run_failed"],
      summary: { latencyMs: null, thresholdGreenMs: 1000, thresholdRedMs: 4000 }
    };
  }

  const latencyMs =
    toSafeNonNegativeInt(run?.metrics?.latencyMs) ??
    toSafeNonNegativeInt(verification?.durationMs) ??
    null;
  const thresholdGreenMs = 1000;
  const thresholdRedMs = 4000;

  if (latencyMs === null) {
    return {
      verificationStatus: SETTLEMENT_VERIFICATION_STATUS.AMBER,
      reasonCodes: ["verifier_plugin_latency_missing"],
      summary: { latencyMs: null, thresholdGreenMs, thresholdRedMs }
    };
  }

  if (latencyMs <= thresholdGreenMs) {
    return {
      verificationStatus: SETTLEMENT_VERIFICATION_STATUS.GREEN,
      reasonCodes: [],
      summary: { latencyMs, thresholdGreenMs, thresholdRedMs }
    };
  }
  if (latencyMs >= thresholdRedMs) {
    return {
      verificationStatus: SETTLEMENT_VERIFICATION_STATUS.RED,
      reasonCodes: ["verifier_plugin_latency_above_red_threshold"],
      summary: { latencyMs, thresholdGreenMs, thresholdRedMs }
    };
  }
  return {
    verificationStatus: SETTLEMENT_VERIFICATION_STATUS.AMBER,
    reasonCodes: ["verifier_plugin_latency_between_thresholds"],
    summary: { latencyMs, thresholdGreenMs, thresholdRedMs }
  };
}

function evaluateDeterministicSchemaCheck({ run, verification, source }) {
  const cfg = parseDeterministicSchemaCheckConfig(source);
  const runStatus = normalizeNullableLowerString(run?.status);
  const latencyMs =
    toSafeNonNegativeInt(run?.metrics?.latencyMs) ??
    toSafeNonNegativeInt(verification?.durationMs) ??
    null;
  const releaseRatePct = toSafeNonNegativeInt(run?.metrics?.settlementReleaseRatePct);
  const violations = [];

  if (runStatus !== "completed") {
    violations.push({
      path: "$.status",
      code: "not_completed",
      message: "run.status must be completed"
    });
  }

  if (latencyMs === null) {
    violations.push({
      path: "$.metrics.latencyMs",
      code: "missing_latency",
      message: "metrics.latencyMs is required and must be a non-negative integer"
    });
  } else if (latencyMs > cfg.latencyMaxMs) {
    violations.push({
      path: "$.metrics.latencyMs",
      code: "latency_above_max",
      message: `metrics.latencyMs must be <= ${cfg.latencyMaxMs}`
    });
  }

  if (cfg.requireSettlementReleaseRatePct && releaseRatePct === null) {
    violations.push({
      path: "$.metrics.settlementReleaseRatePct",
      code: "missing_release_rate",
      message: "metrics.settlementReleaseRatePct is required"
    });
  } else if (releaseRatePct !== null && releaseRatePct > 100) {
    violations.push({
      path: "$.metrics.settlementReleaseRatePct",
      code: "release_rate_out_of_range",
      message: "metrics.settlementReleaseRatePct must be <= 100"
    });
  }

  if (violations.length > 0) {
    return {
      verificationStatus: SETTLEMENT_VERIFICATION_STATUS.RED,
      reasonCodes: ["verifier_plugin_schema_check_failed"],
      summary: {
        schemaVersion: "DeterministicVerifierSchemaCheck.v1",
        source,
        latencyMaxMs: cfg.latencyMaxMs,
        requireSettlementReleaseRatePct: cfg.requireSettlementReleaseRatePct,
        violations
      }
    };
  }

  return {
    verificationStatus: SETTLEMENT_VERIFICATION_STATUS.GREEN,
    reasonCodes: [],
    summary: {
      schemaVersion: "DeterministicVerifierSchemaCheck.v1",
      source,
      latencyMaxMs: cfg.latencyMaxMs,
      requireSettlementReleaseRatePct: cfg.requireSettlementReleaseRatePct,
      metrics: {
        latencyMs,
        settlementReleaseRatePct: releaseRatePct
      }
    }
  };
}

export function resolveSettlementVerifierRef({ verificationMethod = null } = {}) {
  const method =
    verificationMethod && typeof verificationMethod === "object" && !Array.isArray(verificationMethod) ? verificationMethod : null;
  const source = normalizeVerifierSource(method?.source);
  const sourceBase = normalizeVerifierSourceBase(source);
  const modality = normalizeNullableLowerString(method?.mode);

  if (sourceBase === DETERMINISTIC_LATENCY_VERIFIER.source) {
    return {
      verifierId: DETERMINISTIC_LATENCY_VERIFIER.verifierId,
      verifierVersion: DETERMINISTIC_LATENCY_VERIFIER.verifierVersion,
      verifierHash: computeVerifierHash({
        verifierId: DETERMINISTIC_LATENCY_VERIFIER.verifierId,
        verifierVersion: DETERMINISTIC_LATENCY_VERIFIER.verifierVersion,
        source: source ?? DETERMINISTIC_LATENCY_VERIFIER.source
      }),
      modality: DETERMINISTIC_LATENCY_VERIFIER.modality,
      source,
      matchedPlugin: DETERMINISTIC_LATENCY_VERIFIER.source
    };
  }

  if (sourceBase === DETERMINISTIC_SCHEMA_CHECK_VERIFIER.source || sourceBase === DETERMINISTIC_SCHEMA_CHECK_VERIFIER.legacySource) {
    return {
      verifierId: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.verifierId,
      verifierVersion: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.verifierVersion,
      verifierHash: computeVerifierHash({
        verifierId: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.verifierId,
        verifierVersion: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.verifierVersion,
        source: source ?? DETERMINISTIC_SCHEMA_CHECK_VERIFIER.source
      }),
      modality: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.modality,
      source,
      matchedPlugin: DETERMINISTIC_SCHEMA_CHECK_VERIFIER.source
    };
  }

  return {
    verifierId: DEFAULT_VERIFIER_REF.verifierId,
    verifierVersion: DEFAULT_VERIFIER_REF.verifierVersion,
    verifierHash: DEFAULT_VERIFIER_REF.verifierHash,
    modality: modality ?? null,
    source,
    matchedPlugin: null
  };
}

export function evaluateSettlementVerifierExecution({
  verificationMethod = null,
  run = null,
  verification = null,
  baseVerificationStatus = null
} = {}) {
  const verifierRef = resolveSettlementVerifierRef({ verificationMethod });
  const defaultStatus = normalizeVerificationStatus(baseVerificationStatus);

  let evaluation = {
    pluginMatched: false,
    source: verifierRef.source,
    reasonCodes: [],
    summary: null
  };
  let verificationStatus = defaultStatus;

  if (verifierRef.matchedPlugin === DETERMINISTIC_LATENCY_VERIFIER.source) {
    const pluginResult = evaluateDeterministicLatencyThreshold({ run, verification });
    verificationStatus = normalizeVerificationStatus(pluginResult.verificationStatus, defaultStatus);
    evaluation = {
      pluginMatched: true,
      source: verifierRef.source,
      reasonCodes: Array.isArray(pluginResult.reasonCodes) ? pluginResult.reasonCodes.map((v) => String(v)) : [],
      summary:
        pluginResult.summary && typeof pluginResult.summary === "object" && !Array.isArray(pluginResult.summary)
          ? pluginResult.summary
          : null
    };
  } else if (verifierRef.matchedPlugin === DETERMINISTIC_SCHEMA_CHECK_VERIFIER.source) {
    const pluginResult = evaluateDeterministicSchemaCheck({
      run,
      verification,
      source: verifierRef.source ?? DETERMINISTIC_SCHEMA_CHECK_VERIFIER.source
    });
    verificationStatus = normalizeVerificationStatus(pluginResult.verificationStatus, defaultStatus);
    evaluation = {
      pluginMatched: true,
      source: verifierRef.source,
      reasonCodes: Array.isArray(pluginResult.reasonCodes) ? pluginResult.reasonCodes.map((v) => String(v)) : [],
      summary:
        pluginResult.summary && typeof pluginResult.summary === "object" && !Array.isArray(pluginResult.summary)
          ? pluginResult.summary
          : null
    };
  }

  return {
    verificationStatus,
    verifierRef: {
      verifierId: verifierRef.verifierId,
      verifierVersion: verifierRef.verifierVersion,
      verifierHash: verifierRef.verifierHash,
      modality: verifierRef.modality
    },
    evaluation
  };
}
