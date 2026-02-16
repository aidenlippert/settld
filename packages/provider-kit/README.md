# @settld/provider-kit

Provider middleware for paid tool endpoints using SettldPay.

## What it provides

- `HTTP 402` challenge flow with both `x-payment-required` and `PAYMENT-REQUIRED`
- Offline SettldPay verification (`Authorization: SettldPay <token>`)
- Cached `/.well-known/settld-keys.json` resolution with pinned-key fallback
- Provider response signing (`x-settld-provider-*` headers)
- Replay dedupe keyed by `authorizationRef` (fallback `gateId`)

## Minimal usage

```js
import http from "node:http";
import { createSettldPaidNodeHttpHandler } from "@settld/provider-kit";

const paidHandler = createSettldPaidNodeHttpHandler({
  providerId: "prov_exa_mock",
  providerPublicKeyPem: process.env.PROVIDER_PUBLIC_KEY_PEM,
  providerPrivateKeyPem: process.env.PROVIDER_PRIVATE_KEY_PEM,
  priceFor: ({ req, url }) => ({
    amountCents: 500,
    currency: "USD",
    providerId: "prov_exa_mock",
    toolId: `${req.method}:${url.pathname}`
  }),
  settldPay: {
    keysetUrl: "http://127.0.0.1:3000/.well-known/settld-keys.json"
  },
  execute: async ({ url }) => ({
    body: {
      ok: true,
      query: url.searchParams.get("q") ?? ""
    }
  })
});

const server = http.createServer((req, res) => paidHandler(req, res));
server.listen(9402);
```

## Exports

- `createSettldPaidNodeHttpHandler(options)`
- `createSettldPayKeysetResolver(options)`
- `createInMemoryReplayStore(options)`
- `parseSettldPayAuthorizationHeader(header)`
- `buildPaymentRequiredHeaderValue(offer)`
