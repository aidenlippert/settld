import { spawn } from "node:child_process";

function assertCmdExists(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ["version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReceiverReady({ baseUrl, timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    async function tick() {
      try {
        const res = await fetch(`${baseUrl}/health`);
        if (res.status === 200) return resolve();
      } catch {}
      if (Date.now() - started > timeoutMs) return reject(new Error("webhook receiver did not become ready"));
      setTimeout(tick, 250);
    }
    tick();
  });
}

async function main() {
  const ok = await assertCmdExists("k6");
  if (!ok) {
    process.stderr.write("k6 is required on PATH (https://k6.io/docs/get-started/installation/)\n");
    process.exit(2);
  }

  const receiverPort = process.env.RECEIVER_PORT ?? "4010";
  const receiverUrl = process.env.RECEIVER_URL ?? `http://127.0.0.1:${receiverPort}`;

  const receiver = spawn(process.execPath, ["scripts/load/webhook-receiver.js"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PORT: receiverPort }
  });

  try {
    await waitForReceiverReady({ baseUrl: receiverUrl, timeoutMs: 15_000 });

    // Give the API a moment to settle if it was just started.
    await sleep(250);

    const k6Args = ["run", "scripts/load/delivery-stress.k6.js"];
    const k6 = spawn("k6", k6Args, { stdio: "inherit", env: process.env });
    const exitCode = await new Promise((resolve) => k6.on("exit", (code) => resolve(code ?? 1)));
    process.exitCode = exitCode;
  } finally {
    try {
      receiver.kill("SIGTERM");
    } catch {}
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});

