# State Machines

## Authorization / Execution

`quoted -> authorized -> executed -> verified -> receipted`

## Escalation

`policy_blocked -> pending_escalation -> approved|denied -> resumed|voided`

## Agent Lifecycle

`active -> frozen -> unwind -> archived`

## Queue Guarantees

- Retries with backoff
- Dead-lettering on repeated failure
- Idempotent command processing
