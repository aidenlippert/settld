import { canonicalJsonStringify } from "./canonical-json.js";

export const VERIFICATION_WARNING_CODE = Object.freeze({
  LEGACY_KEYS_FORMAT_USED: "LEGACY_KEYS_FORMAT_USED",
  NONSERVER_REVOCATION_NOT_ENFORCED: "NONSERVER_REVOCATION_NOT_ENFORCED",
  MISSING_GOVERNANCE_SNAPSHOT_LENIENT: "MISSING_GOVERNANCE_SNAPSHOT_LENIENT",
  UNSIGNED_REPORT_LENIENT: "UNSIGNED_REPORT_LENIENT",
  TOOL_VERSION_UNKNOWN: "TOOL_VERSION_UNKNOWN"
});

const WARNING_CODE_SET = new Set(Object.values(VERIFICATION_WARNING_CODE));

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

export function normalizeVerificationWarnings(warnings) {
  if (warnings === null || warnings === undefined) return [];
  if (!Array.isArray(warnings)) throw new TypeError("warnings must be an array");

  const seen = new Set();
  const out = [];
  for (const w of warnings) {
    if (!isPlainObject(w)) throw new TypeError("warning must be an object");
    const code = typeof w.code === "string" ? w.code : null;
    if (!code || !WARNING_CODE_SET.has(code)) throw new TypeError(`invalid warning code: ${String(code ?? "")}`);
    const message = w.message === undefined ? undefined : w.message === null ? null : String(w.message);
    const detail = w.detail === undefined ? undefined : w.detail;

    const normalized = {};
    normalized.code = code;
    if (message !== undefined) normalized.message = message;
    if (detail !== undefined) normalized.detail = detail;

    const key = canonicalJsonStringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  out.sort((a, b) => String(a.code).localeCompare(String(b.code)) || canonicalJsonStringify(a).localeCompare(canonicalJsonStringify(b)));
  return out;
}
