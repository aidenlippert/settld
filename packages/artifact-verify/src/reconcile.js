import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256HexUtf8 } from "./crypto.js";

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function keyOf({ partyId, accountId }) {
  return `${partyId}\n${accountId}`;
}

function addToMap(map, key, delta) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

export function reconcileGlBatchAgainstPartyStatements({ glBatch, partyStatements } = {}) {
  assertPlainObject(glBatch, "glBatch");
  if (!Array.isArray(partyStatements)) throw new TypeError("partyStatements must be an array");

  const glArtifactType = glBatch?.artifactType ?? glBatch?.schemaVersion ?? null;
  if (glArtifactType !== "GLBatch.v1") return { ok: false, error: "expected GLBatch.v1", got: glArtifactType };
  if (glBatch.schemaVersion && glBatch.schemaVersion !== "GLBatch.v1") {
    return { ok: false, error: "schemaVersion mismatch", expected: "GLBatch.v1", actual: glBatch.schemaVersion };
  }
  const glActualHash = glBatch.artifactHash ?? null;
  if (typeof glActualHash !== "string" || !glActualHash.trim()) return { ok: false, error: "missing glBatch artifactHash" };
  try {
    // eslint-disable-next-line no-unused-vars
    const { artifactHash: _ignored, ...core } = glBatch;
    const expected = sha256HexUtf8(canonicalJsonStringify(core));
    if (expected !== glActualHash) return { ok: false, error: "glBatch artifactHash mismatch", expected, actual: glActualHash };
  } catch (err) {
    return { ok: false, error: "failed to hash glBatch", detail: err?.message ?? String(err) };
  }

  const period = String(glBatch.period ?? "");
  const basis = String(glBatch.basis ?? "");
  assertNonEmptyString(period, "glBatch.period");
  assertNonEmptyString(basis, "glBatch.basis");

  const batch = glBatch.batch ?? null;
  assertPlainObject(batch, "glBatch.batch");
  const lines = Array.isArray(batch.lines) ? batch.lines : [];

  const glTotals = new Map(); // key(partyId,accountId) -> cents
  const glEntryIds = new Set();
  let glNet = 0;
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const partyId = typeof l.partyId === "string" ? l.partyId : null;
    const accountId = typeof l.accountId === "string" ? l.accountId : null;
    const entryId = typeof l.entryId === "string" ? l.entryId : null;
    const amountCents = Number.isSafeInteger(l.amountCents) ? l.amountCents : null;
    if (!partyId || !accountId || !entryId || amountCents === null) continue;
    addToMap(glTotals, keyOf({ partyId, accountId }), amountCents);
    glEntryIds.add(entryId);
    glNet += amountCents;
  }
  if (glNet !== 0) return { ok: false, error: "glBatch does not net to zero", glNet };

  const psTotals = new Map();
  const psEntryIds = new Set();
  for (const ps of partyStatements) {
    if (!ps || typeof ps !== "object") continue;

    const psArtifactType = ps?.artifactType ?? ps?.schemaVersion ?? null;
    if (psArtifactType !== "PartyStatement.v1") return { ok: false, error: "expected PartyStatement.v1", got: psArtifactType };
    if (ps.schemaVersion && ps.schemaVersion !== "PartyStatement.v1") {
      return { ok: false, error: "schemaVersion mismatch", expected: "PartyStatement.v1", actual: ps.schemaVersion };
    }
    const psActualHash = ps.artifactHash ?? null;
    if (typeof psActualHash !== "string" || !psActualHash.trim()) return { ok: false, error: "missing partyStatement artifactHash" };
    try {
      // eslint-disable-next-line no-unused-vars
      const { artifactHash: _ignored, ...core } = ps;
      const expected = sha256HexUtf8(canonicalJsonStringify(core));
      if (expected !== psActualHash) return { ok: false, error: "partyStatement artifactHash mismatch", expected, actual: psActualHash };
    } catch (err) {
      return { ok: false, error: "failed to hash partyStatement", detail: err?.message ?? String(err) };
    }

    if (String(ps.period ?? "") !== period) return { ok: false, error: "partyStatement period mismatch", expected: period, got: ps.period ?? null };
    if (String(ps.basis ?? "") !== basis) return { ok: false, error: "partyStatement basis mismatch", expected: basis, got: ps.basis ?? null };

    assertNonEmptyString(ps.partyId, "partyStatement.partyId");
    const partyId = String(ps.partyId);

    const totals = ps.statement?.totalsByAccountId ?? ps.totalsByAccountId ?? null;
    if (!totals || typeof totals !== "object" || Array.isArray(totals)) return { ok: false, error: "partyStatement totalsByAccountId missing" };

    for (const [accountIdRaw, amountRaw] of Object.entries(totals)) {
      const accountId = String(accountIdRaw);
      const amountCents = Number(amountRaw);
      if (!Number.isFinite(amountCents) || !Number.isSafeInteger(amountCents)) {
        return { ok: false, error: "partyStatement totalsByAccountId contains non-integer", accountId };
      }
      addToMap(psTotals, keyOf({ partyId, accountId }), amountCents);
    }

    const included = ps.statement?.includedEntryIds ?? ps.includedEntryIds ?? [];
    for (const id of included) {
      if (typeof id === "string" && id.trim()) psEntryIds.add(id);
    }
  }

  const diffs = [];
  const keys = new Set([...glTotals.keys(), ...psTotals.keys()]);
  for (const k of keys) {
    const a = glTotals.get(k) ?? 0;
    const b = psTotals.get(k) ?? 0;
    if (a !== b) {
      const [partyId, accountId] = k.split("\n");
      diffs.push({ partyId, accountId, glBatchCents: a, partyStatementsCents: b, deltaCents: a - b });
    }
  }

  if (diffs.length) return { ok: false, error: "totals mismatch", diffs };

  // Sanity: entry ids match.
  const glEntryList = Array.from(glEntryIds).sort();
  const psEntryList = Array.from(psEntryIds).sort();
  const sameEntries = glEntryList.length === psEntryList.length && glEntryList.every((v, i) => v === psEntryList[i]);
  if (!sameEntries) {
    return { ok: false, error: "included entry ids mismatch", glEntryIds: glEntryList, partyStatementEntryIds: psEntryList };
  }

  return { ok: true, period, basis, totalsKeys: keys.size, entryCount: glEntryIds.size };
}
