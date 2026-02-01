import { applyJournalEntry } from "../core/ledger.js";
import { DEFAULT_TENANT_ID, makeScopedKey, normalizeTenantId } from "../core/tenancy.js";
import { allocateEntry } from "../core/allocations.js";

export function processOutbox(store, { maxMessages = Number.MAX_SAFE_INTEGER } = {}) {
  if (!store || typeof store !== "object") throw new TypeError("store is required");
  if (!Array.isArray(store.outbox)) throw new TypeError("store.outbox must be an array");
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 0) throw new TypeError("maxMessages must be a non-negative safe integer");

  if (!Number.isSafeInteger(store.outboxCursor) || store.outboxCursor < 0) {
    store.outboxCursor = 0;
  }

  let processed = 0;
  while (store.outboxCursor < store.outbox.length && processed < maxMessages) {
    const message = store.outbox[store.outboxCursor];
    store.outboxCursor += 1;
    processed += 1;

    if (!message || typeof message !== "object") continue;
    const type = message.type;
    if (typeof type !== "string" || type.trim() === "") continue;

    if (type === "LEDGER_ENTRY_APPLY") {
      const entry = message.entry;
      if (!entry?.id) throw new TypeError("LEDGER_ENTRY_APPLY requires entry.id");
      const tenantId = normalizeTenantId(message.tenantId ?? DEFAULT_TENANT_ID);
      const ledger = typeof store.getLedger === "function" ? store.getLedger(tenantId) : store.ledger;
      applyJournalEntry(ledger, entry);

      const jobId = typeof message.jobId === "string" && message.jobId.trim() !== "" ? String(message.jobId) : null;
      if (jobId && store.ledgerAllocations instanceof Map) {
        try {
          const job = store.jobs instanceof Map ? store.jobs.get(makeScopedKey({ tenantId, id: jobId })) : null;
          if (job && typeof job === "object") {
            let operatorContractDoc = null;
            if (job?.operatorContractHash && store.contractsV2 instanceof Map) {
              for (const c of store.contractsV2.values()) {
                if (!c || typeof c !== "object") continue;
                if (normalizeTenantId(c.tenantId ?? DEFAULT_TENANT_ID) !== tenantId) continue;
                if (String(c.contractHash ?? "") !== String(job.operatorContractHash)) continue;
                operatorContractDoc = c.doc ?? null;
                break;
              }
            }
            const allocations = allocateEntry({ tenantId, entry, job, operatorContractDoc, currency: "USD" });
            for (const a of allocations) {
              const key = `${tenantId}\n${a.entryId}\n${a.postingId}\n${a.partyId}`;
              if (!store.ledgerAllocations.has(key)) store.ledgerAllocations.set(key, a);
            }
          }
        } catch {
          // Best-effort; allocations must never block ledger apply in memory mode.
        }
      }
      continue;
    }

    if (type.startsWith("NOTIFY_")) {
      if (!Array.isArray(store.notifications)) store.notifications = [];
      store.notifications.push({
        outboxIndex: store.outboxCursor - 1,
        topic: type,
        tenantId: normalizeTenantId(message.tenantId ?? DEFAULT_TENANT_ID),
        payload: message,
        createdAt: new Date().toISOString()
      });
      continue;
    }

    if (type === "CORRELATION_APPLY") {
      const tenantId = normalizeTenantId(message.tenantId ?? DEFAULT_TENANT_ID);
      if (typeof store.upsertCorrelation !== "function") continue;
      try {
        // Best-effort: correlation index is a cache; conflicts are handled at ingest time.
        void store.upsertCorrelation({
          tenantId,
          siteId: message.siteId,
          correlationKey: message.correlationKey,
          jobId: message.jobId,
          expiresAt: message.expiresAt ?? null
        });
      } catch {
        // Ignore: correlation conflicts are surfaced via ops and/or ingest errors.
      }
      continue;
    }

    // Other message types are processed by separate workers.
  }

  return { processed, cursor: store.outboxCursor };
}
