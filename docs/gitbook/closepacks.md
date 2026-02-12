# Closepacks (Offline Verification)

A closepack is a portable verification bundle proving settlement lineage without relying on live server trust.

## What you can prove with a closepack

- artifact integrity and signatures
- agreement/evidence/decision bindings
- dispute lineage correctness
- deterministic adjustment routing expectations
- replay comparison consistency

## Export

```bash
npx settld closepack export --agreement-hash <agreementHash> --out closepack.zip
```

Repo checkout:

```bash
./bin/settld.js closepack export --agreement-hash <agreementHash> --out closepack.zip
```

## Verify

```bash
npx settld closepack verify closepack.zip --json-out /tmp/closepack-verify.json
```

Repo checkout:

```bash
./bin/settld.js closepack verify closepack.zip --json-out /tmp/closepack-verify.json
```

## Operational policy recommendation

For every production release candidate:

1. Generate at least one representative closepack.
2. Verify it offline.
3. Store verify JSON with release artifacts.

## Why this matters

Closepacks shift trust from “believe the API response” to “independently verify the economic claim.”

That is a core credibility boundary for settlement infrastructure.

## Related references

- `docs/spec/ClosePack.v1.md`
- `docs/spec/ClosePackManifest.v1.md`
- `docs/spec/INVARIANTS.md`
