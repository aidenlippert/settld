#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";

const REPORT_SCHEMA_VERSION = "NooterraProtocolCompatibilityMatrixReport.v1";
const POLICY_SCHEMA_VERSION = "NooterraProtocolCompatibilityPolicy.v1";
const DRIFT_OVERRIDE_SCHEMA_VERSION = "NooterraProtocolCompatibilityDriftOverride.v1";
const DRIFT_GATE_SCHEMA_VERSION = "NooterraProtocolCompatibilityDriftGate.v1";
const DETERMINISTIC_CORE_SCHEMA_VERSION = "NooterraProtocolCompatibilityMatrixDeterministicCore.v1";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_REPORT_PATH = "artifacts/gates/protocol-compatibility-matrix.json";
const DEFAULT_POLICY_PATH = "docs/kernel-compatible/protocol-compatibility-policy.json";
const PUBLIC_SPEC_DIR = "docs/spec/public";
const JSON_SCHEMA_DIR = "docs/spec/schemas";
const OPENAPI_PATH = "openapi/nooterra.openapi.json";
const REPO_PACKAGE_PATH = "package.json";
const ARTIFACT_VERIFY_PACKAGE_PATH = "packages/artifact-verify/package.json";
const SURFACE_IDS = Object.freeze(["publicSpecMarkdown", "jsonSchema", "openapi"]);

function usage() {
  return [
    "usage: node scripts/ci/run-protocol-compatibility-matrix.mjs [options]",
    "",
    "options:",
    "  --report <file>          Output report path (default: artifacts/gates/protocol-compatibility-matrix.json)",
    "  --policy <file>          Compatibility policy path (default: docs/kernel-compatible/protocol-compatibility-policy.json)",
    "  --drift-override <file>  Optional drift override JSON path",
    "  --now <iso-8601>         Optional deterministic timestamp for report + override validation",
    "  --help                   Show help"
  ].join("\n");
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cmpString(a, b) {
  const aa = String(a ?? "");
  const bb = String(b ?? "");
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  return 0;
}

function uniqueSortedStrings(values) {
  const set = new Set();
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized) continue;
    set.add(normalized);
  }
  return Array.from(set).sort(cmpString);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseIso8601(value, fieldName) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const epochMs = Date.parse(normalized);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`${fieldName} must be a valid ISO-8601 timestamp`);
  }
  return new Date(epochMs).toISOString();
}

function parseNodeMajor(version = process.versions?.node ?? "") {
  const match = String(version).match(/^(\d+)\./);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

function countStringOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length - needle.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function extractSchemaVersionFromJsonSchema(json) {
  const constValue = json?.properties?.schemaVersion?.const;
  if (typeof constValue === "string" && constValue.trim() !== "") {
    return constValue;
  }
  const enumValue = json?.properties?.schemaVersion?.enum;
  if (Array.isArray(enumValue) && enumValue.length === 1 && typeof enumValue[0] === "string" && enumValue[0].trim() !== "") {
    return enumValue[0];
  }
  return null;
}

function normalizeIssue(issue) {
  return {
    id: normalizeOptionalString(issue?.id) ?? "issue_unknown",
    category: normalizeOptionalString(issue?.category) ?? "gate",
    code: normalizeOptionalString(issue?.code) ?? "unknown",
    message: normalizeOptionalString(issue?.message) ?? "unknown issue",
    objectId: normalizeOptionalString(issue?.objectId),
    schemaVersion: normalizeOptionalString(issue?.schemaVersion),
    surface: normalizeOptionalString(issue?.surface)
  };
}

function sortIssues(issues) {
  return [...issues]
    .map(normalizeIssue)
    .sort((a, b) => cmpString(a.id, b.id) || cmpString(a.category, b.category) || cmpString(a.code, b.code));
}

export function parseArgs(argv, cwd = process.cwd()) {
  const out = {
    reportPath: path.resolve(cwd, DEFAULT_REPORT_PATH),
    policyPath: path.resolve(cwd, DEFAULT_POLICY_PATH),
    driftOverridePath: null,
    nowIso: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "").trim();
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--report") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--report requires a file path");
      out.reportPath = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--policy") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--policy requires a file path");
      out.policyPath = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--drift-override") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--drift-override requires a JSON file path");
      out.driftOverridePath = path.resolve(cwd, value);
      i += 1;
      continue;
    }
    if (arg === "--now") {
      const value = normalizeOptionalString(argv[i + 1]);
      if (!value) throw new Error("--now requires an ISO-8601 timestamp");
      out.nowIso = parseIso8601(value, "--now");
      i += 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return out;
}

