-- session — one row per minted capability URL (DESIGN.md §3, §5, §8).
--
-- The UUID is both the ingest path (`/i/{uuid}`) and the dashboard key
-- (`/d/{uuid}`); possession is authority (§3). Minted by `POST /api/sessions`
-- (M3). `last_post_at` drives the 30-day inactivity retention sweep (§11);
-- it is NULL until the first POST arrives, so the retention worker falls back
-- to `created_at`.
--
-- §1.3 auth is an opt-in compliance layer, not a gate (§3). When a supplier
-- opts in via the dashboard, the service generates a credential and stores
-- only its hash — the secret is never persisted in the clear and is echoed to
-- the supplier exactly once (§12).
--
-- Applied as ordered SQL on first boot (mirrors ../tremble/db/initdb); a
-- migration runner is deferred (DESIGN.md §8).

CREATE TABLE session (
  uuid             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz   NOT NULL DEFAULT now(),

  -- NULL until the first POST; retention (§11) uses COALESCE(last_post_at, created_at).
  last_post_at     timestamptz,

  -- §1.3 opt-in auth. Disabled by default so onboarding has zero friction (§3).
  auth_enabled     boolean       NOT NULL DEFAULT false,

  -- 'header' (token in a configurable header) | 'basic' (HTTP Basic). NULL when
  -- auth is disabled. Kept as text + CHECK rather than an enum to avoid a
  -- migration when a method is added.
  auth_method      text          CHECK (auth_method IN ('header', 'basic')),

  -- Header name carrying the token when auth_method = 'header' (configurable per §1.3).
  auth_header_name text,

  -- Hash of the generated secret; never the plaintext (§12).
  auth_secret_hash text
);

COMMENT ON TABLE session IS
  'One capability-URL session: ingest path + dashboard key. Possession = authority (§3).';
COMMENT ON COLUMN session.last_post_at IS
  'Timestamp of the most recent POST; NULL until first POST. Drives 30-day retention (§11).';
COMMENT ON COLUMN session.auth_secret_hash IS
  'Hash of the opt-in §1.3 credential; plaintext is never stored (§12).';
