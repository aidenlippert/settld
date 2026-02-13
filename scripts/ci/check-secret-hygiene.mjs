#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PRIVATE_KEY_PATTERNS = Object.freeze([
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----"
]);

const ALLOWED_PREFIXES = Object.freeze([
  "test/fixtures/",
  "conformance/",
  "docs/spec/examples/",
  "scripts/pilot/fixtures/"
]);

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output
    .split("\0")
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
}

function isAllowedFixturePath(filePath) {
  return ALLOWED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function hasPrivateKeyMaterial(filePath) {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) return false;
  const text = buffer.toString("utf8");
  return PRIVATE_KEY_PATTERNS.some((pattern) => text.includes(pattern));
}

function main() {
  const tracked = listTrackedFiles();
  const violations = [];

  for (const filePath of tracked) {
    if (filePath.startsWith("keys/")) {
      violations.push(`${filePath}: tracked key material is forbidden`);
      continue;
    }
    if (isAllowedFixturePath(filePath)) continue;
    try {
      if (hasPrivateKeyMaterial(filePath)) {
        violations.push(`${filePath}: private key marker detected`);
      }
    } catch (err) {
      violations.push(`${filePath}: failed to scan (${err?.message ?? String(err)})`);
    }
  }

  if (violations.length > 0) {
    process.stderr.write("secret hygiene check failed:\n");
    for (const violation of violations) process.stderr.write(`- ${violation}\n`);
    process.exit(1);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        trackedFilesScanned: tracked.length
      },
      null,
      2
    ) + "\n"
  );
}

main();
