export const DEFAULT_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_NOOTERRA_API_BASE_URL
    ? String(import.meta.env.VITE_NOOTERRA_API_BASE_URL)
    : "/__nooterra";
export const DEFAULT_AUTH_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_NOOTERRA_AUTH_BASE_URL
    ? String(import.meta.env.VITE_NOOTERRA_AUTH_BASE_URL)
    : "/__magic";

export const PRODUCT_RUNTIME_STORAGE_KEY = "nooterra_product_runtime_v2";

function toBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  for (let index = 0; index < view.length; index += chunkSize) {
    const chunk = view.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function fromBase64(value) {
  const raw = atob(String(value ?? ""));
  const out = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
  return out;
}

function wrapPemBody(base64) {
  return String(base64).replace(/(.{64})/g, "$1\n").trim();
}

function arrayBufferToPem(buffer, label) {
  const base64 = toBase64(new Uint8Array(buffer));
  return `-----BEGIN ${label}-----\n${wrapPemBody(base64)}\n-----END ${label}-----\n`;
}

function pemToArrayBuffer(pem) {
  const normalized = String(pem ?? "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return fromBase64(normalized).buffer;
}

function canonicalize(value) {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsupported number for canonical JSON: non-finite");
    if (Object.is(value, -0)) throw new TypeError("Unsupported number for canonical JSON: -0");
    return value;
  }
  if (valueType === "undefined") throw new TypeError("Unsupported value for canonical JSON: undefined");
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType}`);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (valueType === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("Unsupported object for canonical JSON: non-plain object");
    }
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)}`);
}

function normalizeForCanonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Unsupported number for canonical JSON: non-finite");
    if (Object.is(value, -0)) throw new TypeError("Unsupported number for canonical JSON: -0");
    return value;
  }
  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType}`);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((row) => normalizeForCanonicalJson(row));
  if (valueType === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("Unsupported object for canonical JSON: non-plain object");
    }
    const out = {};
    for (const key of Object.keys(value)) {
      const normalized = normalizeForCanonicalJson(value[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)}`);
}

function hexToUint8Array(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError("value must be sha256 hex");
  const out = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    out[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return out;
}

export function loadRuntimeConfig() {
  if (typeof window === "undefined") {
    return {
      baseUrl: DEFAULT_BASE_URL,
      authBaseUrl: DEFAULT_AUTH_BASE_URL,
      apiKey: "",
      tenantId: "tenant_default",
      protocol: "1.0"
    };
  }
  try {
    const raw = localStorage.getItem(PRODUCT_RUNTIME_STORAGE_KEY);
    if (!raw) throw new Error("missing");
    const parsed = JSON.parse(raw);
    return {
      baseUrl: typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_BASE_URL,
      authBaseUrl:
        typeof parsed?.authBaseUrl === "string" && parsed.authBaseUrl.trim()
          ? parsed.authBaseUrl.trim()
          : DEFAULT_AUTH_BASE_URL,
      apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
      tenantId: typeof parsed?.tenantId === "string" && parsed.tenantId.trim() ? parsed.tenantId.trim() : "tenant_default",
      protocol: typeof parsed?.protocol === "string" && parsed.protocol.trim() ? parsed.protocol.trim() : "1.0"
    };
  } catch {
    return {
      baseUrl: DEFAULT_BASE_URL,
      authBaseUrl: DEFAULT_AUTH_BASE_URL,
      apiKey: "",
      tenantId: "tenant_default",
      protocol: "1.0"
    };
  }
}

export function buildHeaders({ tenantId, protocol, apiKey, write = false, idempotencyKey = null } = {}) {
  const headers = {
    "content-type": "application/json",
    "x-proxy-tenant-id": tenantId,
    "x-nooterra-protocol": protocol
  };
  if (write) headers["x-request-id"] = createClientId("req");
  if (apiKey && String(apiKey).trim()) headers.authorization = `Bearer ${String(apiKey).trim()}`;
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
  return headers;
}

export async function requestJson({
  baseUrl,
  pathname,
  method = "GET",
  headers,
  body = null,
  credentials
} = {}) {
  const url = `${String(baseUrl).replace(/\/$/, "")}${pathname}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    ...(credentials ? { credentials } : {})
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object"
        ? String(parsed?.message ?? parsed?.error ?? `HTTP ${response.status}`)
        : String(parsed ?? `HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    error.code = parsed && typeof parsed === "object" ? parsed?.code ?? null : null;
    error.details = parsed && typeof parsed === "object" ? parsed?.details ?? null : null;
    throw error;
  }
  return parsed;
}

export function createClientId(prefix = "ui") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function parseCapabilityList(rawValue) {
  const seen = new Set();
  const out = [];
  for (const raw of String(rawValue ?? "").split(/\r?\n|,/)) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function formatDateTime(value) {
  const ms = Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) return "n/a";
  return new Date(ms).toLocaleString();
}

export function formatCurrency(amountCents, currency = "USD") {
  const amount = Number(amountCents ?? 0);
  if (!Number.isFinite(amount)) return "n/a";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      maximumFractionDigits: 2
    }).format(amount / 100);
  } catch {
    return `${String(currency || "USD").toUpperCase()} ${(amount / 100).toFixed(2)}`;
  }
}

export function abbreviateHash(value, length = 12) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "n/a";
  return normalized.length <= length ? normalized : `${normalized.slice(0, length)}…`;
}

export function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

export async function sha256HexUtf8(text) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export async function generateBrowserEd25519KeypairPem() {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is not available in this browser");
  const keypair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyPem = arrayBufferToPem(await crypto.subtle.exportKey("spki", keypair.publicKey), "PUBLIC KEY");
  const privateKeyPem = arrayBufferToPem(await crypto.subtle.exportKey("pkcs8", keypair.privateKey), "PRIVATE KEY");
  const keyId = `key_${(await sha256HexUtf8(publicKeyPem)).slice(0, 24)}`;
  return { publicKeyPem, privateKeyPem, keyId };
}

export async function buildAgentCardPublishSignature({
  tenantId,
  requestBody,
  signerKeyId,
  privateKeyPem,
  signedAt = new Date().toISOString()
} = {}) {
  const normalizedBody = normalizeForCanonicalJson({
    schemaVersion: "AgentCardPublishPayload.v1",
    tenantId: String(tenantId ?? "").trim(),
    agentId: String(requestBody?.agentId ?? "").trim(),
    displayName: requestBody?.displayName ?? null,
    description: requestBody?.description ?? null,
    capabilities: requestBody?.capabilities ?? null,
    visibility: requestBody?.visibility ?? null,
    executionCoordinatorDid: requestBody?.executionCoordinatorDid ?? null,
    host: requestBody?.host ?? null,
    priceHint: requestBody?.priceHint ?? null,
    attestations: requestBody?.attestations ?? null,
    tools: requestBody?.tools ?? null,
    policyCompatibility: requestBody?.policyCompatibility ?? null,
    tags: requestBody?.tags ?? null,
    metadata: requestBody?.metadata ?? null
  });
  const payloadHash = await sha256HexUtf8(canonicalJsonStringify(normalizedBody));
  const importedKey = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKeyPem), { name: "Ed25519" }, false, ["sign"]);
  const signatureBytes = await crypto.subtle.sign("Ed25519", importedKey, hexToUint8Array(payloadHash));
  return {
    schemaVersion: "AgentCardPublish.v1",
    algorithm: "ed25519",
    signerKeyId: String(signerKeyId ?? "").trim(),
    signedAt: new Date(Date.parse(signedAt)).toISOString(),
    payloadHash,
    signature: toBase64(new Uint8Array(signatureBytes))
  };
}
