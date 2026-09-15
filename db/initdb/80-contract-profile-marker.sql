-- Record the contract profile this database was last written under (by1c.52).
--
-- Shadow grading (epic by1c) stores every finding with the requirement lineage it
-- graded against (60-finding-profile.sql), and CONTRACT_PROFILE in
-- src/schema-registry.ts names which lineage is the contract in force. The day
-- that constant moves from '2025' to 'ds013', the meaning of the stored rows
-- changes underneath them: a finding recorded as '2025' was a contract finding
-- when it was written and becomes a shadow finding the moment the service
-- restarts, so a pre-flip transport rejection would silently stop counting
-- against the supplier's grade. The decision is a clean cut — on flip day ALL
-- stored data is discarded, never migrated — and this table is what lets the
-- service enforce it instead of trusting an operator to have read the README.
--
-- Why a marker and not inference: the old default made every unstamped finding
-- indistinguishable from a deliberately stamped one, so no query over `finding`
-- can tell which contract profile the database was written under. The profile is
-- therefore recorded explicitly, once, by the boot check in src/index.ts
-- (src/db/contract-marker.ts): absent → write it; equal → continue; different →
-- refuse to start and print the operator action.
--
-- Single row by construction: `singleton` is the primary key and CHECKed true, so
-- a second row cannot be inserted. The CHECK on `contract_profile` mirrors the one
-- on `finding.profile` — the same two lineages, kept in step by hand.
--
-- House rule: an existing db/initdb file is NEVER edited in place — new schema
-- arrives as a new numbered file, so the ordered first-boot replay stays a true
-- history of the schema.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a
-- fresh volume, so an EXISTING deployment will not pick this up automatically.
-- The statements below are therefore written to be safe to apply by hand to a
-- live database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/80-contract-profile-marker.sql
--
-- CREATE TABLE IF NOT EXISTS makes the create idempotent and COMMENT ON is a
-- straight overwrite, so the file is a no-op on second application. No row is
-- seeded here: an empty table means "fresh database", which is exactly what the
-- boot check needs in order to stamp the profile the service actually runs.
--
-- No index: the table holds at most one row, reached by primary key.

CREATE TABLE IF NOT EXISTS service_marker (
  singleton        boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  contract_profile text        NOT NULL CHECK (contract_profile IN ('2025', 'ds013')),
  written_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE service_marker IS
  'One row of service-level facts about this database. Empty means a fresh database that has not been written under any contract profile yet.';

COMMENT ON COLUMN service_marker.singleton IS
  'Always true: primary key plus CHECK, so the table can hold at most one row.';

COMMENT ON COLUMN service_marker.contract_profile IS
  'Requirement lineage in force when this database was last written: 2025 (the contract in force) | ds013 (the DS01.3 shadow run). Mirrors finding.profile. A change here is a flip day: the service refuses to boot and the data is discarded, never migrated.';

COMMENT ON COLUMN service_marker.written_at IS
  'When the marker was stamped — i.e. when this database was first written under the recorded contract profile.';
