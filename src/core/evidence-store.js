import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { presignS3Url } from "./s3-presign.js";
import { normalizeTenantId } from "./tenancy.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

export function parseObjEvidenceRef(evidenceRef) {
  assertNonEmptyString(evidenceRef, "evidenceRef");
  if (!evidenceRef.startsWith("obj://")) throw new TypeError("evidenceRef must start with obj://");
  const raw = evidenceRef.slice("obj://".length);
  if (!raw || raw.trim() === "") throw new TypeError("evidenceRef path is required");
  if (raw.includes("\0")) throw new TypeError("evidenceRef must not contain NUL");

  const normalized = raw.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") throw new TypeError("evidenceRef must not contain path traversal");
  }
  return parts.join("/");
}

export function buildEvidenceDownloadUrl({ basePath = "/evidence/download", tenantId, jobId, evidenceId, evidenceRef, expiresAt, secret }) {
  assertNonEmptyString(basePath, "basePath");
  tenantId = normalizeTenantId(tenantId);
  assertNonEmptyString(jobId, "jobId");
  assertNonEmptyString(evidenceId, "evidenceId");
  assertNonEmptyString(evidenceRef, "evidenceRef");
  assertNonEmptyString(expiresAt, "expiresAt");
  assertNonEmptyString(secret, "secret");

  const sig = signEvidenceDownload({ secret, tenantId, jobId, evidenceId, evidenceRef, expiresAt });
  const qs = new URLSearchParams({
    tenantId,
    jobId,
    evidenceId,
    evidenceRef,
    expiresAt,
    sig
  });
  return `${basePath}?${qs.toString()}`;
}

