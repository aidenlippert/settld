import { canonicalJsonStringify, normalizeForCanonicalJson } from "./canonical-json.js";
import { sha256Hex, signHashHexEd25519, verifyHashHexEd25519 } from "./crypto.js";

export const EVENT_ENVELOPE_VERSION = 1;

function payloadMaterialForEvent({ v, id, at, streamId, type, actor, payload }) {
  return canonicalJsonStringify({ v, id, at, streamId, type, actor, payload });
}

function chainMaterialForEvent({ v, prevChainHash, payloadHash }) {
  return canonicalJsonStringify({ v, prevChainHash, payloadHash });
}

export function finalizeChainedEvent({ event, prevChainHash, signer }) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  if (event.v !== EVENT_ENVELOPE_VERSION) throw new TypeError(`event.v must be ${EVENT_ENVELOPE_VERSION}`);

  const normalizedActor = normalizeForCanonicalJson(event.actor ?? null, { path: "$.actor" });
  const normalizedPayload = normalizeForCanonicalJson(event.payload ?? null, { path: "$.payload" });

  const base = {
    ...event,
    actor: normalizedActor,
    payload: normalizedPayload,
    prevChainHash
  };

  const payloadHash = sha256Hex(payloadMaterialForEvent(base));
  const chainHash = sha256Hex(chainMaterialForEvent({ v: EVENT_ENVELOPE_VERSION, prevChainHash, payloadHash }));

  let signature = null;
  let signerKeyId = null;
  if (signer?.privateKeyPem && signer?.keyId) {
    signature = signHashHexEd25519(payloadHash, signer.privateKeyPem);
    signerKeyId = signer.keyId;
  }

  return {
    ...base,
    payloadHash,
    chainHash,
    signature,
    signerKeyId
  };
}

export function verifyChainedEvents(events, { publicKeyByKeyId = new Map() } = {}) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const prev = i === 0 ? null : events[i - 1];

    if (!event || typeof event !== "object") return { ok: false, error: `invalid event at index ${i}` };
    if (event.v !== EVENT_ENVELOPE_VERSION) return { ok: false, error: `unsupported event.v at index ${i}` };

    const expectedPrevChainHash = prev?.chainHash ?? null;
    if (event.prevChainHash !== expectedPrevChainHash) {
      return { ok: false, error: `prevChainHash mismatch at index ${i}` };
    }

    const expectedPayloadHash = sha256Hex(payloadMaterialForEvent(event));
    if (event.payloadHash !== expectedPayloadHash) {
      return { ok: false, error: `payloadHash mismatch at index ${i}` };
    }

    const expectedChainHash = sha256Hex(
      chainMaterialForEvent({ v: EVENT_ENVELOPE_VERSION, prevChainHash: event.prevChainHash, payloadHash: event.payloadHash })
    );
    if (event.chainHash !== expectedChainHash) {
      return { ok: false, error: `chainHash mismatch at index ${i}` };
    }

    if (event.signature) {
      if (!event.signerKeyId) return { ok: false, error: `missing signerKeyId at index ${i}` };
      const publicKeyPem = publicKeyByKeyId.get(event.signerKeyId);
      if (!publicKeyPem) return { ok: false, error: `unknown signerKeyId at index ${i}` };
      const ok = verifyHashHexEd25519({
        hashHex: event.payloadHash,
        signatureBase64: event.signature,
        publicKeyPem
      });
      if (!ok) return { ok: false, error: `signature invalid at index ${i}` };
    }
  }

  return { ok: true };
}

