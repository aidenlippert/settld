import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

async function listenServer(server, { host = "127.0.0.1" } = {}) {
  await new Promise((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected server address");
  return { host, port: addr.port, url: `http://${host}:${addr.port}` };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function runNode(args, { env = {} } = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

function parseSingleJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("expected json output");
  return JSON.parse(text);
}

test("provider:publish emits machine-readable failure and writes publication/conformance artifacts", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-provider-publish-cli-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const publicationOutPath = path.join(tempDir, "publication.json");
  const conformanceOutPath = path.join(tempDir, "publication.conformance.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: "PaidToolManifest.v1",
        providerId: "prov_cli_failure",
        upstreamBaseUrl: "https://provider.example",
        defaults: {
          currency: "USD",
          amountCents: 500,
          idempotency: "idempotent",
          signatureMode: "required"
        },
        tools: [
          {
            toolId: "bridge.search",
            mcpToolName: "bridge.search",
            description: "search",
            method: "GET",
            upstreamPath: "/search",
            paidPath: "/tool/search",
            pricing: { amountCents: 500, currency: "USD" },
            auth: { mode: "none" }
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/marketplace/providers/publish") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      assert.equal(parsed.providerId, null);
      assert.equal(parsed.baseUrl, "http://127.0.0.1:9402");
      res.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          publication: {
            schemaVersion: "MarketplaceProviderPublication.v1",
            publicationId: "pub_cli_1",
            providerId: "prov_cli_failure",
            status: "conformance_failed",
            certified: false,
            manifestHash: "a".repeat(64),
            conformanceReport: {
              schemaVersion: "ProviderConformanceReport.v1",
              verdict: { ok: false, requiredChecks: 12, passedChecks: 5 }
            }
          }
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const addr = await listenServer(server);
  t.after(async () => {
    await closeServer(server);
  });

  const run = await runNode([
    "scripts/provider/publish.mjs",
    "--manifest",
    manifestPath,
    "--base-url",
    "http://127.0.0.1:9402",
    "--api-url",
    addr.url,
    "--api-key",
    "sk_test_cli",
    "--json-out",
    publicationOutPath
  ]);
  assert.equal(run.code, 1, run.stderr || run.stdout);
  const output = parseSingleJson(run.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.code, "PROVIDER_PUBLISH_CONFORMANCE_FAILED");
  assert.equal(output.providerId, "prov_cli_failure");
  assert.equal(output.status, "conformance_failed");
  assert.equal(output.certified, false);

  const publicationRaw = await fs.readFile(publicationOutPath, "utf8");
  const publication = JSON.parse(publicationRaw);
  assert.equal(publication.providerId, "prov_cli_failure");
  assert.equal(publication.status, "conformance_failed");
  assert.equal(publication.certified, false);
  assert.equal(publication.publicationId, "pub_cli_1");
  assert.equal(publication.manifestHash, "a".repeat(64));

  const conformanceRaw = await fs.readFile(conformanceOutPath, "utf8");
  const conformance = JSON.parse(conformanceRaw);
  assert.equal(conformance.verdict?.ok, false);
  assert.equal(conformance.verdict?.requiredChecks, 12);
  assert.equal(conformance.verdict?.passedChecks, 5);
});

test("provider:conformance emits machine-readable failure and exits non-zero by default", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "settld-provider-conformance-cli-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const reportOutPath = path.join(tempDir, "conformance.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: "PaidToolManifest.v1",
        providerId: "prov_cli_conf",
        upstreamBaseUrl: "https://provider.example",
        defaults: {
          currency: "USD",
          amountCents: 500,
          idempotency: "idempotent",
          signatureMode: "required"
        },
        tools: [
          {
            toolId: "bridge.search",
            mcpToolName: "bridge.search",
            description: "search",
            method: "GET",
            upstreamPath: "/search",
            paidPath: "/tool/search",
            pricing: { amountCents: 500, currency: "USD" },
            auth: { mode: "none" }
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/marketplace/providers/conformance/run") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          report: {
            schemaVersion: "ProviderConformanceReport.v1",
            providerId: "prov_cli_conf",
            tool: { toolId: "bridge.search" },
            verdict: { ok: false, requiredChecks: 8, passedChecks: 6 }
          }
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const addr = await listenServer(server);
  t.after(async () => {
    await closeServer(server);
  });

  const run = await runNode([
    "scripts/provider/conformance-run.mjs",
    "--manifest",
    manifestPath,
    "--base-url",
    "http://127.0.0.1:9402",
    "--api-url",
    addr.url,
    "--api-key",
    "sk_test_cli",
    "--json-out",
    reportOutPath
  ]);
  assert.equal(run.code, 1, run.stderr || run.stdout);
  const output = parseSingleJson(run.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.code, "PROVIDER_CONFORMANCE_FAILED");
  assert.equal(output.providerId, "prov_cli_conf");
  assert.equal(output.toolId, "bridge.search");

  const reportRaw = await fs.readFile(reportOutPath, "utf8");
  const report = JSON.parse(reportRaw);
  assert.equal(report.verdict?.ok, false);
  assert.equal(report.verdict?.requiredChecks, 8);
});
