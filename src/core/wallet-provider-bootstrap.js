import crypto from "node:crypto";

const PROVIDERS = new Set(["circle"]);
const MODES = new Set(["auto", "sandbox", "production"]);

function mustString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function normalizeHttpUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeHex64(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new Error("entity secret must be a 64-char hex string");
  return raw;
}

async function callCircle({ baseUrl, apiKey, method, endpoint, body = null, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

function pickWalletRows(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const wallets =
    (Array.isArray(root?.data?.wallets) && root.data.wallets) ||
    (Array.isArray(root?.wallets) && root.wallets) ||
    [];
  return wallets.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

function pickWalletAddress(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const candidates = [root, root.wallet, root.data, root.data?.wallet];
  if (Array.isArray(root?.data?.wallets)) candidates.push(...root.data.wallets);
  for (const row of candidates) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (typeof row.address === "string" && row.address.trim()) return row.address.trim();
    if (typeof row.blockchainAddress === "string" && row.blockchainAddress.trim()) return row.blockchainAddress.trim();
  }
  return null;
}

function pickUsdcTokenId(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const balances =
    (Array.isArray(root?.data?.tokenBalances) && root.data.tokenBalances) ||
    (Array.isArray(root?.tokenBalances) && root.tokenBalances) ||
    [];
  for (const row of balances) {
    if (!row || typeof row !== "object") continue;
    const token = row.token && typeof row.token === "object" ? row.token : null;
    const symbol = String(token?.symbol ?? row.symbol ?? "").trim().toUpperCase();
    if (symbol !== "USDC") continue;
    const id = String(token?.id ?? row.tokenId ?? row.id ?? "").trim();
    if (id) return id;
  }
  return null;
}

function inferModeFromBaseUrl(baseUrl) {
  const u = normalizeHttpUrl(baseUrl);
  if (!u) return null;
  if (u.includes("api-sandbox.circle.com")) return "sandbox";
  return "production";
}

async function detectCircleBaseUrl({ apiKey, preferredMode = "auto", explicitBaseUrl = null, fetchImpl = fetch }) {
  const explicit = normalizeHttpUrl(explicitBaseUrl);
  if (explicit) {
    const check = await callCircle({
      baseUrl: explicit,
      apiKey,
      method: "GET",
      endpoint: "/v1/w3s/wallets",
      fetchImpl
    });
    if (check.status >= 200 && check.status < 300) {
      const explicitMode = preferredMode === "auto" ? inferModeFromBaseUrl(explicit) ?? "production" : preferredMode;
      return {
        baseUrl: explicit,
        mode: explicitMode,
        probeStatus: check.status
      };
    }
    throw new Error(`Circle API auth failed at ${explicit} (HTTP ${check.status})`);
  }

  const targets =
    preferredMode === "sandbox"
      ? [{ mode: "sandbox", baseUrl: "https://api-sandbox.circle.com" }]
      : preferredMode === "production"
        ? [{ mode: "production", baseUrl: "https://api.circle.com" }]
        : [
            { mode: "sandbox", baseUrl: "https://api-sandbox.circle.com" },
            { mode: "production", baseUrl: "https://api.circle.com" }
          ];

  const failures = [];
  for (const target of targets) {
    const probe = await callCircle({
      baseUrl: target.baseUrl,
      apiKey,
      method: "GET",
      endpoint: "/v1/w3s/wallets",
      fetchImpl
    });
    if (probe.status >= 200 && probe.status < 300) {
      return { ...target, probeStatus: probe.status };
    }
    failures.push(`${target.baseUrl}:HTTP${probe.status}`);
  }

  throw new Error(`Circle API auth failed for all endpoints (${failures.join(", ")})`);
}

function chooseWalletIds({ wallets, spendWalletId = null, escrowWalletId = null, blockchain = null }) {
  const normalizedSpend = String(spendWalletId ?? "").trim() || null;
  const normalizedEscrow = String(escrowWalletId ?? "").trim() || null;
  if (normalizedSpend && normalizedEscrow) return { spendWalletId: normalizedSpend, escrowWalletId: normalizedEscrow };

  const chain = String(blockchain ?? "").trim().toUpperCase();
  const candidates = wallets.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return false;
    if (!chain) return true;
    const rowChain = String(row.blockchain ?? "").trim().toUpperCase();
    return rowChain === chain;
  });

  if (candidates.length === 0) {
    throw new Error(`no wallets found for blockchain=${chain || "(any)"}; create wallets in Circle Console first`);
  }

  const spend = normalizedSpend || String(candidates[0].id).trim();
  const escrow = normalizedEscrow || String((candidates[1] ?? candidates[0]).id).trim();
  return { spendWalletId: spend, escrowWalletId: escrow };
}

async function resolveWalletMeta({ baseUrl, apiKey, walletId, fetchImpl = fetch }) {
  const out = await callCircle({
    baseUrl,
    apiKey,
    method: "GET",
    endpoint: `/v1/w3s/wallets/${encodeURIComponent(walletId)}`,
    fetchImpl
  });
  if (out.status < 200 || out.status >= 300) {
    throw new Error(`wallet lookup failed for ${walletId} (HTTP ${out.status})`);
  }
  const address = pickWalletAddress(out.json);
  if (!address) throw new Error(`wallet lookup for ${walletId} returned no address`);
  return { walletId, address };
}

async function resolveUsdcTokenId({ baseUrl, apiKey, walletIds, fetchImpl = fetch }) {
  for (const walletId of walletIds) {
    const out = await callCircle({
      baseUrl,
      apiKey,
      method: "GET",
      endpoint: `/v1/w3s/wallets/${encodeURIComponent(walletId)}/balances`,
      fetchImpl
    });
    if (out.status < 200 || out.status >= 300) continue;
    const tokenId = pickUsdcTokenId(out.json);
    if (tokenId) return tokenId;
  }
  return null;
}