async function loadTextArtifact(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = err?.code === "ENOENT" ? "file_missing" : "file_read_error";
    return {
      readOk: false,
      raw: null,
      sourceSha256: null,
      errorCode: code,
      errorMessage: err?.message ?? String(err)
    };
  }

  return {
    readOk: true,
    raw,
    sourceSha256: sha256Hex(raw),
    errorCode: null,
    errorMessage: null
  };
}

async function loadJsonArtifact(filePath) {
  const loaded = await loadTextArtifact(filePath);
  if (!loaded.readOk) {
    return {
      ...loaded,
      parseOk: false,
      json: null
    };
  }

  try {
    return {
      ...loaded,
      parseOk: true,
      json: JSON.parse(loaded.raw)
    };
  } catch (err) {
    return {
      ...loaded,
      parseOk: false,
      json: null,
      errorCode: "json_parse_error",
      errorMessage: err?.message ?? String(err)
    };
  }
}

function normalizePolicyObject(rawRow, index) {
  if (!isPlainObject(rawRow)) {
    throw new Error(`policy objects[${index}] must be an object`);
  }

  const objectId = normalizeOptionalString(rawRow.objectId);
  if (!objectId) throw new Error(`policy objects[${index}].objectId is required`);

  const schemaVersion = normalizeOptionalString(rawRow.schemaVersion);
  if (!schemaVersion) throw new Error(`policy objects[${index}].schemaVersion is required`);

  if (!Array.isArray(rawRow.requiredSurfaces) || rawRow.requiredSurfaces.length === 0) {
    throw new Error(`policy objects[${index}].requiredSurfaces must be a non-empty array`);
  }

  const requiredSurfaces = uniqueSortedStrings(rawRow.requiredSurfaces);
  for (const surface of requiredSurfaces) {
    if (!SURFACE_IDS.includes(surface)) {
      throw new Error(`policy objects[${index}].requiredSurfaces includes unsupported surface ${surface}`);
    }
  }

  return {
    objectId,
    schemaVersion,
    requiredSurfaces
  };
}

function normalizePolicy(rawPolicy, policyPath) {
  if (!isPlainObject(rawPolicy)) {
    throw new Error(`policy at ${policyPath} must be a JSON object`);
  }

  if (rawPolicy.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new Error(`policy schemaVersion must be ${POLICY_SCHEMA_VERSION}`);
  }

  const policyId = normalizeOptionalString(rawPolicy.policyId) ?? "nooterra-protocol-compatibility-policy";
  const updatedAt = parseIso8601(normalizeOptionalString(rawPolicy.updatedAt), "policy.updatedAt");

  if (!Array.isArray(rawPolicy.objects) || rawPolicy.objects.length === 0) {
    throw new Error("policy objects must be a non-empty array");
  }

  const seenObjectIds = new Set();
  const objects = [];
  for (let index = 0; index < rawPolicy.objects.length; index += 1) {
    const normalized = normalizePolicyObject(rawPolicy.objects[index], index);
    if (seenObjectIds.has(normalized.objectId)) {
      throw new Error(`policy objectId must be unique; duplicate ${normalized.objectId}`);
    }
    seenObjectIds.add(normalized.objectId);
    objects.push(normalized);
  }

  objects.sort((a, b) => cmpString(a.objectId, b.objectId) || cmpString(a.schemaVersion, b.schemaVersion));

  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    policyId,
    updatedAt,
    policyPath,
    objects
  };
}

async function loadPolicy(policyPath) {
  const loaded = await loadJsonArtifact(policyPath);
  if (!loaded.readOk) {
    return {
      ok: false,
      policy: null,
      sourceSha256: null,
      errorCode: `policy_${loaded.errorCode}`,
      errorMessage: loaded.errorMessage
    };
  }
  if (!loaded.parseOk) {
    return {
      ok: false,
      policy: null,
      sourceSha256: loaded.sourceSha256,
      errorCode: "policy_json_parse_error",
      errorMessage: loaded.errorMessage
    };
  }

  try {
    return {
      ok: true,
      policy: normalizePolicy(loaded.json, policyPath),
      sourceSha256: loaded.sourceSha256,
      errorCode: null,
      errorMessage: null
    };
  } catch (err) {
    return {
      ok: false,
      policy: null,
      sourceSha256: loaded.sourceSha256,
      errorCode: "policy_invalid",
      errorMessage: err?.message ?? String(err)
    };
  }
}

