import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sh(cmd, args, { cwd, env } = {}) {
  const isWin = process.platform === "win32";
  const resolvedCmd = cmd;
  // On Windows runners, invoking npm via a shell is more reliable than trying to exec a .cmd shim directly.
  const res = spawnSync(resolvedCmd, args, { cwd, env, encoding: "utf8", shell: isWin && cmd === "npm" });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || res.error?.message || "").trim();
    throw new Error(`${resolvedCmd} ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
  }
  return res.stdout;
}

function nodeCli({ cliJs, cwd, env, args }) {
  if (typeof cliJs !== "string" || cliJs.trim() === "") throw new TypeError("cliJs is required");
  const res = spawnSync(process.execPath, [cliJs, ...args], { cwd, env, encoding: "utf8" });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || res.error?.message || "").trim();
    throw new Error(`node ${cliJs} ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
  }
  return res.stdout;
}

async function main() {
  const repoRoot = process.cwd();
  const verifyPkgDir = path.resolve(repoRoot, "packages", "artifact-verify");
  const producePkgDir = path.resolve(repoRoot, "packages", "artifact-produce");

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-pack-"));
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-install-"));
  const npmCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-npm-cache-"));

  try {
    // Force npm cache/log writes into /tmp so CI-like sandboxes don't block ~/.npm.
    const npmEnv = {
      ...process.env,
      NPM_CONFIG_CACHE: npmCacheDir,
      npm_config_cache: npmCacheDir,
      npm_config_update_notifier: "false"
    };

    sh("npm", ["pack", "--pack-destination", outDir], { cwd: verifyPkgDir, env: npmEnv });
    sh("npm", ["pack", "--pack-destination", outDir], { cwd: producePkgDir, env: npmEnv });
    const packed = (await fs.readdir(outDir)).filter((n) => n.endsWith(".tgz"));
    if (!packed.length) throw new Error("npm pack did not produce a .tgz in pack destination");
    const verifyCandidates = packed.filter((n) => n.startsWith("settld-artifact-verify-"));
    const produceCandidates = packed.filter((n) => n.startsWith("settld-artifact-produce-"));
    if (!verifyCandidates.length) throw new Error("expected settld-artifact-verify-*.tgz in pack destination");
    if (!produceCandidates.length) throw new Error("expected settld-artifact-produce-*.tgz in pack destination");
    const verifyTarball = path.join(outDir, verifyCandidates[0]);
    const produceTarball = path.join(outDir, produceCandidates[0]);

    sh("npm", ["init", "-y"], { cwd: installDir, env: npmEnv });
    sh("npm", ["install", "--silent", verifyTarball, produceTarball], { cwd: installDir, env: npmEnv });

    const verifyCliJs = path.join(installDir, "node_modules", "settld-artifact-verify", "bin", "settld-verify.js");
    const produceCliJs = path.join(installDir, "node_modules", "settld-artifact-produce", "bin", "settld-produce.js");
    const trustCliJs = path.join(installDir, "node_modules", "settld-artifact-produce", "bin", "settld-trust.js");

    const ver = nodeCli({ cliJs: verifyCliJs, cwd: installDir, env: npmEnv, args: ["--version"] }).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-.]+)?$/.test(ver)) {
      throw new Error(`unexpected --version output: ${JSON.stringify(ver)}`);
    }
    const prodVer = nodeCli({ cliJs: produceCliJs, cwd: installDir, env: npmEnv, args: ["--version"] }).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-.]+)?$/.test(prodVer)) {
      throw new Error(`unexpected settld-produce --version output: ${JSON.stringify(prodVer)}`);
    }
    const trustVer = nodeCli({ cliJs: trustCliJs, cwd: installDir, env: npmEnv, args: ["--version"] }).trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-.]+)?$/.test(trustVer)) {
      throw new Error(`unexpected settld-trust --version output: ${JSON.stringify(trustVer)}`);
    }

    // Producer bootstrap: init trust + produce bundles + strict verify them using the installed packages.
    const trustOutDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-trust-init-"));
    const trustInitRaw = nodeCli({
      cliJs: trustCliJs,
      cwd: installDir,
      env: npmEnv,
      args: ["init", "--format", "json", "--out", trustOutDir, "--force"]
    });
    const trustInit = JSON.parse(trustInitRaw);
    if (trustInit?.schemaVersion !== "TrustInitOutput.v1") throw new Error("settld-trust init returned unexpected JSON");
    const trust = JSON.parse(await fs.readFile(trustInit.trustPath, "utf8"));
    const producedEnv = {
      ...npmEnv,
      SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON: JSON.stringify(trust.governanceRoots ?? {}),
      SETTLD_TRUSTED_TIME_AUTHORITY_KEYS_JSON: JSON.stringify(trust.timeAuthorities ?? {})
    };

    const tmpOut = await fs.mkdtemp(path.join(os.tmpdir(), "settld-produce-"));
    const jobBundle = path.join(tmpOut, "jobproof");
    const monthBundle = path.join(tmpOut, "monthproof");
    const financeBundle = path.join(tmpOut, "financepack");

    const prodJob = nodeCli({
      cliJs: produceCliJs,
      cwd: installDir,
      env: npmEnv,
      args: ["jobproof", "--format", "json", "--deterministic", "--force", "--out", jobBundle, "--keys", trustInit.keypairsPath]
    });
    const prodJobJson = JSON.parse(prodJob);
    if (prodJobJson?.schemaVersion !== "ProduceCliOutput.v1") throw new Error("settld-produce jobproof did not return ProduceCliOutput.v1");
    if (prodJobJson?.ok !== true) throw new Error(`settld-produce jobproof failed: ${JSON.stringify(prodJobJson)}`);

    const verifyJob = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: producedEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--job-proof", jobBundle]
    });
    const verifyJobJson = JSON.parse(verifyJob);
    if (verifyJobJson?.ok !== true) throw new Error("installed settld-verify failed produced jobproof bundle verification");

    // Delegated signing smoke: run a dev remote signer (holds private keys in a separate process),
    // init trust in remote-only mode, and produce a jobproof bundle using --signer remote.
    const kp = JSON.parse(await fs.readFile(trustInit.keypairsPath, "utf8"));
    const govKeyId = String(kp?.govRoot?.keyId ?? "");
    const serverKeyId = String(kp?.serverA?.keyId ?? "");
    if (!govKeyId || !serverKeyId) throw new Error("missing govRoot/serverA key ids in keypairs.json");

    const signerDevJs = path.join(installDir, "node_modules", "settld-artifact-produce", "bin", "settld-signer-dev.js");
    const signerCommand = process.execPath;
    const signerArgsJson = JSON.stringify([signerDevJs, "--stdio", "--keys", trustInit.keypairsPath]);

    const remoteTrustDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-trust-remote-"));
    const remoteTrustRaw = nodeCli({
      cliJs: trustCliJs,
      cwd: installDir,
      env: npmEnv,
      args: [
        "init",
        "--mode",
        "remote-only",
        "--out",
        remoteTrustDir,
        "--signer-command",
        signerCommand,
        "--signer-args-json",
        signerArgsJson,
        "--governance-root-key-id",
        govKeyId,
        "--format",
        "json",
        "--force"
      ]
    });
    const remoteTrust = JSON.parse(remoteTrustRaw);
    const trustRemote = JSON.parse(await fs.readFile(remoteTrust.trustPath, "utf8"));
    const remoteEnv = {
      ...npmEnv,
      SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON: JSON.stringify(trustRemote.governanceRoots ?? {}),
      SETTLD_TRUSTED_TIME_AUTHORITY_KEYS_JSON: JSON.stringify(trustRemote.timeAuthorities ?? {})
    };

    const jobBundleRemote = path.join(tmpOut, "jobproof-remote");
    const prodJobRemote = nodeCli({
      cliJs: produceCliJs,
      cwd: installDir,
      env: npmEnv,
      args: [
        "jobproof",
        "--format",
        "json",
        "--deterministic",
        "--force",
        "--out",
        jobBundleRemote,
        "--signer",
        "remote",
        "--signer-command",
        signerCommand,
        "--signer-args-json",
        signerArgsJson,
        "--gov-key-id",
        govKeyId,
        "--server-key-id",
        serverKeyId
      ]
    });
    const prodJobRemoteJson = JSON.parse(prodJobRemote);
    if (prodJobRemoteJson?.ok !== true) throw new Error("settld-produce jobproof remote signer failed");

    const verifyJobRemote = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: remoteEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--job-proof", jobBundleRemote]
    });
    const verifyJobRemoteJson = JSON.parse(verifyJobRemote);
    if (verifyJobRemoteJson?.ok !== true) throw new Error("installed settld-verify failed remote-signed jobproof verification");

    // Plugin signer smoke: load a signer provider via a local plugin file (no private keys in Settld core).
    const pluginCfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-plugin-cfg-"));
    const pluginCfgPath = path.join(pluginCfgDir, "config.json");
    await fs.writeFile(pluginCfgPath, JSON.stringify({ keypairsPath: trustInit.keypairsPath }, null, 2) + "\n", "utf8");
    const pluginPath = path.join(pluginCfgDir, "plugin.mjs");
    await fs.writeFile(
      pluginPath,
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "import { sign as nodeSign } from 'node:crypto';",
        "",
        "export async function createSignerProvider({ config } = {}) {",
        "  const abs = path.resolve(process.cwd(), config.keypairsPath);",
        "  const kp = JSON.parse(await fs.readFile(abs, 'utf8'));",
        "  const byKeyId = new Map();",
        "  for (const v of Object.values(kp ?? {})) {",
        "    if (!v?.keyId || !v?.publicKeyPem || !v?.privateKeyPem) continue;",
        "    byKeyId.set(v.keyId, v);",
        "  }",
        "  return {",
        "    async getPublicKeyPem({ keyId }) {",
        "      const r = byKeyId.get(keyId);",
        "      if (!r) throw new Error('unknown keyId');",
        "      return r.publicKeyPem;",
        "    },",
        "    async sign({ keyId, algorithm, messageBytes }) {",
        "      const r = byKeyId.get(keyId);",
        "      if (!r) throw new Error('unknown keyId');",
        "      if (algorithm !== 'ed25519') throw new Error('unsupported algorithm');",
        "      const sig = nodeSign(null, Buffer.from(messageBytes), r.privateKeyPem).toString('base64');",
        "      return { signatureBase64: sig };",
        "    }",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const jobBundlePlugin = path.join(tmpOut, "jobproof-plugin");
    const prodJobPlugin = nodeCli({
      cliJs: produceCliJs,
      cwd: installDir,
      env: npmEnv,
      args: [
        "jobproof",
        "--format",
        "json",
        "--deterministic",
        "--force",
        "--out",
        jobBundlePlugin,
        "--signer",
        "plugin",
        "--signer-plugin",
        pluginPath,
        "--signer-plugin-config",
        pluginCfgPath,
        "--gov-key-id",
        govKeyId,
        "--server-key-id",
        serverKeyId
      ]
    });
    const prodJobPluginJson = JSON.parse(prodJobPlugin);
    if (prodJobPluginJson?.ok !== true) throw new Error("settld-produce jobproof plugin signer failed");

    const verifyJobPlugin = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: producedEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--job-proof", jobBundlePlugin]
    });
    const verifyJobPluginJson = JSON.parse(verifyJobPlugin);
    if (verifyJobPluginJson?.ok !== true) throw new Error("installed settld-verify failed plugin-signed jobproof verification");

    const prodMonth = nodeCli({
      cliJs: produceCliJs,
      cwd: installDir,
      env: npmEnv,
      args: [
        "monthproof",
        "--format",
        "json",
        "--deterministic",
        "--force",
        "--out",
        monthBundle,
        "--keys",
        trustInit.keypairsPath,
        "--tenant",
        "tenant_default",
        "--period",
        "1970-01",
        "--basis",
        "settledAt"
      ]
    });
    const prodMonthJson = JSON.parse(prodMonth);
    if (prodMonthJson?.ok !== true) throw new Error("settld-produce monthproof failed");

    const verifyMonth = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: producedEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--month-proof", monthBundle]
    });
    const verifyMonthJson = JSON.parse(verifyMonth);
    if (verifyMonthJson?.ok !== true) throw new Error("installed settld-verify failed produced monthproof bundle verification");

    const prodFin = nodeCli({
      cliJs: produceCliJs,
      cwd: installDir,
      env: npmEnv,
      args: [
        "financepack",
        "--format",
        "json",
        "--deterministic",
        "--force",
        "--out",
        financeBundle,
        "--keys",
        trustInit.keypairsPath,
        "--monthproof",
        monthBundle,
        "--tenant",
        "tenant_default",
        "--period",
        "1970-01",
        "--protocol",
        "1.0"
      ]
    });
    const prodFinJson = JSON.parse(prodFin);
    if (prodFinJson?.ok !== true) throw new Error("settld-produce financepack failed");

    const verifyFin = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: producedEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--finance-pack", financeBundle]
    });
    const verifyFinJson = JSON.parse(verifyFin);
    if (verifyFinJson?.ok !== true) throw new Error("installed settld-verify failed produced financepack bundle verification");

    // Fixture/conformance trust roots (these bundles are signed by fixture keys, not the bootstrap keys).
    const fixtureTrustPath = path.resolve(repoRoot, "test", "fixtures", "bundles", "v1", "trust.json");
    const fixtureTrust = JSON.parse(await fs.readFile(fixtureTrustPath, "utf8"));
    const fixtureEnv = {
      ...npmEnv,
      SETTLD_TRUSTED_GOVERNANCE_ROOT_KEYS_JSON: JSON.stringify(fixtureTrust.governanceRoots ?? {}),
      SETTLD_TRUSTED_PRICING_SIGNER_KEYS_JSON: JSON.stringify(fixtureTrust.pricingSigners ?? {}),
      SETTLD_TRUSTED_TIME_AUTHORITY_KEYS_JSON: JSON.stringify(fixtureTrust.timeAuthorities ?? {})
    };

    const fixtureDir = path.resolve(repoRoot, "test", "fixtures", "bundles", "v1", "jobproof", "strict-pass");
    const verifyOut = nodeCli({
      cliJs: verifyCliJs,
      cwd: installDir,
      env: fixtureEnv,
      args: ["--format", "json", "--strict", "--hash-concurrency", "4", "--job-proof", fixtureDir]
    });
    const parsed = JSON.parse(verifyOut);
    if (!parsed || typeof parsed !== "object") throw new Error("verify output was not JSON object");
    if (parsed.ok !== true) throw new Error(`installed settld-verify failed fixture verification: ${JSON.stringify(parsed)}`);

    // Conformance must run against the installed package bits (not repo-relative JS entrypoint).
    const installedCliJs = path.join(installDir, "node_modules", "settld-artifact-verify", "bin", "settld-verify.js");
    const conf = spawnSync(process.execPath, [path.resolve(repoRoot, "conformance", "v1", "run.mjs"), "--node-bin", installedCliJs], {
      cwd: repoRoot,
      env: fixtureEnv,
      encoding: "utf8"
    });
    if (conf.status !== 0) {
      throw new Error(`conformance failed against installed package\n\nstdout:\n${conf.stdout}\n\nstderr:\n${conf.stderr}`);
    }

    // Producer conformance must also run against installed package bits.
    const installedProduceJs = path.join(installDir, "node_modules", "settld-artifact-produce", "bin", "settld-produce.js");
    const confProduce = spawnSync(
      process.execPath,
      [
        path.resolve(repoRoot, "conformance", "v1", "run-produce.mjs"),
        "--produce-node-bin",
        installedProduceJs,
        "--verify-node-bin",
        installedCliJs
      ],
      {
        cwd: repoRoot,
        env: fixtureEnv,
        encoding: "utf8"
      }
    );
    if (confProduce.status !== 0) {
      throw new Error(`producer conformance failed against installed package\n\nstdout:\n${confProduce.stdout}\n\nstderr:\n${confProduce.stderr}`);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(installDir, { recursive: true, force: true });
    await fs.rm(npmCacheDir, { recursive: true, force: true });
  }
}

await main();
