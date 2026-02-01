# Backup/Restore verification (PG)

This folder contains a deterministic backup/restore drill:

- Seed a known workload into Postgres (PG store).
- Capture a small set of state digests (counts + stable hashes).
- Take a logical backup (`pg_dump`).
- Restore into a fresh database.
- Recompute state digests and compare.

Entry point: `scripts/backup-restore-test.sh`.

Requirements:

- `STORE=pg`
- `DATABASE_URL` and `RESTORE_DATABASE_URL` set
- `pg_dump` and `psql` available on PATH