function evaluateSurfaceIssue({
  objectId,
  schemaVersion,
  surface,
  required,
  readOk,
  parseOk,
  matchesSchemaVersion,
  readErrorCode
}) {
  if (required) {
    if (!readOk) {
      return {
        id: `${objectId}:${surface}:missing_required`,
        category: "compatibility",
        code: `required_surface_unavailable_${readErrorCode ?? "unknown"}`,
        message: `${surface} is required but unavailable`,
        objectId,
        schemaVersion,
        surface
      };
    }
    if (parseOk === false) {
      return {
        id: `${objectId}:${surface}:invalid`,
        category: "compatibility",
        code: "required_surface_invalid_json",
        message: `${surface} is required but contains invalid JSON`,
        objectId,
        schemaVersion,
        surface
      };
    }
    if (matchesSchemaVersion === false) {
      return {
        id: `${objectId}:${surface}:mismatch`,
        category: "compatibility",
        code: "required_surface_schema_version_missing",
        message: `${surface} is required but does not reference expected schemaVersion`,
        objectId,
        schemaVersion,
        surface
      };
    }
    return null;
  }

  if (!readOk) {
    if (readErrorCode === "file_missing") return null;
    return {
      id: `${objectId}:${surface}:read_error`,
      category: "compatibility",
      code: `optional_surface_unavailable_${readErrorCode ?? "unknown"}`,
      message: `${surface} optional surface is unreadable`,
      objectId,
      schemaVersion,
      surface
    };
  }

  if (parseOk === false) {
    return {
      id: `${objectId}:${surface}:invalid`,
      category: "compatibility",
      code: "optional_surface_invalid_json",
      message: `${surface} optional surface has invalid JSON`,
      objectId,
      schemaVersion,
      surface
    };
  }

  if (matchesSchemaVersion === false) {
    return {
      id: `${objectId}:${surface}:mismatch`,
      category: "compatibility",
      code: "optional_surface_schema_version_mismatch",
      message: `${surface} optional surface exists but does not match expected schemaVersion`,
      objectId,
      schemaVersion,
      surface
    };
  }

  return null;
}

