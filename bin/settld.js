#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  // eslint-disable-next-line no-console
  console.error("usage:");
  console.error("  settld --version");
  console.error("  settld conformance test [--case <id>] [--bin settld-verify] [--node-bin <path/to/settld-verify.js>] [--keep-temp]");
  console.error("  settld conformance list");
  console.error("  settld conformance kernel --ops-token <tok_opsw> [--base-url http://127.0.0.1:3000] [--tenant-id tenant_default] [--protocol 1.0] [--case <id>]");
  console.error("  settld conformance kernel:list");
  console.error("  settld closepack export --agreement-hash <sha256> --out <path.zip> [--ops-token tok_ops] [--base-url http://127.0.0.1:3000] [--tenant-id tenant_default] [--protocol 1.0]");
  console.error("  settld closepack verify <path.zip> [--json-out <path.json>]");
  console.error("  settld dev up [--no-build] [--foreground]");
  console.error("  settld dev down [--wipe]");
  console.error("  settld dev ps");
  console.error("  settld dev logs [--follow] [--service api]");
  console.error("  settld dev info");
  console.error("  settld init capability <name> [--out <dir>] [--force]");
}

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function readVersion() {
  try {
    const fp = path.join(repoRoot(), "SETTLD_VERSION");
    return fs.readFileSync(fp, "utf8").trim();
  } catch {
    return null;
  }
}

function runNodeScript(scriptRelPath, args) {
  const script = path.join(repoRoot(), scriptRelPath);
  const res = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  process.exit(typeof res.status === "number" ? res.status : 1);
}

function runCommandOrExit(cmd, args, { cwd } = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: cwd ?? repoRoot() });
  if (res.error && res.error.code === "ENOENT") {
    // eslint-disable-next-line no-console
    console.error(`missing executable: ${cmd}`);
    process.exit(127);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}

function dockerCompose(args) {
  // Prefer `docker compose` (newer), fall back to `docker-compose` (older installs).
  const primary = spawnSync("docker", ["compose", ...args], { stdio: "inherit", cwd: repoRoot() });
  if (!primary.error && typeof primary.status === "number") return primary.status;
  if (primary.error && primary.error.code === "ENOENT") {
    // No docker binary; try docker-compose anyway.
    const fallback = spawnSync("docker-compose", args, { stdio: "inherit", cwd: repoRoot() });
    if (fallback.error && fallback.error.code === "ENOENT") {
      // eslint-disable-next-line no-console
      console.error("missing executable: docker (or docker-compose)");
      return 127;
    }
    return typeof fallback.status === "number" ? fallback.status : 1;
  }
  // docker exists but compose subcommand may not; try docker-compose.
  const fallback = spawnSync("docker-compose", args, { stdio: "inherit", cwd: repoRoot() });
  if (fallback.error && fallback.error.code === "ENOENT") {
    // eslint-disable-next-line no-console
    console.error("missing executable: docker-compose");
    return 127;
  }
  return typeof fallback.status === "number" ? fallback.status : 1;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ? String(argv[0]) : "";

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "--version" || cmd === "-v") {
    // eslint-disable-next-line no-console
    console.log(readVersion() ?? "unknown");
    process.exit(0);
  }

  if (cmd === "conformance") {
    const sub = argv[1] ? String(argv[1]) : "test";
    if (sub === "test") return runNodeScript("conformance/v1/run.mjs", argv.slice(2));
    if (sub === "list") return runNodeScript("conformance/v1/run.mjs", ["--list", ...argv.slice(2)]);
    if (sub === "kernel") return runNodeScript("conformance/kernel-v0/run.mjs", argv.slice(2));
    if (sub === "kernel:list") return runNodeScript("conformance/kernel-v0/run.mjs", ["--list", ...argv.slice(2)]);
    usage();
    // eslint-disable-next-line no-console
    console.error(`unknown conformance subcommand: ${sub}`);
    process.exit(1);
  }

  if (cmd === "dev") {
    const sub = argv[1] ? String(argv[1]) : "";
    const rest = argv.slice(2);
    if (!sub) {
      usage();
      // eslint-disable-next-line no-console
      console.error("missing dev subcommand");
      process.exit(1);
    }

    if (sub === "up") {
      const build = !rest.includes("--no-build");
      const foreground = rest.includes("--foreground");
      const upArgs = ["--profile", "app", "up", ...(foreground ? [] : ["-d"]), ...(build ? ["--build"] : [])];
      const upStatus = dockerCompose(upArgs);
      if (upStatus !== 0) process.exit(upStatus);
      const initStatus = dockerCompose(["--profile", "init", "run", "--rm", "minio-init"]);
      if (initStatus !== 0) process.exit(initStatus);
      // eslint-disable-next-line no-console
      console.log("");
      // eslint-disable-next-line no-console
      console.log("dev stack is up:");
      // eslint-disable-next-line no-console
      console.log("  baseUrl:   http://127.0.0.1:3000");
      // eslint-disable-next-line no-console
      console.log("  tenantId:  tenant_default");
      // eslint-disable-next-line no-console
      console.log("  opsToken:  tok_ops");
      // eslint-disable-next-line no-console
      console.log("  explorer:  http://127.0.0.1:3000/ops/kernel/workspace?opsToken=tok_ops");
      process.exit(0);
    }

    if (sub === "down") {
      const wipe = rest.includes("--wipe");
      const downArgs = ["--profile", "app", "down", ...(wipe ? ["-v"] : [])];
      process.exit(dockerCompose(downArgs));
    }

    if (sub === "ps") {
      process.exit(dockerCompose(["--profile", "app", "ps"]));
    }

    if (sub === "logs") {
      const follow = rest.includes("--follow") || rest.includes("-f");
      const serviceIdx = rest.findIndex((v) => v === "--service");
      const service = serviceIdx >= 0 ? String(rest[serviceIdx + 1] ?? "").trim() : "";
      const tailArgs = ["--profile", "app", "logs", ...(follow ? ["-f"] : []), ...(service ? [service] : [])];
      process.exit(dockerCompose(tailArgs));
    }

    if (sub === "info") {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ baseUrl: "http://127.0.0.1:3000", tenantId: "tenant_default", opsToken: "tok_ops" }, null, 2));
      process.exit(0);
    }

    usage();
    // eslint-disable-next-line no-console
    console.error(`unknown dev subcommand: ${sub}`);
    process.exit(1);
  }

  if (cmd === "init") {
    const sub = argv[1] ? String(argv[1]) : "";
    if (!sub) {
      usage();
      // eslint-disable-next-line no-console
      console.error("missing init subcommand");
      process.exit(1);
    }
    if (sub === "capability") {
      return runNodeScript("scripts/init/capability.mjs", argv.slice(2));
    }
    usage();
    // eslint-disable-next-line no-console
    console.error(`unknown init subcommand: ${sub}`);
    process.exit(1);
  }

  if (cmd === "closepack") {
    const sub = argv[1] ? String(argv[1]) : "";
    if (!sub) {
      usage();
      // eslint-disable-next-line no-console
      console.error("missing closepack subcommand");
      process.exit(1);
    }
    if (sub === "export") {
      return runNodeScript("scripts/closepack/export.mjs", argv.slice(2));
    }
    if (sub === "verify") {
      return runNodeScript("scripts/closepack/verify.mjs", argv.slice(2));
    }
    usage();
    // eslint-disable-next-line no-console
    console.error(`unknown closepack subcommand: ${sub}`);
    process.exit(1);
  }

  usage();
  // eslint-disable-next-line no-console
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

main();
