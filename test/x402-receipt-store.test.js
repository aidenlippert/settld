import test from "node:test";
import assert from "node:assert/strict";

import { createStore } from "../src/api/store.js";

test("store: x402 receipts are immutable per receiptId", async () => {
  const store = createStore();
  const receipt = {
    schemaVersion: "X402ReceiptRecord.v1",
    receiptId: "x402rcpt_immutable_1",
    gateId: "x402gate_immutable_1",
    runId: "x402_run_immutable_1",
    settlementState: "released",
    settledAt: "2026-02-18T01:00:00.000Z",
    createdAt: "2026-02-18T01:00:00.000Z",
    updatedAt: "2026-02-18T01:00:00.000Z",
    evidenceRefs: []
  };

  const created = await store.putX402Receipt({ receipt });
  assert.equal(created?.receiptId, receipt.receiptId);

  const sameAgain = await store.putX402Receipt({ receipt: { ...receipt } });
  assert.equal(sameAgain?.receiptId, receipt.receiptId);

  await assert.rejects(
    () =>
      store.putX402Receipt({
        receipt: {
          ...receipt,
          settlementState: "refunded"
        }
      }),
    (err) => {
      assert.equal(err?.code, "X402_RECEIPT_IMMUTABLE");
      return true;
    }
  );
});
