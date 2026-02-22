import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { createEd25519Keypair, verifyHashHexEd25519 } from "../src/core/crypto.js";

const SCRIPT_PATH = path.resolve("scripts/ops/dispute-finance-reconciliation-packet.mjs");

function startStubServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = { "content-type": "application/json" };

    if (url.pathname === "/ops/settlement-adjustments/sadj_test_release_1") {
      const body = {
        ok: true,
        tenantId: "tenant_default",
        adjustment: {
          schemaVersion: "SettlementAdjustment.v1",
          adjustmentId: "sadj_test_release_1",
          kind: "holdback_release",
          amountCents: 250,
          currency: "USD",
          adjustmentHash: "c6325f4bc165f7d5f720f0beea5d8ecb3cead6b2b76eca74a2ac935f7f02f4da"
        }
      };
      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/agents/agt_payer_1/wallet") {
      const body = {
        ok: true,
        wallet: {
          walletId: "wallet_agt_payer_1",
          agentId: "agt_payer_1",
          currency: "USD",
          availableCents: 1000,
          escrowLockedCents: 50,
          updatedAt: "2026-02-22T00:00:00.000Z"
        }
      };
      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/agents/agt_payee_1/wallet") {
      const body = {
        ok: true,
        wallet: {
          walletId: "wallet_agt_payee_1",
          agentId: "agt_payee_1",
          currency: "USD",
          availableCents: 750,
          escrowLockedCents: 0,
          updatedAt: "2026-02-22T00:00:00.000Z"
        }
      };
      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "not found" }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unable to resolve server address"));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`
      });
    });
  });
}

function runScript(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk ?? "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test("dispute finance reconciliation packet script: emits deterministic packet with signatures", async () => {
  const { server, baseUrl } = await startStubServer();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-dispute-finance-packet-"));
  const packetPath1 = path.join(tmpDir, "packet-1.json");
  const packetPath2 = path.join(tmpDir, "packet-2.json");
  const keypair = createEd25519Keypair();
  const keyPath = path.join(tmpDir, "finance-signing-key.pem");
  await fs.writeFile(keyPath, keypair.privateKeyPem, "utf8");

  const generatedAt = "2026-02-22T01:00:00.000Z";
  const commonArgs = [
    SCRIPT_PATH,
    "--base-url",
    baseUrl,
    "--tenant-id",
    "tenant_default",
    "--ops-token",
    "tok_ops_finance",
    "--adjustment-id",
    "sadj_test_release_1",
    "--payer-agent-id",
    "agt_payer_1",
    "--payee-agent-id",
    "agt_payee_1",
    "--generated-at",
    generatedAt,
    "--signing-key-file",
    keyPath,
    "--signature-key-id",
    "finance_key_1"
  ];

  const run1 = await runScript([...commonArgs, "--out", packetPath1], { cwd: path.resolve(".") });
  assert.equal(run1.code, 0, run1.stderr || run1.stdout);

  const run2 = await runScript([...commonArgs, "--out", packetPath2], { cwd: path.resolve(".") });
  assert.equal(run2.code, 0, run2.stderr || run2.stdout);

  const packet1 = JSON.parse(await fs.readFile(packetPath1, "utf8"));
  const packet2 = JSON.parse(await fs.readFile(packetPath2, "utf8"));

  assert.equal(packet1.schemaVersion, "DisputeFinanceReconciliationPacket.v1");
  assert.equal(packet1.adjustmentId, "sadj_test_release_1");
  assert.equal(packet1.balances.derivationMode, "holdback_release");
  assert.equal(packet1.balances.payer.before.escrowLockedCents, 300);
  assert.equal(packet1.balances.payer.after.escrowLockedCents, 50);
  assert.equal(packet1.balances.payee.before.availableCents, 500);
  assert.equal(packet1.balances.payee.after.availableCents, 750);
  assert.equal(packet1.checksums.adjustmentHash, "c6325f4bc165f7d5f720f0beea5d8ecb3cead6b2b76eca74a2ac935f7f02f4da");
  assert.ok(typeof packet1.checksums.packetHash === "string" && packet1.checksums.packetHash.length === 64);
  assert.equal(packet1.checksums.packetHash, packet2.checksums.packetHash);
  assert.equal(packet1.signature.signature, packet2.signature.signature);
  assert.equal(packet1.signature.keyId, "finance_key_1");

  const validSignature = verifyHashHexEd25519({
    hashHex: packet1.signature.packetHash,
    signatureBase64: packet1.signature.signature,
    publicKeyPem: keypair.publicKeyPem
  });
  assert.equal(validSignature, true);

  await new Promise((resolve) => server.close(resolve));
});
