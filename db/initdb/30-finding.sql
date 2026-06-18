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
  outdated        boolean       NOT NULL DEFAULT false,

  -- STRUCTURED signature fields (4h4.1): a signature collapses identical defects
  -- into one issue by keying off these fields, never the English message string
  -- (which drifts across Ajv versions). All nullable — populated only where they
  -- apply, NULL otherwise.

  -- Ajv keyword for schema (§3.2) errors — the defect CLASS (required / format /
  -- additionalProperties / type / enum / minimum / maximum / …). NULL for
  -- non-schema findings.
  keyword         text,

  -- Ajv instancePath for schema errors, e.g. '/data/0/ABST'. NULL when the
  -- finding is not a schema error.
  instance_path   text,

  -- The identifying param pulled from the Ajv error (missingProperty / format /
  -- additionalProperty / enum-of / limit / …) — NOT the offending value. NULL
  -- when n/a.
  param           text,

  -- Stable check code for transport/heuristic findings (e.g. 'tx.missing_charset',
  -- 'tx.outdated_schema'). NULL for schema findings (those key off keyword).
  code            text
);

COMMENT ON TABLE finding IS
  'Per-requirement result for a transmission; severity is the §7 pass/fail/info honesty class.';
COMMENT ON COLUMN finding.pointer IS
  'JSON Pointer into the payload where relevant (e.g. schema-error location); NULL otherwise.';
COMMENT ON COLUMN finding.outdated IS
  'TRUE for the §3.2 info finding on an outdated-but-valid schema version; FALSE otherwise.';
COMMENT ON COLUMN finding.keyword IS
  'Ajv keyword for §3.2 schema errors (defect class, closed vocabulary); NULL for non-schema findings.';
COMMENT ON COLUMN finding.instance_path IS
  'Ajv instancePath for schema errors (e.g. /data/0/ABST); NULL when not a schema error.';
COMMENT ON COLUMN finding.param IS
  'Identifying param of a schema error (missingProperty / format / additionalProperty / …) — NOT the bad value; NULL when n/a.';
COMMENT ON COLUMN finding.code IS
  'Stable check code for transport/heuristic findings (e.g. tx.missing_charset); NULL for schema findings.';
