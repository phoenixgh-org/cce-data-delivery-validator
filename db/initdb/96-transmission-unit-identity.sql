-- transmission_unit_identity — the appliance-side identifiers each transmission
-- carried, per CCE unit (0rfk, the data model behind adv.identifier_collision).
--
-- A supplier's platform can hand the same appliance two names over the life of a
-- session: a serial corrected between deliveries, a platform handle reassigned, an
-- asset id entered twice. From the receiving side all of those look the same — one
-- appliance-side identifier arrives in two deliveries beside a DIFFERENT companion
-- identifier each time. Nothing stored before this table could see it.
-- `transmission_unit_window` (95-) holds the identity KEY and the ABST span, but
-- not the other identifiers the report carried, so it cannot say which companion
-- travelled with the key.
--
-- A SEPARATE TABLE, not three more columns on the window. A window row exists only
-- when at least one of the report's records carried a parseable ABST; identity must
-- not depend on timestamps, because a report whose clock the service cannot read
-- still names an appliance perfectly well.
--
-- One row per report-unit per transmission. A body carrying several reports yields
-- several rows; a report that names no appliance (neither ASER nor AMID — the
-- identity rule in src/identity/unit-key.ts) writes no row, because there is
-- nothing to match against a later delivery. Two reports for one appliance inside
-- one body write ONE row, the first of them: intra-body disagreement is a different
-- observation and is not graded here.
--
-- The three columns are the APPLIANCE-SIDE identifiers, exactly: ASER (the
-- manufacturer's serial for the equipment), AMID (the supplier platform's own
-- handle on it, an rtmd-report property only) and AID (the employer's asset id,
-- optional on both branches). LSER, ESER, LID and EID are deliberately absent: they
-- name the logger and the monitoring device, and one appliance being re-instrumented
-- or one logger moved between appliances is ordinary operation rather than anything
-- the receiving side should remark on. Values are stored AS REPORTED after trimming
-- and are never case-folded — "ab" and "AB" are different serials (`identifier` in
-- src/identity/unit-key.ts).
--
-- A delivery the service did not accept writes no row: the ingest route writes these
-- rows only for a body the schema stage accepted, exactly as it does for windows, and
-- `findPriorUnitIdentities` filters on `schema_ok` besides.
--
-- Numbering: 96, the next free two-digit slot after 95. The entrypoint replays this
-- directory in the shell's glob order, which is byte order, and '-' sorts BEFORE any
-- digit — so a file named `100-…` would run immediately after `10-session.sql` and
-- before `20-transmission.sql`, and the foreign key below would fail on a fresh
-- volume. The two-digit decade scheme ends at 90; later files take the gaps.
--
-- Retention (DESIGN.md §11): rows carry no independent lifetime. ON DELETE CASCADE
-- from `transmission` means the 7-day inactivity sweep reaches them transitively
-- (session → transmission → transmission_unit_identity), so `purgeExpiredSessions`
-- still needs no per-table delete.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a fresh
-- volume, so an EXISTING deployment will not pick this up automatically. Without it
-- every ingest write fails once the advisory lands, because the ingest route writes
-- these rows beside the findings. The statements below are therefore written to be
-- safe to apply by hand to a live database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/96-transmission-unit-identity.sql
--
-- CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS make the DDL
-- idempotent, and COMMENT ON is a straight overwrite, so the file is a no-op on
-- second application.

CREATE TABLE IF NOT EXISTS transmission_unit_identity (
  -- FK → transmission; cascade on delete so a session purge (§11) reaches these
  -- rows transitively, the same path finding and window take.
  transmission_id uuid NOT NULL
                       REFERENCES transmission (id) ON DELETE CASCADE,

  -- Denormalized from transmission.session_uuid so the prior-identity lookup can be
  -- answered from this table's own indexes without joining to find the session.
  session_uuid    uuid NOT NULL,

  -- The appliance identity key: 'aser:<serial>' preferred, 'amid:<supplier id>'
  -- as the fallback (src/identity/unit-key.ts, decided 2026-08-04 under bd p98).
  -- The prefix is part of the key: the two namespaces never reconcile.
  unit_key        text NOT NULL,

  -- The three appliance-side identifiers as reported, trimmed, never case-folded.
  -- NULL means the report did not carry a usable value (absent, JSON null, blank,
  -- or not a string) — an absent value is never compared against anything.
  aser            text NULL,
  amid            text NULL,
  aid             text NULL,

  -- One identity per unit per transmission: a second report for the same appliance
  -- inside one body contributes nothing further here.
  PRIMARY KEY (transmission_id, unit_key)
);

-- The primary read path: "every earlier identity in this session under these unit
-- keys". Leading on session_uuid keeps the lookup inside one supplier's sandbox.
CREATE INDEX IF NOT EXISTS transmission_unit_identity_session_unit
  ON transmission_unit_identity (session_uuid, unit_key);

-- The reverse read paths. A prior that carried the SAME AMID under a different
-- serial keys on `aser:<other serial>`, so the unit_key index above cannot find it;
-- likewise for a shared AID. Without these two the reverse match would scan every
-- identity row in the database.
CREATE INDEX IF NOT EXISTS transmission_unit_identity_session_amid
  ON transmission_unit_identity (session_uuid, amid);
CREATE INDEX IF NOT EXISTS transmission_unit_identity_session_aid
  ON transmission_unit_identity (session_uuid, aid);

COMMENT ON TABLE transmission_unit_identity IS
  'The appliance-side identifiers one transmission carried for one CCE unit (0rfk); read back to observe an identifier arriving beside a different companion across transmissions in a session. Purged with its transmission.';
COMMENT ON COLUMN transmission_unit_identity.session_uuid IS
  'Denormalized from transmission.session_uuid so the prior-identity lookup is answered from this table''s indexes.';
COMMENT ON COLUMN transmission_unit_identity.unit_key IS
  'Appliance identity key — aser:<serial> preferred, amid:<supplier id> fallback (src/identity/unit-key.ts, bd p98); the prefix is part of the key.';
COMMENT ON COLUMN transmission_unit_identity.aser IS
  'Appliance manufacturer serial number as reported, trimmed; NULL when the report carried no usable value.';
COMMENT ON COLUMN transmission_unit_identity.amid IS
  'Appliance Monitoring ID — the supplier platform''s handle, an rtmd-report property only — as reported, trimmed; NULL when absent.';
COMMENT ON COLUMN transmission_unit_identity.aid IS
  'Appliance identifier — the employer''s asset id, optional on both branches — as reported, trimmed; NULL when absent.';