async function evaluatePolicyObjectRow({
  objectId,
  schemaVersion,
  requiredSurfaces,
  publicSpecDir,
  jsonSchemaDir,
  openapiPath,
  openapiLoaded
}) {
  const requiredSet = new Set(requiredSurfaces);
  const issues = [];

  const publicSpecPath = path.join(publicSpecDir, `${schemaVersion}.md`);
  const publicSpecLoaded = await loadTextArtifact(publicSpecPath);
  const publicSpecOccurrenceCount = publicSpecLoaded.readOk ? countStringOccurrences(publicSpecLoaded.raw, schemaVersion) : 0;
  const publicSpecMatches = publicSpecOccurrenceCount > 0;
  const publicSpecIssue = evaluateSurfaceIssue({
    objectId,
    schemaVersion,
    surface: "publicSpecMarkdown",
    required: requiredSet.has("publicSpecMarkdown"),
    readOk: publicSpecLoaded.readOk,
    parseOk: null,
    matchesSchemaVersion: publicSpecMatches,
    readErrorCode: publicSpecLoaded.errorCode
  });
  if (publicSpecIssue) issues.push(publicSpecIssue);

  const jsonSchemaPath = path.join(jsonSchemaDir, `${schemaVersion}.schema.json`);
  const jsonSchemaLoaded = await loadJsonArtifact(jsonSchemaPath);
  const declaredSchemaVersion = jsonSchemaLoaded.readOk && jsonSchemaLoaded.parseOk ? extractSchemaVersionFromJsonSchema(jsonSchemaLoaded.json) : null;
  const jsonSchemaMatches = declaredSchemaVersion === schemaVersion;
  const jsonSchemaIssue = evaluateSurfaceIssue({
    objectId,
    schemaVersion,
    surface: "jsonSchema",
    required: requiredSet.has("jsonSchema"),
    readOk: jsonSchemaLoaded.readOk,
    parseOk: jsonSchemaLoaded.parseOk,
    matchesSchemaVersion: jsonSchemaLoaded.readOk && jsonSchemaLoaded.parseOk ? jsonSchemaMatches : false,
    readErrorCode: jsonSchemaLoaded.errorCode
  });
  if (jsonSchemaIssue) issues.push(jsonSchemaIssue);

  const openapiOccurrenceCount = openapiLoaded.readOk ? countStringOccurrences(openapiLoaded.raw, schemaVersion) : 0;
  const openapiMatches = openapiOccurrenceCount > 0;
  const openapiIssue = evaluateSurfaceIssue({
    objectId,
    schemaVersion,
    surface: "openapi",
    required: requiredSet.has("openapi"),
    readOk: openapiLoaded.readOk,
    parseOk: null,
    matchesSchemaVersion: openapiMatches,
    readErrorCode: openapiLoaded.errorCode
  });
  if (openapiIssue) issues.push(openapiIssue);

  const row = {
    objectId,
    schemaVersion,
    requiredSurfaces,
    strictCompatibilityOk: issues.length === 0,
    surfaces: {
      publicSpecMarkdown: {
        required: requiredSet.has("publicSpecMarkdown"),
        ok: publicSpecLoaded.readOk && publicSpecMatches,
        present: publicSpecLoaded.readOk,
        path: publicSpecPath,
        sourceSha256: publicSpecLoaded.sourceSha256,
        occurrenceCount: publicSpecOccurrenceCount,
        schemaVersionMatches: publicSpecMatches,
        errorCode: publicSpecLoaded.errorCode,
        errorMessage: publicSpecLoaded.errorMessage
      },
      jsonSchema: {
        required: requiredSet.has("jsonSchema"),
        ok: jsonSchemaLoaded.readOk && jsonSchemaLoaded.parseOk && jsonSchemaMatches,
        present: jsonSchemaLoaded.readOk,
        path: jsonSchemaPath,
        sourceSha256: jsonSchemaLoaded.sourceSha256,
        parseOk: jsonSchemaLoaded.parseOk,
        declaredSchemaVersion,
        schemaVersionMatches: jsonSchemaLoaded.readOk && jsonSchemaLoaded.parseOk ? jsonSchemaMatches : false,
        errorCode: jsonSchemaLoaded.errorCode,
        errorMessage: jsonSchemaLoaded.errorMessage
      },
      openapi: {
        required: requiredSet.has("openapi"),
        ok: openapiLoaded.readOk && openapiMatches,
        present: openapiLoaded.readOk,
        path: openapiPath,
        sourceSha256: openapiLoaded.sourceSha256,
        occurrenceCount: openapiOccurrenceCount,
        schemaVersionMatches: openapiMatches,
        errorCode: openapiLoaded.errorCode,
        errorMessage: openapiLoaded.errorMessage
      }
    },
    issueIds: issues.map((issue) => issue.id).sort(cmpString)
  };

  return {
    row,
    issues
  };
}

function buildRuntimeRelease({ repoPackage, artifactVerifyPackage, openapiMetadata }) {
  const nodeVersion = normalizeOptionalString(process.versions?.node) ?? null;
  const nodeMajor = parseNodeMajor(nodeVersion ?? "");

  const repoVersion = repoPackage.readOk && repoPackage.parseOk ? normalizeOptionalString(repoPackage.json?.version) : null;
  const repoPackageName = repoPackage.readOk && repoPackage.parseOk ? normalizeOptionalString(repoPackage.json?.name) : null;
  const repoScripts = repoPackage.readOk && repoPackage.parseOk && isPlainObject(repoPackage.json?.scripts)
    ? repoPackage.json.scripts
    : {};
  const repoBin = repoPackage.readOk && repoPackage.parseOk && isPlainObject(repoPackage.json?.bin)
    ? repoPackage.json.bin
    : {};
  const repoExports = repoPackage.readOk && repoPackage.parseOk && isPlainObject(repoPackage.json?.exports)
    ? repoPackage.json.exports
    : {};
  const hasAgentverseGateScript = typeof repoScripts["test:ops:agentverse-gate"] === "string";
  const hasAgentverseBin = typeof repoBin.agentverse === "string";
  const hasAgentverseExport = typeof repoExports["./agentverse"] === "string";
  const artifactVerifyVersion =
    artifactVerifyPackage.readOk && artifactVerifyPackage.parseOk ? normalizeOptionalString(artifactVerifyPackage.json?.version) : null;
  const openapiInfoVersion =
    openapiMetadata.readOk && openapiMetadata.parseOk ? normalizeOptionalString(openapiMetadata.json?.info?.version) : null;
  const openapiProtocol =
    openapiMetadata.readOk && openapiMetadata.parseOk ? normalizeOptionalString(openapiMetadata.json?.info?.["x-nooterra-protocol"]) : null;

  return {
    repo: {
      path: repoPackage.path,
      sourceSha256: repoPackage.sourceSha256,
      packageName: repoPackageName,
      version: repoVersion,
      readOk: repoPackage.readOk,
      parseOk: repoPackage.parseOk,
      errorCode: repoPackage.errorCode,
      errorMessage: repoPackage.errorMessage
    },
    artifactVerify: {
      path: artifactVerifyPackage.path,
      sourceSha256: artifactVerifyPackage.sourceSha256,
      packageName:
        artifactVerifyPackage.readOk && artifactVerifyPackage.parseOk ? normalizeOptionalString(artifactVerifyPackage.json?.name) : null,
      version: artifactVerifyVersion,
      readOk: artifactVerifyPackage.readOk,
      parseOk: artifactVerifyPackage.parseOk,
      errorCode: artifactVerifyPackage.errorCode,
      errorMessage: artifactVerifyPackage.errorMessage
    },
    openapi: {
      path: openapiMetadata.path,
      sourceSha256: openapiMetadata.sourceSha256,
      infoVersion: openapiInfoVersion,
      xNooterraProtocol: openapiProtocol,
      readOk: openapiMetadata.readOk,
      parseOk: openapiMetadata.parseOk,
      errorCode: openapiMetadata.errorCode,
      errorMessage: openapiMetadata.errorMessage
    },
    node: {
      version: nodeVersion,
      major: nodeMajor
    },
    agentverse: {
      gateScriptPresent: hasAgentverseGateScript,
      cliBinPresent: hasAgentverseBin,
      packageExportPresent: hasAgentverseExport
    }
  };
}

