# Quickstart

## 1) Start API Runtime

```bash
npm run dev:api
npm run dev:maintenance
```

## 2) Mint SDK Key

```bash
npx settld dev:sdk:key --print-only
```

## 3) Execute First Flow

```bash
npx settld sdk:first-run
```

## 4) Export + Verify Offline

```bash
npx settld closepack export --receipt-id rcpt_123 --out closepack.zip
npx settld closepack verify closepack.zip
```

## Expected Outputs

- Request-bound authorization issued
- Receipt + timeline persisted immutably
- Offline verification returns enforceable lineage status
