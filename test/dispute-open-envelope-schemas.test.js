import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv/dist/2020.js";

import { buildDisputeOpenEnvelopeV1, validateDisputeOpenEnvelopeV1 } from "../src/core/dispute-open-envelope.js";
import { canonicalJsonStringify } from "../src/core/canonical-json.js";
import { sha256Hex } from "../src/core/crypto.js";

async function loadSchemas() {
  const base = path.resolve(process.cwd(), "docs/spec/schemas");
  const names = (await fs.readdir(base)).filter((n) => n.endsWith(".json")).sort();
  const schemas = [];
  for (const name of names) {
    const raw = await fs.readFile(path.join(base, name), "utf8");
    schemas.push(JSON.parse(raw));
  }
  return schemas;
}

test("dispute-open-envelope schema validates canonical example", async () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const schema of await loadSchemas()) {
    if (schema && typeof schema === "object" && typeof schema.$id === "string") {
      ajv.addSchema(schema, schema.$id);
    }
  }

  const validate = ajv.getSchema("https://settld.local/schemas/DisputeOpenEnvelope.v1.schema.json");
  assert.ok(validate);

  const example = buildDisputeOpenEnvelopeV1({
    envelopeId: "dopen_tc_" + "1".repeat(64),
    caseId: "arb_case_tc_" + "1".repeat(64),
    tenantId: "tenant_default",
    agreementHash: "1".repeat(64),
    receiptHash: "2".repeat(64),
    holdHash: "3".repeat(64),
    openedByAgentId: "agt_payee_demo",
    openedAt: "2026-02-11T12:00:00.000Z",
    reasonCode: "TOOL_CALL_DISPUTE",
    nonce: "nonce_demo_00000001",
    signerKeyId: "key_demo_signer_0001",
    signature: "sig_demo_base64_0001"
  });

  assert.equal(validate(example), true, JSON.stringify(validate.errors ?? [], null, 2));
  assert.equal(validateDisputeOpenEnvelopeV1(example), true);
});

test("dispute-open-envelope canonical hash is stable under key reorder", () => {
  const envelope = buildDisputeOpenEnvelopeV1({
    envelopeId: "dopen_tc_" + "1".repeat(64),
    caseId: "arb_case_tc_" + "1".repeat(64),
    tenantId: "tenant_default",
    agreementHash: "1".repeat(64),
    receiptHash: "2".repeat(64),
    holdHash: "3".repeat(64),
    openedByAgentId: "agt_payee_demo",
    openedAt: "2026-02-11T12:00:00.000Z",
    reasonCode: "TOOL_CALL_DISPUTE",
    nonce: "nonce_demo_00000002",
    signerKeyId: "key_demo_signer_0001",
    signature: "sig_demo_base64_0002"
  });
  const canonical = canonicalJsonStringify(envelope);
  const hashA = sha256Hex(canonical);
  const reordered = {
    envelopeHash: envelope.envelopeHash,
    signature: envelope.signature,
    holdHash: envelope.holdHash,
    caseId: envelope.caseId,
    receiptHash: envelope.receiptHash,
    schemaVersion: envelope.schemaVersion,
    artifactType: envelope.artifactType,
    tenantId: envelope.tenantId,
    signerKeyId: envelope.signerKeyId,
    openedByAgentId: envelope.openedByAgentId,
    openedAt: envelope.openedAt,
    reasonCode: envelope.reasonCode,
    agreementHash: envelope.agreementHash,
    nonce: envelope.nonce,
    artifactId: envelope.artifactId,
    envelopeId: envelope.envelopeId
  };
  const hashB = sha256Hex(canonicalJsonStringify(reordered));
  assert.equal(hashB, hashA);
});