function buildRuntimeReleaseIssues(runtimeRelease) {
  const issues = [];

  if (!runtimeRelease.repo.version) {
    issues.push({
      id: "runtime:repo_version_missing",
      category: "gate",
      code: "runtime_release_repo_version_missing",
      message: "repo package version is missing"
    });
  }

  if (!runtimeRelease.artifactVerify.version) {
    issues.push({
      id: "runtime:artifact_verify_version_missing",
      category: "gate",
      code: "runtime_release_artifact_verify_version_missing",
      message: "artifact-verify package version is missing"
    });
  }

  if (!runtimeRelease.openapi.infoVersion) {
    issues.push({
      id: "runtime:openapi_info_version_missing",
      category: "gate",
      code: "runtime_release_openapi_info_version_missing",
      message: "openapi info.version is missing"
    });
  }

  if (!runtimeRelease.openapi.xNooterraProtocol) {
    issues.push({
      id: "runtime:openapi_protocol_missing",
      category: "gate",
      code: "runtime_release_openapi_protocol_missing",
      message: "openapi info.x-nooterra-protocol is missing"
    });
  }

  if (!Number.isSafeInteger(runtimeRelease.node.major)) {
    issues.push({
      id: "runtime:node_major_missing",
      category: "gate",
      code: "runtime_release_node_major_missing",
      message: "node major version is unavailable"
    });
  }

  // Agentverse gate requirements apply to this repository package only.
  if (runtimeRelease.repo.packageName === "nooterra") {
    if (runtimeRelease.agentverse?.gateScriptPresent !== true) {
      issues.push({
        id: "runtime:agentverse_gate_script_missing",
        category: "gate",
        code: "runtime_release_agentverse_gate_script_missing",
        message: "package.json scripts.test:ops:agentverse-gate is missing"
      });
    }
    if (runtimeRelease.agentverse?.cliBinPresent !== true) {
      issues.push({
        id: "runtime:agentverse_cli_bin_missing",
        category: "gate",
        code: "runtime_release_agentverse_cli_bin_missing",
        message: "package.json bin.agentverse is missing"
      });
    }
    if (runtimeRelease.agentverse?.packageExportPresent !== true) {
      issues.push({
        id: "runtime:agentverse_export_missing",
        category: "gate",
        code: "runtime_release_agentverse_export_missing",
        message: "package.json exports['./agentverse'] is missing"
      });
    }
  }

  return issues;
}

