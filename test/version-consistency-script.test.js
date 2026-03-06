import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { changelogReferencesVersion, checkVersionConsistency } from "../scripts/ci/check-version-consistency.mjs";

async function writeFixtureRepo(rootDir, { nooterraVersion, packageVersion, artifactVersion, changelogBody }) {
  await fs.mkdir(path.join(rootDir, "packages", "artifact-verify"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "NOOTERRA_VERSION"), `${nooterraVersion}\n`, "utf8");
  await fs.writeFile(path.join(rootDir, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`, "utf8");
  await fs.writeFile(path.join(rootDir, "packages", "artifact-verify", "package.json"), `${JSON.stringify({ version: artifactVersion })}\n`, "utf8");
  await fs.writeFile(path.join(rootDir, "CHANGELOG.md"), changelogBody, "utf8");
}

test("version consistency check: passes when NOOTERRA_VERSION/package/changelog are aligned", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-version-check-pass-"));
  try {
    await writeFixtureRepo(tmpRoot, {
      nooterraVersion: "1.2.3",
      packageVersion: "1.2.3",
      artifactVersion: "1.2.3",
      changelogBody: "# Changelog\n\n## [Unreleased]\n\nCurrent Release: 1.2.3\n"
    });
    const result = checkVersionConsistency({ repoRoot: tmpRoot });
    assert.equal(result.version, "1.2.3");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("version consistency check: fails closed when changelog does not reference release version", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-version-check-changelog-fail-"));
  try {
    await writeFixtureRepo(tmpRoot, {
      nooterraVersion: "2.0.0",
      packageVersion: "2.0.0",
      artifactVersion: "2.0.0",
      changelogBody: "# Changelog\n\n## [Unreleased]\n"
    });
    assert.throws(
      () => checkVersionConsistency({ repoRoot: tmpRoot }),
      /CHANGELOG\.md must reference version 2\.0\.0/
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("version consistency check: fails closed when package.json version diverges", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-version-check-package-fail-"));
  try {
    await writeFixtureRepo(tmpRoot, {
      nooterraVersion: "3.4.5",
      packageVersion: "3.4.6",
      artifactVersion: "3.4.5",
      changelogBody: "# Changelog\n\n## [3.4.5] - 2026-03-04\n"
    });
    assert.throws(
      () => checkVersionConsistency({ repoRoot: tmpRoot }),
      /does not match package\.json version=3\.4\.6/
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("version consistency helper: accepts explicit release headings", () => {
  const ok = changelogReferencesVersion("# Changelog\n\n## [0.9.0] - 2026-03-04\n", "0.9.0");
  assert.equal(ok, true);
});

