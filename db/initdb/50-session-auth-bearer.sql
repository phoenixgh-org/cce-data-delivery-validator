-- Widen session.auth_method to admit 'bearer' (5bs.4).
--
-- DS01.3 clause 5.1.5 names THREE authentication methods where the 2025
-- requirements named two; the third is `Authorization: Bearer <token>`
-- (RFC 6750). 10-session.sql created auth_method with a CHECK listing only
-- ('header', 'basic'), so the value has to be admitted here.
--
-- House rule: an existing db/initdb file is NEVER edited in place — a widening
-- arrives as a new numbered file, so the ordered first-boot replay stays a true
-- history of the schema.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a
-- fresh volume, so an EXISTING deployment will not pick this up automatically.
-- The statements below are therefore written to be safe to apply by hand to a
-- live database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/50-session-auth-bearer.sql
--
-- DROP CONSTRAINT IF EXISTS + ADD makes the pair idempotent; the constraint name
-- is the one Postgres generated for the inline column CHECK in 10-session.sql
-- (<table>_<column>_check). The widening is purely additive — every row that
-- satisfied the old constraint satisfies the new one — so the ADD cannot fail a
-- validation scan on existing data.

ALTER TABLE session DROP CONSTRAINT IF EXISTS session_auth_method_check;

ALTER TABLE session ADD CONSTRAINT session_auth_method_check
  CHECK (auth_method IN ('header', 'basic', 'bearer'));

COMMENT ON COLUMN session.auth_method IS
  '§1.3 opt-in auth method: header (token in a configurable header) | basic (HTTP Basic) | bearer (RFC 6750). NULL when auth is disabled.';
