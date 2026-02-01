function enabled() {
  if (typeof process === "undefined") return false;
  if (process.env.NODE_ENV !== "test") return false;
  if (process.env.PROXY_ENABLE_FAILPOINTS !== "1") return false;
  return typeof process.env.PROXY_FAILPOINTS === "string" && process.env.PROXY_FAILPOINTS.trim() !== "";
}

function parseFailpoints(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const ACTIVE_FAILPOINTS = enabled() ? parseFailpoints(process.env.PROXY_FAILPOINTS) : new Set();

export function failpoint(name) {
  if (!ACTIVE_FAILPOINTS.size) return;
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("failpoint name must be a non-empty string");
  if (!ACTIVE_FAILPOINTS.has(name)) return;
  process.kill(process.pid, "SIGKILL");
}

export function listFailpoints() {
  return Array.from(ACTIVE_FAILPOINTS).sort();
}

