-- transmission_unit_window — the ABST span each transmission covered, per CCE unit
-- (agj.24, the data model behind adv.abst_window_overlap).
--
-- PQS describes a common delivery failure as "a chunk of records placed at the end
-- of the previous data file": the same records arrive in two deliveries, each file
-- shows a gap, and time steps backwards at the boundary. From the receiving side
-- that is two transmissions in one session, for one appliance, whose timestamp
-- ranges intersect while their bodies differ. Nothing stored before this table
-- could see it: §1.8 keys on the whole-body hash and the transfer id, so two POSTs
-- sharing most of their records are byte-novel and both pass.
--
-- One row per report-unit per transmission. A body carrying several reports yields
-- several rows; a report that names no appliance (neither ASER nor AMID — the
-- identity rule in src/identity/unit-key.ts) or whose records carry no parseable
-- ABST writes no row, because there is no window to compare. `abst_min`/`abst_max`
-- are the window AS PARSED from the payload's own ABST strings, not a receipt time:
-- they are supplier-reported instants, and a supplier clock that is wrong makes
-- them wrong together. `record_count` counts only the records that parsed.
--
-- The alternative shape — one row per record — was declined on agj.14: a payload
-- can carry thousands of records, and the window is exact enough for the failure
-- PQS actually describes.
--
-- Numbering: 95, not 100. The entrypoint replays this directory in the shell's
-- glob order, which is byte order, and '-' sorts BEFORE any digit — so a file
-- named `100-…` would run immediately after `10-session.sql` and before
-- `20-transmission.sql`, and the foreign key below would fail on a fresh volume.
-- The two-digit decade scheme therefore ends at 90; later files take the gaps.
--
-- Retention (DESIGN.md §11): rows carry no independent lifetime. ON DELETE CASCADE
-- from `transmission` means the 7-day inactivity sweep reaches them transitively
-- (session → transmission → transmission_unit_window), so `purgeExpiredSessions`
-- still needs no per-table delete.
--
-- Applicability: docker-entrypoint-initdb.d only runs on the FIRST boot of a fresh
-- volume, so an EXISTING deployment will not pick this up automatically. Without
-- it every ingest write fails once the advisory lands, because the ingest route
-- writes these rows beside the findings. The statements below are therefore
-- written to be safe to apply by hand to a live database, and safe to re-apply:
--
--   docker exec -i cce-validator-db \
--     psql -U cce_validator -d cce_validator -f - < db/initdb/95-transmission-unit-window.sql
--
-- CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS make the DDL
-- idempotent, and COMMENT ON is a straight overwrite, so the file is a no-op on
-- second application.

CREATE TABLE IF NOT EXISTS transmission_unit_window (
  -- FK → transmission; cascade on delete so a session purge (§11) reaches these
  -- rows transitively, the same path finding takes (30-finding.sql).
  transmission_id uuid        NOT NULL
                              REFERENCES transmission (id) ON DELETE CASCADE,

  -- Denormalized from transmission.session_uuid so the prior-window lookup can be
  -- answered from this table's own index without joining to find the session.
  session_uuid    uuid        NOT NULL,

  -- The appliance identity key: 'aser:<serial>' preferred, 'amid:<supplier id>'
  -- as the fallback (src/identity/unit-key.ts, decided 2026-08-04 under bd p98).
  -- The prefix is part of the key: the two namespaces never reconcile.
  unit_key        text        NOT NULL,

  -- Earliest / latest parseable ABST among this report's records, as parsed.
  abst_min        timestamptz NOT NULL,
  abst_max        timestamptz NOT NULL,

  -- Records of this report whose ABST parsed — the population the window spans.
  record_count    integer     NOT NULL,

  -- One window per unit per transmission: a second report for the same appliance
  -- inside one body is the intra-payload case, graded elsewhere.
  PRIMARY KEY (transmission_id, unit_key)
);

-- The read path: "every earlier window in this session for these unit keys".
-- Leading on session_uuid keeps the lookup inside one supplier's sandbox.
CREATE INDEX IF NOT EXISTS transmission_unit_window_session_unit
  ON transmission_unit_window (session_uuid, unit_key);

COMMENT ON TABLE transmission_unit_window IS
  'The ABST span one transmission covered for one CCE unit (agj.24); read back to observe overlapping windows across transmissions in a session. Purged with its transmission.';
COMMENT ON COLUMN transmission_unit_window.session_uuid IS
  'Denormalized from transmission.session_uuid so the prior-window lookup is answered from this table''s index.';
COMMENT ON COLUMN transmission_unit_window.unit_key IS
  'Appliance identity key — aser:<serial> preferred, amid:<supplier id> fallback (src/identity/unit-key.ts, bd p98); the prefix is part of the key.';
COMMENT ON COLUMN transmission_unit_window.abst_min IS
  'Earliest parseable ABST among this report''s records, as the supplier reported it — not a receipt time.';
COMMENT ON COLUMN transmission_unit_window.abst_max IS
  'Latest parseable ABST among this report''s records, as the supplier reported it — not a receipt time.';
COMMENT ON COLUMN transmission_unit_window.record_count IS
  'Records of this report whose ABST parsed; records with absent, null or unparseable ABST are excluded and do not widen the window.';
