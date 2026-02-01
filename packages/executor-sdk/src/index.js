import { randomUUID } from "node:crypto";

import { canonicalJsonStringify } from "./canonical-json.js";
import { finalizeChainedEvent } from "./event-chain.js";
import { createDiskSpool } from "./spool.js";

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeBackoffMs({ attempts, baseMs, maxMs, random }) {
  const exp = Math.min(16, Math.max(0, attempts));
  const raw = Math.min(maxMs, baseMs * 2 ** exp);
  const jitter = 0.8 + random() * 0.4;
  return Math.max(baseMs, Math.floor(raw * jitter));
}

function normalizeBaseUrl(baseUrl) {
  assertNonEmptyString(baseUrl, "baseUrl");
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function streamKindPath(kind) {
  if (kind === "robot") return "robots";
  if (kind === "operator") return "operators";
  return "jobs";
}

export function createExecutorSdk({
  baseUrl,
  tenantId = "tenant_default",
  principalId = "anon",
  signer,
  apiKey = null,
  authorization = null,
  fetch: fetchImpl = globalThis.fetch,
  spoolDir = null,
  maxSendAttempts = 5,
  backoffBaseMs = 250,
  backoffMaxMs = 10_000,
  random = Math.random
} = {}) {
  const apiBase = normalizeBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("fetch must be a function");
  assertNonEmptyString(tenantId, "tenantId");
  assertNonEmptyString(principalId, "principalId");
  if (!signer || typeof signer !== "object") throw new TypeError("signer is required");
  assertNonEmptyString(signer.keyId, "signer.keyId");
  assertNonEmptyString(signer.privateKeyPem, "signer.privateKeyPem");
  if (apiKey !== null && apiKey !== undefined) assertNonEmptyString(apiKey, "apiKey");
  if (authorization !== null && authorization !== undefined) assertNonEmptyString(authorization, "authorization");
  if (!Number.isSafeInteger(maxSendAttempts) || maxSendAttempts <= 0) throw new TypeError("maxSendAttempts must be a positive integer");
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs <= 0) throw new TypeError("backoffBaseMs must be a positive integer");
  if (!Number.isSafeInteger(backoffMaxMs) || backoffMaxMs <= 0) throw new TypeError("backoffMaxMs must be a positive integer");
  if (typeof random !== "function") throw new TypeError("random must be a function");

  const spool = spoolDir ? createDiskSpool({ spoolDir }) : null;
  const authHeader =
    typeof authorization === "string" && authorization.trim()
      ? authorization.trim()
      : typeof apiKey === "string" && apiKey.trim()
        ? `Bearer ${apiKey.trim()}`
        : null;

  function withAuth(headers) {
    if (!authHeader) return headers;
    return { ...headers, authorization: authHeader };
  }

  async function fetchJson(path, init) {
    const url = `${apiBase}${path}`;
    const res = await fetchImpl(url, init);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, ok: res.ok, json };
  }

  async function getStreamHead({ streamKind, streamId }) {
    const collection = streamKindPath(streamKind);
    const r = await fetchJson(`/${collection}/${encodeURIComponent(streamId)}`, {
      method: "GET",
      headers: withAuth({
        "x-proxy-tenant-id": tenantId,
        "x-proxy-principal-id": principalId
      })
    });
    if (!r.ok) throw new Error(`failed to load ${streamKind} stream: ${r.status}`);
    const entity = r.json?.job ?? r.json?.robot ?? r.json?.operator ?? null;
    if (!entity) throw new Error(`malformed ${streamKind} response`);
    return entity.lastChainHash ?? null;
  }

  function computeIdempotencyKey({ mode, eventId, prevChainHash }) {
    const prev = typeof prevChainHash === "string" && prevChainHash.trim() ? prevChainHash.slice(0, 16) : "root";
    const m = mode === "server" ? "srv" : "cli";
    return `${m}:${eventId}:${prev}`;
  }

  function buildDraft({ streamId, type, actor, payload, at, eventId }) {
    assertNonEmptyString(streamId, "streamId");
    assertNonEmptyString(type, "type");
    if (!actor || typeof actor !== "object") throw new TypeError("actor is required");
    assertNonEmptyString(actor.type, "actor.type");
    assertNonEmptyString(actor.id, "actor.id");
    assertNonEmptyString(at, "at");
    assertNonEmptyString(eventId, "eventId");
    return {
      v: 1,
      id: eventId,
      at,
      streamId,
      type,
      actor,
      payload: payload ?? null,
      payloadHash: null,
      prevChainHash: null,
      chainHash: null,
      signature: null,
      signerKeyId: null
    };
  }

  async function sendFinalized({ streamKind, streamId, finalized, idempotencyKey }) {
    const collection = streamKindPath(streamKind);
    const body = { type: finalized.type, ...finalized };
    const r = await fetchJson(`/${collection}/${encodeURIComponent(streamId)}/events`, {
      method: "POST",
      headers: withAuth({
        "content-type": "application/json; charset=utf-8",
        "x-proxy-tenant-id": tenantId,
        "x-proxy-principal-id": principalId,
        "x-idempotency-key": idempotencyKey
      }),
      body: canonicalJsonStringify(body)
    });
    return r;
  }

  async function sendServerEvent({ streamKind, streamId, type, actor, payload, expectedPrevChainHash, idempotencyKey }) {
    const collection = streamKindPath(streamKind);
    const body = { type, actor, payload: payload ?? null };
    const r = await fetchJson(`/${collection}/${encodeURIComponent(streamId)}/events`, {
      method: "POST",
      headers: withAuth({
        "content-type": "application/json; charset=utf-8",
        "x-proxy-tenant-id": tenantId,
        "x-proxy-principal-id": principalId,
        "x-idempotency-key": idempotencyKey,
        "x-proxy-expected-prev-chain-hash":
          expectedPrevChainHash === null || expectedPrevChainHash === undefined ? "null" : String(expectedPrevChainHash)
      }),
      body: canonicalJsonStringify(body)
    });
    return r;
  }

  async function appendEvent(streamId, type, actor, payload, opts = {}) {
    const streamKind = opts.streamKind ?? "job";
    const mode = opts.mode === "server" ? "server" : "client";
    const at = typeof opts.at === "string" && opts.at.trim() ? opts.at : new Date().toISOString();
    const eventId = typeof opts.eventId === "string" && opts.eventId.trim() ? opts.eventId : `evt_${randomUUID()}`;

    const item = {
      v: 1,
      createdAt: new Date().toISOString(),
      streamKind,
      streamId,
      type,
      actor,
      payload: payload ?? null,
      at,
      eventId,
      mode,
      attempts: 0,
      finalized: null,
      lastError: null
    };

    if (spool) {
      const saved = await spool.enqueue(item);
      await flushSpool({ maxItems: 1, allowReorder: false, onlyFile: saved._file });
      return { status: "queued", eventId: saved.eventId };
    }

    const prevChainHash = await getStreamHead({ streamKind, streamId });
    const idempotencyKey = computeIdempotencyKey({ mode, eventId, prevChainHash });

    if (mode === "server") {
      let attempts = 0;
      while (attempts < maxSendAttempts) {
        attempts += 1;
        const r = await sendServerEvent({
          streamKind,
          streamId,
          type,
          actor,
          payload,
          expectedPrevChainHash: prevChainHash,
          idempotencyKey
        });
        if (r.ok) return { status: "accepted", response: r.json };
        if (r.status === 409 && r.json?.error === "event append conflict") {
          const nextPrev = await getStreamHead({ streamKind, streamId });
          const nextIdem = computeIdempotencyKey({ mode, eventId, prevChainHash: nextPrev });
          const rr = await sendServerEvent({
            streamKind,
            streamId,
            type,
            actor,
            payload,
            expectedPrevChainHash: nextPrev,
            idempotencyKey: nextIdem
          });
          if (rr.ok) return { status: "accepted", response: rr.json };
        }
        if (attempts >= maxSendAttempts) throw new Error(`append failed: ${r.status} ${r.json?.error ?? ""}`);
        const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
        await sleep(delayMs);
      }
      throw new Error("append failed");
    }

    const draft = buildDraft({ streamId, type, actor, payload, at, eventId });
    const finalized = finalizeChainedEvent({ event: draft, prevChainHash, signer });

    let attempts = 0;
    while (attempts < maxSendAttempts) {
      attempts += 1;
      const r = await sendFinalized({ streamKind, streamId, finalized, idempotencyKey });
      if (r.ok) return { status: "accepted", response: r.json };
      if (r.status === 409 && r.json?.error === "event append conflict") {
        // Rebase onto new head; do not reuse idempotency key for the old prevChainHash.
        const nextPrev = await getStreamHead({ streamKind, streamId });
        const rebased = finalizeChainedEvent({ event: draft, prevChainHash: nextPrev, signer });
        const nextIdem = computeIdempotencyKey({ mode, eventId, prevChainHash: nextPrev });
        const rr = await sendFinalized({ streamKind, streamId, finalized: rebased, idempotencyKey: nextIdem });
        if (rr.ok) return { status: "accepted", response: rr.json };
      }
      if (attempts >= maxSendAttempts) throw new Error(`append failed: ${r.status} ${r.json?.error ?? ""}`);
      const delayMs = computeBackoffMs({ attempts, baseMs: backoffBaseMs, maxMs: backoffMaxMs, random });
      await sleep(delayMs);
    }
    throw new Error("append failed");
  }

  async function flushSpool({ maxItems = 100, allowReorder = false, onlyFile = null } = {}) {
    if (!spool) return { processed: [] };
    const { queued, inflight } = await spool.listAll();
    const candidates = [...inflight, ...queued].filter((x) => (onlyFile ? x._file === onlyFile : true));
    candidates.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || String(a.eventId ?? "").localeCompare(String(b.eventId ?? "")));

    const processed = [];
    for (const raw of candidates.slice(0, maxItems)) {
      const item = await spool.claim(raw);

      try {
        if (item.mode === "server") {
          let expectedPrevChainHash = item.finalized?.expectedPrevChainHash ?? null;
          let idempotencyKey = item.finalized?.idempotencyKey ?? null;

          if (idempotencyKey === null || idempotencyKey === undefined) {
            expectedPrevChainHash = await getStreamHead({ streamKind: item.streamKind, streamId: item.streamId });
            idempotencyKey = computeIdempotencyKey({ mode: "server", eventId: item.eventId, prevChainHash: expectedPrevChainHash });
            item.finalized = { expectedPrevChainHash, idempotencyKey };
            await spool.update(item);
          }

          item.attempts = (Number.isSafeInteger(item.attempts) ? item.attempts : 0) + 1;
          await spool.update(item);

          const r = await sendServerEvent({
            streamKind: item.streamKind,
            streamId: item.streamId,
            type: item.type,
            actor: item.actor,
            payload: item.payload,
            expectedPrevChainHash,
            idempotencyKey
          });

          if (r.ok) {
            await spool.markDone(item);
            processed.push({ streamId: item.streamId, eventId: item.eventId, status: "delivered" });
            continue;
          }

          if (r.status === 409 && r.json?.error === "event append conflict" && allowReorder) {
            const nextPrev = await getStreamHead({ streamKind: item.streamKind, streamId: item.streamId });
            const nextIdem = computeIdempotencyKey({ mode: "server", eventId: item.eventId, prevChainHash: nextPrev });
            item.finalized = { expectedPrevChainHash: nextPrev, idempotencyKey: nextIdem };
            await spool.update(item);
            const rr = await sendServerEvent({
              streamKind: item.streamKind,
              streamId: item.streamId,
              type: item.type,
              actor: item.actor,
              payload: item.payload,
              expectedPrevChainHash: nextPrev,
              idempotencyKey: nextIdem
            });
            if (rr.ok) {
              await spool.markDone(item);
              processed.push({ streamId: item.streamId, eventId: item.eventId, status: "delivered" });
              continue;
            }
          }

          throw new Error(`${r.status} ${r.json?.error ?? "send failed"}`);
        }

        const draft = buildDraft({
          streamId: item.streamId,
          type: item.type,
          actor: item.actor,
          payload: item.payload,
          at: item.at,
          eventId: item.eventId
        });

        let finalized = item.finalized?.event ?? null;
        let idempotencyKey = item.finalized?.idempotencyKey ?? null;

        if (!finalized || !idempotencyKey) {
          const prevChainHash = await getStreamHead({ streamKind: item.streamKind, streamId: item.streamId });
          finalized = finalizeChainedEvent({ event: draft, prevChainHash, signer });
          idempotencyKey = computeIdempotencyKey({ mode: "client", eventId: item.eventId, prevChainHash });
          item.finalized = { event: finalized, idempotencyKey };
          await spool.update(item);
        }

        item.attempts = (Number.isSafeInteger(item.attempts) ? item.attempts : 0) + 1;
        await spool.update(item);

        const r = await sendFinalized({ streamKind: item.streamKind, streamId: item.streamId, finalized, idempotencyKey });
        if (r.ok) {
          await spool.markDone(item);
          processed.push({ streamId: item.streamId, eventId: item.eventId, status: "delivered" });
          continue;
        }

        if (r.status === 409 && r.json?.error === "event append conflict" && allowReorder) {
          // Rebase to new head and retry once.
          const prevChainHash = await getStreamHead({ streamKind: item.streamKind, streamId: item.streamId });
          const rebased = finalizeChainedEvent({ event: draft, prevChainHash, signer });
          const nextIdem = computeIdempotencyKey({ mode: "client", eventId: item.eventId, prevChainHash });
          item.finalized = { event: rebased, idempotencyKey: nextIdem };
          await spool.update(item);
          const rr = await sendFinalized({ streamKind: item.streamKind, streamId: item.streamId, finalized: rebased, idempotencyKey: nextIdem });
          if (rr.ok) {
            await spool.markDone(item);
            processed.push({ streamId: item.streamId, eventId: item.eventId, status: "delivered" });
            continue;
          }
        }

        throw new Error(`${r.status} ${r.json?.error ?? "send failed"}`);
      } catch (err) {
        const lastError = typeof err?.message === "string" ? err.message : String(err);
        if (item.attempts >= maxSendAttempts) {
          await spool.markFailed(item, { error: lastError });
          processed.push({ streamId: item.streamId, eventId: item.eventId, status: "failed", error: lastError });
        } else {
          item.lastError = lastError;
          await spool.update(item);
          processed.push({ streamId: item.streamId, eventId: item.eventId, status: "retrying", error: lastError });
        }
      }
    }

    return { processed };
  }

  async function appendBatch(batch) {
    if (!Array.isArray(batch)) throw new TypeError("batch must be an array");
    const results = [];
    for (const item of batch) {
      if (!item) continue;
      const streamId = item.streamId ?? item[0];
      const type = item.type ?? item[1];
      const actor = item.actor ?? item[2];
      const payload = item.payload ?? item[3];
      const opts = item.opts ?? item[4] ?? {};
      // eslint-disable-next-line no-await-in-loop
      results.push(await appendEvent(streamId, type, actor, payload, opts));
    }
    return results;
  }

  return {
    appendEvent,
    appendBatch,
    flushSpool,
    canonicalJsonStringify,
    finalizeChainedEvent
  };
}
