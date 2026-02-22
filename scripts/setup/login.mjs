#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { cookieHeaderFromSetCookie, defaultSessionPath, writeSavedSession } from "./session-store.mjs";

const FORMAT_OPTIONS = new Set(["text", "json"]);

function usage() {
  const text = [
    "usage:",
    "  settld login [flags]",
    "  node scripts/setup/login.mjs [flags]",
    "",
    "flags:",
    "  --base-url <url>                Settld onboarding base URL (default: https://api.settld.work)",
    "  --tenant-id <id>                Existing tenant ID (omit to create via public signup)",
    "  --email <email>                 Login email",
    "  --company <name>                Company name (required when --tenant-id omitted)",
    "  --otp <code>                    OTP code (otherwise prompted)",
    "  --non-interactive               Disable prompts; require explicit flags",
    "  --session-file <path>           Session output path (default: ~/.settld/session.json)",
    "  --format <text|json>            Output format (default: text)",
    "  --help                          Show this help"
  ].join("\n");
  process.stderr.write(`${text}\n`);
}

function readArgValue(argv, index, rawArg) {
  const arg = String(rawArg ?? "");
  const eq = arg.indexOf("=");
  if (eq >= 0) return { value: arg.slice(eq + 1), nextIndex: index };
  return { value: String(argv[index + 1] ?? ""), nextIndex: index + 1 };
}

function parseArgs(argv) {
  const out = {
    baseUrl: "https://api.settld.work",
    tenantId: "",
    email: "",
    company: "",
    otp: "",
    nonInteractive: false,
    sessionFile: defaultSessionPath(),
    format: "text",
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--non-interactive" || arg === "--yes") {
      out.nonInteractive = true;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const parsed = readArgValue(argv, i, arg);
      out.baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const parsed = readArgValue(argv, i, arg);
      out.tenantId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--email" || arg.startsWith("--email=")) {
      const parsed = readArgValue(argv, i, arg);
      out.email = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--company" || arg.startsWith("--company=")) {
      const parsed = readArgValue(argv, i, arg);
      out.company = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--otp" || arg.startsWith("--otp=")) {
      const parsed = readArgValue(argv, i, arg);
      out.otp = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--session-file" || arg.startsWith("--session-file=")) {
      const parsed = readArgValue(argv, i, arg);
      out.sessionFile = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--format" || arg.startsWith("--format=")) {
      const parsed = readArgValue(argv, i, arg);
      out.format = String(parsed.value ?? "").trim().toLowerCase();
      i = parsed.nextIndex;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!FORMAT_OPTIONS.has(out.format)) throw new Error("--format must be text|json");
  out.baseUrl = String(out.baseUrl ?? "").trim().replace(/\/+$/, "");
  out.tenantId = String(out.tenantId ?? "").trim();
  out.email = String(out.email ?? "").trim().toLowerCase();
  out.company = String(out.company ?? "").trim();
  out.otp = String(out.otp ?? "").trim();
  out.sessionFile = path.resolve(process.cwd(), String(out.sessionFile ?? "").trim() || defaultSessionPath());
  return out;
}

