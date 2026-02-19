import fs from "node:fs/promises";
import path from "node:path";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isNonWritableFsError(err) {
  const code = String(err?.code ?? "");
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

export class DedupeStore {
  constructor({ filePath }) {
    assertNonEmptyString(filePath, "filePath");
    this.filePath = filePath;
    this.records = new Map(); // dedupeKey -> record
    this._appendQueue = Promise.resolve();
    this.persistenceDisabled = false;
  }

  async init() {
    let raw = "";
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        raw = await fs.readFile(this.filePath, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
        raw = "";
      }
    } catch (err) {
      if (!isNonWritableFsError(err)) throw err;
      this.persistenceDisabled = true;
      raw = "";
    }

    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      const evt = safeJsonParse(line);
      if (!evt || typeof evt !== "object") continue;
      const k = typeof evt.dedupeKey === "string" ? evt.dedupeKey : null;
      if (!k) continue;
      const type = typeof evt.type === "string" ? evt.type : null;
      const existing =
        this.records.get(k) ??
        ({
          dedupeKey: k,
          artifactHash: null,
          deliveryId: null,
          storedAt: null,
          ackedAt: null,
          ackAttempts: 0,
          ackNextAttemptAt: null,
          lastAckError: null
        });
      if (type === "RECEIVED") {
        this.records.set(k, {
          ...existing,
          artifactHash: evt.artifactHash ?? existing.artifactHash ?? null,
          deliveryId: evt.deliveryId ?? existing.deliveryId ?? null,
          receivedAt: evt.at ?? existing.receivedAt ?? null
        });
        continue;
      }
      if (type === "STORED") {
        this.records.set(k, {
          ...existing,
          artifactHash: evt.artifactHash ?? existing.artifactHash ?? null,
          deliveryId: evt.deliveryId ?? existing.deliveryId ?? null,
          storedAt: evt.at ?? existing.storedAt ?? null
        });
        continue;
      }
      if (type === "ACK_QUEUED") {
        this.records.set(k, {
          ...existing,
          artifactHash: evt.artifactHash ?? existing.artifactHash ?? null,
          deliveryId: evt.deliveryId ?? existing.deliveryId ?? null,
          ackNextAttemptAt: evt.nextAttemptAt ?? evt.at ?? existing.ackNextAttemptAt ?? null,
          lastAckError: null
        });
        continue;
      }
      if (type === "ACK_RESULT") {
        const ok = evt.ok === true;
        this.records.set(k, {
          ...existing,
          artifactHash: evt.artifactHash ?? existing.artifactHash ?? null,
          deliveryId: evt.deliveryId ?? existing.deliveryId ?? null,
          ackedAt: ok ? (evt.at ?? existing.ackedAt ?? null) : existing.ackedAt ?? null,
          ackAttempts: Number.isSafeInteger(evt.attempts) ? evt.attempts : existing.ackAttempts ?? 0,
          ackNextAttemptAt: ok ? null : (evt.nextAttemptAt ?? existing.ackNextAttemptAt ?? null),
          lastAckError: ok ? null : (evt.error ?? existing.lastAckError ?? null)
        });
      }
    }
  }

  get(dedupeKey) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    return this.records.get(dedupeKey) ?? null;
  }

  async appendEvent(evt) {
    if (!evt || typeof evt !== "object") throw new TypeError("evt must be an object");
    if (this.persistenceDisabled) return false;
    const line = `${JSON.stringify(evt)}\n`;
    const append = async () => {
      await fs.appendFile(this.filePath, line, "utf8");
    };
    const op = this._appendQueue.then(append, append);
    this._appendQueue = op.catch(() => {});
    try {
      await op;
      return true;
    } catch (err) {
      if (!isNonWritableFsError(err)) throw err;
      this.persistenceDisabled = true;
      return false;
    }
  }

  async ensureReceived({ dedupeKey, artifactHash }) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    assertNonEmptyString(artifactHash, "artifactHash");
    const existing = this.records.get(dedupeKey) ?? null;
    if (existing) return existing;
    const at = nowIso();
    const record = {
      dedupeKey,
      artifactHash,
      deliveryId: null,
      receivedAt: at,
      storedAt: null,
      ackedAt: null,
      ackAttempts: 0,
      ackNextAttemptAt: null,
      lastAckError: null
    };
    this.records.set(dedupeKey, record);
    await this.appendEvent({ type: "RECEIVED", dedupeKey, artifactHash, deliveryId: null, at });
    return record;
  }

  async touchDeliveryId({ dedupeKey, artifactHash, deliveryId }) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    assertNonEmptyString(artifactHash, "artifactHash");
    assertNonEmptyString(deliveryId, "deliveryId");
    const at = nowIso();
    const existing =
      this.records.get(dedupeKey) ??
      ({
        dedupeKey,
        artifactHash,
        deliveryId: null,
        receivedAt: null,
        storedAt: null,
        ackedAt: null,
        ackAttempts: 0,
        ackNextAttemptAt: null,
        lastAckError: null
      });
    const next = { ...existing, artifactHash, deliveryId };
    this.records.set(dedupeKey, next);
    await this.appendEvent({ type: "RECEIVED", dedupeKey, artifactHash, deliveryId, at });
    return next;
  }

  async markStored({ dedupeKey, artifactHash, deliveryId = null }) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    assertNonEmptyString(artifactHash, "artifactHash");
    const at = nowIso();
    const existing =
      this.records.get(dedupeKey) ??
      ({ dedupeKey, artifactHash, deliveryId: null, receivedAt: null, storedAt: null, ackedAt: null, ackAttempts: 0, ackNextAttemptAt: null, lastAckError: null });
    const next = { ...existing, artifactHash, deliveryId: deliveryId ?? existing.deliveryId ?? null, storedAt: at };
    this.records.set(dedupeKey, next);
    await this.appendEvent({ type: "STORED", dedupeKey, artifactHash, deliveryId: next.deliveryId ?? null, at });
    return next;
  }

  async markAckQueued({ dedupeKey, artifactHash, deliveryId = null, nextAttemptAt = null }) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    assertNonEmptyString(artifactHash, "artifactHash");
    const at = nowIso();
    const existing =
      this.records.get(dedupeKey) ??
      ({ dedupeKey, artifactHash, deliveryId: null, receivedAt: null, storedAt: null, ackedAt: null, ackAttempts: 0, ackNextAttemptAt: null, lastAckError: null });
    const nextAt = nextAttemptAt ? new Date(String(nextAttemptAt)).toISOString() : at;
    const next = { ...existing, artifactHash, deliveryId: deliveryId ?? existing.deliveryId ?? null, ackNextAttemptAt: nextAt, lastAckError: null };
    this.records.set(dedupeKey, next);
    await this.appendEvent({ type: "ACK_QUEUED", dedupeKey, artifactHash, deliveryId: next.deliveryId ?? null, at, nextAttemptAt: nextAt });
    return next;
  }

  async markAckResult({ dedupeKey, artifactHash, deliveryId = null, ok, attempts, nextAttemptAt, error }) {
    assertNonEmptyString(dedupeKey, "dedupeKey");
    assertNonEmptyString(artifactHash, "artifactHash");
    const at = nowIso();
    const existing =
      this.records.get(dedupeKey) ??
      ({ dedupeKey, artifactHash, deliveryId: null, receivedAt: null, storedAt: null, ackedAt: null, ackAttempts: 0, ackNextAttemptAt: null, lastAckError: null });

    const next = ok
      ? { ...existing, artifactHash, deliveryId: deliveryId ?? existing.deliveryId ?? null, ackedAt: at, ackAttempts: attempts, ackNextAttemptAt: null, lastAckError: null }
      : {
          ...existing,
          artifactHash,
          deliveryId: deliveryId ?? existing.deliveryId ?? null,
          ackAttempts: attempts,
          ackNextAttemptAt: nextAttemptAt ?? null,
          lastAckError: error ?? "ack_failed"
        };
    this.records.set(dedupeKey, next);
    await this.appendEvent({
      type: "ACK_RESULT",
      dedupeKey,
      artifactHash,
      deliveryId: next.deliveryId ?? null,
      ok: ok === true,
      attempts,
      nextAttemptAt: ok ? null : (nextAttemptAt ?? null),
      error: ok ? null : (error ?? null),
      at
    });
    return next;
  }

  listPendingAcks({ nowMs = Date.now(), limit = 50 } = {}) {
    const out = [];
    for (const r of this.records.values()) {
      if (!r || typeof r !== "object") continue;
      if (!r.storedAt) continue;
      if (r.ackedAt) continue;
      if (!r.deliveryId) continue;
      const nextAt = r.ackNextAttemptAt ? Date.parse(String(r.ackNextAttemptAt)) : 0;
      if (Number.isFinite(nextAt) && nextAt > nowMs) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}
