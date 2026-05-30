-- transmission — one row per `POST /i/{uuid}` (DESIGN.md §6, §8).
--
-- Mirrors ../tremble's `source_artifact` (content hash, byte size, content
-- type, received-at) with ONE DELIBERATE DIVERGENCE: tremble makes
-- `content_hash` UNIQUE to dedup-and-drop idempotent replays. We must NOT —
-- duplicate detection is the §1.8 signal we GRADE, so we record EVERY POST and
-- flag repeats instead of silently collapsing them. `content_hash` is
-- therefore NON-UNIQUE here.
--
-- The pipeline (§6) fills the parse/schema columns as it runs: a transmission
-- row is written even when parsing or schema validation fails, so the dashboard
-- can show what was rejected and why. `body` is NULL when the payload is
-- unparseable; `raw_body` is the size-bounded original kept for drill-down,
-- especially in the failure case.

CREATE TABLE transmission (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- FK → session; cascade on delete so retention (§11) purges a session and
  -- all its transmissions in one statement.
  session_uuid     uuid          NOT NULL
                                 REFERENCES session (uuid) ON DELETE CASCADE,

  received_at      timestamptz   NOT NULL DEFAULT now(),

  -- SHA-256 of the raw wire body. NON-UNIQUE by design (see header) — equal
  -- hashes across rows are exactly the §1.8 exact-replay signal we grade.
  content_hash     bytea,

  -- Exact bytes on the wire, measured post-encoding for the §1.4 1MB cap.
  wire_bytes       bigint        CHECK (wire_bytes IS NULL OR wire_bytes >= 0),

  content_type     text,                       -- request Content-Type (§1.2)
  content_encoding text,                       -- request Content-Encoding (§1.6)
  http_status      integer,                    -- status the pipeline returned (§6)

  -- Echoed transmission-meta fields, pulled from the parsed payload when present
  -- (§3.1). Kept as plain columns (in addition to `body`) so the duplicate /
  -- per-transfer indexes below can serve §1.8 without digging into jsonb.
  transfer_id      text,
  transfer_src     text,
  transfer_type    text,
  schema_version   text,                       -- raw meta.schemaVersion as sent (§9)

  -- Parsed payload; NULL when the body is unparseable (§8).
  body             jsonb,

  -- Size-bounded original bytes, retained for dashboard drill-down — especially
  -- valuable when parsing fails and `body` is NULL (§8, §10).
  raw_body         text,

  parse_ok         boolean,                    -- did §6 stage 6 (JSON parse) succeed?
  schema_ok        boolean                     -- did §6 stage 7 (Ajv validate) succeed?
);

COMMENT ON TABLE transmission IS
  'One row per POST /i/{uuid}. content_hash is NON-UNIQUE: every POST is recorded so §1.8 duplicates can be graded.';
COMMENT ON COLUMN transmission.content_hash IS
  'SHA-256 of the raw wire body; intentionally NON-UNIQUE — duplicate detection (§1.8) is graded, not deduplicated.';
COMMENT ON COLUMN transmission.body IS
  'Parsed JSON payload; NULL when the body is unparseable.';
COMMENT ON COLUMN transmission.raw_body IS
  'Size-bounded original bytes kept for drill-down, especially when parsing fails.';
