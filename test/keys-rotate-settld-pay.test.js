import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createApi } from "../src/api/app.js";
import { createStore } from "../src/api/store.js";
import { createEd25519Keypair, keyIdFromPublicKeyPem } from "../src/core/crypto.js";
import { buildSettldPayPayloadV1, mintSettldPayTokenV1, verifySettldPayTokenV1 } from "../src/core/settld-pay-token.js";
import { request } from "./api-test-harness.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode({ args, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("keys:rotate updates keyset store and preserves old token verification", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "settld-keys-rotate-"));
  const dataDir = path.join(tmpRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const oldSigner = createEd25519Keypair();
  const oldKid = keyIdFromPublicKeyPem(oldSigner.publicKeyPem);
  const signerPath = path.join(dataDir, "server-signer.json");
  await fs.promises.writeFile(
    signerPath,
    JSON.stringify({ publicKeyPem: oldSigner.publicKeyPem, privateKeyPem: oldSigner.privateKeyPem }, null, 2) + "\n",
    "utf8"
  );

  const reportPath = path.join(tmpRoot, "rotation-report.json");
  const exec = await runNode({
    cwd: REPO_ROOT,
    args: [
      "scripts/trust-config/rotate-settld-pay.mjs",
      "--data-dir",
      dataDir,
      "--report",
      reportPath,
      "--keep-previous",
      "3"
    ]
  });
  assert.equal(exec.code, 0, `stderr=${exec.stderr}`);
  assert.match(exec.stdout, /Provider notification snippet:/);
  assert.match(exec.stdout, /new_active_kid=/);
  assert.match(exec.stdout, /rotation_report=/);

  const keysetStorePath = path.join(dataDir, "settld-pay-keyset-store.json");
  const keysetStore = JSON.parse(await readFile(keysetStorePath, "utf8"));
  assert.equal(keysetStore.schemaVersion, "SettldPayKeysetStore.v1");
  assert.equal(typeof keysetStore.active?.privateKeyPem, "string");
  assert.ok(Array.isArray(keysetStore.previous));
  assert.equal(keysetStore.previous.some((row) => row.keyId === oldKid), true);

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.schemaVersion, "SettldPayKeyRotationReport.v1");
  assert.equal(report.oldActiveKeyId, oldKid);
  assert.equal(typeof report.newActiveKeyId, "string");
  assert.notEqual(report.newActiveKeyId, oldKid);

  const store = createStore({ persistenceDir: dataDir });
  const api = createApi({ store });
  const keysetRes = await request(api, { method: "GET", path: "/.well-known/settld-keys.json", auth: "none" });
  assert.equal(keysetRes.statusCode, 200, keysetRes.body);
  const servedKidSet = new Set((keysetRes.json?.keys ?? []).map((row) => row?.kid));
  assert.equal(servedKidSet.has(oldKid), true);
  assert.equal(servedKidSet.has(report.newActiveKeyId), true);

  // Token minted before rotation (old key) remains verifiable while old key is still published.
  const nowUnix = Math.floor(Date.now() / 1000);
  const oldTokenPayload = buildSettldPayPayloadV1({
    iss: "settld",
    aud: "agt_x402_payee_provider",
    gateId: "gate_rotate_test_old",
    authorizationRef: "auth_gate_rotate_test_old",
    amountCents: 500,
    currency: "USD",
    payeeProviderId: "agt_x402_payee_provider",
    iat: nowUnix - 30,
    exp: nowUnix + 120
  });
  const oldToken = mintSettldPayTokenV1({
    payload: oldTokenPayload,
    keyId: oldKid,
    publicKeyPem: oldSigner.publicKeyPem,
    privateKeyPem: oldSigner.privateKeyPem
  }).token;
  const verified = verifySettldPayTokenV1({
    token: oldToken,
    keyset: keysetRes.json,
    expectedAudience: "agt_x402_payee_provider",
    expectedPayeeProviderId: "agt_x402_payee_provider",
    nowUnixSeconds: nowUnix
  });
  assert.equal(verified.ok, true);
});
