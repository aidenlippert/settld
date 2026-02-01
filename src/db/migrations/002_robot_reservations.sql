-- v1.0: robot reservations index + overlap prevention.

-- Needed for exclusion constraints on TEXT columns.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS robot_reservations (
  job_id TEXT PRIMARY KEY,
  robot_id TEXT NOT NULL,
  "window" TSTZRANGE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'robot_reservations_no_overlap'
  ) THEN
    ALTER TABLE robot_reservations
      ADD CONSTRAINT robot_reservations_no_overlap
      EXCLUDE USING gist (robot_id WITH =, "window" WITH &&);
  END IF;
END $$;
