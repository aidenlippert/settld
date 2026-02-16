import fs from "node:fs";
import path from "node:path";

export function usage() {
  return [
    "Usage:",
    "  create-settld-paid-tool [directory] [--force] [--provider-id <id>]",
    "",
    "Options:",
    "  --force               Allow scaffolding into an existing non-empty directory",
    "  --provider-id <id>    Provider id used in the generated template (default: prov_paid_tool_demo)",
    "  --help                Show this help"
  ].join("\n");
}

export function parseArgs(argv) {
  const out = {
    directory: null,
    force: false,
    providerId: "prov_paid_tool_demo",
    help: false
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--provider-id") {
      const value = String(argv[i + 1] ?? "").trim();
      if (!value) throw new Error("--provider-id requires a value");
      out.providerId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 1) throw new Error("only one target directory may be provided");
  out.directory = positional[0] ?? "settld-paid-tool";
  return out;
}

function ensureScaffoldTarget(targetDir, { force }) {
  const exists = fs.existsSync(targetDir);
  if (!exists) {
    fs.mkdirSync(targetDir, { recursive: true });
    return;
  }
  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) throw new Error(`target path exists and is not a directory: ${targetDir}`);
  const entries = fs.readdirSync(targetDir);
  if (entries.length > 0 && !force) {
    throw new Error(`target directory is not empty: ${targetDir} (pass --force to continue)`);
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content.replace(/\s+$/u, "")}\n`, "utf8");
}

function buildTemplate({ providerId }) {
  const packageJson = {
    name: "settld-paid-tool",
    version: "0.0.0",
    private: true,
    type: "module",
    engines: {
      node: ">=20"
    },
    scripts: {
      start: "node server.mjs"
    },
    dependencies: {
      "@settld/provider-kit": "latest"
    }
  };

  const envExample = [
    "PORT=9402",
    `SETTLD_PROVIDER_ID=${providerId}`,
    "SETTLD_PRICE_AMOUNT_CENTS=500",
    "SETTLD_PRICE_CURRENCY=USD",
    "SETTLD_PAYMENT_ADDRESS=mock:payee",
    "SETTLD_PAYMENT_NETWORK=mocknet",
    "SETTLD_PAY_KEYSET_URL=http://127.0.0.1:3000/.well-known/settld-keys.json",
    "PROVIDER_PUBLIC_KEY_PEM_FILE=./provider-public.pem",
    "PROVIDER_PRIVATE_KEY_PEM_FILE=./provider-private.pem",
    "",
    "# Optional inline alternatives:",
    "# PROVIDER_PUBLIC_KEY_PEM='-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----'",
    "# PROVIDER_PRIVATE_KEY_PEM='-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----'"
  ].join("\n");

  const server = `import fs from "node:fs";
import http from "node:http";

import { createSettldPaidNodeHttpHandler } from "@settld/provider-kit";

