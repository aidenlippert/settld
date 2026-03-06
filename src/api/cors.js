const DEV_CORS_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

export function resolveCorsOrigin({ originHeader, corsAllowOrigins }) {
  if (!(corsAllowOrigins instanceof Set)) throw new TypeError("corsAllowOrigins must be a Set");
  if (typeof originHeader !== "string" || originHeader.trim() === "") return null;
  const origin = originHeader.trim();
  if (corsAllowOrigins.has("*")) return origin;
  if (corsAllowOrigins.has(origin)) return origin;
  if (DEV_CORS_ORIGIN_RE.test(origin)) return origin;
  return null;
}

export function applyCorsHeaders({ req, res, corsAllowOrigins }) {
  if (!req || typeof req !== "object") throw new TypeError("req is required");
  if (!res || typeof res.setHeader !== "function") throw new TypeError("res is required");
  const allowOrigin = resolveCorsOrigin({
    originHeader: req.headers?.origin,
    corsAllowOrigins
  });
  if (!allowOrigin) return false;
  res.setHeader("access-control-allow-origin", allowOrigin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    [
      "authorization",
      "content-type",
      "idempotency-key",
      "x-api-key",
      "x-proxy-api-key",
      "x-proxy-tenant-id",
      "x-proxy-ops-token",
      "x-request-id",
      "x-nooterra-protocol"
    ].join(", ")
  );
  res.setHeader("access-control-max-age", "600");
  return true;
}
