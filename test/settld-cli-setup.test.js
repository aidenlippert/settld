import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI: settld setup --help routes to setup wizard", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-setup-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "wizard-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(setupDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "settld.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(setupDir, "wizard.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.SETUP_WIZARD_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "setup", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_WIZARD_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `setup failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const wizardArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(wizardArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: setup/);
});
