#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_MODULES = Object.freeze([
  "src/api/app.js",
  "src/core/settlement-kernel.js",
  "src/core/settlement-verifier.js",
  "src/db/store-pg.js"
]);

function toAbsolute(modulePath) {
  return path.resolve(process.cwd(), modulePath);
}

function assertFileReadable(modulePath) {
  const absolute = toAbsolute(modulePath);
  try {
    fs.accessSync(absolute, fs.constants.R_OK);
  } catch (err) {
    const wrapped = new Error(`missing or unreadable module: ${modulePath}`);
    wrapped.cause = err;
    throw wrapped;
  }
  return absolute;
}

async function importModule(absolutePath) {
  const moduleUrl = pathToFileURL(absolutePath).toString();
  await import(moduleUrl);
}

async function main() {
  const imported = [];
  for (const modulePath of REQUIRED_MODULES) {
    const absolutePath = assertFileReadable(modulePath);
    await importModule(absolutePath);
    imported.push(modulePath);
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        imported
      },
      null,
      2
    ) + "\n"
  );
}

main().catch((err) => {
  const message = err?.stack ?? err?.message ?? String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
