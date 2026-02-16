#!/usr/bin/env node

import { runCreateSettldPaidToolCli, usage } from "../src/lib.js";

try {
  runCreateSettldPaidToolCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr
  });
} catch (err) {
  process.stderr.write(`${err?.message ?? String(err ?? "")}\n`);
  if (err?.showUsage) {
    process.stderr.write("\n");
    process.stderr.write(`${usage()}\n`);
  }
  process.exitCode = 1;
}
