import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "./tenancy.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

export function makeOpsAuditRecord({
  tenantId = DEFAULT_TENANT_ID,
  actorKeyId = null,
  actorPrincipalId = null,
  requestId = null,
  action,
  targetType = null,
  targetId = null,
  at = null,
  details = null
} = {}) {
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
  assertNonEmptyString(action, "action");

  let normalizedDetails;
  try {
    normalizedDetails = normalizeForCanonicalJson(details === undefined ? null : details);
  } catch {
    normalizedDetails = { error: "DETAILS_UNSERIALIZABLE" };
  }

  const detailsHash = sha256Hex(canonicalJsonStringify(normalizedDetails));

  return {
    tenantId,
    actorKeyId: actorKeyId === null || actorKeyId === undefined ? null : String(actorKeyId),
    actorPrincipalId: actorPrincipalId === null || actorPrincipalId === undefined ? null : String(actorPrincipalId),
    requestId: requestId === null || requestId === undefined ? null : String(requestId),
    action: String(action),
    targetType: targetType === null || targetType === undefined ? null : String(targetType),
    targetId: targetId === null || targetId === undefined ? null : String(targetId),
    at: at ? new Date(String(at)).toISOString() : new Date().toISOString(),
    detailsHash,
    details: normalizedDetails
  };
}

