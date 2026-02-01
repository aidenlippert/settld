import { Readable } from "node:stream";

import { computeSlaPolicy } from "../src/core/sla.js";
import { buildPolicySnapshot, computePolicyHash } from "../src/core/policy.js";
import { authKeyId, authKeySecret, hashAuthKeySecret } from "../src/core/auth.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../src/core/tenancy.js";

const DEFAULT_TEST_SCOPES = Object.freeze(["ops_write", "finance_write", "audit_read"]);

function makeReq({ method, path, headers, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = path;
  req.headers = headers ?? {};
  return req;
}

function makeRes() {
  const headers = new Map();
  return {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    end(payload) {
      this.body = payload ?? "";
      this.headers = headers;
      this.ended = true;
    }
  };
}

function isAuthExempt({ method, path }) {
  const url = new URL(path ?? "/", "http://localhost");
  const pathname = url.pathname;
  return (
    (method === "GET" && pathname === "/health") ||
    (method === "GET" && pathname === "/healthz") ||
    (method === "POST" && pathname === "/ingest/proxy") ||
    (method === "POST" && pathname === "/exports/ack")
  );
}

function hasAuthHeader(headers) {
  const keys = Object.keys(headers ?? {});
  for (const k of keys) {
    const key = String(k).toLowerCase();
    if (key === "authorization" || key === "x-proxy-api-key" || key === "x-proxy-ops-token") return true;
  }
  return false;
}

async function ensureTestAuth(api, tenantId, { scopes = DEFAULT_TEST_SCOPES } = {}) {
  if (!api || typeof api !== "object") throw new TypeError("api is required");
  if (!api.store || typeof api.store !== "object") throw new TypeError("api.store is required");
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);

  if (!(api.__testAuthByTenant instanceof Map)) api.__testAuthByTenant = new Map();
  const existing = api.__testAuthByTenant.get(tenantId) ?? null;
  if (existing) return existing;

  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecret(secret);
  const createdAt = typeof api.store.nowIso === "function" ? api.store.nowIso() : new Date().toISOString();

  if (typeof api.store.putAuthKey === "function") {
    await api.store.putAuthKey({
      tenantId,
      authKey: {
        keyId,
        secretHash,
        scopes: Array.isArray(scopes) ? scopes : DEFAULT_TEST_SCOPES,
        status: "active",
        createdAt
      }
    });
  } else {
    if (!(api.store.authKeys instanceof Map)) api.store.authKeys = new Map();
    api.store.authKeys.set(`${tenantId}\n${keyId}`, {
      tenantId,
      keyId,
      secretHash,
      scopes: Array.isArray(scopes) ? scopes : DEFAULT_TEST_SCOPES,
      status: "active",
      createdAt,
      updatedAt: createdAt
    });
  }

  const token = `${keyId}.${secret}`;
  const auth = { tenantId, keyId, secret, token, authorization: `Bearer ${token}` };
  api.__testAuthByTenant.set(tenantId, auth);
  return auth;
}

export async function request(api, { method, path, body, headers, auth = "auto" } = {}) {
  const reqHeaders = { ...(headers ?? {}) };
  if (body !== undefined) reqHeaders["content-type"] = "application/json";

  if (auth !== "none" && auth !== false && !isAuthExempt({ method, path }) && !hasAuthHeader(reqHeaders)) {
    const tenantIdHeader = reqHeaders["x-proxy-tenant-id"] ?? reqHeaders["X-Proxy-Tenant-Id"] ?? null;
    const tenantId = tenantIdHeader ? normalizeTenantId(tenantIdHeader) : DEFAULT_TENANT_ID;
    const testAuth = await ensureTestAuth(api, tenantId);
    reqHeaders.authorization = testAuth.authorization;
  }

  const req = makeReq({ method, path, headers: reqHeaders, body });
  const res = makeRes();
  await api.handle(req, res);

  const text = typeof res.body === "string" ? res.body : Buffer.from(res.body ?? "").toString("utf8");
  const contentType = res.headers?.get?.("content-type") ? String(res.headers.get("content-type")) : "";
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  const json = isJson && text ? JSON.parse(text) : null;
  return { statusCode: res.statusCode, json, body: text, headers: res.headers };
}

export function makeBookedPayload({
  startAt,
  endAt,
  environmentTier,
  requiresOperatorCoverage = false,
  sla: slaOverride = null,
  zoneId = null,
  customerId = null,
  siteId = null,
  contractId = "contract_default",
  contractVersion = 1,
  paymentHoldId = "hold_test",
  creditPolicy = { enabled: false, defaultAmountCents: 0, maxAmountCents: 0, currency: "USD" },
  evidencePolicy = { retentionDays: 0 },
  claimPolicy = { currency: "USD", autoApproveThresholdCents: 0, maxPayoutCents: 0, reservePercent: 0 },
  coveragePolicy = { required: false, responseSlaSeconds: 0, includedAssistSeconds: 0, overageRateCentsPerMinute: 0 }
} = {}) {
  if (typeof startAt !== "string" || startAt.trim() === "") throw new TypeError("startAt is required");
  if (typeof endAt !== "string" || endAt.trim() === "") throw new TypeError("endAt is required");
  if (typeof environmentTier !== "string" || environmentTier.trim() === "") throw new TypeError("environmentTier is required");

  const effectiveRequiresOperatorCoverage = requiresOperatorCoverage === true || environmentTier === "ENV_IN_HOME";
  const sla = slaOverride ?? computeSlaPolicy({ environmentTier });
  const policySnapshot = buildPolicySnapshot({
    contractId,
    contractVersion,
    environmentTier,
    requiresOperatorCoverage: effectiveRequiresOperatorCoverage,
    sla,
    creditPolicy,
    evidencePolicy,
    claimPolicy,
    coveragePolicy
  });
  const policyHash = computePolicyHash(policySnapshot);

  return {
    paymentHoldId,
    startAt,
    endAt,
    environmentTier,
    requiresOperatorCoverage: effectiveRequiresOperatorCoverage,
    zoneId,
    sla,
    customerId,
    siteId,
    contractId,
    contractVersion,
    creditPolicy,
    evidencePolicy,
    policySnapshot,
    policyHash
  };
}
