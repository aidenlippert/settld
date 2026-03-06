import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export function moduleDir(moduleName) {
  return path.join(repoRoot, 'src', 'agentverse', moduleName);
}

export async function assertModuleDirectoryExists(moduleName) {
  const dir = moduleDir(moduleName);
  await access(dir);
  return dir;
}

async function collectJavaScriptFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  const files = [];

  for (const entry of sorted) {
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(fullPath, relativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(relativePath.split(path.sep).join('/'));
    }
  }

  return files;
}

export async function listModuleJavaScriptFiles(moduleName) {
  const dir = await assertModuleDirectoryExists(moduleName);
  return collectJavaScriptFiles(dir);
}

export async function assertModulePlaceholder(moduleName) {
  const files = await listModuleJavaScriptFiles(moduleName);
  assert.deepEqual(
    files,
    [],
    `expected ${moduleName} module placeholder (no JavaScript files), found: ${files.join(', ')}`
  );
}

export async function assertModuleImplemented(moduleName, requiredFiles = []) {
  const files = await listModuleJavaScriptFiles(moduleName);
  assert.ok(files.length > 0, `expected ${moduleName} module implementation files`);

  for (const requiredFile of requiredFiles) {
    assert.ok(files.includes(requiredFile), `expected ${moduleName} module to include ${requiredFile}; found: ${files.join(', ')}`);
  }

  return files;
}
