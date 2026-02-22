#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SESSION_SCHEMA_VERSION = "SettldCliSession.v1";

function normalizeCookieHeader(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const firstSegment = raw.split(";")[0]?.trim() ?? "";
  if (!firstSegment) return null;
  const eq = firstSegment.indexOf("=");
  if (eq <= 0) return null;
  const name = firstSegment.slice(0, eq).trim();
  const token = firstSegment.slice(eq + 1).trim();
  if (!name || !token) return null;
  return `${name}=${token}`;
}

export function defaultSessionPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".settld", "session.json");
}

export function normalizeSession(input) {
  const row = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.trim().replace(/\/+$/, "") : "";
  const tenantId = typeof row.tenantId === "string" ? row.tenantId.trim() : "";
  const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
  const cookie = normalizeCookieHeader(row.cookie);
  if (!baseUrl || !tenantId || !cookie) return null;
  const out = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    savedAt: typeof row.savedAt === "string" && row.savedAt.trim() ? row.savedAt.trim() : new Date().toISOString(),
    baseUrl,
    tenantId,
    cookie,
    email: email || null
  };
  if (typeof row.expiresAt === "string" && row.expiresAt.trim()) out.expiresAt = row.expiresAt.trim();
  return out;
}

export async function readSavedSession({ sessionPath = defaultSessionPath() } = {}) {
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeSession(parsed);
  } catch {
    return null;
  }
}

export async function writeSavedSession({ session, sessionPath = defaultSessionPath() } = {}) {
  const normalized = normalizeSession(session);
  if (!normalized) throw new Error("invalid session payload");
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return normalized;
}

export function cookieHeaderFromSetCookie(value) {
  return normalizeCookieHeader(value);
}
