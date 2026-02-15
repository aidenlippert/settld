import http from "node:http";
import { createApi } from "./app.js";
import { createStore } from "./store.js";
import { createPgStore } from "../db/store-pg.js";
import { logger } from "../core/log.js";
import { configForLog, loadConfig } from "../core/config.js";

const cfg = loadConfig({ mode: "api" });
logger.info("config.effective", { config: configForLog(cfg) });

let store;
if (cfg.store.mode === "pg") {
  store = await createPgStore({
    databaseUrl: cfg.store.databaseUrl,
    schema: cfg.store.pgSchema,
    migrateOnStartup: cfg.store.migrateOnStartup
  });
} else {
  store = cfg.store.persistenceDir ? createStore({ persistenceDir: cfg.store.persistenceDir }) : createStore();
}
const api = createApi({ store });
const { handle } = api;

const port = cfg.api.port;
const server = http.createServer(handle);
const bindHostRaw = typeof process !== "undefined" ? (process.env.PROXY_BIND_HOST ?? process.env.BIND_HOST ?? "") : "";
const bindHost = typeof bindHostRaw === "string" && bindHostRaw.trim() !== "" ? bindHostRaw.trim() : null;
if (bindHost) {
  server.listen(port, bindHost, () => {
    const storeDesc =
      cfg.store.mode === "pg" ? "(postgres)" : cfg.store.persistenceDir ? `(dataDir=${cfg.store.persistenceDir})` : "(in-memory)";
    logger.info("api listening", { port, host: bindHost, storeMode: cfg.store.mode, storeDesc });
  });
} else {
  server.listen(port, () => {
    const storeDesc =
      cfg.store.mode === "pg" ? "(postgres)" : cfg.store.persistenceDir ? `(dataDir=${cfg.store.persistenceDir})` : "(in-memory)";
    logger.info("api listening", { port, storeMode: cfg.store.mode, storeDesc });
  });
}

const autotickIntervalMs = cfg.api.autotick.intervalMs;
const autotickMaxMessages = cfg.api.autotick.maxMessages;
let autotickTimer = null;
let autotickStopped = false;
let autotickInFlight = false;
let autotickLastTickAt = null;
let autotickLastSuccessAt = null;

async function runAutotickOnce() {
  if (autotickStopped || autotickInFlight) return;
  autotickInFlight = true;
  autotickLastTickAt = new Date().toISOString();
  try {
    store.__autotickLastTickAt = autotickLastTickAt;
  } catch {}
  try {
    if (cfg.store.mode === "pg" && typeof store.processOutbox === "function") {
      await store.processOutbox({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickDispatch === "function") {
      await api.tickDispatch({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickProof === "function") {
      await api.tickProof({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickArtifacts === "function") {
      await api.tickArtifacts({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickDeliveries === "function") {
      await api.tickDeliveries({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickX402Holdbacks === "function") {
      await api.tickX402Holdbacks({ maxMessages: autotickMaxMessages });
    }
    if (typeof api.tickBillingStripeSync === "function") {
      await api.tickBillingStripeSync({ maxRows: autotickMaxMessages });
    }
    if (typeof api.tickFinanceReconciliation === "function") {
      await api.tickFinanceReconciliation({ maxTenants: autotickMaxMessages, maxPeriodsPerTenant: 1 });
    }
    autotickLastSuccessAt = new Date().toISOString();
    try {
      store.__autotickLastSuccessAt = autotickLastSuccessAt;
    } catch {}
  } catch (err) {
    logger.error("autotick failed", { err });
  } finally {
    autotickInFlight = false;
  }
}

if (autotickIntervalMs) {
  autotickTimer = setInterval(runAutotickOnce, autotickIntervalMs);
  runAutotickOnce();
}

async function shutdown() {
  autotickStopped = true;
  if (autotickTimer) {
    clearInterval(autotickTimer);
    autotickTimer = null;
  }
  try {
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await store?.close?.();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
