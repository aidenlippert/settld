# Canonical JSON

Settld hashes and signs canonical JSON to avoid ambiguity across runtimes/languages.

## Canonicalization algorithm

Given an input value:

- `null`, `string`, `boolean` serialize as-is.
- `number` must be finite and must not be `-0`.
- `array` preserves element order; each element is canonicalized recursively.
- `object` must be a plain object (prototype is `Object.prototype` or `null`), with no symbol keys.
  - Keys are sorted ascending (lexicographic).
  - Values are canonicalized recursively.

The canonical form is serialized with JSON (no whitespace) via `JSON.stringify`.

## Hash rule

When a spec says **“hash the object”**, it means:

`sha256_hex( utf8( canonical_json_stringify(object) ) )`

