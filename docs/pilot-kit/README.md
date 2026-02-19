# Pilot Kit (Verify Cloud / Magic Link)

This folder is the “send to prospects” kit for running a paid pilot:

- Buyer materials (what the page means, what to download, how to re-verify offline)
- Security posture summary (what we harden against)
- Integration starting point (webhooks)
- Simple ROI / billing templates

## Recommended pilot flow

1. Operator produces an `InvoiceBundle.v1` and uploads it to Verify Cloud (Magic Link).
2. Buyer receives the link, reviews Green/Amber/Red, and (optionally) records **Approve/Hold** on the page.
3. Buyer downloads the audit packet for archiving (bundle ZIP + deterministic JSON outputs).
4. Operator consumes the webhook event to drive their internal workflow.

## Contents

- `buyer-one-pager.md` — what the buyer sees and what to do.
- `buyer-email.txt` — copy/paste email template for sending links.
- `offline-verify.md` — how a buyer/auditor re-verifies locally.
- `security-summary.md` — zip and bundle hardening posture.
- `security-qa.md` — short procurement/security questionnaire answers.
- `architecture-one-pager.md` — deployment and data flow overview for security reviewers.
- `procurement-one-pager.md` — procurement-facing overview (adoption + security posture).
- `rfp-clause.md` — draft procurement / RFP language.
- `roi-calculator-template.csv` — simple template for pilot ROI tracking.
- `gtm-pilot-playbook.md` — outreach templates, pilot KPI gates, and case-study format.
- `PILOT_PACKAGE_SCORECARD_X402.md` — default x402 pilot package, baseline/target scorecard, and expansion triggers.
