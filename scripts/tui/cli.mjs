#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";

import { canonicalJsonStringify, normalizeForCanonicalJson } from "../../src/core/canonical-json.js";
import { sha256Hex } from "../../src/core/crypto.js";

const TUI_STATE_SCHEMA_VERSION = "NooterraTuiState.v1";
const PANEL_ORDER = Object.freeze(["identity", "session", "workOrder", "routing", "incidentControls"]);
const PANEL_LABEL = Object.freeze({
  identity: "Identity + Keys",
  session: "Session Inbox",
  workOrder: "Work Orders",
  routing: "Discovery + Routing",
  incidentControls: "Incident Controls"
});

function usage() {
  const lines = [
    "usage:",
    "  nooterra tui [--json] [--non-interactive] [--base-url <url>] [--tenant-id <id>] [--session-id <id>] [--work-order-id <id>] [--agent-ref <ref>] [--protocol <version>] [--ops-token <token>] [--api-key <key>]",
    "",
    "modes:",
    "  --json             print deterministic panel snapshot JSON",
    "  --non-interactive  print deterministic text snapshot (no TTY required)",
    "",
    "interactive keys:",
    "  1..5 select panel, q quit"
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

function fail(message, { code = "TUI_ERROR", statusCode = 1 } = {}) {
  const err = new Error(String(message ?? "tui command failed"));
  err.code = code;
  err.statusCode = Number.isInteger(statusCode) ? statusCode : 1;
  throw err;
}

function readArgValue(argv, index, rawArg) {
  const arg = String(rawArg ?? "");
  const eq = arg.indexOf("=");
  if (eq >= 0) return { value: arg.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function normalizeHttpUrl(value, fieldName = "baseUrl") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${fieldName} must be a valid http(s) URL`, { code: "SCHEMA_INVALID", statusCode: 2 });
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    fail(`${fieldName} must use http or https`, { code: "SCHEMA_INVALID", statusCode: 2 });
  }
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeOptionalString(value, fieldName, { max = 256 } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) fail(`${fieldName} must be <= ${max} characters`, { code: "SCHEMA_INVALID", statusCode: 2 });
  return text;
}

function parseArgs(argv) {
  const out = {
    json: false,
    nonInteractive: false,
    help: false,
    baseUrl: normalizeHttpUrl(process.env.NOOTERRA_BASE_URL ?? "http://127.0.0.1:3000"),
    tenantId: normalizeOptionalString(process.env.NOOTERRA_TENANT_ID ?? "tenant_default", "tenantId", { max: 128 }),
    sessionId: null,
    workOrderId: null,
    agentRef: null,
    protocol: normalizeOptionalString(process.env.NOOTERRA_PROTOCOL ?? "1.0", "protocol", { max: 32 }),
    opsToken: normalizeOptionalString(process.env.NOOTERRA_OPS_TOKEN ?? null, "opsToken", { max: 512 }),
    apiKey: normalizeOptionalString(process.env.NOOTERRA_API_KEY ?? null, "apiKey", { max: 512 })
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--non-interactive") {
      out.nonInteractive = true;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const parsed = readArgValue(argv, i, arg);
      out.baseUrl = normalizeHttpUrl(parsed.value, "baseUrl");
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.tenantId = normalizeOptionalString(parsed.value, "tenantId", { max: 128 });
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.sessionId = normalizeOptionalString(parsed.value, "sessionId", { max: 200 });
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--work-order-id" || arg.startsWith("--work-order-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.workOrderId = normalizeOptionalString(parsed.value, "workOrderId", { max: 200 });
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--agent-ref" || arg.startsWith("--agent-ref=")) {
      const parsed = readArgValue(argv, i, arg);
      out.agentRef = normalizeOptionalString(parsed.value, "agentRef", { max: 512 });
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--protocol" || arg.startsWith("--protocol=")) {
      const parsed = readArgValue(argv, i, arg);
      out.protocol = normalizeOptionalString(parsed.value, "protocol", { max: 32 });
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--ops-token" || arg.startsWith("--ops-token=")) {
      const parsed = readArgValue(argv, i, arg);
      out.opsToken = normalizeOptionalString(parsed.value, "opsToken", { max: 512 });
      i = parsed.nextIndex;
      continue;
    }
    if (
      arg === "--api-key" ||
      arg === "--magic-link-api-key" ||
      arg === "--x-api-key" ||
      arg.startsWith("--api-key=") ||
      arg.startsWith("--magic-link-api-key=") ||
      arg.startsWith("--x-api-key=")
    ) {
      const parsed = readArgValue(argv, i, arg);
      out.apiKey = normalizeOptionalString(parsed.value, "apiKey", { max: 512 });
      i = parsed.nextIndex;
      continue;
    }
    fail(`unknown argument: ${arg}`, { code: "SCHEMA_INVALID", statusCode: 2 });
  }

  if (!out.baseUrl) fail("baseUrl is required", { code: "SCHEMA_INVALID", statusCode: 2 });
  if (!out.tenantId) out.tenantId = "tenant_default";
  return out;
}

function buildHeaders(args) {
  const headers = {
    accept: "application/json",
    "x-nooterra-protocol": args.protocol ?? "1.0",
    "x-tenant-id": args.tenantId ?? "tenant_default"
  };
  if (args.opsToken) headers.authorization = `Bearer ${args.opsToken}`;
  if (args.apiKey) headers["x-api-key"] = args.apiKey;
  return headers;
}

async function fetchJson(baseUrl, relativePath, headers) {
  const url = `${baseUrl}${relativePath}`;
  let response = null;
  try {
    response = await fetch(url, { method: "GET", headers });
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      reasonCode: "NETWORK_ERROR",
      message: err?.message ?? "request failed",
      path: relativePath,
      body: null
    };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      reasonCode: String(body?.code ?? "REQUEST_FAILED"),
      message: String(body?.error ?? body?.message ?? `request failed (${response.status})`),
      path: relativePath,
      body
    };
  }
  return {
    ok: true,
    statusCode: response.status,
    reasonCode: null,
    message: null,
    path: relativePath,
    body
  };
}

function panelUnavailable(reasonCode, message, { inputRequired = false } = {}) {
  return normalizeForCanonicalJson(
    {
      ok: false,
      reasonCode,
      message,
      inputRequired: inputRequired === true,
      data: null
    },
    { path: "$.panel" }
  );
}

async function collectPanels(args) {
  const headers = buildHeaders(args);

  const identity = args.agentRef
    ? await fetchJson(args.baseUrl, `/v1/public/agents/resolve?agent=${encodeURIComponent(args.agentRef)}`, headers)
    : null;
  const routing = args.agentRef
    ? await fetchJson(args.baseUrl, `/v1/public/agents/resolve?agent=${encodeURIComponent(args.agentRef)}`, headers)
    : null;
  const session = args.sessionId
    ? await fetchJson(args.baseUrl, `/sessions/${encodeURIComponent(args.sessionId)}/events?limit=20`, headers)
    : null;
  const workOrder = args.workOrderId
    ? await fetchJson(args.baseUrl, `/work-orders/${encodeURIComponent(args.workOrderId)}`, headers)
    : null;
  const incidentControls = await fetchJson(args.baseUrl, "/ops/emergency/controls?limit=20", headers);

  const panels = {
    identity: identity
      ? identity.ok
        ? {
            ok: true,
            reasonCode: null,
            message: null,
            data: normalizeForCanonicalJson(identity.body?.locator ?? identity.body ?? null, { path: "$.identity" })
          }
        : panelUnavailable(identity.reasonCode, identity.message)
      : panelUnavailable("PANEL_INPUT_MISSING", "agentRef is required for identity panel", { inputRequired: true }),
    session: session
      ? session.ok
        ? {
            ok: true,
            reasonCode: null,
            message: null,
            data: normalizeForCanonicalJson(
              {
                sessionId: args.sessionId,
                eventCount: Array.isArray(session.body?.events) ? session.body.events.length : 0,
                inbox: session.body?.inbox ?? null,
                latestEvent: Array.isArray(session.body?.events) && session.body.events.length > 0 ? session.body.events[session.body.events.length - 1] : null
              },
              { path: "$.session" }
            )
          }
        : panelUnavailable(session.reasonCode, session.message)
      : panelUnavailable("PANEL_INPUT_MISSING", "sessionId is required for session panel", { inputRequired: true }),
    workOrder: workOrder
      ? workOrder.ok
        ? {
            ok: true,
            reasonCode: null,
            message: null,
            data: normalizeForCanonicalJson(workOrder.body?.workOrder ?? workOrder.body ?? null, { path: "$.workOrder" })
          }
        : panelUnavailable(workOrder.reasonCode, workOrder.message)
      : panelUnavailable("PANEL_INPUT_MISSING", "workOrderId is required for work-order panel", { inputRequired: true }),
    routing: routing
      ? routing.ok
        ? {
            ok: true,
            reasonCode: null,
            message: null,
            data: normalizeForCanonicalJson(
              {
                agentRef: args.agentRef,
                resolved: routing.body?.locator?.resolved ?? null,
                candidates: routing.body?.locator?.candidates ?? [],
                reasonCode: routing.body?.locator?.reasonCode ?? null
              },
              { path: "$.routing" }
            )
          }
        : panelUnavailable(routing.reasonCode, routing.message)
      : panelUnavailable("PANEL_INPUT_MISSING", "agentRef is required for routing panel", { inputRequired: true }),
    incidentControls: incidentControls.ok
      ? {
          ok: true,
          reasonCode: null,
          message: null,
          data: normalizeForCanonicalJson(
            {
              controls: incidentControls.body?.controls ?? incidentControls.body?.items ?? [],
              total: Number(incidentControls.body?.total ?? 0)
            },
            { path: "$.incidentControls" }
          )
        }
      : panelUnavailable(incidentControls.reasonCode, incidentControls.message)
  };

  const ok = PANEL_ORDER.some((panelId) => panels[panelId]?.ok === true);
  const core = normalizeForCanonicalJson(
    {
      schemaVersion: TUI_STATE_SCHEMA_VERSION,
      ok,
      baseUrl: args.baseUrl,
      tenantId: args.tenantId,
      protocol: args.protocol ?? "1.0",
      panels
    },
    { path: "$" }
  );
  return normalizeForCanonicalJson(
    {
      ...core,
      snapshotHash: sha256Hex(canonicalJsonStringify(core))
    },
    { path: "$" }
  );
}

function renderPanelValue(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function renderSnapshotText(snapshot, selectedPanelId = "identity") {
  const selected = PANEL_ORDER.includes(selectedPanelId) ? selectedPanelId : PANEL_ORDER[0];
  const lines = [];
  lines.push(`Nooterra TUI v1  tenant=${snapshot.tenantId}  baseUrl=${snapshot.baseUrl}`);
  lines.push(`Snapshot: ${snapshot.snapshotHash}`);
  lines.push("");
  lines.push(PANEL_ORDER.map((panelId, index) => `${index + 1}:${panelId === selected ? "*" : " "} ${PANEL_LABEL[panelId]}`).join("  "));
  lines.push("");
  const panel = snapshot.panels?.[selected] ?? panelUnavailable("PANEL_MISSING", "panel not found");
  lines.push(`[${PANEL_LABEL[selected]}] ok=${panel.ok === true ? "true" : "false"} reason=${panel.reasonCode ?? "none"}`);
  if (panel.message) lines.push(`message: ${panel.message}`);
  lines.push(renderPanelValue(panel.data));
  lines.push("");
  lines.push("Keys: 1..5 switch panels, q quit");
  return `${lines.join("\n")}\n`;
}

async function runInteractive(args, snapshot) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("interactive TUI requires a TTY; use --json or --non-interactive", {
      code: "TUI_REQUIRES_TTY",
      statusCode: 1
    });
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  let selectedPanel = "identity";

  const paint = () => {
    process.stdout.write("\x1Bc");
    process.stdout.write(renderSnapshotText(snapshot, selectedPanel));
  };

  paint();

  await new Promise((resolve) => {
    const onKeypress = (str, key) => {
      const name = String(key?.name ?? str ?? "").toLowerCase();
      if (name === "q" || name === "escape" || (name === "c" && key?.ctrl)) {
        process.stdin.off("keypress", onKeypress);
        resolve();
        return;
      }
      if (/^[1-5]$/.test(name)) {
        const idx = Number(name) - 1;
        selectedPanel = PANEL_ORDER[idx] ?? selectedPanel;
        paint();
      }
    };
    process.stdin.on("keypress", onKeypress);
  });

  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.pause();
}

async function main() {
  let args = null;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      usage();
      process.exit(0);
      return;
    }

    const snapshot = await collectPanels(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      process.exit(snapshot.ok ? 0 : 1);
      return;
    }

    if (args.nonInteractive) {
      process.stdout.write(renderSnapshotText(snapshot, PANEL_ORDER[0]));
      process.exit(snapshot.ok ? 0 : 1);
      return;
    }

    await runInteractive(args, snapshot);
    process.exit(0);
  } catch (err) {
    const code = String(err?.code ?? "TUI_ERROR");
    const statusCode = Number.isInteger(err?.statusCode) ? Number(err.statusCode) : 1;
    process.stderr.write(`${code}: ${err?.message ?? String(err ?? "tui failed")}\n`);
    process.exit(statusCode);
  }
}

await main();
