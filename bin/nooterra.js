#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  // eslint-disable-next-line no-console
  console.error("usage:");
  console.error("  nooterra --version");
  console.error("  nooterra onboard [--help]");
  console.error("  nooterra login [--help]");
  console.error("  nooterra setup [--help]");
  console.error("  nooterra setup legacy [--help]");
  console.error("  nooterra setup circle [--help]");
  console.error("  nooterra setup openclaw [--help]");
  console.error("  nooterra doctor [--help] [--report <path>]");
  console.error("  nooterra conformance test [--case <id>] [--bin nooterra-verify] [--node-bin <path/to/nooterra-verify.js>] [--keep-temp]");
  console.error("  nooterra conformance list");
  console.error("  nooterra conformance kernel --ops-token <tok_opsw> [--base-url http://127.0.0.1:3000] [--tenant-id tenant_default] [--protocol 1.0] [--case <id>]");
  console.error("  nooterra conformance kernel:list");
  console.error("  nooterra closepack export --agreement-hash <sha256> --out <path.zip> [--ops-token tok_ops] [--base-url http://127.0.0.1:3000] [--tenant-id tenant_default] [--protocol 1.0]");
  console.error("  nooterra closepack verify <path.zip> [--json-out <path.json>]");
  console.error("  nooterra x402 receipt verify <receipt.json|-> [--strict] [--format json|text] [--json-out <path>]");
  console.error(
    "  nooterra tui [--json] [--non-interactive] [--base-url <url>] [--tenant-id <id>] [--session-id <id>] [--work-order-id <id>] [--agent-ref <ref>] [--protocol <version>] [--ops-token <token>] [--api-key <key>]"
  );
  console.error(
    "  nooterra wallet status [--base-url <url>] [--tenant-id <id>] [--session-file <path>] [--cookie <cookie>] [--magic-link-api-key <key>] [--format text|json] [--json-out <path>]"
  );
  console.error(
    "  nooterra wallet fund [--method card|bank|transfer|faucet] [--open] [--hosted-url <url>] [--non-interactive] [--base-url <url>] [--tenant-id <id>] [--session-file <path>] [--cookie <cookie>] [--magic-link-api-key <key>] [--format text|json] [--json-out <path>]"
  );
  console.error(
    "  nooterra wallet balance [--watch] [--min-usdc <amount>] [--interval-seconds <n>] [--timeout-seconds <n>] [--base-url <url>] [--tenant-id <id>] [--session-file <path>] [--cookie <cookie>] [--magic-link-api-key <key>] [--format text|json] [--json-out <path>]"
  );
  console.error("  nooterra agent resolve <agentRef> [--json] [--base-url <url>] [--protocol <version>]");
  console.error("  nooterra agent init <name> [--capability <cap>] [--description <text>] [--dir <path>] [--force]");
  console.error("  nooterra agent run [--file <agent.js>] [--policy <policy.yaml>] [--agent-id <id>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--poll-ms <n>]");
  console.error("  nooterra agent status --agent-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>]");
  console.error("  nooterra agent logs --session-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--max-events <n>] [--timeout-ms <n>]");
  console.error(
    "  nooterra agent upgrade [--pid-file <path>] [--no-reload] [--status <status>] [--agent-id <id>] [--reason-code <code>] [--reason-message <text>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>]"
  );
  console.error(
    "  nooterra agent decommission [--agent-id <id>] [--reason-code <code>] [--reason-message <text>] [--wind-down] [--no-stop] [--pid-file <path>] [--base-url <url>] [--tenant-id <id>] [--protocol <v>]"
  );
  console.error("  nooterra observe session --session-id <id> [--base-url <url>] [--tenant-id <id>] [--protocol <v>] [--max-events <n>] [--timeout-ms <n>]");
  console.error("  nooterra profile list [--format json|text] [--json-out <path>]");
  console.error("  nooterra profile init <profile-id> [--out <path>] [--force] [--format json|text] [--json-out <path>]");
  console.error(
    "  nooterra profile wizard [--template <profile-id>] [--non-interactive] [--profile-id <id>] [--name <text>] [--vertical <text>] [--description <text>] [--currency <code>] [--per-request-usd-cents <int>] [--monthly-usd-cents <int>] [--providers <csv>] [--tools <csv>] [--out <path>] [--force] [--format json|text] [--json-out <path>]"
  );
  console.error("  nooterra profile validate <profile.json|-> [--format json|text] [--json-out <path>]");
  console.error(
    "  nooterra profile simulate <profile.json|-> [--scenario <scenario.json|->|--scenario-json <json>] [--format json|text] [--json-out <path>]"
  );
  console.error("  nooterra policy init <pack-id> [--out <path>] [--force] [--format json|text] [--json-out <path>]");
  console.error(
    "  nooterra policy simulate <policy-pack.json|-> [--scenario <scenario.json|->|--scenario-json <json>] [--format json|text] [--json-out <path>]"
  );
  console.error(
    "  nooterra policy publish <policy-pack.json|-> [--out <path>] [--force] [--channel <name>] [--owner <id>] [--format json|text] [--json-out <path>]"
  );
  console.error("  nooterra dev up [--no-build] [--foreground]");
  console.error("  nooterra dev down [--wipe]");
  console.error("  nooterra dev ps");
  console.error("  nooterra dev logs [--follow] [--service api]");
  console.error("  nooterra dev info");
  console.error("  nooterra init capability <name> [--out <dir>] [--force]");
  console.error("");
  console.error("onboarding:");
  console.error("  nooterra onboard");
  console.error("  nooterra setup");
  console.error("  nooterra setup --help");
  console.error("  nooterra dev up");
}

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function readVersion() {
  try {
    const fp = path.join(repoRoot(), "NOOTERRA_VERSION");
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

  if (cmd === "setup") {
    const setupSubcommand = String(argv[1] ?? "").trim();
    if (setupSubcommand === "openclaw") {
      return runNodeScript("scripts/setup/openclaw-onboard.mjs", argv.slice(2));
    }
    if (setupSubcommand === "circle") {
      return runNodeScript("scripts/setup/circle-bootstrap.mjs", argv.slice(2));
    }
    if (setupSubcommand === "legacy") {
      return runNodeScript("scripts/setup/wizard.mjs", argv.slice(2));
    }
    return runNodeScript("scripts/setup/onboard.mjs", argv.slice(1));
  }

  if (cmd === "onboard") {
    return runNodeScript("scripts/setup/onboard.mjs", argv.slice(1));
  }

  if (cmd === "login") {
    return runNodeScript("scripts/setup/login.mjs", argv.slice(1));
  }

  if (cmd === "doctor") {
    return runNodeScript("scripts/doctor/mcp-host.mjs", argv.slice(1));
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

  if (cmd === "x402") {
    const sub = argv[1] ? String(argv[1]) : "";
    const sub2 = argv[2] ? String(argv[2]) : "";
    if (sub === "receipt" && sub2 === "verify") {
      return runNodeScript("scripts/x402/receipt-verify.mjs", argv.slice(3));
    }
    usage();
    // eslint-disable-next-line no-console
    console.error(`unknown x402 subcommand: ${sub}${sub2 ? ` ${sub2}` : ""}`);
    process.exit(1);
  }

  if (cmd === "wallet") {
    return runNodeScript("scripts/wallet/cli.mjs", argv.slice(1));
  }

  if (cmd === "tui") {
    return runNodeScript("scripts/tui/cli.mjs", argv.slice(1));
  }

  if (cmd === "agent") {
    const sub = argv[1] ? String(argv[1]) : "";
    if (sub === "init" || sub === "run" || sub === "status" || sub === "logs" || sub === "upgrade" || sub === "decommission") {
      return runNodeScript("bin/agentverse-cli.js", ["agent", ...argv.slice(1)]);
    }
    return runNodeScript("scripts/agent/cli.mjs", argv.slice(1));
  }

  if (cmd === "observe") {
    return runNodeScript("bin/agentverse-cli.js", ["observe", ...argv.slice(1)]);
  }

  if (cmd === "profile") {
    return runNodeScript("scripts/profile/cli.mjs", argv.slice(1));
  }

  if (cmd === "policy") {
    return runNodeScript("scripts/policy/cli.mjs", argv.slice(1));
  }

  usage();
  // eslint-disable-next-line no-console
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

main();
