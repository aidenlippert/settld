import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { buildToolManifestV1 } from "../src/core/tool-manifest.js";
import { assertAuthorityGrantAllows, buildAuthorityGrantV1, verifyAuthorityGrantV1 } from "../src/core/authority-grants.js";

async function loadTestSigner() {
  const p = path.resolve(process.cwd(), "test/fixtures/keys/ed25519_test_keypair.json");
  const { publicKeyPem, privateKeyPem } = JSON.parse(await fs.readFile(p, "utf8"));
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  return { publicKeyPem, privateKeyPem, keyId };
}

test("AuthorityGrant.v1: build -> verify -> enforce allowlist + pin + spend", async () => {
  const { publicKeyPem, privateKeyPem, keyId } = await loadTestSigner();

  const tool = buildToolManifestV1({
    tenantId: "tenant_vectors",
    toolId: "tool_demo_translate_v1",
    name: "Translate (Demo)",
    tool: {
      name: "translate",
      description: "Translate text.",
      inputSchema: { type: "object" }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  const grant = buildAuthorityGrantV1({
    tenantId: "tenant_vectors",
    grantId: "agr_auth_demo_0001",
    grantedBy: { actorType: "human", actorId: "user_1" },
    grantedTo: { actorType: "agent", actorId: "agt_demo" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 500,
      toolIds: [tool.toolId],
      pinnedManifests: { [tool.toolId]: tool.manifestHash },
      expiresAt: "2026-02-02T00:00:00.000Z"
    },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:01.000Z"
  });

  assert.equal(verifyAuthorityGrantV1({ grant, publicKeyPem }), true);

  assert.equal(
    assertAuthorityGrantAllows({
      grant,
      at: "2026-02-01T00:10:00.000Z",
      toolId: tool.toolId,
      manifestHash: tool.manifestHash,
      amountCents: 499,
      currency: "USD"
    }),
    true
  );

  assert.throws(
    () =>
      assertAuthorityGrantAllows({
        grant,
        at: "2026-02-01T00:10:00.000Z",
        toolId: "tool_not_allowed",
        manifestHash: tool.manifestHash,
        amountCents: 10,
        currency: "USD"
      }),
    (err) => err && err.code === "AUTHORITY_GRANT_TOOL_NOT_ALLOWED"
  );

  assert.throws(
    () =>
      assertAuthorityGrantAllows({
        grant,
        at: "2026-02-01T00:10:00.000Z",
        toolId: tool.toolId,
        manifestHash: "0".repeat(64),
        amountCents: 10,
        currency: "USD"
      }),
    (err) => err && err.code === "AUTHORITY_GRANT_PIN_MISMATCH"
  );

  assert.throws(
    () =>
      assertAuthorityGrantAllows({
        grant,
        at: "2026-02-01T00:10:00.000Z",
        toolId: tool.toolId,
        manifestHash: tool.manifestHash,
        amountCents: 501,
        currency: "USD"
      }),
    (err) => err && err.code === "AUTHORITY_GRANT_SPEND_LIMIT"
  );
});

test("AuthorityGrant.v1: expired grants fail-closed", async () => {
  const { publicKeyPem, privateKeyPem, keyId } = await loadTestSigner();

  const grant = buildAuthorityGrantV1({
    tenantId: "tenant_vectors",
    grantId: "agr_auth_demo_0002",
    grantedBy: { actorType: "human", actorId: "user_1" },
    grantedTo: { actorType: "agent", actorId: "agt_demo" },
    limits: {
      currency: "USD",
      maxPerTransactionCents: 1,
      toolIds: ["tool_demo"],
      pinnedManifests: null,
      expiresAt: "2026-02-01T00:00:02.000Z"
    },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:01.000Z"
  });

  assert.equal(verifyAuthorityGrantV1({ grant, publicKeyPem }), true);

  assert.throws(
    () =>
      assertAuthorityGrantAllows({
        grant,
        at: "2026-02-01T00:00:02.000Z",
        toolId: "tool_demo",
        manifestHash: null,
        amountCents: 0,
        currency: "USD"
      }),
    (err) => err && err.code === "AUTHORITY_GRANT_EXPIRED"
  );
});

