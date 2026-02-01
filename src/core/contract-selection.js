function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function normalizeIso(atIso) {
  if (atIso === null || atIso === undefined) return null;
  if (typeof atIso !== "string" || atIso.trim() === "") throw new TypeError("at must be an ISO date string");
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) throw new TypeError("at must be an ISO date string");
  return atIso;
}

function normalizeScope(scope) {
  if (scope === null || scope === undefined) return {};
  assertPlainObject(scope, "scope");
  return {
    customerId: scope.customerId ?? null,
    siteId: scope.siteId ?? null,
    templateId: scope.templateId ?? null,
    zoneId: scope.zoneId ?? null,
    skillId: scope.skillId ?? null
  };
}

function matchesScope(contractScope, scope) {
  const c = contractScope && typeof contractScope === "object" ? contractScope : {};
  const s = scope ?? {};
  const keys = ["customerId", "siteId", "templateId", "zoneId", "skillId"];
  for (const k of keys) {
    const cv = c[k] ?? null;
    if (cv === null || cv === undefined || String(cv).trim() === "") continue;
    const sv = s[k] ?? null;
    if (sv === null || sv === undefined || String(sv).trim() === "") return false;
    if (String(cv) !== String(sv)) return false;
  }
  return true;
}

function scopeSpecificityScore(contractScope) {
  const c = contractScope && typeof contractScope === "object" ? contractScope : {};
  let score = 0;
  const keys = ["customerId", "siteId", "templateId", "zoneId", "skillId"];
  for (const k of keys) {
    const v = c[k] ?? null;
    if (v === null || v === undefined || String(v).trim() === "") continue;
    score += 1;
  }
  return score;
}

function effectiveWindowAllows({ effectiveFrom, effectiveTo, atIso }) {
  if (!atIso) return true;
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return false;
  if (effectiveFrom) {
    const from = Date.parse(effectiveFrom);
    if (Number.isFinite(from) && at < from) return false;
  }
  if (effectiveTo) {
    const to = Date.parse(effectiveTo);
    if (Number.isFinite(to) && at > to) return false;
  }
  return true;
}

function compareNullableIsoDesc(a, b) {
  const at = a ? Date.parse(a) : NaN;
  const bt = b ? Date.parse(b) : NaN;
  const aOk = Number.isFinite(at);
  const bOk = Number.isFinite(bt);
  if (aOk && bOk) return bt - at;
  if (aOk && !bOk) return -1;
  if (!aOk && bOk) return 1;
  return 0;
}

function compareLexAsc(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""));
}

// Deterministic selection "physics" for ACTIVE contracts-as-code records.
//
// Precedence tuple (highest wins):
// 1) scopeSpecificityScore (higher)
// 2) contractVersion (higher)
// 3) effectiveFrom (later)
// 4) contractHash (lexicographic as final tie-breaker)
export function selectActiveContractV2(contracts, { kind = null, scope = null, at = null } = {}) {
  if (!Array.isArray(contracts)) throw new TypeError("contracts must be an array");
  if (kind !== null && kind !== undefined) {
    if (typeof kind !== "string" || kind.trim() === "") throw new TypeError("kind must be a non-empty string");
  }
  const atIso = normalizeIso(at);
  const normalizedScope = normalizeScope(scope);

  let best = null;
  for (const c of contracts) {
    if (!c || typeof c !== "object") continue;
    if (String(c.status ?? "") !== "ACTIVE") continue;

    if (!effectiveWindowAllows({ effectiveFrom: c.effectiveFrom ?? null, effectiveTo: c.effectiveTo ?? null, atIso })) continue;
    if (!matchesScope(c.scope ?? null, normalizedScope)) continue;

    const candidate = {
      ...c,
      __score: scopeSpecificityScore(c.scope ?? null),
      __contractVersion: Number(c.contractVersion ?? 0),
      __effectiveFrom: c.effectiveFrom ?? null,
      __contractHash: c.contractHash ?? null
    };

    if (!best) {
      best = candidate;
      continue;
    }

    if (candidate.__score !== best.__score) {
      if (candidate.__score > best.__score) best = candidate;
      continue;
    }
    if (candidate.__contractVersion !== best.__contractVersion) {
      if (candidate.__contractVersion > best.__contractVersion) best = candidate;
      continue;
    }
    const efCmp = compareNullableIsoDesc(candidate.__effectiveFrom, best.__effectiveFrom);
    if (efCmp !== 0) {
      if (efCmp < 0) best = candidate; // candidate effectiveFrom is later
      continue;
    }
    if (compareLexAsc(candidate.__contractHash, best.__contractHash) > 0) best = candidate;
  }

  return best
    ? {
        tenantId: best.tenantId ?? null,
        contractId: best.contractId ?? null,
        contractVersion: best.contractVersion ?? null,
        contractHash: best.contractHash ?? null,
        policyHash: best.policyHash ?? null,
        compilerId: best.compilerId ?? null,
        doc: best.doc ?? null,
        scope: best.scope ?? null,
        effectiveFrom: best.effectiveFrom ?? null,
        effectiveTo: best.effectiveTo ?? null,
        status: best.status ?? null
      }
    : null;
}

