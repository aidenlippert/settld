# First Production Cutover

## Cutover Sequence

1. Deploy API with durable persistence.
2. Validate webhook endpoints and signature verification.
3. Run conformance + closepack verification gates.
4. Enable one pilot provider + one policy class.
5. Monitor escalation queue and unwind/reversal queue behavior.

## Go/No-Go Conditions

- Conformance suite green
- Replay verification match
- No dead-letter queue growth
- Operator escalation resolution functioning
