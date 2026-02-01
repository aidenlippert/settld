import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";
import { resolveExternalAccountFor } from "./finance-account-map.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) return `"${s.replace(/\"/g, '""')}"`;
  return s;
}

export const JOURNAL_CSV_SCHEMA_VERSION_V1 = "JournalCsv.v1";

export function renderJournalCsvV1({ glBatchArtifact, accountMap, columns = null } = {}) {
  if (!glBatchArtifact || typeof glBatchArtifact !== "object") throw new TypeError("glBatchArtifact is required");
  if (!accountMap || typeof accountMap !== "object") throw new TypeError("accountMap is required");

  const artifactType = glBatchArtifact.artifactType ?? null;
  if (artifactType !== "GLBatch.v1") throw new TypeError("glBatchArtifact.artifactType must be GLBatch.v1");
  assertNonEmptyString(glBatchArtifact.tenantId, "glBatchArtifact.tenantId");
  assertNonEmptyString(glBatchArtifact.period, "glBatchArtifact.period");

  const batch = glBatchArtifact.batch ?? null;
  if (!batch || typeof batch !== "object") throw new TypeError("glBatchArtifact.batch is required");
  const lines = Array.isArray(batch.lines) ? batch.lines : [];

  const header =
    columns ??
    [
      "schemaVersion",
      "tenantId",
      "period",
      "basis",
      "glBatchArtifactHash",
      "entryId",
      "postingId",
      "at",
      "partyId",
      "partyRole",
      "accountId",
      "externalAccount",
      "debitCents",
      "creditCents",
      "currency",
      "jobId",
      "memo"
    ];

  const rows = [];
  rows.push(header.map(csvEscape).join(","));

  const artifactHash = glBatchArtifact.artifactHash ?? null;
  const basis = glBatchArtifact.basis ?? null;

  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const amountCents = Number.isSafeInteger(l.amountCents) ? l.amountCents : null;
    if (amountCents === null) continue;
    const debitCents = amountCents > 0 ? amountCents : 0;
    const creditCents = amountCents < 0 ? -amountCents : 0;
    const externalAccount = resolveExternalAccountFor({ map: accountMap, accountId: String(l.accountId ?? "") });

    const record = {
      schemaVersion: JOURNAL_CSV_SCHEMA_VERSION_V1,
      tenantId: glBatchArtifact.tenantId,
      period: glBatchArtifact.period,
      basis,
      glBatchArtifactHash: artifactHash ?? "",
      entryId: l.entryId ?? "",
      postingId: l.postingId ?? "",
      at: l.at ?? "",
      partyId: l.partyId ?? "",
      partyRole: l.partyRole ?? "",
      accountId: l.accountId ?? "",
      externalAccount,
      debitCents,
      creditCents,
      currency: l.currency ?? "USD",
      jobId: l.jobId ?? "",
      memo: l.memo ?? ""
    };

    rows.push(header.map((c) => csvEscape(record[c])).join(","));
  }

  const csv = `${rows.join("\n")}\n`;
  const csvHash = sha256Hex(canonicalJsonStringify({ csv }));
  return { csv, csvHash, rowCount: Math.max(0, rows.length - 1) };
}

