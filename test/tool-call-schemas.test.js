import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv/dist/2020.js";

async function loadSchemas() {
  const base = path.resolve(process.cwd(), "docs/spec/schemas");
  const names = (await fs.readdir(base)).filter((name) => name.endsWith(".json")).sort();
  const out = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(base, name), "utf8");
    out.push(JSON.parse(raw));
  }
  return out;
}

test("ToolCallAgreement.v1 + ToolCallEvidence.v1 schemas validate canonical shapes", async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const schema of await loadSchemas()) {
    if (schema && typeof schema === "object" && typeof schema.$id === "string") {
      ajv.addSchema(schema, schema.$id);
    }
  }

  const validateAgreement = ajv.getSchema("https://settld.local/schemas/ToolCallAgreement.v1.schema.json");
  assert.ok(validateAgreement);

  const agreement = {
    schemaVersion: "ToolCallAgreement.v1",
    toolId: "cap_demo",
    manifestHash: "f".repeat(64),
    callId: "call_demo_1",
    inputHash: "e".repeat(64),
    acceptanceCriteria: null,
    settlementTerms: { amountCents: 10000, currency: "USD" },
    payerAgentId: null,
    payeeAgentId: null,
    createdAt: "2026-02-11T00:00:00.000Z",
    agreementHash: "a".repeat(64)
  };

  assert.equal(validateAgreement(agreement), true);

  const validateEvidence = ajv.getSchema("https://settld.local/schemas/ToolCallEvidence.v1.schema.json");
  assert.ok(validateEvidence);

  const evidence = {
    schemaVersion: "ToolCallEvidence.v1",
    agreementHash: agreement.agreementHash,
    callId: agreement.callId,
    inputHash: agreement.inputHash,
    outputHash: "d".repeat(64),
    outputRef: null,
    metrics: null,
    startedAt: "2026-02-11T00:00:01.000Z",
    completedAt: "2026-02-11T00:00:02.000Z",
    createdAt: "2026-02-11T00:00:02.000Z",
    evidenceHash: "b".repeat(64)
  };

  assert.equal(validateEvidence(evidence), true);
});

