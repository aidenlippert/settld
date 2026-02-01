import { Readable } from "node:stream";

import { createApi } from "../../src/api/app.js";
import { createPgStore } from "../../src/db/store-pg.js";
import { authKeyId, authKeySecret, hashAuthKeySecretLegacy } from "../../src/core/auth.js";
import { DEFAULT_TENANT_ID, normalizeTenantId } from "../../src/core/tenancy.js";

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

function hasAuthHeader(headers) {
  const keys = Object.keys(headers ?? {});
  for (const k of keys) {
    const key = String(k).toLowerCase();
    if (key === "authorization" || key === "x-proxy-api-key" || key === "x-proxy-ops-token") return true;
  }
  return false;
}

async function ensureAuth({ store, tenantId, scopes }) {
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
  const keyId = authKeyId();
  const secret = authKeySecret();
  const secretHash = hashAuthKeySecretLegacy(secret);
  const createdAt = new Date().toISOString();
  await store.putAuthKey({
    tenantId,
    authKey: { keyId, secretHash, scopes, status: "active", description: "backup-restore-drill", createdAt }
  });
  const token = `${keyId}.${secret}`;
  return { token, authorization: `Bearer ${token}` };
}

export async function createBackupRestoreApiClient({
  databaseUrl,
  schema = null,
  tenantId = DEFAULT_TENANT_ID,
  scopes = ["ops_write", "finance_write", "audit_read"],
  protocol = "1.0"
} = {}) {
  if (!databaseUrl) throw new Error("databaseUrl is required");
  tenantId = normalizeTenantId(tenantId ?? DEFAULT_TENANT_ID);
  const store = await createPgStore({
    databaseUrl,
    schema: schema ?? (process.env.PROXY_PG_SCHEMA ?? "public"),
    migrateOnStartup: true
  });
  const api = createApi({ store });

  const auth = await ensureAuth({ store, tenantId, scopes });

  async function request({ method, path, headers = {}, body } = {}) {
    const reqHeaders = {
      "x-proxy-tenant-id": tenantId,
      "x-settld-protocol": protocol,
      ...(headers ?? {})
    };
    if (body !== undefined) reqHeaders["content-type"] = "application/json";
    if (!hasAuthHeader(reqHeaders)) reqHeaders.authorization = auth.authorization;
    const req = makeReq({ method, path, headers: reqHeaders, body });
    const res = makeRes();
    await api.handle(req, res);
    const text = typeof res.body === "string" ? res.body : Buffer.from(res.body ?? "").toString("utf8");
    const contentType = res.headers?.get?.("content-type") ? String(res.headers.get("content-type")) : "";
    const isJson = contentType.includes("application/json") || contentType.includes("+json");
    const json = isJson && text ? JSON.parse(text) : null;
    return { statusCode: res.statusCode, json, body: text, headers: res.headers };
  }

  async function close() {
    await store.close?.();
  }

  return { store, api, request, close, tenantId };
}