async function evaluateDriftOverride({ overridePath, nowIso }) {
  if (!overridePath) {
    return {
      provided: false,
      path: null,
      accepted: false,
      sourceSha256: null,
      schemaVersion: null,
      ticket: null,
      reason: null,
      approvedBy: null,
      approvedAt: null,
      expiresAt: null,
      auditRef: null,
      auditEvidenceSha256: null,
      errorCodes: []
    };
  }

  const loaded = await loadJsonArtifact(overridePath);
  if (!loaded.readOk) {
    return {
      provided: true,
      path: overridePath,
      accepted: false,
      sourceSha256: null,
      schemaVersion: null,
      ticket: null,
      reason: null,
      approvedBy: null,
      approvedAt: null,
      expiresAt: null,
      auditRef: null,
      auditEvidenceSha256: null,
      errorCodes: [`override_${loaded.errorCode}`],
      detail: loaded.errorMessage
    };
  }

  if (!loaded.parseOk) {
    return {
      provided: true,
      path: overridePath,
      accepted: false,
      sourceSha256: loaded.sourceSha256,
      schemaVersion: null,
      ticket: null,
      reason: null,
      approvedBy: null,
      approvedAt: null,
      expiresAt: null,
      auditRef: null,
      auditEvidenceSha256: null,
      errorCodes: ["override_json_parse_error"],
      detail: loaded.errorMessage
    };
  }

  const override = loaded.json;
  const errorCodes = [];

  if (override?.schemaVersion !== DRIFT_OVERRIDE_SCHEMA_VERSION) {
    errorCodes.push("override_schema_invalid");
  }

  const ticket = normalizeOptionalString(override?.ticket);
  const reason = normalizeOptionalString(override?.reason);
  const approvedBy = normalizeOptionalString(override?.approvedBy);
  const approvedAtRaw = normalizeOptionalString(override?.approvedAt);
  const expiresAtRaw = normalizeOptionalString(override?.expiresAt);
  const auditRef = normalizeOptionalString(override?.auditRef);
  const auditEvidenceSha256 = normalizeOptionalString(override?.auditEvidenceSha256)?.toLowerCase() ?? null;

  if (!ticket) errorCodes.push("override_ticket_missing");
  if (!reason) errorCodes.push("override_reason_missing");
  if (!approvedBy) errorCodes.push("override_approved_by_missing");
  if (!approvedAtRaw) errorCodes.push("override_approved_at_missing");
  if (!expiresAtRaw) errorCodes.push("override_expires_at_missing");
  if (!auditRef) errorCodes.push("override_audit_ref_missing");
  if (!auditEvidenceSha256) {
    errorCodes.push("override_audit_evidence_sha256_missing");
  } else if (!SHA256_HEX_PATTERN.test(auditEvidenceSha256)) {
    errorCodes.push("override_audit_evidence_sha256_invalid");
  }

  let approvedAtIso = null;
  let expiresAtIso = null;
  let approvedAtEpochMs = null;
  let expiresAtEpochMs = null;

  if (approvedAtRaw) {
    approvedAtEpochMs = Date.parse(approvedAtRaw);
    if (!Number.isFinite(approvedAtEpochMs)) {
      errorCodes.push("override_approved_at_invalid");
    } else {
      approvedAtIso = new Date(approvedAtEpochMs).toISOString();
    }
  }

  if (expiresAtRaw) {
    expiresAtEpochMs = Date.parse(expiresAtRaw);
    if (!Number.isFinite(expiresAtEpochMs)) {
      errorCodes.push("override_expires_at_invalid");
    } else {
      expiresAtIso = new Date(expiresAtEpochMs).toISOString();
    }
  }

  const nowEpochMs = Date.parse(nowIso);
  if (Number.isFinite(expiresAtEpochMs) && Number.isFinite(nowEpochMs) && expiresAtEpochMs <= nowEpochMs) {
    errorCodes.push("override_expired");
  }

  if (Number.isFinite(approvedAtEpochMs) && Number.isFinite(expiresAtEpochMs) && expiresAtEpochMs <= approvedAtEpochMs) {
    errorCodes.push("override_expiry_not_after_approved_at");
  }

  errorCodes.sort(cmpString);

  return {
    provided: true,
    path: overridePath,
    accepted: errorCodes.length === 0,
    sourceSha256: loaded.sourceSha256,
    schemaVersion: typeof override?.schemaVersion === "string" ? override.schemaVersion : null,
    ticket,
    reason,
    approvedBy,
    approvedAt: approvedAtIso,
    expiresAt: expiresAtIso,
    auditRef,
    auditEvidenceSha256,
    errorCodes
  };
}

