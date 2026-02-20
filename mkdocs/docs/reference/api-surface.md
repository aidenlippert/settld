# API Surface

## Authorization and Spend

- `POST /x402/wallets/:walletId/authorize`
- `POST /x402/gate/authorize-payment`
- `POST /x402/gate/verify`
- `POST /x402/gate/reversal`

## Receipts and Evidence

- `GET /x402/receipts/:receiptId`
- `GET /x402/receipts`
- `GET /x402/receipts/export.jsonl`
- `GET /x402/receipts/:receiptId/closepack`

## Escalation and Webhooks

- `GET /x402/gate/escalations`
- `POST /x402/gate/escalations/:id/resolve`
- `POST /x402/webhooks/endpoints`
- `POST /x402/webhooks/endpoints/:id/rotate-secret`

## Lifecycle

- `POST /x402/gate/agents/:id/wind-down`
