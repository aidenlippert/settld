import fs from "node:fs";
import path from "node:path";

function readTrimmed(filePath) {
  return String(fs.readFileSync(filePath, "utf8")).trim();
}

function ensureExists(filePath, errorMessage) {
  if (!fs.existsSync(filePath)) throw new Error(errorMessage);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function changelogReferencesVersion(changelogText, version) {
  const text = typeof changelogText === "string" ? changelogText : "";
  const normalizedVersion = String(version ?? "").trim();
  if (!normalizedVersion) return false;

  const escapedVersion = escapeRegExp(normalizedVersion);
  const headingPattern = new RegExp(`^##\\s+\\[(?:v)?${escapedVersion}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
  const currentReleasePattern = new RegExp(`^Current Release:\\s*(?:v)?${escapedVersion}\\s*$`, "mi");
  return headingPattern.test(text) || currentReleasePattern.test(text);
}

export function checkVersionConsistency({ repoRoot = process.cwd() } = {}) {
  const nooterraVersionPath = path.join(repoRoot, "NOOTERRA_VERSION");
  const rootPackagePath = path.join(repoRoot, "package.json");
  const artifactVerifyPackagePath = path.join(repoRoot, "packages", "artifact-verify", "package.json");
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");

  ensureExists(nooterraVersionPath, "version consistency check failed: NOOTERRA_VERSION file is missing");
  ensureExists(rootPackagePath, "version consistency check failed: package.json is missing");
  ensureExists(artifactVerifyPackagePath, "version consistency check failed: packages/artifact-verify/package.json is missing");
  ensureExists(changelogPath, "version consistency check failed: CHANGELOG.md is missing");

  const repoVersion = readTrimmed(nooterraVersionPath);
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  const rootVersion = String(rootPackage.version ?? "").trim();
  const artifactVerifyPackage = JSON.parse(fs.readFileSync(artifactVerifyPackagePath, "utf8"));
  const artifactVerifyVersion = String(artifactVerifyPackage.version ?? "").trim();
  const changelogText = fs.readFileSync(changelogPath, "utf8");

  if (!repoVersion) {
    throw new Error("version consistency check failed: NOOTERRA_VERSION is empty");
  }
  if (!rootVersion) {
    throw new Error("version consistency check failed: package.json version is empty");
  }
  if (!artifactVerifyVersion) {
    throw new Error("version consistency check failed: packages/artifact-verify/package.json version is empty");
  }
  if (repoVersion !== rootVersion) {
    throw new Error(`version consistency check failed: NOOTERRA_VERSION=${repoVersion} does not match package.json version=${rootVersion}`);
  }
  if (repoVersion !== artifactVerifyVersion) {
    throw new Error(
      `version consistency check failed: NOOTERRA_VERSION=${repoVersion} does not match packages/artifact-verify/package.json version=${artifactVerifyVersion}`
    );
  }
  if (!changelogReferencesVersion(changelogText, repoVersion)) {
    throw new Error(
      `version consistency check failed: CHANGELOG.md must reference version ${repoVersion} (use a release heading or "Current Release: ${repoVersion}")`
    );
  }

  return { version: repoVersion };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = checkVersionConsistency();
    // eslint-disable-next-line no-console
    console.log(`version consistency check passed: ${result.version}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}
