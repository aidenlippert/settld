import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("CLI: nooterra agent init routes to bin/agentverse-cli.js", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-agentverse-route-"));
  const binDir = path.join(tmpRoot, "bin");
  const scriptsAgentDir = path.join(tmpRoot, "scripts", "agent");
  const srcAgentverseCliDir = path.join(tmpRoot, "src", "agentverse", "cli");
  const routeLogPath = path.join(tmpRoot, "route-log.json");

  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(scriptsAgentDir, { recursive: true });
  await fs.mkdir(srcAgentverseCliDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "nooterra.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "nooterra.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "NOOTERRA_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(binDir, "agentverse-cli.js"),
    [
      "#!/usr/bin/env node",
      'import { runCli } from "../src/agentverse/cli/commands.js";',
      "const code = await runCli(process.argv.slice(2));",
      "process.exit(code);"
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(srcAgentverseCliDir, "commands.js"),
    [
      'import fs from "node:fs";',
      'const p = process.env.AGENTVERSE_ROUTE_LOG;',
      "if (!p) process.exit(2);",
      "fs.writeFileSync(p, JSON.stringify({ tool: \"agentverse\", argv: process.argv.slice(2) }));",
      "export async function runCli() { return 0; }"
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(scriptsAgentDir, "cli.mjs"),
    [
      'import fs from "node:fs";',
      'const p = process.env.AGENTVERSE_ROUTE_LOG;',
      "if (!p) process.exit(2);",
      "fs.writeFileSync(p, JSON.stringify({ tool: \"legacy\", argv: process.argv.slice(2) }));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  const res = spawnSync(process.execPath, [path.join(binDir, "nooterra.js"), "agent", "init", "demo"], {
    cwd: tmpRoot,
    env: { ...process.env, AGENTVERSE_ROUTE_LOG: routeLogPath },
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.equal(res.status, 0, `agent init route failed\nstdout:\n${String(res.stdout)}\nstderr:\n${String(res.stderr)}`);

  const logged = JSON.parse(await fs.readFile(routeLogPath, "utf8"));
  assert.equal(logged.tool, "agentverse");
  assert.deepEqual(logged.argv, ["agent", "init", "demo"]);
});

test("CLI: nooterra agent upgrade/decommission routes to bin/agentverse-cli.js", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-agentverse-route-"));
  const binDir = path.join(tmpRoot, "bin");
  const scriptsAgentDir = path.join(tmpRoot, "scripts", "agent");
  const srcAgentverseCliDir = path.join(tmpRoot, "src", "agentverse", "cli");
  const routeLogPath = path.join(tmpRoot, "route-log.json");

  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(scriptsAgentDir, { recursive: true });
  await fs.mkdir(srcAgentverseCliDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "nooterra.js");
  const sourceBin = await fs.readFile(sourceBinPath, "utf8");
  await fs.writeFile(path.join(binDir, "nooterra.js"), sourceBin, "utf8");
  await fs.writeFile(path.join(tmpRoot, "NOOTERRA_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(binDir, "agentverse-cli.js"),
    [
      "#!/usr/bin/env node",
      'import { runCli } from "../src/agentverse/cli/commands.js";',
      "const code = await runCli(process.argv.slice(2));",
      "process.exit(code);"
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(srcAgentverseCliDir, "commands.js"),
    [
      'import fs from "node:fs";',
      'const p = process.env.AGENTVERSE_ROUTE_LOG;',
      "if (!p) process.exit(2);",
      "fs.writeFileSync(p, JSON.stringify({ tool: \"agentverse\", argv: process.argv.slice(2) }));",
      "export async function runCli() { return 0; }"
    ].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(scriptsAgentDir, "cli.mjs"),
    [
      'import fs from "node:fs";',
      'const p = process.env.AGENTVERSE_ROUTE_LOG;',
      "if (!p) process.exit(2);",
      "fs.writeFileSync(p, JSON.stringify({ tool: \"legacy\", argv: process.argv.slice(2) }));",
      "process.exit(0);"
    ].join("\n"),
    "utf8"
  );

  const upgradeRes = spawnSync(process.execPath, [path.join(binDir, "nooterra.js"), "agent", "upgrade", "--no-reload", "--status", "active"], {
    cwd: tmpRoot,
    env: { ...process.env, AGENTVERSE_ROUTE_LOG: routeLogPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(upgradeRes.status, 0, `agent upgrade route failed\nstdout:\n${String(upgradeRes.stdout)}\nstderr:\n${String(upgradeRes.stderr)}`);
  const upgradeLog = JSON.parse(await fs.readFile(routeLogPath, "utf8"));
  assert.equal(upgradeLog.tool, "agentverse");
  assert.deepEqual(upgradeLog.argv.slice(0, 2), ["agent", "upgrade"]);

  const decommissionRes = spawnSync(process.execPath, [path.join(binDir, "nooterra.js"), "agent", "decommission", "--no-stop", "--agent-id", "agt_1"], {
    cwd: tmpRoot,
    env: { ...process.env, AGENTVERSE_ROUTE_LOG: routeLogPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(
    decommissionRes.status,
    0,
    `agent decommission route failed\nstdout:\n${String(decommissionRes.stdout)}\nstderr:\n${String(decommissionRes.stderr)}`
  );
  const decommissionLog = JSON.parse(await fs.readFile(routeLogPath, "utf8"));
  assert.equal(decommissionLog.tool, "agentverse");
  assert.deepEqual(decommissionLog.argv.slice(0, 2), ["agent", "decommission"]);
});
