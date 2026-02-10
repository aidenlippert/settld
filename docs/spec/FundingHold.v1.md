# FundingHold.v1

`FundingHold.v1` is a server-signed receipt that funds for a specific agreement have been locked (pre-authorized) and cannot be spent elsewhere.

It exists to make the agreement trustworthy **before** the provider executes work.

## Core fields

- `schemaVersion = "FundingHold.v1"`
- `artifactType = "FundingHold.v1"`
- `artifactId`
- `tenantId`
- `agreement`:
  - `artifactId`
  - `agreementHash`
- `payerAgentId`
- `amountCents` (positive integer)
- `currency`
- `lockedAt`
- `expiresAt` (optional; omitted when absent)

## holdHash + signature

- `holdHash` is computed over canonical JSON with `holdHash`, `signature`, and `artifactHash` removed.
- `signature` is an Ed25519 signature over `holdHash`.

The signer is expected to be the settlement service key (server signer).
