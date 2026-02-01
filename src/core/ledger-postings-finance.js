import { createJournalEntry } from "./ledger.js";

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
}

export function ledgerEntriesForFinanceEvent({ event }) {
  if (!event || typeof event !== "object") throw new TypeError("event is required");
  const entries = [];

  if (event.type === "INSURER_REIMBURSEMENT_RECORDED") {
    const amountCents = event.payload?.amountCents ?? null;
    assertSafeInteger(amountCents, "payload.amountCents");
    if (amountCents <= 0) throw new TypeError("payload.amountCents must be positive");

    entries.push(
      createJournalEntry({
        id: `jnl_${event.id}`,
        at: event.at,
        memo: `finance reimbursement:${event.payload?.insurerId ?? "unknown"}`,
        postings: [
          { accountId: "acct_cash", amountCents },
          { accountId: "acct_insurer_receivable", amountCents: -amountCents }
        ]
      })
    );
  }

  return entries;
}

