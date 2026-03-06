import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sh(cmd, args, { cwd, env } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
  }
  return res.stdout;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function main() {
  const repoRoot = process.cwd();
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-pack-"));
  const unpackDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-unpack-"));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-out-"));
  const npmCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "nooterra-cli-cache-"));

  const npmEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
    npm_config_update_notifier: "false"
  };

  try {
    sh("npm", ["--cache", npmCacheDir, "pack", "--silent", "--pack-destination", packDir], { cwd: repoRoot, env: npmEnv });
    const packed = (await fs.readdir(packDir)).filter((name) => /^nooterra-.*\.tgz$/.test(name)).sort();
    assert(packed.length > 0, "npm pack did not produce nooterra-*.tgz");
    const tarballPath = path.join(packDir, packed[packed.length - 1]);
    sh("tar", ["-xzf", tarballPath, "-C", unpackDir], { env: npmEnv });
    const packageRoot = path.join(unpackDir, "package");
    const cliPath = path.join(packageRoot, "bin", "nooterra.js");
    await fs.access(path.join(packageRoot, "bin", "agentverse-cli.js"));
    await fs.access(path.join(packageRoot, "src", "agentverse", "index.js"));
    await fs.access(path.join(packageRoot, "scripts", "ci", "run-agentverse-gate.mjs"));
    await fs.access(path.join(packageRoot, "scripts", "mcp", "nooterra-mcp-server.mjs"));
    await fs.access(path.join(packageRoot, "packages", "api-sdk", "src", "x402-autopay.js"));

    const runTarballCli = (args) => {
      const cmd = ["npx", "--yes", "--package", tarballPath, "--", "nooterra", ...args].map(shellQuote).join(" ");
      const res = spawnSync("bash", ["-lc", cmd], {
        cwd: packDir,
        env: npmEnv,
        encoding: "utf8"
      });
      const blockedBySandbox =
        res.error &&
        res.error.code === "EPERM" &&
        res.status === 0 &&
        String(res.stdout ?? "").trim() === "" &&
        String(res.stderr ?? "").trim() === "";
      if (blockedBySandbox) return { stdout: "", blockedBySandbox: true };
      if (res.status !== 0) {
        const err = (res.stderr || res.stdout || "").trim();
        throw new Error(`npx --package <tarball> nooterra ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
      }
      return { stdout: String(res.stdout ?? ""), blockedBySandbox: false };
    };

    const runCli = (args) => {
      const cmd = [process.execPath, cliPath, ...args].map(shellQuote).join(" ");
      const res = spawnSync("bash", ["-lc", cmd], {
        cwd: packageRoot,
        env: npmEnv,
        encoding: "utf8"
      });
      const blockedBySandbox =
        res.error &&
        res.error.code === "EPERM" &&
        res.status === 0 &&
        String(res.stdout ?? "").trim() === "" &&
        String(res.stderr ?? "").trim() === "";
      if (blockedBySandbox) return { stdout: "", blockedBySandbox: true };
      if (res.status !== 0) {
        const err = (res.stderr || res.stdout || "").trim();
        throw new Error(`nooterra ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
      }
      return { stdout: String(res.stdout ?? ""), blockedBySandbox: false };
    };

    const versionResult = runTarballCli(["--version"]);
    const sandboxBlocked = versionResult.blockedBySandbox === true;
    if (!sandboxBlocked) {
      const version = versionResult.stdout.trim();
      assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-.]+)?$/.test(version), `unexpected nooterra --version output: ${JSON.stringify(version)}`);
    }

    if (sandboxBlocked) {
      // In restricted sandboxes some child-process invocations return EPERM with status=0 and no IO.
      // Fall back to static package checks; CI environments still execute the full behavioral path above.
      await fs.access(path.join(packageRoot, "bin", "nooterra.js"));
      await fs.access(path.join(packageRoot, "scripts", "init", "capability.mjs"));
      await fs.access(path.join(packageRoot, "conformance", "kernel-v0", "run.mjs"));
      await fs.access(path.join(packageRoot, "scripts", "closepack", "verify.mjs"));
      await fs.access(path.join(packageRoot, "NOOTERRA_VERSION"));
      await fs.access(path.join(packageRoot, "Dockerfile"));
      await fs.access(path.join(packageRoot, "docker-compose.yml"));
      await fs.access(path.join(packageRoot, "src", "api", "server.js"));
      await fs.access(path.join(packageRoot, "services", "receiver", "src", "server.js"));
      try {
        await fs.access(path.join(packageRoot, "test"));
        throw new Error("packed CLI unexpectedly includes test/ directory");
      } catch (err) {
        if (String(err?.message ?? "").includes("unexpectedly includes")) throw err;
      }
      try {
        await fs.access(path.join(packageRoot, ".github"));
        throw new Error("packed CLI unexpectedly includes .github/ directory");
      } catch (err) {
        if (String(err?.message ?? "").includes("unexpectedly includes")) throw err;
      }
      return;
    }

    const tarballCases = runTarballCli(["conformance", "kernel:list"]).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert(tarballCases.length > 0, "npx --package <tarball> nooterra conformance kernel:list returned no cases");

    const infoRaw = runCli(["dev", "info"]).stdout.trim();
    const info = JSON.parse(infoRaw);
    assert(String(info.baseUrl ?? "") === "http://127.0.0.1:3000", "nooterra dev info baseUrl mismatch");
    assert(String(info.tenantId ?? "") === "tenant_default", "nooterra dev info tenantId mismatch");
    assert(String(info.opsToken ?? "") === "tok_ops", "nooterra dev info opsToken mismatch");

    const cases = runCli(["conformance", "kernel:list"]).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    assert(cases.length > 0, "nooterra conformance kernel:list returned no cases");

    runCli(["closepack", "verify", "--help"]);
    runCli(["x402", "receipt", "verify", "--help"]);

    const starterDir = path.join(outDir, "starter-capability");
    runCli(["init", "capability", "smoke-capability", "--out", starterDir]);
    await fs.access(path.join(starterDir, "manifest.json"));
    await fs.access(path.join(starterDir, "manifest.sig.json"));
    await fs.access(path.join(starterDir, "server.js"));
    await fs.access(path.join(starterDir, "scripts", "kernel-prove.mjs"));
    await fs.access(path.join(starterDir, "scripts", "kernel-conformance.mjs"));
    const kernelProveSource = await fs.readFile(path.join(starterDir, "scripts", "kernel-prove.mjs"), "utf8");
    assert(kernelProveSource.includes("import(\"nooterra-api-sdk\")"), "starter kernel-prove script must attempt npm SDK import first");
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.rm(unpackDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(npmCacheDir, { recursive: true, force: true });
  }
}

await main();
