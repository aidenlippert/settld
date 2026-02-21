import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI: settld setup --help routes to onboard helper", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-setup-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "onboard-from-setup-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(setupDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "settld.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(setupDir, "onboard.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.SETUP_ONBOARD_FROM_SETUP_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(setupDir, "wizard.mjs"), "process.exit(3);\n", "utf8");

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "setup", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_ONBOARD_FROM_SETUP_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `setup failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const onboardArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(onboardArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: setup/);
});

test("CLI: settld setup legacy --help routes to setup wizard", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-setup-legacy-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "wizard-from-legacy-argv.json");
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
      'const logPath = process.env.SETUP_LEGACY_WIZARD_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(path.join(setupDir, "onboard.mjs"), "process.exit(3);\n", "utf8");

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "setup", "legacy", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_LEGACY_WIZARD_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `setup legacy failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const wizardArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(wizardArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: setup/);
});

test("CLI: settld onboard --help routes to onboard helper", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-onboard-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "onboard-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(setupDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "settld.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(setupDir, "onboard.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.SETUP_ONBOARD_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  // keep other helpers present to ensure dispatch target is onboard helper.
  await fs.writeFile(path.join(setupDir, "wizard.mjs"), "process.exit(3);\n", "utf8");
  await fs.writeFile(path.join(setupDir, "circle-bootstrap.mjs"), "process.exit(4);\n", "utf8");
  await fs.writeFile(path.join(setupDir, "openclaw-onboard.mjs"), "process.exit(5);\n", "utf8");

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "onboard", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_ONBOARD_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `onboard failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const helperArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(helperArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: onboard/);
});

test("CLI: settld setup circle --help routes to circle bootstrap helper", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-setup-circle-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "circle-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(setupDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "settld.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(setupDir, "circle-bootstrap.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.SETUP_CIRCLE_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  // keep wizard present to prove dispatch is selecting circle helper specifically.
  await fs.writeFile(
    path.join(setupDir, "wizard.mjs"),
    "process.exit(3);\n",
    "utf8"
  );

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "setup", "circle", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_CIRCLE_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `setup circle failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const helperArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(helperArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: setup/);
});

test("CLI: settld setup openclaw --help routes to openclaw onboarding helper", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-setup-openclaw-"));
  const binDir = path.join(tmpRoot, "bin");
  const setupDir = path.join(tmpRoot, "scripts", "setup");
  const logPath = path.join(tmpRoot, "openclaw-argv.json");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(setupDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "settld.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(setupDir, "openclaw-onboard.mjs"),
    [
      'import fs from "node:fs";',
      'const logPath = process.env.SETUP_OPENCLAW_LOG;',
      "if (!logPath) process.exit(2);",
      "fs.writeFileSync(logPath, JSON.stringify(process.argv.slice(2)));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  // keep other setup helpers present to ensure correct dispatch target.
  await fs.writeFile(path.join(setupDir, "wizard.mjs"), "process.exit(3);\n", "utf8");
  await fs.writeFile(path.join(setupDir, "circle-bootstrap.mjs"), "process.exit(4);\n", "utf8");

  const res = spawnSync(process.execPath, [path.join(binDir, "settld.js"), "setup", "openclaw", "--help"], {
    cwd: tmpRoot,
    env: { ...process.env, SETUP_OPENCLAW_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `setup openclaw failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const helperArgv = JSON.parse(await fs.readFile(logPath, "utf8"));
  assert.deepEqual(helperArgv, ["--help"]);
  assert.doesNotMatch(String(res.stderr), /unknown command: setup/);
});
