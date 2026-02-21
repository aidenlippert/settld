import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applySettldServerConfig,
  buildSettldMcpServerConfig,
  resolveHostConfigPathCandidatesDetailed,
  runHostConfigSetup
} from "../scripts/setup/host-config.mjs";

function baseEnv(overrides = {}) {
  return {
    SETTLD_BASE_URL: "http://127.0.0.1:3000",
    SETTLD_TENANT_ID: "tenant_default",
    SETTLD_API_KEY: "sk_test_id.secret",
    ...overrides
  };
}

test("path resolution prefers host-specific env override", () => {
  const rows = resolveHostConfigPathCandidatesDetailed({
    host: "codex",
    platform: "linux",
    homeDir: "/home/alice",
    cwd: "/workspace",
    env: {
      SETTLD_CODEX_MCP_CONFIG_PATH: "configs/codex-mcp.json",
      CODEX_HOME: "/tmp/custom-codex-home"
    }
  });

  assert.ok(rows.length > 0);
  assert.equal(rows[0].path, path.resolve("/workspace", "configs/codex-mcp.json"));
  assert.equal(rows[0].source, "env:SETTLD_CODEX_MCP_CONFIG_PATH");
  assert.ok(rows.some((row) => row.path === path.join("/tmp/custom-codex-home", "config.json")));
});

test("path resolution includes platform defaults", () => {
  const rows = resolveHostConfigPathCandidatesDetailed({
    host: "cursor",
    platform: "darwin",
    homeDir: "/Users/alice",
    env: {}
  });

  assert.ok(
    rows.some(
      (row) => row.path === path.join("/Users/alice", "Library", "Application Support", "Cursor", "User", "mcp.json")
    )
  );
  assert.ok(rows.some((row) => row.path === path.join("/Users/alice", ".cursor", "mcp.json")));
});

test("merge updates mcpServers.settld and remains idempotent", () => {
  const settldServer = buildSettldMcpServerConfig({ env: baseEnv() });
  const existing = {
    mcpServers: {
      weather: {
        command: "node",
        args: ["weather.js"],
        env: { API_KEY: "abc" }
      },
      settld: {
        command: "node",
        args: ["old.js"],
        env: { SETTLD_BASE_URL: "http://old" }
      }
    },
    metadata: { owner: "team-mcp" }
  };

  const first = applySettldServerConfig({
    host: "claude",
    existingConfig: existing,
    settldServer
  });
  assert.equal(first.keyPath, "mcpServers.settld");
  assert.equal(first.changed, true);
  assert.deepEqual(first.config.mcpServers.weather, existing.mcpServers.weather);
  assert.equal(first.config.metadata.owner, "team-mcp");
  assert.deepEqual(first.config.mcpServers.settld, settldServer);

  const second = applySettldServerConfig({
    host: "claude",
    existingConfig: first.config,
    settldServer
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.config, first.config);
});

test("openclaw falls back to root host-equivalent shape when no server map exists", () => {
  const settldServer = buildSettldMcpServerConfig({ env: baseEnv({ SETTLD_PAID_TOOLS_BASE_URL: "http://127.0.0.1:8402" }) });
  const existing = {
    description: "OpenClaw skill MCP server",
    name: "placeholder",
    command: "node",
    args: ["legacy.js"],
    env: { LEGACY: "1" }
  };

  const merged = applySettldServerConfig({
    host: "openclaw",
    existingConfig: existing,
    settldServer
  });

  assert.equal(merged.keyPath, "root");
  assert.equal(merged.config.description, existing.description);
  assert.equal(merged.config.name, "settld");
  assert.equal(merged.config.command, "npx");
  assert.deepEqual(merged.config.args, ["-y", "settld-mcp"]);
  assert.equal(merged.config.env.SETTLD_BASE_URL, "http://127.0.0.1:3000");
  assert.equal(merged.config.env.SETTLD_PAID_TOOLS_BASE_URL, "http://127.0.0.1:8402");
});

test("dry-run does not modify config file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-host-config-test-"));
  try {
    const configPath = path.join(tempDir, "codex-config.json");
    const initial = {
      mcpServers: {
        settld: {
          command: "node",
          args: ["legacy.js"],
          env: { SETTLD_BASE_URL: "http://old" }
        }
      }
    };
    await fs.writeFile(configPath, JSON.stringify(initial, null, 2) + "\n", "utf8");

    const summary = await runHostConfigSetup({
      host: "codex",
      configPath,
      dryRun: true,
      env: baseEnv()
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.wroteFile, false);
    assert.equal(summary.changed, true);
    assert.equal(summary.pathSource, "cli:--config-path");

    const after = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(after, initial);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("runHostConfigSetup writes once and then becomes idempotent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-host-config-test-"));
  try {
    const configPath = path.join(tempDir, "claude-config.json");

    const first = await runHostConfigSetup({
      host: "claude",
      configPath,
      env: baseEnv({ SETTLD_PAID_TOOLS_BASE_URL: "https://paid.tools.settld.work" })
    });

    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.equal(first.wroteFile, true);
    assert.equal(first.existed, false);
    assert.equal(first.keyPath, "mcpServers.settld");

    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(written.mcpServers?.settld?.command, "npx");
    assert.deepEqual(written.mcpServers?.settld?.args, ["-y", "settld-mcp"]);
    assert.equal(written.mcpServers?.settld?.env?.SETTLD_API_KEY, "sk_test_id.secret");

    const second = await runHostConfigSetup({
      host: "claude",
      configPath,
      env: baseEnv({ SETTLD_PAID_TOOLS_BASE_URL: "https://paid.tools.settld.work" })
    });

    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.wroteFile, false);
    assert.equal(second.existed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
