-- Add finding.summary — the one-line OBSERVATION an advisory carries (agj.17).
--
-- An advisory used to arrive as a single paragraph that fused what was observed
-- with why it matters, which is the wrong shape for a list a supplier scans. The
-- prose is now two pieces: `summary` is the observation with its numbers ("3 of
-- 12 reports carry no appliance serial number"), shown on the advisory row, and
-- `detail` becomes the rationale, shown behind that row's expander. Graded §7
-- findings are unaffected — they keep their explanation in `detail` alone and
-- leave this column null.
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
--     psql -U cce_validator -d cce_validator -f - < db/initdb/90-finding-summary.sql
--
-- ADD COLUMN IF NOT EXISTS makes the ALTER idempotent, and COMMENT ON is a
-- straight overwrite, so the file is a no-op on second application.
--
-- NULLABLE, and with no default: a finding stored before this column existed
-- carries no observation line, and inventing one is not possible after the fact.
-- Those rows stay readable for the remainder of the retention window (DESIGN.md
-- §11) because the dashboard falls back to `detail` wherever `summary` is null —
-- the same fallback that lets a check emit only `detail` until it is converted.
--
-- No index: summary is display prose, never a filter or a join key.

ALTER TABLE finding
  ADD COLUMN IF NOT EXISTS summary text;

COMMENT ON COLUMN finding.summary IS
  'One-line observation carried by an advisory (agj.17), with detail holding the rationale. Null on graded findings and on rows written before this column existed.';
