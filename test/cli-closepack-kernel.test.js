import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createApi } from "../src/api/app.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function uniqueSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

async function listenEphemeral(server) {
  return await new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      server.off("error", onError);
    };
    server.on("error", onError);
    server.listen(0, "127.0.0.1", () => {
      cleanup();
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      resolve({ port });
    });
  });
}

function spawnCapture(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

test("CLI: settld closepack export/verify roundtrip for tool-call dispute chain", async (t) => {
  const tenantId = `tenant_cli_closepack_${uniqueSuffix()}`;
  const opsToken = "tok_ops";
  const api = createApi({ opsTokens: `${opsToken}:ops_read,ops_write,finance_read,finance_write,audit_read` });
  const server = http.createServer(api.handle);

  let port = null;
  try {
    ({ port } = await listenEphemeral(server));
  } catch (err) {
    const code = err?.code ?? null;
    if (code === "EPERM" || code === "EACCES") {
      t.skip(`loopback listen not permitted (${code})`);
      return;
    }
    throw err;
  }

  try {
    const tmp = path.join("/tmp", `settld_cli_closepack_${uniqueSuffix()}`);
    await fs.mkdir(tmp, { recursive: true });
    const conformanceJson = path.join(tmp, "kernel-conformance.json");

    const runConformance = await spawnCapture([
      path.join(REPO_ROOT, "conformance", "kernel-v0", "run.mjs"),
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--tenant-id",
      tenantId,
      "--protocol",
      "1.0",
      "--ops-token",
      opsToken,
      "--case",
      "tool_call_holdback_release",
      "--json-out",
      conformanceJson,
      "--closepack-out-dir",
      tmp
    ]);

    assert.equal(
      runConformance.status,
      0,
      `kernel conformance failed\n\nstdout:\n${runConformance.stdout}\n\nstderr:\n${runConformance.stderr}`
    );

    const report = JSON.parse(await fs.readFile(conformanceJson, "utf8"));
    const agreementHash = String(report?.results?.[0]?.details?.agreementHash ?? "");
    assert.match(agreementHash, /^[0-9a-f]{64}$/);

    const closepackZipPath = path.join(tmp, `${agreementHash}_cli.zip`);
    const exportRes = await spawnCapture([
      path.join(REPO_ROOT, "bin", "settld.js"),
      "closepack",
      "export",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--tenant-id",
      tenantId,
      "--protocol",
      "1.0",
      "--ops-token",
      opsToken,
      "--agreement-hash",
      agreementHash,
      "--out",
      closepackZipPath
    ]);

    assert.equal(exportRes.status, 0, `closepack export failed\n\nstdout:\n${exportRes.stdout}\n\nstderr:\n${exportRes.stderr}`);
    const exportBody = JSON.parse(exportRes.stdout);
    assert.equal(exportBody.ok, true);
    assert.equal(exportBody.outPath, closepackZipPath);
    assert.match(String(exportBody.zipSha256 ?? ""), /^[0-9a-f]{64}$/);

    const verifyJsonPath = path.join(tmp, `${agreementHash}_verify.json`);
    const verifyRes = await spawnCapture([
      path.join(REPO_ROOT, "bin", "settld.js"),
      "closepack",
      "verify",
      closepackZipPath,
      "--json-out",
      verifyJsonPath
    ]);

    assert.equal(verifyRes.status, 0, `closepack verify failed\n\nstdout:\n${verifyRes.stdout}\n\nstderr:\n${verifyRes.stderr}`);
    const verifyBody = JSON.parse(verifyRes.stdout);
    assert.equal(verifyBody.ok, true);
    assert.equal(verifyBody.replayMatch, true);

    const verifyFile = JSON.parse(await fs.readFile(verifyJsonPath, "utf8"));
    assert.equal(verifyFile.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
