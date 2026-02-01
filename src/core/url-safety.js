import dns from "node:dns/promises";
import net from "node:net";

export const URL_SAFETY_CODE = Object.freeze({
  INVALID_URL: "URL_INVALID",
  SCHEME_FORBIDDEN: "URL_SCHEME_FORBIDDEN",
  USERINFO_FORBIDDEN: "URL_USERINFO_FORBIDDEN",
  HOST_FORBIDDEN: "URL_HOST_FORBIDDEN",
  DNS_LOOKUP_FAILED: "URL_DNS_LOOKUP_FAILED",
  DNS_FORBIDDEN: "URL_DNS_FORBIDDEN"
});

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function defaultAllowHttp() {
  if (typeof process !== "undefined" && process.env.PROXY_ALLOW_HTTP_URLS === "1") return true;
  const env = typeof process !== "undefined" ? process.env.NODE_ENV : "";
  return env === "development" || env === "test";
}

function stripTrailingDot(hostname) {
  const h = String(hostname ?? "").trim().toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function isMetadataHostname(hostname) {
  const h = stripTrailingDot(hostname);
  if (!h) return false;
  if (h === "metadata.google.internal") return true;
  if (h === "metadata.azure.internal") return true;
  return false;
}

function parseIpv4(ip) {
  const parts = String(ip).trim().split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const p of parts) {
    if (p.trim() === "" || !/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function isPublicIpv4(ip, { allowLoopback = false, allowPrivate = false } = {}) {
  const b = parseIpv4(ip);
  if (!b) return false;
  const [a, c] = b;
  const d = b[1];

  // Unspecified / broadcast / multicast / reserved.
  if (a === 0) return false;
  if (a >= 224) return false;
  if (a === 255) return false;

  // Loopback.
  if (!allowLoopback && a === 127) return false;

  // Link-local.
  if (!allowPrivate && a === 169 && d === 254) return false;

  // RFC1918.
  if (!allowPrivate && a === 10) return false;
  if (!allowPrivate && a === 172 && d >= 16 && d <= 31) return false;
  if (!allowPrivate && a === 192 && d === 168) return false;

  // CGNAT.
  if (!allowPrivate && a === 100 && d >= 64 && d <= 127) return false;

  // Benchmarking.
  if (!allowPrivate && a === 198 && (d === 18 || d === 19)) return false;

  return true;
}

function parseIpv6ToHextets(ip) {
  let value = String(ip).trim().toLowerCase();
  const zoneIdx = value.indexOf("%");
  if (zoneIdx !== -1) value = value.slice(0, zoneIdx);

  if (value === "") return null;
  const parts = value.split("::");
  if (parts.length > 2) return null;

  const head = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];

  function expandIpv4InPlace(list) {
    if (!list.length) return;
    const last = list[list.length - 1];
    if (!last.includes(".")) return;
    const b = parseIpv4(last);
    if (!b) return;
    list.pop();
    const hi = (b[0] << 8) | b[1];
    const lo = (b[2] << 8) | b[3];
    list.push(hi.toString(16));
    list.push(lo.toString(16));
  }

  expandIpv4InPlace(head);
  expandIpv4InPlace(tail);

  const total = head.length + tail.length;
  const hasCompression = parts.length === 2;
  if (!hasCompression && total !== 8) return null;
  if (hasCompression && total > 8) return null;

  const missing = hasCompression ? 8 - total : 0;
  const hextets = [];
  for (const h of head) hextets.push(h);
  for (let i = 0; i < missing; i += 1) hextets.push("0");
  for (const t of tail) hextets.push(t);

  if (hextets.length !== 8) return null;
  const out = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(parseInt(h, 16));
  }
  return out;
}

function isPublicIpv6(ip, { allowLoopback = false, allowPrivate = false } = {}) {
  const hextets = parseIpv6ToHextets(ip);
  if (!hextets) return false;

  const allZero = hextets.every((h) => h === 0);
  const loopback = hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1;
  if (allZero) return false;
  if (!allowLoopback && loopback) return false;

  const first = hextets[0];
  // Unique local: fc00::/7
  if (!allowPrivate && first >= 0xfc00 && first <= 0xfdff) return false;
  // Link-local: fe80::/10
  if (!allowPrivate && first >= 0xfe80 && first <= 0xfebf) return false;
  // Multicast: ff00::/8
  if (first >= 0xff00 && first <= 0xffff) return false;

  // IPv4-mapped IPv6: ::ffff:w.x.y.z
  const v4Mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (v4Mapped) {
    const v4 = `${hextets[6] >> 8}.${hextets[6] & 0xff}.${hextets[7] >> 8}.${hextets[7] & 0xff}`;
    return isPublicIpv4(v4, { allowLoopback, allowPrivate });
  }

  return true;
}

function schemeFromUrlString(urlString) {
  const idx = urlString.indexOf(":");
  if (idx === -1) return null;
  return urlString.slice(0, idx).trim().toLowerCase();
}

export function checkUrlSafetySync(
  target,
  {
    allowHttp = defaultAllowHttp(),
    allowPrivate = false,
    allowLoopback = false,
    allowedSchemes = ["https", "s3", "gcs", "gs", "minio", "obj"]
  } = {}
) {
  assertNonEmptyString(target, "target");
  const raw = String(target).trim();
  if (raw.includes("\n") || raw.includes("\r")) {
    return { ok: false, code: URL_SAFETY_CODE.INVALID_URL, message: "URL must not contain newlines" };
  }

  const scheme = schemeFromUrlString(raw);
  if (!scheme) return { ok: false, code: URL_SAFETY_CODE.INVALID_URL, message: "URL is missing scheme" };
  if (!allowedSchemes.includes(scheme) && !(allowHttp && scheme === "http")) {
    return { ok: false, code: URL_SAFETY_CODE.SCHEME_FORBIDDEN, message: "URL scheme is not allowed", scheme };
  }
  if (scheme === "http" && !allowHttp) {
    return { ok: false, code: URL_SAFETY_CODE.SCHEME_FORBIDDEN, message: "http:// is not allowed", scheme };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: URL_SAFETY_CODE.INVALID_URL, message: "invalid URL" };
  }

  // Non-network schemes (opaque refs).
  if (scheme === "obj" || scheme === "s3" || scheme === "gcs" || scheme === "gs" || scheme === "minio") {
    return { ok: true, scheme, url, needsDns: false };
  }

  // Only http/https below.
  if (url.username || url.password) {
    return { ok: false, code: URL_SAFETY_CODE.USERINFO_FORBIDDEN, message: "URL userinfo is not allowed", scheme };
  }

  const hostname = stripTrailingDot(url.hostname);
  if (!hostname) return { ok: false, code: URL_SAFETY_CODE.INVALID_URL, message: "URL hostname is required", scheme };

  if (hostname === "localhost" || isMetadataHostname(hostname)) {
    if (!allowLoopback && hostname === "localhost") {
      return { ok: false, code: URL_SAFETY_CODE.HOST_FORBIDDEN, message: "URL hostname is not allowed", scheme, hostname };
    }
    if (isMetadataHostname(hostname)) {
      return { ok: false, code: URL_SAFETY_CODE.HOST_FORBIDDEN, message: "URL hostname is not allowed", scheme, hostname };
    }
  }

  const ipKind = net.isIP(hostname);
  if (ipKind === 4) {
    if (!isPublicIpv4(hostname, { allowLoopback, allowPrivate })) {
      return { ok: false, code: URL_SAFETY_CODE.HOST_FORBIDDEN, message: "URL host is not allowed", scheme, hostname };
    }
    return { ok: true, scheme, url, hostname, needsDns: false };
  }
  if (ipKind === 6) {
    if (!isPublicIpv6(hostname, { allowLoopback, allowPrivate })) {
      return { ok: false, code: URL_SAFETY_CODE.HOST_FORBIDDEN, message: "URL host is not allowed", scheme, hostname };
    }
    return { ok: true, scheme, url, hostname, needsDns: false };
  }

  return { ok: true, scheme, url, hostname, needsDns: true };
}

export async function checkUrlSafety(target, options = {}) {
  const base = checkUrlSafetySync(target, options);
  if (!base.ok) return base;
  if (!base.needsDns) return base;

  const allowPrivate = Boolean(options.allowPrivate);
  const allowLoopback = Boolean(options.allowLoopback);
  const hostname = base.hostname;
  if (!hostname) return base;

  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, code: URL_SAFETY_CODE.DNS_LOOKUP_FAILED, message: "DNS lookup failed", hostname, err: { message: err?.message } };
  }

  for (const a of addrs) {
    const ip = a?.address ? String(a.address) : null;
    const kind = ip ? net.isIP(ip) : 0;
    if (kind === 4) {
      if (!isPublicIpv4(ip, { allowLoopback, allowPrivate })) {
        return { ok: false, code: URL_SAFETY_CODE.DNS_FORBIDDEN, message: "DNS resolved to a forbidden IP", hostname, ip };
      }
    } else if (kind === 6) {
      if (!isPublicIpv6(ip, { allowLoopback, allowPrivate })) {
        return { ok: false, code: URL_SAFETY_CODE.DNS_FORBIDDEN, message: "DNS resolved to a forbidden IP", hostname, ip };
      }
    }
  }

  return base;
}
