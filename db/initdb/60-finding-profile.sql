-- Add finding.profile — which requirement lineage a finding grades against (by1c.5).
--
-- Shadow grading (epic by1c) runs the DS01.3 draft alongside the 2025 contract
-- and records BOTH sets of results. The response code and the contract dashboard
-- must keep counting only the contract results, so every finding carries the
-- lineage it belongs to: '2025' (the requirements in force, the only value
-- written today) or 'ds013' (the DS01.3 shadow run). Filtering by this column is
-- what keeps a shadow failure out of a supplier's grade.
--
-- House rule: an existing db/initdb file is NEVER edited in place — an additive
-- column arrives as a new numbered file, so the ordered first-boot replay stays a
-- true history of the schema. 30-finding.sql is left untouched.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a
-- fresh volume, so an EXISTING deployment will not pick this up automatically.
-- The statements below are therefore written to be safe to apply by hand to a
-- live database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/60-finding-profile.sql
--
-- ADD COLUMN IF NOT EXISTS makes the ALTER idempotent, and COMMENT ON is a
-- straight overwrite, so the file is a no-op on second application. The column is
-- NOT NULL with a DEFAULT, which Postgres 11+ applies without rewriting the table
-- and which back-fills every existing row to '2025' — correct, because every
-- finding written before this column existed was a contract finding.
--
-- No index: findings are read per session through the transmission join
-- (finding_transmission in 40-indexes.sql), and profile is a two-value filter
-- applied to that already-small set. An index on it would not be used.

ALTER TABLE finding
  ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT '2025'
    CHECK (profile IN ('2025', 'ds013'));

COMMENT ON COLUMN finding.profile IS
  'Requirement lineage this finding grades against: 2025 (the contract in force) | ds013 (the DS01.3 shadow run). Defaults to 2025.';
