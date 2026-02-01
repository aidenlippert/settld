function canonicalize(value) {
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Unsupported number for canonical JSON: non-finite");
    }
    if (Object.is(value, -0)) {
      throw new TypeError("Unsupported number for canonical JSON: -0");
    }
    return value;
  }

  if (valueType === "undefined") {
    throw new TypeError("Unsupported value for canonical JSON: undefined");
  }

  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType}`);
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (valueType === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Unsupported object for canonical JSON: non-plain object");
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length) {
      throw new TypeError("Unsupported object for canonical JSON: symbol keys");
    }
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) out[key] = canonicalize(value[key]);
    return out;
  }

  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)}`);
}

export function canonicalJsonStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function assertPlainObject(value) {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Unsupported object for canonical JSON: non-plain object");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length) {
    throw new TypeError("Unsupported object for canonical JSON: symbol keys");
  }
}

export function normalizeForCanonicalJson(value, { path = "$", inArray = false } = {}) {
  if (value === undefined) {
    if (inArray) throw new TypeError(`Unsupported value for canonical JSON: undefined at ${path}`);
    return undefined;
  }

  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Unsupported number for canonical JSON: non-finite at ${path}`);
    }
    if (Object.is(value, -0)) {
      throw new TypeError(`Unsupported number for canonical JSON: -0 at ${path}`);
    }
    return value;
  }

  if (valueType === "bigint" || valueType === "function" || valueType === "symbol") {
    throw new TypeError(`Unsupported type for canonical JSON: ${valueType} at ${path}`);
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(normalizeForCanonicalJson(value[i], { path: `${path}[${i}]`, inArray: true }));
    }
    return out;
  }

  if (valueType === "object") {
    assertPlainObject(value);
    const out = {};
    for (const key of Object.keys(value)) {
      const normalized = normalizeForCanonicalJson(value[key], { path: `${path}.${key}`, inArray: false });
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }

  throw new TypeError(`Unsupported value for canonical JSON: ${String(value)} at ${path}`);
}

