-- finding — one row per per-requirement result emitted by the pipeline (§6, §7, §8).
--
-- The compliance engine (M2/M5) writes a finding per check it runs against a
-- transmission: schema errors (one per Ajv error, with a JSON Pointer),
-- size/content-type/encoding observations, and the §1.8/§2.1/§3.x semantic
-- signals. `severity` carries the honesty classification at the row level
-- (§7): pass / fail / info.

CREATE TABLE finding (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK → transmission; cascade on delete so a session purge (§11) reaches
  -- findings transitively (session → transmission → finding).
  transmission_id uuid          NOT NULL
                                REFERENCES transmission (id) ON DELETE CASCADE,

  -- Requirement id this finding speaks to, e.g. '1.4', '3.2' (§7 matrix).
  requirement     text          NOT NULL,

  -- pass | fail | info — the row-level honesty class (§7). text + CHECK rather
  -- than an enum to avoid migrations as the matrix evolves.
  severity        text          NOT NULL CHECK (severity IN ('pass', 'fail', 'info')),

  detail          text,                        -- human-readable explanation for the dashboard

  -- JSON Pointer into the payload where relevant (e.g. the location of a schema
  -- error); NULL for findings not tied to a specific path (§8, §10).
  pointer         text,

  -- TRUE for the §3.2 info finding raised when a transmission validates against a
  -- valid-but-OLDER registered schema version (§7 outdated-but-valid): the body
  -- is accepted, but the dashboard surfaces an OUTDATED SCHEMA tag. FALSE for
  -- every other finding.
  outdated        boolean       NOT NULL DEFAULT false
);

COMMENT ON TABLE finding IS
  'Per-requirement result for a transmission; severity is the §7 pass/fail/info honesty class.';
COMMENT ON COLUMN finding.pointer IS
  'JSON Pointer into the payload where relevant (e.g. schema-error location); NULL otherwise.';
COMMENT ON COLUMN finding.outdated IS
  'TRUE for the §3.2 info finding on an outdated-but-valid schema version; FALSE otherwise.';
