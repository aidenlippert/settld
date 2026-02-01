import crypto from "node:crypto";

export function sha256HexUtf8(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256HexBytes(value) {
  const buf = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value ?? ""), "utf8");
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function hmacSha256Hex({ secret, value }) {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function verifyHashHexEd25519({ hashHex, signatureBase64, publicKeyPem }) {
  return crypto.verify(null, Buffer.from(String(hashHex ?? ""), "hex"), String(publicKeyPem ?? ""), Buffer.from(String(signatureBase64 ?? ""), "base64"));
}
