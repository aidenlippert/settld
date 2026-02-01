# Ledger (v0.4)

Settld treats settlement as a double-entry ledger: every journal entry must balance to zero.

## Posting sign convention

- Positive `amountCents` = debit
- Negative `amountCents` = credit
- Every journal entry satisfies `sum(postings.amountCents) === 0`

## Chart of accounts (current prototype)

Defined in `src/api/store.js`:

- `acct_cash` — payment processor clearing cash
- `acct_customer_escrow` — customer escrow liability
- `acct_platform_revenue` — platform revenue
- `acct_owner_payable` — owner payout liability
- `acct_operator_payable` — operator payout liability
- `acct_developer_royalty_payable` — developer royalties liability
- `acct_insurance_reserve` — insurance reserve
- `acct_claims_expense` — claims expense (prototype)
- `acct_claims_payable` — claims payable liability

## Job lifecycle postings (current)

### `BOOKED`

Captures funds into escrow (prototype model):

- Debit `acct_cash` for `amountCents`
- Credit `acct_customer_escrow` for `amountCents`

### `SETTLED` (job was `COMPLETED`)

Moves escrow into revenue + payables + reserve:

- Debit `acct_customer_escrow` for `amountCents`
- Credit:
  - `acct_platform_revenue`
  - `acct_owner_payable`
  - `acct_operator_payable` (only if assist occurred)
  - `acct_developer_royalty_payable` (equals sum of licensed skill fees)
  - `acct_insurance_reserve`

Splits are deterministic and integer-cent safe (see `src/core/ledger-postings.js`).

### `SETTLED` (job was `ABORTED`)

Full refund from escrow:

- Debit `acct_customer_escrow` for `amountCents`
- Credit `acct_cash` for `amountCents`

## Claims postings (v0.4)

Claims are modeled as their own workflow, but postings stay deterministic and derived from events.

### `JOB_ADJUSTED` (claim was approved)

Creates a payable for the approved total (payout + refund), and offsets it via:

- **Payouts** (`payoutCents`):
  - Debit `acct_claims_expense`
  - Credit `acct_claims_payable`
- **Refunds** (`refundCents`, completed jobs only):
  - Debit proportional reversals of:
    - `acct_platform_revenue`
    - `acct_owner_payable`
    - `acct_operator_payable` (if assist)
    - `acct_developer_royalty_payable` (if licensed skills)
    - `acct_insurance_reserve`
  - Credit `acct_claims_payable`

Refund reversals are computed as a deterministic pro-rata split of the original settlement allocation (see `src/core/ledger-postings.js`).

### `CLAIM_PAID`

Moves funds out of cash and clears the liability:

- Debit `acct_claims_payable` for `amountCents`
- Credit `acct_cash` for `amountCents`
