-- Indexes for the dashboard read path and §1.8 duplicate detection (DESIGN.md §8).
--
-- All three are session-scoped (leading `session_uuid`) because every query is
-- per capability-URL — the UUID is the tenant boundary.

-- Dashboard transmission list + per-session rollups: reverse-chronological by
-- arrival. Serves "latest N for this session" ORDER BY received_at DESC from
-- the index alone.
CREATE INDEX transmission_session_received_at
  ON transmission (session_uuid, received_at DESC);

-- §1.8 exact-replay detection: find prior transmissions in this session with the
-- same wire bytes. content_hash is NON-UNIQUE (see 20-transmission.sql) — this
-- index supports the lookup that GRADES repeats rather than dropping them.
CREATE INDEX transmission_session_content_hash
  ON transmission (session_uuid, content_hash);

-- §1.8 duplicate-transferId detection: find prior transmissions in this session
-- carrying the same meta.transferId.
CREATE INDEX transmission_session_transfer_id
  ON transmission (session_uuid, transfer_id);

-- Per-transmission finding fetch for the drill-down view (§10).
CREATE INDEX finding_transmission ON finding (transmission_id);

COMMENT ON INDEX transmission_session_received_at IS
  'Dashboard reverse-chronological list + per-session rollups (§8, §10).';
COMMENT ON INDEX transmission_session_content_hash IS
  'Exact-replay detection (§1.8); content_hash is NON-UNIQUE — repeats are graded, not dropped.';
COMMENT ON INDEX transmission_session_transfer_id IS
  'Duplicate-transferId detection (§1.8).';
