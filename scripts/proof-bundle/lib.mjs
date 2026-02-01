import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFilesToDir({ files, outDir }) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map");
  if (!outDir) throw new TypeError("outDir is required");
  ensureDir(outDir);

  for (const [name, bytes] of files.entries()) {
    const full = path.join(outDir, name);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, Buffer.from(bytes));
  }
}

export async function writeZipFromDir({ dir, outPath, mtime = new Date("2000-01-01T00:00:00.000Z") } = {}) {
  if (!dir) throw new Error("dir is required");
  if (!outPath) throw new Error("outPath is required");

  // Avoid npm dependencies: use Python's stdlib zipfile for deterministic zips.
  // We set a constant timestamp for all entries to keep bytes stable across reruns.
  const mtimeUtc = new Date(mtime);
  if (!Number.isFinite(mtimeUtc.getTime())) throw new Error("mtime must be a valid Date");
  const dt = [
    mtimeUtc.getUTCFullYear(),
    mtimeUtc.getUTCMonth() + 1,
    mtimeUtc.getUTCDate(),
    mtimeUtc.getUTCHours(),
    mtimeUtc.getUTCMinutes(),
    mtimeUtc.getUTCSeconds()
  ];

  const compression = arguments[0]?.compression ?? "deflated";
  const compressionMode = String(compression).toLowerCase();
  if (compressionMode !== "deflated" && compressionMode !== "stored") {
    throw new Error('compression must be "deflated" or "stored"');
  }
  const zipCompression = compressionMode === "stored" ? "ZIP_STORED" : "ZIP_DEFLATED";

  const pyCode = `
import os, sys, zipfile

src = sys.argv[1]
out = sys.argv[2]
dt = tuple(int(x) for x in sys.argv[3].split(","))
mode = sys.argv[4]
compression = zipfile.ZIP_STORED if mode == "ZIP_STORED" else zipfile.ZIP_DEFLATED

files = []
for root, dirs, filenames in os.walk(src):
    dirs.sort()
    for fn in sorted(filenames):
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, src).replace(os.sep, "/")
        files.append((full, rel))

zf = zipfile.ZipFile(out, "w", compression=compression)
try:
    for full, rel in files:
        zi = zipfile.ZipInfo(rel, date_time=dt)
        zi.compress_type = compression
        with open(full, "rb") as f:
            zf.writestr(zi, f.read())
finally:
    zf.close()
  `.trim();

  const py = spawn(
    "python3",
    [
      "-c",
      pyCode,
      dir,
      outPath,
      dt.join(","),
      zipCompression
    ],
    { stdio: "inherit" }
  );

  await new Promise((resolve, reject) => {
    py.on("error", reject);
    py.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`python3 zip failed with exit code ${code}`))));
  });
}
