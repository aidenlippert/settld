import { createId } from "./ids.js";

function assertSafeCents(amountCents) {
  if (!Number.isSafeInteger(amountCents)) throw new TypeError("amountCents must be a safe integer (cents)");
  if (amountCents === 0) throw new TypeError("amountCents must be non-zero");
}

export function createAccount({ id, name, currency = "USD", type }) {
  if (!id) throw new TypeError("account id is required");
  if (!name) throw new TypeError("account name is required");
  if (!type) throw new TypeError("account type is required");

  return { id, name, currency, type, createdAt: new Date().toISOString() };
}

export function createJournalEntry({ id = createId("jnl"), at = new Date().toISOString(), memo = "", postings }) {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new TypeError("postings must be an array of at least 2 items");
  }

  let sum = 0;
  for (const p of postings) {
    if (!p || typeof p !== "object") throw new TypeError("posting must be an object");
    if (!p.accountId) throw new TypeError("posting.accountId is required");
    assertSafeCents(p.amountCents);
    sum += p.amountCents;
  }
  if (sum !== 0) throw new Error(`journal entry must balance to zero; got sum=${sum}`);

  return { id, at, memo, postings };
}

export function createLedger() {
  return {
    accounts: new Map(),
    entries: [],
    entryIds: new Set(),
    balances: new Map()
  };
}

export function addAccount(ledger, account) {
  if (!ledger?.accounts) throw new TypeError("ledger is required");
  ledger.accounts.set(account.id, account);
  if (!ledger.balances.has(account.id)) ledger.balances.set(account.id, 0);
}

export function applyJournalEntry(ledger, entry) {
  if (!ledger?.balances) throw new TypeError("ledger is required");
  if (!entry?.id) throw new TypeError("entry.id is required");
  if (ledger.entryIds?.has(entry.id)) return false;
  if (ledger.entryIds) ledger.entryIds.add(entry.id);
  ledger.entries.push(entry);
  for (const posting of entry.postings) {
    const current = ledger.balances.get(posting.accountId) ?? 0;
    ledger.balances.set(posting.accountId, current + posting.amountCents);
  }
  return true;
}
