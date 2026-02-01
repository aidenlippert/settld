import test from "node:test";
import assert from "node:assert/strict";

import { createLedger, addAccount, createAccount, createJournalEntry, applyJournalEntry } from "../src/core/ledger.js";

test("ledger: balances journal entries", () => {
  const ledger = createLedger();
  addAccount(ledger, createAccount({ id: "acct_a", name: "A", type: "test" }));
  addAccount(ledger, createAccount({ id: "acct_b", name: "B", type: "test" }));

  const entry = createJournalEntry({
    memo: "A pays B",
    postings: [
      { accountId: "acct_a", amountCents: -500 },
      { accountId: "acct_b", amountCents: 500 }
    ]
  });

  applyJournalEntry(ledger, entry);

  assert.equal(ledger.balances.get("acct_a"), -500);
  assert.equal(ledger.balances.get("acct_b"), 500);
});

test("ledger: rejects unbalanced entries", () => {
  assert.throws(
    () =>
      createJournalEntry({
        postings: [
          { accountId: "acct_a", amountCents: -500 },
          { accountId: "acct_b", amountCents: 499 }
        ]
      }),
    /must balance/
  );
});

