import { randomUUID } from "node:crypto";

let deterministicCounter = 0;
function deterministicEnabled() {
  if (typeof process === "undefined") return false;
  if (process.env.NODE_ENV === "production") return false;
  return process.env.PROXY_DETERMINISTIC_IDS === "1";
}

export function resetDeterministicIds() {
  deterministicCounter = 0;
}

export function createId(prefix) {
  if (deterministicEnabled()) {
    const n = deterministicCounter;
    deterministicCounter += 1;
    return `${prefix}_det_${String(n).padStart(8, "0")}`;
  }
  return `${prefix}_${randomUUID()}`;
}
