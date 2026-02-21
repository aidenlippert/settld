import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function makeCliFixture() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-cli-doctor-"));
  const binDir = path.join(tmpRoot, "bin");
  const doctorDir = path.join(tmpRoot, "scripts", "doctor");
  const ciDir = path.join(tmpRoot, "scripts", "ci");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(doctorDir, { recursive: true });
  await fs.mkdir(ciDir, { recursive: true });

  const sourceBinPath = path.resolve(process.cwd(), "bin", "settld.js");
  const sourceDoctorPath = path.resolve(process.cwd(), "scripts", "doctor", "mcp-host.mjs");
  await fs.copyFile(sourceBinPath, path.join(binDir, "settld.js"));
  await fs.copyFile(sourceDoctorPath, path.join(doctorDir, "mcp-host.mjs"));
  await fs.writeFile(path.join(tmpRoot, "SETTLD_VERSION"), "0.0.0-test\n", "utf8");

  await fs.writeFile(
    path.join(ciDir, "run-mcp-host-smoke.mjs"),
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      'import process from "node:process";',
      "",
      'const reportPath = path.resolve(process.cwd(), process.env.MCP_HOST_SMOKE_REPORT_PATH || "artifacts/ops/mcp-host-smoke.json");',
      'const fail = process.env.SMOKE_STUB_MODE === "fail";',
      "const report = {",
      '  schemaVersion: "McpHostSmokeReport.v1",',
      "  ok: !fail,",
      '  checks: [{ id: "stub_check", ok: !fail }],',
      '  error: fail ? { message: "stub failure" } : null',
      "};",
      "await fs.mkdir(path.dirname(reportPath), { recursive: true });",
      'await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\\n", "utf8");',
      'process.stdout.write(`wrote mcp host smoke report: ${reportPath}\\n`);',
      "process.exit(fail ? 1 : 0);"
    ].join("\n"),
    "utf8"
  );

  return { tmpRoot, cliPath: path.join(binDir, "settld.js") };
}

test("CLI: settld doctor prints PASS and report path when smoke passes", async () => {
  const { tmpRoot, cliPath } = await makeCliFixture();
  const expectedRoot = await fs.realpath(tmpRoot);
  const expectedReportPath = path.join(expectedRoot, "artifacts", "ops", "mcp-host-smoke.json");

  const res = spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd: tmpRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 0, `doctor failed\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const stdout = String(res.stdout);
  assert.match(stdout, /PASS mcp-host-compatibility/);
  assert.match(stdout, new RegExp(`report: ${escapeRegex(expectedReportPath)}`));

  const report = JSON.parse(await fs.readFile(expectedReportPath, "utf8"));
  assert.equal(report.ok, true);
});

test("CLI: settld doctor prints FAIL and custom report path when smoke fails", async () => {
  const { tmpRoot, cliPath } = await makeCliFixture();
  const expectedRoot = await fs.realpath(tmpRoot);
  const expectedReportPath = path.join(expectedRoot, "artifacts", "ops", "custom-doctor-report.json");

  const res = spawnSync(process.execPath, [cliPath, "doctor", "--report", expectedReportPath], {
    cwd: tmpRoot,
    env: { ...process.env, SMOKE_STUB_MODE: "fail" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(res.status, 1, `doctor should fail\n\nstdout:\n${String(res.stdout)}\n\nstderr:\n${String(res.stderr)}`);

  const stdout = String(res.stdout);
  assert.match(stdout, /FAIL mcp-host-compatibility/);
  assert.match(stdout, new RegExp(`report: ${escapeRegex(expectedReportPath)}`));
  assert.match(stdout, /error: stub failure/);

  const report = JSON.parse(await fs.readFile(expectedReportPath, "utf8"));
  assert.equal(report.ok, false);
});
