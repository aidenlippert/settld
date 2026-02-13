import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../src/core/canonical-json.js";
import { sha256Hex, verifyHashHexEd25519 } from "../src/core/crypto.js";

async function readJson(fp) {
  return JSON.parse(await fs.readFile(fp, "utf8"));
}

test("CLI: settld init capability writes a signed ToolManifest.v1 starter", async () => {
  const tmpRoot = path.join("/tmp", `settld_init_cap_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`);
  const outDir = path.join(tmpRoot, "capability-demo");

  const res = spawnSync(process.execPath, ["bin/settld.js", "init", "capability", "demo-cap", "--out", outDir], {
    cwd: path.resolve(process.cwd()),
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `init failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const manifestPath = path.join(outDir, "manifest.json");
  const sigPath = path.join(outDir, "manifest.sig.json");
  const pubKeyPath = path.join(outDir, "keys", "dev-public-key.pem");
  const keypairPath = path.join(outDir, "keys", "dev-keypair.json");
  const kernelProvePath = path.join(outDir, "scripts", "kernel-prove.mjs");

  const manifest = await readJson(manifestPath);
  const sig = await readJson(sigPath);
  const pubKeyPem = await fs.readFile(pubKeyPath, "utf8");
  const keypair = await readJson(keypairPath);
  const kernelProveSource = await fs.readFile(kernelProvePath, "utf8");

  assert.equal(manifest.schemaVersion, "ToolManifest.v1");
  assert.ok(typeof manifest.toolId === "string" && manifest.toolId.length > 0);
  assert.ok(typeof manifest.toolVersion === "string" && manifest.toolVersion.length > 0);
  assert.ok(Array.isArray(manifest.endpoints) && manifest.endpoints.length > 0);
  assert.ok(typeof manifest.inputSchemaHash === "string" && manifest.inputSchemaHash.length === 64);
  assert.ok(typeof manifest.outputSchemaHash === "string" && manifest.outputSchemaHash.length === 64);
  assert.ok(manifest.signature && typeof manifest.signature === "object");

  // Verify signature binds to the canonical core (manifest without signature).
  // eslint-disable-next-line no-unused-vars
  const { signature, ...rest } = manifest;
  const core = normalizeForCanonicalJson(rest, { path: "$" });
  const manifestHash = sha256Hex(canonicalJsonStringify(core));
  assert.equal(signature.manifestHash, manifestHash);

  assert.equal(sig.manifestHash, manifestHash);
  assert.equal(sig.signerPublicKeyPem.trim(), pubKeyPem.trim());
  assert.equal(keypair.publicKeyPem.trim(), pubKeyPem.trim());

  assert.equal(signature.algorithm, "ed25519");
  assert.equal(signature.signerKeyId, keypair.keyId);
  assert.equal(sig.signerKeyId, keypair.keyId);

  assert.equal(
    verifyHashHexEd25519({ hashHex: manifestHash, signatureBase64: signature.signature, publicKeyPem: pubKeyPem }),
    true,
    "manifest signature should verify"
  );

  assert.match(kernelProveSource, /new SettldClient/);
  assert.match(kernelProveSource, /createAgreement\(/);
  assert.match(kernelProveSource, /signEvidence\(/);
  assert.match(kernelProveSource, /settle\(/);
  assert.match(kernelProveSource, /openDispute\(/);
  assert.match(kernelProveSource, /getArtifacts\(/);
});
