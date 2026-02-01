import fs from "node:fs";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export const SETTLD_PROTOCOL_CURRENT = "1.0";

export function parseProtocolVersion(text) {
  assertNonEmptyString(text, "protocol");
  const raw = String(text).trim();
  const m = raw.match(/^(\d+)\.(\d+)$/);
  if (!m) throw new TypeError("protocol must be major.minor (e.g. 1.0)");
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isSafeInteger(major) || major < 0) throw new TypeError("protocol major must be a non-negative integer");
  if (!Number.isSafeInteger(minor) || minor < 0) throw new TypeError("protocol minor must be a non-negative integer");
  return { major, minor, raw: `${major}.${minor}` };
}

export function compareProtocolVersions(a, b) {
  const pa = typeof a === "string" ? parseProtocolVersion(a) : a;
  const pb = typeof b === "string" ? parseProtocolVersion(b) : b;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  return 0;
}

export function listSupportedProtocols({ min, max }) {
  const pMin = parseProtocolVersion(min);
  const pMax = parseProtocolVersion(max);
  if (compareProtocolVersions(pMin, pMax) > 0) throw new TypeError("min protocol must be <= max protocol");

  // Simple enumerator: only expands contiguous minor versions within the same major.
  if (pMin.major !== pMax.major) return [pMin.raw, pMax.raw];
  const out = [];
  for (let m = pMin.minor; m <= pMax.minor; m += 1) out.push(`${pMin.major}.${m}`);
  return out;
}

export function loadProtocolDeprecations(filePath) {
  if (filePath === null || filePath === undefined) return { byVersion: new Map() };
  const p = String(filePath).trim();
  if (!p) return { byVersion: new Map() };
  if (!fs.existsSync(p)) throw new Error(`PROXY_PROTOCOL_DEPRECATIONS file not found: ${p}`);
  const raw = fs.readFileSync(p, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid PROXY_PROTOCOL_DEPRECATIONS JSON: ${err?.message ?? "parse error"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("PROXY_PROTOCOL_DEPRECATIONS must be a JSON object");

  const byVersion = new Map();
  for (const [ver, v] of Object.entries(parsed)) {
    if (!ver) continue;
    const norm = parseProtocolVersion(ver).raw;
    const cutoff = v?.cutoff ?? v?.cutoffAt ?? v?.cutoff_at ?? null;
    if (cutoff === null || cutoff === undefined || String(cutoff).trim() === "") continue;
    const cutoffIso = new Date(String(cutoff)).toISOString();
    byVersion.set(norm, { cutoffAt: cutoffIso });
  }
  return { byVersion };
}

export function resolveProtocolPolicy({
  current = SETTLD_PROTOCOL_CURRENT,
  min = null,
  max = null,
  requireHeader = null,
  buildId = null,
  deprecationsPath = null
} = {}) {
  const nodeEnv = typeof process !== "undefined" ? (process.env.NODE_ENV ?? "development") : "development";
  const envMin = typeof process !== "undefined" ? (process.env.PROXY_PROTOCOL_MIN ?? null) : null;
  const envMax = typeof process !== "undefined" ? (process.env.PROXY_PROTOCOL_MAX ?? null) : null;
  const envDep = typeof process !== "undefined" ? (process.env.PROXY_PROTOCOL_DEPRECATIONS ?? null) : null;
  const envBuild =
    typeof process !== "undefined"
      ? (process.env.PROXY_BUILD ?? process.env.SETTLD_BUILD ?? process.env.GIT_SHA ?? process.env.SOURCE_VERSION ?? null)
      : null;

  const effectiveMin = (min ?? (envMin && String(envMin).trim() ? String(envMin).trim() : null) ?? current).trim();
  const effectiveMax = (max ?? (envMax && String(envMax).trim() ? String(envMax).trim() : null) ?? current).trim();

  const supported = listSupportedProtocols({ min: effectiveMin, max: effectiveMax });
  const parsedCurrent = parseProtocolVersion(current).raw;
  const requireInProdDefault = nodeEnv === "production";
  const effectiveRequireHeader = requireHeader === null || requireHeader === undefined ? requireInProdDefault : Boolean(requireHeader);

  const depPath = deprecationsPath ?? (envDep && String(envDep).trim() ? String(envDep).trim() : null);
  const deprecations = loadProtocolDeprecations(depPath);

  return {
    current: parsedCurrent,
    min: parseProtocolVersion(effectiveMin).raw,
    max: parseProtocolVersion(effectiveMax).raw,
    supported,
    requireHeader: effectiveRequireHeader,
    buildId: buildId ?? (envBuild && String(envBuild).trim() ? String(envBuild).trim() : null),
    deprecations
  };
}

