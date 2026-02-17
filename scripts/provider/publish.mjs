#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function usage() {
  return [
    "Usage:",
    "  node scripts/provider/publish.mjs --manifest <file> --base-url <providerBaseUrl> [options]",
    "",
    "Options:",
    "  --api-url <url>              Settld API base URL (default: SETTLD_API_URL or http://127.0.0.1:3000)",
    "  --api-key <token>            Settld API key (default: SETTLD_API_KEY)",
    "  --tenant-id <id>             Tenant id header (default: SETTLD_TENANT_ID or tenant_default)",
    "  --provider-id <providerId>   Override provider id (must match manifest.providerId)",
    "  --tool-id <toolId>           Conformance tool id override",
    "  --provider-key-file <path>   Provider signing public key PEM file",
    "  --provider-key-pem <pem>     Provider signing public key PEM inline",
    "  --description <text>         Provider description",
    "  --contact-url <url>          Provider contact/support URL",
    "  --terms-url <url>            Provider terms URL",
    "  --tags <a,b,c>               Comma-separated tags",
    "  --no-conformance             Publish as draft (skip conformance)",
    "  --allow-fail                 Exit 0 even when conformance fails",
    "  --json-out <file>            Write publication JSON to file",
    "  --conformance-json-out <file> Write conformance report JSON to file",
    "  --help                       Show this help"
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    apiUrl: process.env.SETTLD_API_URL || "http://127.0.0.1:3000",
    apiKey: process.env.SETTLD_API_KEY || null,
    tenantId: process.env.SETTLD_TENANT_ID || "tenant_default",
    manifestPath: null,
    baseUrl: null,
    providerId: null,
    toolId: null,
    providerKeyFile: null,
    providerKeyPem: null,
    description: null,
    contactUrl: null,
    termsUrl: null,
    tags: [],
    runConformance: true,
    allowFail: false,
    jsonOut: null,
    conformanceJsonOut: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--no-conformance") out.runConformance = false;
    else if (arg === "--allow-fail") out.allowFail = true;
    else if (arg === "--manifest") out.manifestPath = String(argv[++i] ?? "").trim();
    else if (arg === "--base-url") out.baseUrl = String(argv[++i] ?? "").trim();
    else if (arg === "--api-url") out.apiUrl = String(argv[++i] ?? "").trim();
    else if (arg === "--api-key") out.apiKey = String(argv[++i] ?? "").trim();
    else if (arg === "--tenant-id") out.tenantId = String(argv[++i] ?? "").trim();
    else if (arg === "--provider-id") out.providerId = String(argv[++i] ?? "").trim();
    else if (arg === "--tool-id") out.toolId = String(argv[++i] ?? "").trim();
    else if (arg === "--provider-key-file") out.providerKeyFile = String(argv[++i] ?? "").trim();
    else if (arg === "--provider-key-pem") out.providerKeyPem = String(argv[++i] ?? "").trim();
    else if (arg === "--description") out.description = String(argv[++i] ?? "").trim();
    else if (arg === "--contact-url") out.contactUrl = String(argv[++i] ?? "").trim();
    else if (arg === "--terms-url") out.termsUrl = String(argv[++i] ?? "").trim();
    else if (arg === "--tags") {
      out.tags = String(argv[++i] ?? "")
        .split(",")
        .map((row) => row.trim())
        .filter(Boolean);
    } else if (arg === "--json-out") out.jsonOut = String(argv[++i] ?? "").trim();
    else if (arg === "--conformance-json-out") out.conformanceJsonOut = String(argv[++i] ?? "").trim();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.help) {
    if (!out.manifestPath) throw new Error("--manifest is required");
    if (!out.baseUrl) throw new Error("--base-url is required");
  }
  return out;
}

function readJson(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw);
}

function resolveProviderKeyPem({ inlinePem, filePath }) {
  if (typeof inlinePem === "string" && inlinePem.trim() !== "") return inlinePem;
  if (typeof filePath === "string" && filePath.trim() !== "") {
    const resolved = path.resolve(process.cwd(), filePath);
    return fs.readFileSync(resolved, "utf8");
  }
  return null;
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultConformanceOutPath(publicationOutPath) {
  if (typeof publicationOutPath !== "string" || publicationOutPath.trim() === "") return null;
  const resolved = path.resolve(process.cwd(), publicationOutPath);
  if (resolved.endsWith(".json")) return resolved.slice(0, -".json".length) + ".conformance.json";
  return `${resolved}.conformance.json`;
}

function toPublicationSummary(publication) {
  return {
    providerId: publication?.providerId ?? null,
    status: publication?.status ?? null,
    certified: publication?.certified === true,
    publicationId: publication?.publicationId ?? null,
    manifestHash: publication?.manifestHash ?? null
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function makeCliError(code, message, details = null) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.apiKey) throw makeCliError("PROVIDER_PUBLISH_MISSING_API_KEY", "SETTLD_API_KEY or --api-key is required");

  const manifest = readJson(args.manifestPath);
  const providerSigningPublicKeyPem = resolveProviderKeyPem({ inlinePem: args.providerKeyPem, filePath: args.providerKeyFile });

  const response = await fetch(new URL("/marketplace/providers/publish", args.apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      "x-proxy-tenant-id": args.tenantId,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      providerId: args.providerId || null,
      baseUrl: args.baseUrl,
      toolId: args.toolId || null,
      providerSigningPublicKeyPem,
      runConformance: args.runConformance,
      description: args.description,
      contactUrl: args.contactUrl,
      termsUrl: args.termsUrl,
      tags: args.tags,
      manifest
    })
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw makeCliError("PROVIDER_PUBLISH_REQUEST_FAILED", "publish failed", {
      statusCode: response.status,
      response: json ?? text ?? null
    });
  }
  const publication = json?.publication ?? null;
  if (!publication || typeof publication !== "object") {
    throw makeCliError("PROVIDER_PUBLISH_INVALID_RESPONSE", "publish response missing publication");
  }

  if (args.jsonOut) {
    writeJsonFile(args.jsonOut, publication);
  }
  const conformanceReport = publication?.conformanceReport ?? null;
  const conformanceOutPath = args.conformanceJsonOut || defaultConformanceOutPath(args.jsonOut);
  if (conformanceOutPath && conformanceReport && typeof conformanceReport === "object" && !Array.isArray(conformanceReport)) {
    writeJsonFile(conformanceOutPath, conformanceReport);
  }

  const summary = {
    ...toPublicationSummary(publication),
    conformanceVerdict: conformanceReport?.verdict ?? null,
    publicationJsonOut: args.jsonOut ? path.resolve(process.cwd(), args.jsonOut) : null,
    conformanceJsonOut: conformanceOutPath ?? null
  };
  const conformanceFailed = args.runConformance !== false && publication.certified !== true;
  if (conformanceFailed) {
    const payload = {
      ok: false,
      code: "PROVIDER_PUBLISH_CONFORMANCE_FAILED",
      message: "provider publication is not certified",
      allowFailApplied: args.allowFail === true,
      ...summary
    };
    printJson(payload);
    if (!args.allowFail) process.exitCode = 1;
    return;
  }

  printJson({
    ok: true,
    ...summary
  });
}

main().catch((err) => {
  printJson({
    ok: false,
    code: typeof err?.code === "string" && err.code.trim() !== "" ? err.code : "PROVIDER_PUBLISH_CLI_ERROR",
    message: err?.message ?? String(err ?? ""),
    details: err?.details ?? null
  });
  process.exit(1);
});
