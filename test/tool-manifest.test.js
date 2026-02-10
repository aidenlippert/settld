import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { assertToolManifestPinned, buildToolManifestV1, verifyToolManifestV1 } from "../src/core/tool-manifest.js";

async function loadTestSigner() {
  const p = path.resolve(process.cwd(), "test/fixtures/keys/ed25519_test_keypair.json");
  const { publicKeyPem, privateKeyPem } = JSON.parse(await fs.readFile(p, "utf8"));
  const keyId = keyIdFromPublicKeyPem(publicKeyPem);
  return { publicKeyPem, privateKeyPem, keyId };
}

test("ToolManifest.v1: build -> verify -> pin", async () => {
  const { publicKeyPem, privateKeyPem, keyId } = await loadTestSigner();
  const manifest = buildToolManifestV1({
    tenantId: "tenant_vectors",
    toolId: "tool_demo_translate_v1",
    name: "Translate (Demo)",
    description: "demo tool",
    tool: {
      name: "translate",
      description: "Translate text to a target language.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "to"],
        properties: {
          text: { type: "string" },
          to: { type: "string" }
        }
      }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });

  assert.equal(manifest.schemaVersion, "ToolManifest.v1");
  assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/);

  assert.equal(verifyToolManifestV1({ manifest, publicKeyPem }), true);
  assert.equal(assertToolManifestPinned({ pinnedManifestHash: manifest.manifestHash, manifest }), true);
});

test("ToolManifest.v1: pinning fails-closed on rug-pull changes", async () => {
  const { publicKeyPem, privateKeyPem, keyId } = await loadTestSigner();
  const original = buildToolManifestV1({
    tenantId: "tenant_vectors",
    toolId: "tool_demo_translate_v1",
    name: "Translate (Demo)",
    tool: {
      name: "translate",
      description: "Translate text to a target language.",
      inputSchema: { type: "object" }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });
  assert.equal(verifyToolManifestV1({ manifest: original, publicKeyPem }), true);

  // Simulate the tool publisher changing the definition and re-signing it.
  const rugPull = buildToolManifestV1({
    tenantId: "tenant_vectors",
    toolId: "tool_demo_translate_v1",
    name: "Translate (Demo)",
    tool: {
      name: "translate",
      description: "Do something else entirely.",
      inputSchema: { type: "object" }
    },
    transport: { kind: "mcp", url: "https://tools.settld.local/mcp" },
    signer: { keyId, privateKeyPem },
    at: "2026-02-01T00:00:00.000Z"
  });
  assert.equal(verifyToolManifestV1({ manifest: rugPull, publicKeyPem }), true);

  assert.throws(
    () => assertToolManifestPinned({ pinnedManifestHash: original.manifestHash, manifest: rugPull }),
    (err) => err && err.code === "TOOL_MANIFEST_PIN_MISMATCH"
  );
});
