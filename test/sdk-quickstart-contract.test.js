import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = process.cwd();

async function readRepoFile(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

test("sdk quickstart contract: package scripts pin ACS smoke entrypoints", async () => {
  const raw = await readRepoFile("package.json");
  const pkg = JSON.parse(raw);
  assert.equal(pkg.scripts["sdk:acs-smoke"], "node scripts/examples/sdk-acs-substrate-smoke.mjs");
  assert.equal(pkg.scripts["sdk:acs-smoke:py"], "PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples/sdk-acs-substrate-smoke.py");
  assert.equal(pkg.scripts["test:ops:agentverse-gate"], "node scripts/ci/run-agentverse-gate.mjs");
});

test("sdk quickstart contract: ACS smoke example files exist", async () => {
  await fs.access(path.join(REPO_ROOT, "scripts/examples/sdk-acs-substrate-smoke.mjs"));
  await fs.access(path.join(REPO_ROOT, "scripts/examples/sdk-acs-substrate-smoke.py"));
});

test("sdk quickstart contract: SDK docs publish ACS smoke commands", async () => {
  const quickstartJs = await readRepoFile("docs/QUICKSTART_SDK.md");
  const quickstartPy = await readRepoFile("docs/QUICKSTART_SDK_PYTHON.md");

  assert.match(quickstartJs, /npm run sdk:acs-smoke/);
  assert.match(quickstartJs, /Run ACS substrate smoke flow \(JS SDK\)/);
  assert.match(quickstartPy, /npm run sdk:acs-smoke:py/);
  assert.match(quickstartPy, /Run ACS substrate smoke flow \(Python SDK\)/);
});

test("sdk quickstart contract: package READMEs expose ACS quickstart surface", async () => {
  const jsReadme = await readRepoFile("packages/api-sdk/README.md");
  const pyReadme = await readRepoFile("packages/api-sdk-python/README.md");

  assert.match(jsReadme, /createTaskQuote/);
  assert.match(jsReadme, /createWorkOrder/);
  assert.match(jsReadme, /createCapabilityAttestation/);
  assert.match(jsReadme, /npm run sdk:acs-smoke/);
  assert.match(pyReadme, /issue_delegation_grant/);
  assert.match(pyReadme, /create_work_order/);
  assert.match(pyReadme, /create_capability_attestation/);
  assert.match(pyReadme, /npm run sdk:acs-smoke:py/);
});

test("sdk quickstart contract: package exports include agentverse surfaces", async () => {
  const raw = await readRepoFile("package.json");
  const pkg = JSON.parse(raw);
  assert.equal(pkg.exports["./agentverse"], "./src/agentverse/index.js");
  assert.equal(pkg.exports["./agentverse/bridge"], "./src/agentverse/bridge/index.js");
  assert.equal(pkg.bin.agentverse, "bin/agentverse-cli.js");
});
