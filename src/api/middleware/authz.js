import { hasScope } from "../../core/auth.js";

export function authorize({ scopes, requiredScopes, mode = "any" } = {}) {
  const required = Array.isArray(requiredScopes) ? requiredScopes.filter(Boolean) : [];
  if (!required.length) return false;

  if (mode === "all") {
    for (const s of required) {
      if (!hasScope(scopes, s)) return false;
    }
    return true;
  }

  for (const s of required) {
    if (hasScope(scopes, s)) return true;
  }
  return false;
}