async function requestFaucet({ baseUrl, apiKey, address, blockchain, native, usdc, fetchImpl = fetch }) {
  const out = await callCircle({
    baseUrl,
    apiKey,
    method: "POST",
    endpoint: "/v1/faucet/drips",
    body: {
      address,
      blockchain,
      native: Boolean(native),
      usdc: Boolean(usdc),
      eurc: false
    },
    fetchImpl
  });
  return {
    ok: out.status === 204 || out.status === 409 || out.status === 429 || out.status === 400,
    status: out.status,
    body: out.json ?? out.text ?? null
  };
}

export async function bootstrapCircleProvider({
  apiKey,
  mode = "auto",
  baseUrl = null,
  blockchain = null,
  spendWalletId = null,
  escrowWalletId = null,
  tokenIdUsdc = null,
  faucet = null,
  includeApiKey = false,
  entitySecretHex = null,
  fetchImpl = fetch
} = {}) {
  const normalizedMode = String(mode ?? "auto").trim().toLowerCase();
  if (!MODES.has(normalizedMode)) throw new Error("mode must be auto|sandbox|production");

  const circleApiKey = mustString(apiKey, "apiKey");
  const detected = await detectCircleBaseUrl({
    apiKey: circleApiKey,
    preferredMode: normalizedMode,
    explicitBaseUrl: baseUrl,
    fetchImpl
  });

  const resolvedBlockchain =
    String(blockchain ?? "").trim() ||
    (detected.mode === "production" ? "BASE" : "BASE-SEPOLIA");

  const walletsRes = await callCircle({
    baseUrl: detected.baseUrl,
    apiKey: circleApiKey,
    method: "GET",
    endpoint: "/v1/w3s/wallets",
    fetchImpl
  });
  if (walletsRes.status < 200 || walletsRes.status >= 300) {
    throw new Error(`wallet list failed (HTTP ${walletsRes.status})`);
  }
  const wallets = pickWalletRows(walletsRes.json);
  const chosen = chooseWalletIds({
    wallets,
    spendWalletId,
    escrowWalletId,
    blockchain: resolvedBlockchain
  });

  const [spendMeta, escrowMeta] = await Promise.all([
    resolveWalletMeta({ baseUrl: detected.baseUrl, apiKey: circleApiKey, walletId: chosen.spendWalletId, fetchImpl }),
    resolveWalletMeta({ baseUrl: detected.baseUrl, apiKey: circleApiKey, walletId: chosen.escrowWalletId, fetchImpl })
  ]);

  const resolvedTokenIdUsdc =
    String(tokenIdUsdc ?? "").trim() ||
    (await resolveUsdcTokenId({
      baseUrl: detected.baseUrl,
      apiKey: circleApiKey,
      walletIds: [chosen.spendWalletId, chosen.escrowWalletId],
      fetchImpl
    }));

  if (!resolvedTokenIdUsdc) {
    throw new Error("could not discover USDC token id; pass tokenIdUsdc explicitly");
  }

  const faucetEnabled =
    typeof faucet === "boolean"
      ? faucet
      : detected.mode === "sandbox";
  const faucetResults = [];
  if (faucetEnabled) {
    faucetResults.push(
      {
        wallet: "spend",
        ...(await requestFaucet({
          baseUrl: detected.baseUrl,
          apiKey: circleApiKey,
          address: spendMeta.address,
          blockchain: resolvedBlockchain,
          native: true,
          usdc: true,
          fetchImpl
        }))
      },
      {
        wallet: "escrow",
        ...(await requestFaucet({
          baseUrl: detected.baseUrl,
          apiKey: circleApiKey,
          address: escrowMeta.address,
          blockchain: resolvedBlockchain,
          native: true,
          usdc: true,
          fetchImpl
        }))
      }
    );
  }

  const resolvedEntitySecretHex = normalizeHex64(entitySecretHex) || crypto.randomBytes(32).toString("hex");

  const env = {
    CIRCLE_BASE_URL: detected.baseUrl,
    CIRCLE_BLOCKCHAIN: resolvedBlockchain,
    CIRCLE_WALLET_ID_SPEND: chosen.spendWalletId,
    CIRCLE_WALLET_ID_ESCROW: chosen.escrowWalletId,
    CIRCLE_TOKEN_ID_USDC: resolvedTokenIdUsdc,
    CIRCLE_ENTITY_SECRET_HEX: resolvedEntitySecretHex,
    X402_CIRCLE_RESERVE_MODE: detected.mode,
    X402_REQUIRE_EXTERNAL_RESERVE: "1"
  };
  if (includeApiKey) env.CIRCLE_API_KEY = circleApiKey;

  return {
    provider: "circle",
    mode: detected.mode,
    baseUrl: detected.baseUrl,
    blockchain: resolvedBlockchain,
    wallets: {
      spend: spendMeta,
      escrow: escrowMeta
    },
    tokenIdUsdc: resolvedTokenIdUsdc,
    entitySecretHex: resolvedEntitySecretHex,
    faucetEnabled,
    faucetResults,
    env
  };
}

export async function bootstrapWalletProvider({ provider = "circle", ...rest } = {}) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`unsupported provider: ${normalized || "(empty)"}`);
  }
  if (normalized === "circle") {
    return await bootstrapCircleProvider(rest);
  }
  throw new Error(`unsupported provider: ${normalized}`);
}

export function supportedWalletBootstrapProviders() {
  return [...PROVIDERS];
}
