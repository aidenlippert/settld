import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function readVersionForIndex() {
  const v = process.env.SETTLD_VERSION ?? null;
  return typeof v === "string" && v.trim() ? v.trim() : "0.0.0-local";
}

function sh(cmd, args, { cwd, env } = {}) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})${err ? `: ${err}` : ""}`);
  }
  return res.stdout;
}

async function sha256FileHex(fp) {
  const h = crypto.createHash("sha256");
  const f = await fs.open(fp, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await f.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await f.close();
  }
  return h.digest("hex");
}

async function writeSha256File({ outPath, files }) {
  const lines = [];
  for (const fp of files) {
    // eslint-disable-next-line no-await-in-loop
    const sum = await sha256FileHex(fp);
    lines.push(`${sum}  ${path.basename(fp)}`);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
}

function parseArgs(argv) {
  let outDir = path.resolve(process.cwd(), "dist", "release-artifacts");
  let signReleaseIndex = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") {
      outDir = path.resolve(process.cwd(), String(argv[i + 1] ?? ""));
      i += 1;
      continue;
    }
    if (a === "--sign-release-index") {
      signReleaseIndex = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.error("usage: node scripts/release/build-artifacts.mjs [--out <dir>] [--sign-release-index]");
      process.exit(2);
    }
    // eslint-disable-next-line no-console
    console.error(`unknown arg: ${a}`);
    process.exit(2);
  }
  return { outDir, signReleaseIndex };
}

async function main() {
  const { outDir, signReleaseIndex } = parseArgs(process.argv.slice(2));
  await fs.mkdir(outDir, { recursive: true });

  sh("npm", ["test"]);
  sh(process.execPath, ["scripts/ci/npm-pack-smoke.mjs"]);
  sh(process.execPath, ["scripts/ci/cli-pack-smoke.mjs"]);

  const npmPackages = [".", "packages/api-sdk", "packages/executor-sdk", "packages/artifact-verify"];
  const npmTgzs = [];
  for (const p of npmPackages) {
    // eslint-disable-next-line no-await-in-loop
    const name = sh("npm", ["pack", "--silent", "--pack-destination", outDir], { cwd: path.resolve(process.cwd(), p) }).trim().split("\n").at(-1);
    if (!name) throw new Error(`npm pack did not output tarball for ${p}`);
    npmTgzs.push(path.join(outDir, name));
  }
  const npmChecksumsPath = path.join(outDir, "npm-SHA256SUMS");
  await writeSha256File({ outPath: npmChecksumsPath, files: npmTgzs });

  // Python SDK artifacts (sdist + wheel).
  const sourceDateEpoch = String(Math.floor(Date.parse("2026-02-02T00:00:00Z") / 1000));
  sh("python3", ["-m", "build", "packages/api-sdk-python", "--sdist", "--wheel", "--outdir", outDir], {
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: sourceDateEpoch,
      PYTHONDONTWRITEBYTECODE: "1"
    }
  });
  const outNames = await fs.readdir(outDir);
  const pythonArtifacts = outNames
    .filter((name) => /^settld_api_sdk_python-.*\.(whl|tar\.gz)$/.test(name))
    .sort()
    .map((name) => path.join(outDir, name));
  const hasWheel = pythonArtifacts.some((fp) => fp.endsWith(".whl"));
  const hasSdist = pythonArtifacts.some((fp) => fp.endsWith(".tar.gz"));
  if (!hasWheel || !hasSdist) {
    throw new Error("python build did not produce both wheel and sdist for packages/api-sdk-python");
  }
  const pythonChecksumsPath = path.join(outDir, "python-SHA256SUMS");
  await writeSha256File({ outPath: pythonChecksumsPath, files: pythonArtifacts });

  // Conformance pack (deterministic tar.gz)
  const conformanceDir = path.join(outDir, "conformance-v1");
  const conformanceTar = path.join(outDir, "conformance-v1.tar");
  const conformanceTgz = path.join(outDir, "conformance-v1.tar.gz");
  await fs.rm(conformanceDir, { recursive: true, force: true });
  await fs.rm(conformanceTar, { force: true });
  await fs.rm(conformanceTgz, { force: true });
  await fs.cp(path.join(process.cwd(), "conformance", "v1"), conformanceDir, { recursive: true });
  sh("tar", ["--sort=name", "--mtime=2026-02-02 00:00:00Z", "--owner=0", "--group=0", "--numeric-owner", "-cf", conformanceTar, "-C", outDir, "conformance-v1"]);
  const gz = spawnSync("gzip", ["-n", "-9", "-c", conformanceTar]);
  if (gz.status !== 0) throw new Error("gzip failed");
  await fs.writeFile(conformanceTgz, gz.stdout);
  await fs.rm(conformanceTar, { force: true });
  await fs.rm(conformanceDir, { recursive: true, force: true });
  const conformanceChecksumsPath = path.join(outDir, "conformance-v1-SHA256SUMS");
  await writeSha256File({ outPath: conformanceChecksumsPath, files: [conformanceTgz] });

  // Audit packet zip (deterministic)
  sh(process.execPath, ["scripts/audit/build-audit-packet.mjs", "--out", outDir, "--packet-version", "v1"]);
  const auditZip = path.join(outDir, "settld-audit-packet-v1.zip");
  await fs.access(auditZip);
  const auditChecksumsPath = path.join(outDir, "settld-audit-packet-v1.zip.sha256");
  await writeSha256File({ outPath: auditChecksumsPath, files: [auditZip] });

  const allArtifactsForGlobalChecksums = [
    ...npmTgzs,
    npmChecksumsPath,
    ...pythonArtifacts,
    pythonChecksumsPath,
    conformanceTgz,
    conformanceChecksumsPath,
    auditZip,
    auditChecksumsPath
  ].sort();
  await writeSha256File({
    outPath: path.join(outDir, "SHA256SUMS"),
    files: allArtifactsForGlobalChecksums
  });

  // ReleaseIndex.v1 is a signed release manifest (artifact authenticity surface).
  const version = readVersionForIndex();
  const tag = `v${version}`;
  sh(process.execPath, ["scripts/release/generate-release-index.mjs", "--dir", outDir, "--tag", tag, "--version", version]);
  if (signReleaseIndex) {
    if (!String(process.env.SETTLD_RELEASE_SIGNING_PRIVATE_KEY_PEM ?? "").trim()) {
      throw new Error("missing SETTLD_RELEASE_SIGNING_PRIVATE_KEY_PEM; required for --sign-release-index");
    }
    sh(process.execPath, [
      "scripts/release/sign-release-index.mjs",
      "--index",
      path.join(outDir, "release_index_v1.json"),
      "--out",
      path.join(outDir, "release_index_v1.sig"),
      "--private-key-env",
      "SETTLD_RELEASE_SIGNING_PRIVATE_KEY_PEM"
    ]);
  }
}

await main();
