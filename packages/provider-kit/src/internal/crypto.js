import { createHash, sign as nodeSign, verify as nodeVerify } from "node:crypto";

export function sha256Hex(data) {
  const hash = createHash("sha256");
  if (typeof data === "string") hash.update(data, "utf8");
  else hash.update(data);
  return hash.digest("hex");
}

export function keyIdFromPublicKeyPem(publicKeyPem) {
  return `key_${sha256Hex(publicKeyPem).slice(0, 24)}`;
}

export function signHashHexEd25519(hashHex, privateKeyPem) {
  const signature = nodeSign(null, Buffer.from(hashHex, "hex"), privateKeyPem);
  return signature.toString("base64");
}

export function verifyHashHexEd25519({ hashHex, signatureBase64, publicKeyPem }) {
  return nodeVerify(null, Buffer.from(hashHex, "hex"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
}