function mustHttpUrl(value, label) {
  const raw = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http/https`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function requestJson(url, { method, body, headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function promptLine(rl, label, { defaultValue = "", required = true } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const value = String(await rl.question(`${label}${suffix}: `) ?? "").trim() || String(defaultValue ?? "").trim();
  if (value || !required) return value;
  throw new Error(`${label} is required`);
}

function printBanner(stdout = process.stdout) {
  stdout.write("Settld login\n");
  stdout.write("============\n");
  stdout.write("Sign in with OTP and save local session for one-command setup.\n\n");
}

export async function runLogin({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  fetchImpl = fetch,
  writeSavedSessionImpl = writeSavedSession
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return { ok: true, code: 0 };
  }

  const interactive = !args.nonInteractive;
  const state = {
    baseUrl: args.baseUrl,
    tenantId: args.tenantId,
    email: args.email,
    company: args.company,
    otp: args.otp,
    sessionFile: args.sessionFile,
    format: args.format
  };

  if (interactive) printBanner(stdout);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    if (interactive) {
      state.baseUrl = await promptLine(rl, "Settld base URL", { defaultValue: state.baseUrl || "https://api.settld.work" });
      state.tenantId = await promptLine(rl, "Tenant ID (optional for new signup)", { defaultValue: state.tenantId, required: false });
      state.email = (await promptLine(rl, "Email", { defaultValue: state.email })).toLowerCase();
      if (!state.tenantId) {
        state.company = await promptLine(rl, "Company name", { defaultValue: state.company });
      }
    }

    const baseUrl = mustHttpUrl(state.baseUrl, "base URL");
    if (!state.email) throw new Error("email is required");
    if (!state.tenantId && !state.company) throw new Error("company is required when tenant ID is omitted");

    let tenantId = state.tenantId;
    if (!tenantId) {
      const signup = await requestJson(`${baseUrl}/v1/public/signup`, {
        method: "POST",
        body: { email: state.email, company: state.company },
        fetchImpl
      });
      if (!signup.res.ok) {
        const code = typeof signup.json?.code === "string" ? signup.json.code : "";
        const message = typeof signup.json?.message === "string" ? signup.json.message : signup.text;
        if (code === "SIGNUP_DISABLED") {
          throw new Error("Public signup is disabled for this environment. Use an existing tenant ID or bootstrap key flow.");
        }
        throw new Error(`public signup failed (${signup.res.status}): ${message || "unknown error"}`);
      }
      tenantId = String(signup.json?.tenantId ?? "").trim();
      if (!tenantId) throw new Error("public signup response missing tenantId");
      if (interactive) stdout.write(`Created tenant: ${tenantId}\n`);
    } else {
      const otpRequest = await requestJson(`${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login/otp`, {
        method: "POST",
        body: { email: state.email },
        fetchImpl
      });
      if (!otpRequest.res.ok) {
        const message = typeof otpRequest.json?.message === "string" ? otpRequest.json.message : otpRequest.text;
        throw new Error(`otp request failed (${otpRequest.res.status}): ${message || "unknown error"}`);
      }
    }

    if (!state.otp && interactive) {
      state.otp = await promptLine(rl, "OTP code", { required: true });
    }
    if (!state.otp) throw new Error("otp code is required (pass --otp in non-interactive mode)");

    const login = await requestJson(`${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/buyer/login`, {
      method: "POST",
      body: { email: state.email, code: state.otp },
      fetchImpl
    });
    if (!login.res.ok) {
      const message = typeof login.json?.message === "string" ? login.json.message : login.text;
      throw new Error(`login failed (${login.res.status}): ${message || "unknown error"}`);
    }
    const setCookie = login.res.headers.get("set-cookie") ?? "";
    const cookie = cookieHeaderFromSetCookie(setCookie);
    if (!cookie) throw new Error("login response missing session cookie");

    const session = await writeSavedSessionImpl({
      sessionPath: state.sessionFile,
      session: {
        baseUrl,
        tenantId,
        email: state.email,
        cookie,
        expiresAt: typeof login.json?.expiresAt === "string" ? login.json.expiresAt : null
      }
    });

    const payload = {
      ok: true,
      schemaVersion: "SettldLoginResult.v1",
      baseUrl: session.baseUrl,
      tenantId: session.tenantId,
      email: session.email,
      sessionFile: state.sessionFile,
      expiresAt: session.expiresAt ?? null
    };

    if (state.format === "json") {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(`Login saved.\n`);
      stdout.write(`Tenant: ${session.tenantId}\n`);
      stdout.write(`Session file: ${state.sessionFile}\n`);
      stdout.write(`Next: run \`settld setup\`.\n`);
    }
    return payload;
  } finally {
    if (rl) rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    await runLogin({ argv });
  } catch (err) {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
