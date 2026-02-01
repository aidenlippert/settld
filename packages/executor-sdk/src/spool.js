import fs from "node:fs/promises";
import path from "node:path";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

async function atomicWriteJson(filePath, json) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(json, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export function createDiskSpool({ spoolDir }) {
  assertNonEmptyString(spoolDir, "spoolDir");

  const queuedDir = path.join(spoolDir, "queued");
  const inflightDir = path.join(spoolDir, "inflight");
  const failedDir = path.join(spoolDir, "failed");

  async function ensureDirs() {
    await fs.mkdir(queuedDir, { recursive: true });
    await fs.mkdir(inflightDir, { recursive: true });
    await fs.mkdir(failedDir, { recursive: true });
  }

  function fileNameFor(item) {
    const createdAtMs = Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Date.now();
    const safeStream = String(item.streamId ?? "stream").replaceAll("/", "_");
    const safeId = String(item.eventId ?? "evt").replaceAll("/", "_");
    return `${createdAtMs}_${safeStream}_${safeId}.json`;
  }

  async function enqueue(item) {
    await ensureDirs();
    const fileName = fileNameFor(item);
    const fp = path.join(queuedDir, fileName);
    await atomicWriteJson(fp, item);
    return { ...item, _file: fp };
  }

  async function listAll() {
    await ensureDirs();
    const readDir = async (dir, state) => {
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        names = [];
      }
      names.sort();
      const items = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const fp = path.join(dir, name);
        try {
          const raw = await fs.readFile(fp, "utf8");
          const parsed = JSON.parse(raw);
          items.push({ ...parsed, _file: fp, _state: state });
        } catch {
          // ignore
        }
      }
      return items;
    };

    const queued = await readDir(queuedDir, "queued");
    const inflight = await readDir(inflightDir, "inflight");
    const failed = await readDir(failedDir, "failed");
    return { queued, inflight, failed };
  }

  async function claim(item) {
    await ensureDirs();
    if (!item?._file) throw new TypeError("item._file is required");
    const base = path.basename(item._file);
    const dest = path.join(inflightDir, base);
    try {
      await fs.rename(item._file, dest);
    } catch {
      // Already moved by another process.
    }
    return { ...item, _file: dest, _state: "inflight" };
  }

  async function markDone(item) {
    if (!item?._file) return;
    try {
      await fs.unlink(item._file);
    } catch {
      // ignore
    }
  }

  async function markFailed(item, { error }) {
    await ensureDirs();
    if (!item?._file) throw new TypeError("item._file is required");
    const base = path.basename(item._file);
    const dest = path.join(failedDir, base);
    const { _file: _ignoreFile, _state: _ignoreState, ...persisted } = item;
    const next = { ...persisted, lastError: String(error ?? "failed"), failedAt: new Date().toISOString() };
    await atomicWriteJson(dest, next);
    try {
      await fs.unlink(item._file);
    } catch {
      // ignore
    }
    return { ...next, _file: dest, _state: "failed" };
  }

  async function update(item) {
    if (!item?._file) throw new TypeError("item._file is required");
    const { _file: _ignoreFile, _state: _ignoreState, ...persisted } = item;
    await atomicWriteJson(item._file, persisted);
  }

  return {
    kind: "disk",
    spoolDir,
    enqueue,
    listAll,
    claim,
    update,
    markDone,
    markFailed
  };
}