function buildDeterministicCore(report) {
  const rows = Array.isArray(report?.matrix) ? report.matrix : [];
  const normalizedRows = rows
    .map((row) => ({
      objectId: normalizeOptionalString(row?.objectId),
      schemaVersion: normalizeOptionalString(row?.schemaVersion),
      requiredSurfaces: uniqueSortedStrings(Array.isArray(row?.requiredSurfaces) ? row.requiredSurfaces : []),
      strictCompatibilityOk: row?.strictCompatibilityOk === true,
      surfaces: {
        publicSpecMarkdown: {
          required: row?.surfaces?.publicSpecMarkdown?.required === true,
          ok: row?.surfaces?.publicSpecMarkdown?.ok === true,
          present: row?.surfaces?.publicSpecMarkdown?.present === true,
          schemaVersionMatches: row?.surfaces?.publicSpecMarkdown?.schemaVersionMatches === true,
          occurrenceCount: Number.isInteger(row?.surfaces?.publicSpecMarkdown?.occurrenceCount)
            ? row.surfaces.publicSpecMarkdown.occurrenceCount
            : 0
        },
        jsonSchema: {
          required: row?.surfaces?.jsonSchema?.required === true,
          ok: row?.surfaces?.jsonSchema?.ok === true,
          present: row?.surfaces?.jsonSchema?.present === true,
          parseOk: row?.surfaces?.jsonSchema?.parseOk === true,
          declaredSchemaVersion: normalizeOptionalString(row?.surfaces?.jsonSchema?.declaredSchemaVersion),
          schemaVersionMatches: row?.surfaces?.jsonSchema?.schemaVersionMatches === true
        },
        openapi: {
          required: row?.surfaces?.openapi?.required === true,
          ok: row?.surfaces?.openapi?.ok === true,
          present: row?.surfaces?.openapi?.present === true,
          schemaVersionMatches: row?.surfaces?.openapi?.schemaVersionMatches === true,
          occurrenceCount: Number.isInteger(row?.surfaces?.openapi?.occurrenceCount) ? row.surfaces.openapi.occurrenceCount : 0
        }
      }
    }))
    .sort((a, b) => cmpString(a.objectId, b.objectId) || cmpString(a.schemaVersion, b.schemaVersion));

  const blockingIssues = Array.isArray(report?.driftGate?.blockingIssues)
    ? report.driftGate.blockingIssues.map((issue) => normalizeIssue(issue).id).sort(cmpString)
    : [];

  return normalizeForCanonicalJson({
    schemaVersion: REPORT_SCHEMA_VERSION,
    policy: {
      schemaVersion: normalizeOptionalString(report?.policy?.schemaVersion),
      policyId: normalizeOptionalString(report?.policy?.policyId),
      objects: Array.isArray(report?.policy?.objects)
        ? report.policy.objects
            .map((row) => ({
              objectId: normalizeOptionalString(row?.objectId),
              schemaVersion: normalizeOptionalString(row?.schemaVersion),
              requiredSurfaces: uniqueSortedStrings(Array.isArray(row?.requiredSurfaces) ? row.requiredSurfaces : [])
            }))
            .sort((a, b) => cmpString(a.objectId, b.objectId) || cmpString(a.schemaVersion, b.schemaVersion))
        : []
    },
    runtimeRelease: {
      repoVersion: normalizeOptionalString(report?.runtimeRelease?.repo?.version),
      artifactVerifyVersion: normalizeOptionalString(report?.runtimeRelease?.artifactVerify?.version),
      openapiInfoVersion: normalizeOptionalString(report?.runtimeRelease?.openapi?.infoVersion),
      openapiProtocol: normalizeOptionalString(report?.runtimeRelease?.openapi?.xNooterraProtocol),
      nodeMajor: Number.isInteger(report?.runtimeRelease?.node?.major) ? report.runtimeRelease.node.major : null
    },
    matrix: normalizedRows,
    driftGate: {
      schemaVersion: DRIFT_GATE_SCHEMA_VERSION,
      strictOk: report?.driftGate?.strictOk === true,
      okWithOverride: report?.driftGate?.okWithOverride === true,
      overrideApplied: report?.driftGate?.overrideApplied === true,
      blockingIssueIds: blockingIssues
    }
  });
}

