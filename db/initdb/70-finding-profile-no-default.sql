-- Drop the DEFAULT from finding.profile — storage never labels a finding (by1c.50).
--
-- 60-finding-profile.sql added the column as NOT NULL DEFAULT '2025'. That DEFAULT
-- had exactly one job: back-fill the rows written before the column existed, all of
-- which were contract findings. That back-fill happened at the moment the column was
-- added and cannot happen again, so the DEFAULT now has no remaining purpose.
--
-- Leaving it in place is worse than useless. The code always writes an explicit
-- profile: `InsertFindingInput.profile` is required, and neither insert path in
-- src/db/repository.ts substitutes a value. The one place an absent profile is
-- resolved is the grading/storage boundary in src/ingest/route.ts, which stamps
-- unstamped pipeline findings with CONTRACT_PROFILE before the INSERT. A finding
-- that nonetheless reaches storage without a profile is a bug, and it must fail
-- LOUDLY — the NOT NULL constraint rejects it, the transaction rolls back, and the
-- POST returns 500 — rather than be quietly labelled '2025' by a column default and
-- counted into a supplier's grade under a lineage it was never graded against.
--
-- House rule: an existing db/initdb file is NEVER edited in place. 60-finding-
-- profile.sql keeps its ADD COLUMN ... DEFAULT, because on a fresh first-boot replay
-- that is still the statement that creates the column; this file removes the default
-- immediately afterwards. The ordered replay stays a true history of the schema.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a fresh
-- volume, so an EXISTING deployment will not pick this up automatically. The
-- statement below is therefore written to be safe to apply by hand to a live
-- database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/70-finding-profile-no-default.sql
--
-- ALTER COLUMN ... DROP DEFAULT on a column that has no default is a no-op in
-- Postgres, so the file is idempotent. The NOT NULL constraint and the CHECK from
-- 60-finding-profile.sql are untouched — this changes only what happens when a row
-- arrives with no value for the column, which is now a rejection instead of a guess.

ALTER TABLE finding
  ALTER COLUMN profile DROP DEFAULT;

COMMENT ON COLUMN finding.profile IS
  'Requirement lineage this finding grades against: 2025 (the contract in force) | ds013 (the DS01.3 shadow run). No default: every writer supplies it explicitly, and a missing value is rejected by NOT NULL.';
