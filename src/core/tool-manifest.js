import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const TOOL_MANIFEST_SCHEMA_VERSION = "ToolManifest.v1";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function assertIsoDate(value, name) {
  assertNonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO date string`);
}

function normalizeId(value, name, { min = 1, max = 128 } = {}) {
  assertNonEmptyString(value, name);
  const out = String(value).trim();
  if (out.length < min || out.length > max) throw new TypeError(`${name} must be length ${min}..${max}`);
  if (!/^[A-Za-z0-9:_-]+$/.test(out)) throw new TypeError(`${name} must match ^[A-Za-z0-9:_-]+$`);
  return out;
}

function normalizeOptionalString(value, name, { max = 4000 } = {}) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  if (!out) return null;
  if (out.length > max) throw new TypeError(`${name} must be <= ${max} chars`);
  return out;
}

function normalizeHexHash(value, name) {
  assertNonEmptyString(value, name);
  const out = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(out)) throw new TypeError(`${name} must be a 64-hex sha256`);
  return out;
}

function normalizeToolEnvelope(tool, name) {
  assertPlainObject(tool, name);
  const toolName = normalizeOptionalString(tool.name, `${name}.name`, { max: 200 });
  const toolDesc = normalizeOptionalString(tool.description, `${name}.description`, { max: 4000 });
  if (!toolName) throw new TypeError(`${name}.name is required`);
  if (!toolDesc) throw new TypeError(`${name}.description is required`);
  const inputSchema = tool.inputSchema;
  assertPlainObject(inputSchema, `${name}.inputSchema`);
  return normalizeForCanonicalJson(
    {
      name: toolName,
      description: toolDesc,
      inputSchema
    },
    { path: "$" }
  );
}

function normalizeTransport(transport, name) {
  assertPlainObject(transport, name);
  const kind = typeof transport.kind === "string" ? transport.kind.trim().toLowerCase() : "";
  if (kind !== "mcp") throw new TypeError(`${name}.kind must be "mcp"`);
  assertNonEmptyString(transport.url, `${name}.url`);
  const url = String(transport.url).trim();
  if (url.length > 2000) throw new TypeError(`${name}.url must be <= 2000 chars`);
  return normalizeForCanonicalJson({ kind: "mcp", url }, { path: "$" });
}

export function computeToolManifestHashV1(manifestCore) {
  if (!manifestCore || typeof manifestCore !== "object" || Array.isArray(manifestCore)) {
    throw new TypeError("manifestCore must be an object");
  }
  const copy = { ...manifestCore };
  delete copy.manifestHash;
  delete copy.signature;
  const normalized = normalizeForCanonicalJson(copy, { path: "$" });
  const canonical = canonicalJsonStringify(normalized);
  return sha256Hex(canonical);
}

export function buildToolManifestV1({
  toolId,
  tenantId,
  name,
  description = null,
  tool,
  transport,
  capabilities = null,
  pricing = null,
  metadata = null,
  signer,
  at
} = {}) {
  const createdAt = at ?? new Date().toISOString();
  assertIsoDate(createdAt, "at");

  const normalized = normalizeForCanonicalJson(
    {
      schemaVersion: TOOL_MANIFEST_SCHEMA_VERSION,
      toolId: normalizeId(toolId, "toolId", { min: 3, max: 128 }),
      tenantId: normalizeId(tenantId, "tenantId", { min: 1, max: 128 }),
      name: normalizeOptionalString(name, "name", { max: 200 }) ?? (() => { throw new TypeError("name is required"); })(),
      description: normalizeOptionalString(description, "description", { max: 4000 }),
      tool: normalizeToolEnvelope(tool, "tool"),
      transport: normalizeTransport(transport, "transport"),
      capabilities: Array.isArray(capabilities) ? capabilities.filter((c) => typeof c === "string" && c.trim() !== "").map((c) => c.trim()) : [],
      pricing: pricing && typeof pricing === "object" && !Array.isArray(pricing) ? pricing : null,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null,
      createdAt,
      updatedAt: createdAt
    },
    { path: "$" }
  );

  const manifestHash = computeToolManifestHashV1(normalized);

  if (!signer || typeof signer !== "object" || Array.isArray(signer)) throw new TypeError("signer is required");
  assertNonEmptyString(signer.keyId, "signer.keyId");
  assertNonEmptyString(signer.privateKeyPem, "signer.privateKeyPem");
  const signature = signHashHexEd25519(manifestHash, signer.privateKeyPem);

  return normalizeForCanonicalJson(
    {
      ...normalized,
      manifestHash,
      signature: {
        signerKeyId: String(signer.keyId),
        signedAt: createdAt,
        signature
      }
    },
    { path: "$" }
  );
}

export function validateToolManifestV1(manifest) {
  assertPlainObject(manifest, "manifest");
  if (manifest.schemaVersion !== TOOL_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`manifest.schemaVersion must be ${TOOL_MANIFEST_SCHEMA_VERSION}`);
  }
  normalizeId(manifest.toolId, "manifest.toolId", { min: 3, max: 128 });
  normalizeId(manifest.tenantId, "manifest.tenantId", { min: 1, max: 128 });
  if (!normalizeOptionalString(manifest.name, "manifest.name", { max: 200 })) throw new TypeError("manifest.name is required");
  if (manifest.description !== undefined && manifest.description !== null) {
    normalizeOptionalString(manifest.description, "manifest.description", { max: 4000 });
  }
  normalizeToolEnvelope(manifest.tool, "manifest.tool");
  normalizeTransport(manifest.transport, "manifest.transport");
  assertIsoDate(manifest.createdAt, "manifest.createdAt");
  assertIsoDate(manifest.updatedAt, "manifest.updatedAt");
  const manifestHash = normalizeHexHash(manifest.manifestHash, "manifest.manifestHash");

  assertPlainObject(manifest.signature, "manifest.signature");
  assertNonEmptyString(manifest.signature.signerKeyId, "manifest.signature.signerKeyId");
  assertIsoDate(manifest.signature.signedAt, "manifest.signature.signedAt");
  assertNonEmptyString(manifest.signature.signature, "manifest.signature.signature");

  const computed = computeToolManifestHashV1(manifest);
  if (computed !== manifestHash) throw new TypeError("manifestHash mismatch");

  return true;
}

export function verifyToolManifestV1({ manifest, publicKeyPem } = {}) {
  validateToolManifestV1(manifest);
  assertNonEmptyString(publicKeyPem, "publicKeyPem");
  const ok = verifyHashHexEd25519({
    hashHex: manifest.manifestHash,
    signatureBase64: manifest.signature.signature,
    publicKeyPem
  });
  if (!ok) throw new TypeError("tool manifest signature invalid");
  return true;
}

export function assertToolManifestPinned({ pinnedManifestHash, manifest } = {}) {
  const expected = normalizeHexHash(pinnedManifestHash, "pinnedManifestHash");
  validateToolManifestV1(manifest);
  if (manifest.manifestHash !== expected) {
    const err = new Error("tool manifest hash does not match pinned approval");
    err.code = "TOOL_MANIFEST_PIN_MISMATCH";
    throw err;
  }
  return true;
}

