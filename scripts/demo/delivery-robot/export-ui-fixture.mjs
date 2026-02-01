import fs from "node:fs/promises";
import path from "node:path";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

async function listDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function latestFinancePackBundleZip() {
  const bundlesDir = path.resolve("demo/finance-pack/bundles");
  if (!(await exists(bundlesDir))) return null;
  const files = (await listFiles(bundlesDir)).filter((f) => f.endsWith(".zip")).sort();
  return files.length ? path.join(bundlesDir, files[files.length - 1]) : null;
}

async function exportHistory({ srcRoot, dstRoot, requiredFiles, limit }) {
  if (!(await exists(srcRoot))) return { copiedRuns: [], skipped: "missing_src_root" };

  const runDirs = (await listDirs(srcRoot))
    .filter((d) => d !== "latest")
    .sort()
    .slice(-limit);

  const copiedRuns = [];
  for (const runId of runDirs) {
    const srcDir = path.join(srcRoot, runId);
    const dstDir = path.join(dstRoot, runId);
    const copied = [];
    for (const f of requiredFiles) {
      const src = path.join(srcDir, f);
      if (!(await exists(src))) continue;
      await copyFile(src, path.join(dstDir, f));
      copied.push(f);
    }
    if (copied.length) copiedRuns.push({ runId, copied });
  }

  const index = { copiedRuns, latestRunId: copiedRuns.at(-1)?.runId ?? null };
  await fs.mkdir(dstRoot, { recursive: true });
  await fs.writeFile(path.join(dstRoot, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  return index;
}

async function main() {
  const deliverySrcDir = path.resolve("demo/delivery-robot/output/latest");
  const deliveryDstDirLegacy = path.resolve("dashboard/public/demo/latest");
  const deliveryDstDir = path.resolve("dashboard/public/demo/delivery/latest");
  const financeSrcDir = path.resolve("demo/finance-pack/output/latest");
  const financeDstDir = path.resolve("dashboard/public/demo/finance/latest");

  if (!(await exists(deliverySrcDir))) {
    throw new Error(`missing demo output: ${deliverySrcDir}. Run \`npm run demo:delivery\` first.`);
  }

  const files = [
    "run.json",
    "sample_ingest_request.json",
    "sample_ingest_response.json",
    "timeline.json",
    "WorkCertificate.v1.json",
    "SettlementStatement.v1.json",
    "CreditMemo.v1.json"
  ];

  const copiedDelivery = [];
  for (const f of files) {
    const src = path.join(deliverySrcDir, f);
    if (!(await exists(src))) continue;
    await copyFile(src, path.join(deliveryDstDirLegacy, f));
    await copyFile(src, path.join(deliveryDstDir, f));
    copiedDelivery.push(f);
  }

  await fs.writeFile(path.join(deliveryDstDirLegacy, "index.json"), JSON.stringify({ copied: copiedDelivery }, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(deliveryDstDir, "index.json"), JSON.stringify({ copied: copiedDelivery }, null, 2) + "\n", "utf8");

  // Delivery history (to support “fleet playback” demos).
  const deliveryHistory = await exportHistory({
    srcRoot: path.resolve("demo/delivery-robot/output"),
    dstRoot: path.resolve("dashboard/public/demo/delivery/history"),
    requiredFiles: ["run.json", "timeline.json", "WorkCertificate.v1.json", "SettlementStatement.v1.json", "CreditMemo.v1.json"],
    limit: 6
  });

  // Finance pack fixture (optional, but enables a “finance demo” button).
  const copiedFinance = [];
  let financeHistory = null;
  if (await exists(financeSrcDir)) {
    const financeFiles = [
      "run.json",
      "steps.json",
      "WorkCertificate.v1.json",
      "SettlementStatement.v1.json",
      "CreditMemo.v1.json",
      "GLBatch.v1.json",
      "GLBatch.v1.csv",
      "JournalCsv.v1.json",
      "JournalCsv.v1.csv",
      "JobProofBundle.v1.zip",
      "MonthProofBundle.v1.zip"
    ];

    for (const f of financeFiles) {
      const src = path.join(financeSrcDir, f);
      if (!(await exists(src))) continue;
      await copyFile(src, path.join(financeDstDir, f));
      copiedFinance.push(f);
    }

    const financePackZip = await latestFinancePackBundleZip();
    if (financePackZip) {
      await copyFile(financePackZip, path.join(financeDstDir, "FinancePackBundle.v1.zip"));
      copiedFinance.push("FinancePackBundle.v1.zip");

      // Best-effort: also copy reconcile.json from the unpacked bundle (if present).
      const unpackedDir = financePackZip.replace(/\.zip$/i, "");
      const reconcile = path.join(unpackedDir, "finance", "reconcile.json");
      if (await exists(reconcile)) {
        await copyFile(reconcile, path.join(financeDstDir, "reconcile.json"));
        copiedFinance.push("reconcile.json");
      }
    }

    await fs.writeFile(path.join(financeDstDir, "index.json"), JSON.stringify({ copied: copiedFinance }, null, 2) + "\n", "utf8");

    financeHistory = await exportHistory({
      srcRoot: path.resolve("demo/finance-pack/output"),
      dstRoot: path.resolve("dashboard/public/demo/finance/history"),
      requiredFiles: ["run.json", "steps.json", "WorkCertificate.v1.json", "SettlementStatement.v1.json", "GLBatch.v1.json", "JournalCsv.v1.csv"],
      limit: 4
    });
  }

  // Root index for UI scenario picker.
  const index = {
    generatedAt: new Date().toISOString(),
    history: {
      delivery: { runs: deliveryHistory?.copiedRuns?.length ?? 0, latestRunId: deliveryHistory?.latestRunId ?? null },
      finance: { runs: financeHistory?.copiedRuns?.length ?? 0, latestRunId: financeHistory?.latestRunId ?? null }
    },
    scenarios: [
      {
        id: "delivery",
        title: "SLA Credit (Delivery)",
        subtitle: "Facts in → breach → CreditMemo + SettlementStatement",
        emoji: "🚚"
      },
      {
        id: "finance",
        title: "Finance Pack (Month Close)",
        subtitle: "Statements → GLBatch + JournalCsv + bundles",
        emoji: "📚",
        available: copiedFinance.length > 0
      }
    ]
  };
  const rootIndexPath = path.resolve("dashboard/public/demo/index.json");
  await fs.mkdir(path.dirname(rootIndexPath), { recursive: true });
  await fs.writeFile(rootIndexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

  process.stdout.write(`Exported delivery fixture to dashboard/public/demo/delivery/latest (and legacy demo/latest)\n`);
  if (copiedFinance.length) process.stdout.write(`Exported finance fixture to dashboard/public/demo/finance/latest\n`);
  process.stdout.write(`Wrote dashboard/public/demo/index.json\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
