# On-call Playbook (v0)

## Top priorities

1. Human safety
2. Property safety
3. Privacy compliance
4. Service reliability
5. Financial correctness

## Standard incident response

1. Identify affected job(s) and current state.
2. If robot is active:
   - move to safe state (stop / exit / dock) via operator console,
   - revoke access plan if needed.
3. Preserve evidence bundle (ensure it is generated and immutable).
4. Communicate:
   - requester notification (status + next step),
   - owner/operator notification if dispatch needed.
5. Classify incident and open claim if thresholds are met.
6. Post-incident:
   - tag failure mode,
   - file regression test requirements,
   - add monitoring/alert improvements.

## “Stop the world” triggers

- repeated safety incidents from a robot model or skill version
- privacy policy violations (camera/sensor misuse)
- ledger imbalance or payout correctness bug

## Debug checklist

- job timeline replay (events, transitions)
- agent heartbeats and last known telemetry
- operator action log
- evidence bundle frames (minimal necessary)

