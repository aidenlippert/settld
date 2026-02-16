import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("create-settld-paid-tool scaffold writes runnable template files", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "settld-scaffold-paid-tool-"));
  const outDir = path.join(tmpRoot, "paid-tool");
  const exec = await runNode({
    cwd: REPO_ROOT,
    args: ["scripts/scaffold/create-settld-paid-tool.mjs", outDir, "--provider-id", "prov_test_scaffold_1"]
  });
  assert.equal(exec.code, 0, `stderr=${exec.stderr}`);
  assert.match(exec.stdout, /created=/);
  assert.match(exec.stdout, /providerId=prov_test_scaffold_1/);

  const requiredFiles = ["package.json", "README.md", ".env.example", "server.mjs"];
  for (const filename of requiredFiles) {
    assert.equal(fs.existsSync(path.join(outDir, filename)), true, `${filename} should exist`);
  }

  const pkg = JSON.parse(await readFile(path.join(outDir, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies?.["@settld/provider-kit"], "latest");

  const serverSrc = await readFile(path.join(outDir, "server.mjs"), "utf8");
  assert.match(serverSrc, /createSettldPaidNodeHttpHandler/);
  const readme = await readFile(path.join(outDir, "README.md"), "utf8");
  assert.match(readme, /SettldPay/);
});
