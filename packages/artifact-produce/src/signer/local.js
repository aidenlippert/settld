import fsSync from "node:fs";
import path from "node:path";

import { sign as nodeSign } from "node:crypto";

function assertNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
}

function hasAnyGroupOrOtherBits(mode) {
  // world/group readable/writable/executable bits
  return (mode & 0o077) !== 0;
}

export function loadKeypairsJsonFromFile({ keysPath, enforcePerms = true } = {}) {
  assertNonEmptyString(keysPath, "keysPath");
  const abs = path.resolve(process.cwd(), keysPath);
  const raw = fsSync.readFileSync(abs, "utf8");
  const json = JSON.parse(raw);
  if (!isPlainObject(json)) throw new TypeError("keys file must be a JSON object");
  if (enforcePerms) {
    try {
      const st = fsSync.statSync(abs);
      // On Windows, st.mode is not a meaningful POSIX permission mask and is often reported
      // with group/other bits set even for private files. Enforce perms only on POSIX.
      if (process.platform !== "win32" && typeof st?.mode === "number" && hasAnyGroupOrOtherBits(st.mode)) {
        const err = new Error("refusing to use keypairs file with group/other permissions (expected 0600)");
        err.code = "KEYPAIRS_INSECURE_PERMISSIONS";
        err.path = abs;
        throw err;
      }
    } catch (e) {
      if (e?.code === "KEYPAIRS_INSECURE_PERMISSIONS") throw e;
      // If we can't stat/chmod (Windows), allow but surface via caller warnings if desired.
    }
  }
  return { abs, json };
}

export function createLocalSignerProvider({ keypairsJson } = {}) {
  if (!isPlainObject(keypairsJson)) throw new TypeError("keypairsJson must be an object");

  const byKeyId = new Map();
  for (const v of Object.values(keypairsJson)) {
    if (!isPlainObject(v)) continue;
    const keyId = typeof v.keyId === "string" && v.keyId.trim() ? v.keyId : null;
    const publicKeyPem = typeof v.publicKeyPem === "string" && v.publicKeyPem.trim() ? v.publicKeyPem : null;
    const privateKeyPem = typeof v.privateKeyPem === "string" && v.privateKeyPem.trim() ? v.privateKeyPem : null;
    if (!keyId || !publicKeyPem || !privateKeyPem) continue;
    byKeyId.set(keyId, { keyId, publicKeyPem, privateKeyPem });
  }

  return {
    kind: "local",
    getPublicKeyPem({ keyId }) {
      assertNonEmptyString(keyId, "keyId");
      const kp = byKeyId.get(keyId) ?? null;
      if (!kp) {
        const err = new Error("unknown keyId");
        err.code = "KEY_ID_UNKNOWN";
        err.keyId = keyId;
        throw err;
      }
      return kp.publicKeyPem;
    },
    sign({ keyId, algorithm, messageBytes, purpose, context }) {
      assertNonEmptyString(keyId, "keyId");
      assertNonEmptyString(algorithm, "algorithm");
      assertNonEmptyString(purpose, "purpose");
      const kp = byKeyId.get(keyId) ?? null;
      if (!kp) {
        const err = new Error("unknown keyId");
        err.code = "KEY_ID_UNKNOWN";
        err.keyId = keyId;
        throw err;
      }
      if (algorithm !== "ed25519") {
        const err = new Error("unsupported algorithm");
        err.code = "UNSUPPORTED_ALGORITHM";
        err.algorithm = algorithm;
        throw err;
      }
      const sig = nodeSign(null, Buffer.from(messageBytes), kp.privateKeyPem);
      return { signatureBase64: sig.toString("base64"), signerReceipt: null, context: context ?? null };
    }
  };
}
