#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(cmd, args, { cwd, env } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return String(res.stdout ?? "");
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch (err) {
    throw new Error(`invalid ${label} JSON: ${err?.message ?? String(err)}`);
  }
}

async function main() {
  const repoRoot = process.cwd();
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-public-openclaw-pack-"));
  const unpackDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-public-openclaw-unpack-"));
  const npmCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-public-openclaw-cache-"));
  const fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-public-openclaw-home-"));

  const npmEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: "false"
  };

  try {
    const packJson = run("npm", ["--cache", npmCacheDir, "pack", "--json"], {
      cwd: repoRoot,
      env: npmEnv
    });
    const packRows = parseJsonText(packJson, "npm pack");
    const row = Array.isArray(packRows) ? packRows[0] : null;
    assert(row && typeof row.filename === "string" && row.filename.trim(), "npm pack did not return a tarball filename");
    const tarballName = row.filename.trim();
    const tarballPath = path.join(repoRoot, tarballName);
    await fs.rename(tarballPath, path.join(packDir, tarballName));
    const packedTarballPath = path.join(packDir, tarballName);

    run("tar", ["-xzf", packedTarballPath, "-C", unpackDir], { env: npmEnv });
    const packageRoot = path.join(unpackDir, "package");
    const hostConfigScript = path.join(packageRoot, "scripts", "setup", "host-config.mjs");
    await fs.access(hostConfigScript);

    const versionText = run(
      "npx",
      [
        "--yes",
        "--package",
        packedTarballPath,
        "--",
        "settld",
        "--version"
      ],
      { cwd: packDir, env: npmEnv }
    ).trim();
    assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-.]+)?$/.test(versionText), `unexpected public CLI version output: ${JSON.stringify(versionText)}`);

    const setupReportPath = path.join(fakeHomeDir, "public-setup-report.json");
    run(
      "npx",
      [
        "--yes",
        "--package",
        packedTarballPath,
        "--",
        "settld",
        "setup",
        "--non-interactive",
        "--host",
        "openclaw",
        "--base-url",
        "https://api.settld.work",
        "--tenant-id",
        "tenant_public_smoke",
        "--settld-api-key",
        "sk_public_smoke.x",
        "--wallet-mode",
        "none",
        "--no-preflight",
        "--no-smoke",
        "--dry-run",
        "--format",
        "json",
        "--report-path",
        setupReportPath
      ],
      {
        cwd: packDir,
        env: {
          ...npmEnv,
          HOME: fakeHomeDir
        }
      }
    );
    const setupResult = parseJsonText(await fs.readFile(setupReportPath, "utf8"), "settld setup report");
    assert(setupResult?.ok === true, "public npx setup did not return ok=true");
    assert(String(setupResult?.host ?? "") === "openclaw", "public npx setup host mismatch");
    assert(String(setupResult?.wallet?.mode ?? "") === "none", "public npx wallet mode mismatch");

    const hostConfigModule = await import(pathToFileURL(hostConfigScript).href);
    const hostConfigSummary = await hostConfigModule.runHostConfigSetup({
      host: "openclaw",
      dryRun: true,
      env: {
        ...npmEnv,
        HOME: fakeHomeDir,
        SETTLD_BASE_URL: "https://api.settld.work",
        SETTLD_TENANT_ID: "tenant_public_smoke",
        SETTLD_API_KEY: "sk_public_smoke.x"
      }
    });
    assert(hostConfigSummary?.ok === true, "host-config dry-run summary missing ok=true");
    assert(String(hostConfigSummary?.serverCommand ?? "") === "npx", "public openclaw server command must default to npx");
    assert(Array.isArray(hostConfigSummary?.serverArgs), "public openclaw server args missing");
    assert(hostConfigSummary.serverArgs.includes("-y"), "public openclaw server args missing -y");
    assert(hostConfigSummary.serverArgs.includes("settld-mcp"), "public openclaw server args missing settld-mcp");
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.rm(unpackDir, { recursive: true, force: true });
    await fs.rm(npmCacheDir, { recursive: true, force: true });
    await fs.rm(fakeHomeDir, { recursive: true, force: true });
  }
}

await main();