function readPem({ inlineName, fileName }) {
  const inlineRaw = process.env[inlineName];
  if (typeof inlineRaw === "string" && inlineRaw.trim() !== "") {
    return inlineRaw.replaceAll("\\\\n", "\\n");
  }
  const fileRaw = process.env[fileName];
  if (typeof fileRaw === "string" && fileRaw.trim() !== "") {
    return fs.readFileSync(fileRaw.trim(), "utf8");
  }
  throw new Error(\`Missing \${inlineName} or \${fileName}\`);
}

const PORT = Number(process.env.PORT ?? 9402);
if (!Number.isSafeInteger(PORT) || PORT <= 0) throw new Error("PORT must be a positive integer");

const providerId = typeof process.env.SETTLD_PROVIDER_ID === "string" && process.env.SETTLD_PROVIDER_ID.trim() !== ""
  ? process.env.SETTLD_PROVIDER_ID.trim()
  : "${providerId}";
const amountCents = Number(process.env.SETTLD_PRICE_AMOUNT_CENTS ?? 500);
if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("SETTLD_PRICE_AMOUNT_CENTS must be positive");
const currency = typeof process.env.SETTLD_PRICE_CURRENCY === "string" && process.env.SETTLD_PRICE_CURRENCY.trim() !== ""
  ? process.env.SETTLD_PRICE_CURRENCY.trim().toUpperCase()
  : "USD";

const providerPublicKeyPem = readPem({ inlineName: "PROVIDER_PUBLIC_KEY_PEM", fileName: "PROVIDER_PUBLIC_KEY_PEM_FILE" });
const providerPrivateKeyPem = readPem({ inlineName: "PROVIDER_PRIVATE_KEY_PEM", fileName: "PROVIDER_PRIVATE_KEY_PEM_FILE" });

const paidHandler = createSettldPaidNodeHttpHandler({
  providerId,
  providerPublicKeyPem,
  providerPrivateKeyPem,
  paymentAddress: process.env.SETTLD_PAYMENT_ADDRESS ?? "mock:payee",
  paymentNetwork: process.env.SETTLD_PAYMENT_NETWORK ?? "mocknet",
  priceFor: ({ req, url }) => ({
    amountCents,
    currency,
    providerId,
    toolId: \`\${String(req.method ?? "GET").toUpperCase()}:\${String(url.pathname ?? "/")}\`
  }),
  settldPay: {
    keysetUrl: process.env.SETTLD_PAY_KEYSET_URL ?? "http://127.0.0.1:3000/.well-known/settld-keys.json"
  },
  execute: async ({ url }) => ({
    body: {
      ok: true,
      providerId,
      query: url.searchParams.get("q") ?? "",
      timestamp: new Date().toISOString()
    }
  })
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/tool/search") {
    paidHandler(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "provider_error", message: err?.message ?? String(err ?? "") }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ ok: true, service: "settld-paid-tool", port: PORT, providerId }));
});
`;

  const readme = `# Settld Paid Tool Template

This project was generated by \`create-settld-paid-tool\`.

## Run

1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`
2. Configure environment:
   \`\`\`bash
   cp .env.example .env
   # set PROVIDER_PUBLIC_KEY_PEM_FILE / PROVIDER_PRIVATE_KEY_PEM_FILE
   \`\`\`
3. Start server:
   \`\`\`bash
   npm start
   \`\`\`

## Behavior

- \`GET /tool/search?q=...\` returns \`402\` until a valid \`Authorization: SettldPay <token>\` is provided.
- On paid requests, the server verifies SettldPay offline and returns provider signature headers:
  - \`x-settld-provider-key-id\`
  - \`x-settld-provider-signature\`
  - \`x-settld-provider-response-sha256\`

## Provider Id

Generated with provider id: \`${providerId}\`.

## Note

If \`@settld/provider-kit\` is not yet published to npm, replace it with your internal tarball or git source.
`;

  return {
    "package.json": JSON.stringify(packageJson, null, 2),
    ".env.example": envExample,
    "server.mjs": server,
    "README.md": readme
  };
}

export function scaffoldCreateSettldPaidTool({ directory, force = false, providerId = "prov_paid_tool_demo", cwd = process.cwd() } = {}) {
  const targetDir = path.resolve(cwd, directory);
  ensureScaffoldTarget(targetDir, { force });
  const files = buildTemplate({ providerId });
  for (const [relativePath, content] of Object.entries(files)) {
    writeText(path.join(targetDir, relativePath), content);
  }
  return { targetDir, providerId, filesWritten: Object.keys(files).length };
}

export function runCreateSettldPaidToolCli({ argv = process.argv.slice(2), cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err && typeof err === "object") err.showUsage = true;
    throw err;
  }
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { ok: true, help: true };
  }

  const result = scaffoldCreateSettldPaidTool({
    directory: args.directory,
    force: args.force,
    providerId: args.providerId,
    cwd
  });

  stdout.write(`created=${result.targetDir}\n`);
  stdout.write(`providerId=${result.providerId}\n`);
  stdout.write("next_steps:\n");
  stdout.write(`  cd ${result.targetDir}\n`);
  stdout.write("  npm install\n");
  stdout.write("  cp .env.example .env\n");
  stdout.write("  npm start\n");
  return { ok: true, ...result };
}