export function signEvidenceDownload({ secret, tenantId, jobId, evidenceId, evidenceRef, expiresAt }) {
  assertNonEmptyString(secret, "secret");
  tenantId = normalizeTenantId(tenantId);
  assertNonEmptyString(jobId, "jobId");
  assertNonEmptyString(evidenceId, "evidenceId");
  assertNonEmptyString(evidenceRef, "evidenceRef");
  assertNonEmptyString(expiresAt, "expiresAt");

  const data = `${tenantId}\n${jobId}\n${evidenceId}\n${evidenceRef}\n${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

export function verifyEvidenceDownload({ secret, tenantId, jobId, evidenceId, evidenceRef, expiresAt, sig, nowMs = Date.now() }) {
  assertNonEmptyString(secret, "secret");
  assertNonEmptyString(sig, "sig");
  tenantId = normalizeTenantId(tenantId);
  assertNonEmptyString(jobId, "jobId");
  assertNonEmptyString(evidenceId, "evidenceId");
  assertNonEmptyString(evidenceRef, "evidenceRef");
  assertNonEmptyString(expiresAt, "expiresAt");
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite number");

  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return { ok: false, error: "invalid expiresAt" };
  if (nowMs > expMs) return { ok: false, error: "expired" };

  const expected = signEvidenceDownload({ secret, tenantId, jobId, evidenceId, evidenceRef, expiresAt });
  const ok = crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig, "utf8"));
  return ok ? { ok: true } : { ok: false, error: "bad signature" };
}

export function createFsEvidenceStore({ rootDir }) {
  assertNonEmptyString(rootDir, "rootDir");

  async function ensureRoot(tenantId) {
    tenantId = normalizeTenantId(tenantId);
    await fs.mkdir(path.join(rootDir, tenantId), { recursive: true });
  }

  function resolvePath({ tenantId, evidenceRef }) {
    tenantId = normalizeTenantId(tenantId);
    const rel = parseObjEvidenceRef(evidenceRef);
    return path.join(rootDir, tenantId, rel);
  }

  async function putEvidence({ tenantId, evidenceRef, data }) {
    assertNonEmptyString(evidenceRef, "evidenceRef");
    if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
    await ensureRoot(tenantId);
    const fp = resolvePath({ tenantId, evidenceRef });
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, data);
    return { evidenceRef };
  }

  async function readEvidence({ tenantId, evidenceRef }) {
    const fp = resolvePath({ tenantId, evidenceRef });
    const data = await fs.readFile(fp);
    return { data };
  }

  async function deleteEvidence({ tenantId, evidenceRef }) {
    const fp = resolvePath({ tenantId, evidenceRef });
    try {
      await fs.unlink(fp);
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      throw err;
    }
  }

  return {
    kind: "fs",
    rootDir,
    resolvePath,
    putEvidence,
    readEvidence,
    deleteEvidence
  };
}

export function createInMemoryEvidenceStore() {
  const byTenant = new Map(); // tenantId -> Map<evidenceRef, Uint8Array>

  function getTenantMap(tenantId) {
    tenantId = normalizeTenantId(tenantId);
    let m = byTenant.get(tenantId);
    if (!m) {
      m = new Map();
      byTenant.set(tenantId, m);
    }
    return m;
  }

  return {
    kind: "memory",
    async putEvidence({ tenantId, evidenceRef, data }) {
      assertNonEmptyString(evidenceRef, "evidenceRef");
      if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
      const m = getTenantMap(tenantId);
      m.set(evidenceRef, data);
      return { evidenceRef };
    },
    async readEvidence({ tenantId, evidenceRef }) {
      assertNonEmptyString(evidenceRef, "evidenceRef");
      const m = getTenantMap(tenantId);
      const data = m.get(evidenceRef);
      if (!data) {
        const err = new Error("not found");
        err.code = "ENOENT";
        throw err;
      }
      return { data };
    },
    async deleteEvidence({ tenantId, evidenceRef }) {
      assertNonEmptyString(evidenceRef, "evidenceRef");
      const m = getTenantMap(tenantId);
      return m.delete(evidenceRef);
    }
  };
}

export function createS3EvidenceStore({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = true } = {}) {
  assertNonEmptyString(endpoint, "endpoint");
  assertNonEmptyString(region, "region");
  assertNonEmptyString(bucket, "bucket");
  assertNonEmptyString(accessKeyId, "accessKeyId");
  assertNonEmptyString(secretAccessKey, "secretAccessKey");

  function keyFor({ tenantId, evidenceRef }) {
    tenantId = normalizeTenantId(tenantId);
    const rel = parseObjEvidenceRef(evidenceRef);
    return `${tenantId}/${rel}`;
  }

  async function putEvidence({ tenantId, evidenceRef, data }) {
    assertNonEmptyString(evidenceRef, "evidenceRef");
    if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
    const key = keyFor({ tenantId, evidenceRef });
    const url = presignS3Url({
      endpoint,
      region,
      bucket,
      key,
      method: "PUT",
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      expiresInSeconds: 300
    });
    const resp = await fetch(url, { method: "PUT", body: data });
    if (!resp.ok) throw new Error(`S3 put failed (${resp.status})`);
    return { evidenceRef };
  }

  async function readEvidence({ tenantId, evidenceRef }) {
    assertNonEmptyString(evidenceRef, "evidenceRef");
    const key = keyFor({ tenantId, evidenceRef });
    const url = presignS3Url({
      endpoint,
      region,
      bucket,
      key,
      method: "GET",
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      expiresInSeconds: 300
    });
    const resp = await fetch(url, { method: "GET" });
    if (resp.status === 404) {
      const err = new Error("not found");
      err.code = "ENOENT";
      throw err;
    }
    if (!resp.ok) throw new Error(`S3 get failed (${resp.status})`);
    const ab = await resp.arrayBuffer();
    return { data: new Uint8Array(ab) };
  }

  async function deleteEvidence({ tenantId, evidenceRef }) {
    assertNonEmptyString(evidenceRef, "evidenceRef");
    const key = keyFor({ tenantId, evidenceRef });
    const url = presignS3Url({
      endpoint,
      region,
      bucket,
      key,
      method: "DELETE",
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      expiresInSeconds: 300
    });
    const resp = await fetch(url, { method: "DELETE" });
    if (!resp.ok && resp.status !== 404) throw new Error(`S3 delete failed (${resp.status})`);
    return resp.ok;
  }

  async function getPresignedDownloadUrl({ tenantId, evidenceRef, expiresInSeconds }) {
    assertNonEmptyString(evidenceRef, "evidenceRef");
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new TypeError("expiresInSeconds must be a positive integer");
    }
    const key = keyFor({ tenantId, evidenceRef });
    return presignS3Url({
      endpoint,
      region,
      bucket,
      key,
      method: "GET",
      accessKeyId,
      secretAccessKey,
      forcePathStyle,
      expiresInSeconds
    });
  }

  return {
    kind: "s3",
    endpoint,
    region,
    bucket,
    forcePathStyle: Boolean(forcePathStyle),
    keyFor,
    putEvidence,
    readEvidence,
    deleteEvidence,
    getPresignedDownloadUrl
  };
}
