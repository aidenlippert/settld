import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function sortDirents(a, b) {
  return a.name.localeCompare(b.name);
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(cur, relBase) {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    entries.sort(sortDirents);
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (e.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full, rel);
      } else if (e.isFile()) {
        out.push(rel.split(path.sep).join("/"));
      }
    }
  }
  await walk(dir, "");
  out.sort();
  return out;
}

async function assertSameFile(expectedPath, actualPath, label) {
  const [a, b] = await Promise.all([fs.readFile(expectedPath), fs.readFile(actualPath)]);
  if (Buffer.compare(a, b) !== 0) {
    assert.fail(
      `${label}: file contents differ: ${expectedPath} vs ${actualPath} (bytes ${a.length} vs ${b.length})`
    );
  }
}

test("bundle fixture generator output matches committed fixtures", async () => {
  const repoRoot = process.cwd();
  const committedRoot = path.resolve(repoRoot, "test", "fixtures", "bundles", "v1");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "settld-fixtures-"));

  try {
    const script = path.resolve(repoRoot, "scripts", "fixtures", "generate-bundle-fixtures.mjs");
    const proc = spawnSync(process.execPath, [script, "--out", tmpRoot], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr || proc.stdout || "fixture generator failed");

    const surfaces = ["jobproof", "monthproof", "financepack", "invoicebundle", "closepack", "trust.json"];
    for (const s of surfaces) {
      // eslint-disable-next-line no-await-in-loop
      const committed = path.join(committedRoot, s);
      // eslint-disable-next-line no-await-in-loop
      const generated = path.join(tmpRoot, s);

      // eslint-disable-next-line no-await-in-loop
      const [a, b] = await Promise.all([fs.stat(committed), fs.stat(generated)]);
      assert.equal(a.isDirectory(), b.isDirectory(), `surface type mismatch for ${s}`);

      if (a.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        await assertSameFile(committed, generated, s);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const committedFiles = await listFilesRecursive(committed);
      // eslint-disable-next-line no-await-in-loop
      const generatedFiles = await listFilesRecursive(generated);
      assert.deepEqual(committedFiles, generatedFiles, `file list mismatch under ${s}`);

      for (const rel of committedFiles) {
        const committedFile = path.join(committed, ...rel.split("/"));
        const generatedFile = path.join(generated, ...rel.split("/"));
        // eslint-disable-next-line no-await-in-loop
        await assertSameFile(committedFile, generatedFile, `${s}/${rel}`);
      }
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