export async function runProtocolCompatibilityMatrix(args, env = process.env, cwd = process.cwd()) {
  const nowIso =
    args.nowIso ??
    parseIso8601(normalizeOptionalString(env.PROTOCOL_COMPATIBILITY_MATRIX_NOW), "PROTOCOL_COMPATIBILITY_MATRIX_NOW") ??
    new Date().toISOString();

  const policyLoad = await loadPolicy(args.policyPath);
  const policy = policyLoad.policy;

  const openapiPath = path.resolve(cwd, OPENAPI_PATH);
  const openapiLoaded = await loadJsonArtifact(openapiPath);
  openapiLoaded.path = openapiPath;

  const repoPackagePath = path.resolve(cwd, REPO_PACKAGE_PATH);
  const repoPackage = await loadJsonArtifact(repoPackagePath);
  repoPackage.path = repoPackagePath;

  const artifactVerifyPackagePath = path.resolve(cwd, ARTIFACT_VERIFY_PACKAGE_PATH);
  const artifactVerifyPackage = await loadJsonArtifact(artifactVerifyPackagePath);
  artifactVerifyPackage.path = artifactVerifyPackagePath;

  const runtimeRelease = buildRuntimeRelease({
    repoPackage,
    artifactVerifyPackage,
    openapiMetadata: openapiLoaded
  });

  const issues = [];
  if (!policyLoad.ok) {
    issues.push({
      id: "policy:invalid",
      category: "gate",
      code: policyLoad.errorCode,
      message: policyLoad.errorMessage
    });
  }

  issues.push(...buildRuntimeReleaseIssues(runtimeRelease));

  const publicSpecDir = path.resolve(cwd, PUBLIC_SPEC_DIR);
  const jsonSchemaDir = path.resolve(cwd, JSON_SCHEMA_DIR);

  const matrix = [];
  if (policy) {
    for (const objectRow of policy.objects) {
      // Keep row evaluation deterministic by preserving sorted object iteration order.
      // eslint-disable-next-line no-await-in-loop
      const evaluated = await evaluatePolicyObjectRow({
        ...objectRow,
        publicSpecDir,
        jsonSchemaDir,
        openapiPath,
        openapiLoaded
      });
      matrix.push(evaluated.row);
      issues.push(...evaluated.issues);
    }
  }

  matrix.sort((a, b) => cmpString(a.objectId, b.objectId) || cmpString(a.schemaVersion, b.schemaVersion));

  const override = await evaluateDriftOverride({
    overridePath: args.driftOverridePath,
    nowIso
  });

  const blockingIssues = sortIssues(issues);
  const strictOk = blockingIssues.length === 0;
  const onlyCompatibilityIssues =
    !strictOk && blockingIssues.every((issue) => issue.category === "compatibility");
  const overrideApplied = !strictOk && override.accepted === true && onlyCompatibilityIssues;
  const okWithOverride = strictOk || overrideApplied;

  const driftGate = {
    schemaVersion: DRIFT_GATE_SCHEMA_VERSION,
    strictOk,
    okWithOverride,
    overrideApplied,
    override,
    blockingIssues
  };

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: nowIso,
    ok: okWithOverride,
    strictOk,
    okWithOverride,
    policy: policy
      ? {
          schemaVersion: policy.schemaVersion,
          policyId: policy.policyId,
          updatedAt: policy.updatedAt,
          policyPath: policy.policyPath,
          sourceSha256: policyLoad.sourceSha256,
          objects: policy.objects
        }
      : {
          schemaVersion: POLICY_SCHEMA_VERSION,
          policyId: null,
          updatedAt: null,
          policyPath: args.policyPath,
          sourceSha256: policyLoad.sourceSha256,
          objects: []
        },
    runtimeRelease,
    matrix,
    driftGate
  };

  const deterministicCore = buildDeterministicCore(report);
  report.artifactHashScope = DETERMINISTIC_CORE_SCHEMA_VERSION;
  report.artifactHash = sha256Hex(canonicalJsonStringify(deterministicCore));
  report.deterministicCore = {
    schemaVersion: DETERMINISTIC_CORE_SCHEMA_VERSION,
    sha256: report.artifactHash,
    core: deterministicCore
  };

  const reportPath = path.resolve(cwd, args.reportPath);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    report,
    reportPath
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { report, reportPath } = await runProtocolCompatibilityMatrix(args, process.env, process.cwd());
  process.stdout.write(`${JSON.stringify({ schemaVersion: report.schemaVersion, strictOk: report.strictOk, okWithOverride: report.okWithOverride, reportPath }, null, 2)}\n`);
  if (!report.strictOk && !report.okWithOverride) process.exitCode = 1;
}

const isDirectExecution = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
