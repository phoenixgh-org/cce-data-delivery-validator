/**
 * Typed client for the M3 sessions API, plus the response TS types the four
 * dashboard components import. This file is BROWSER code (uses fetch/window) and
 * is self-contained — it deliberately does NOT import backend modules, so the
 * §7 honesty-class / display-status unions are re-declared here verbatim from
 * src/api/compliance-matrix.ts.
 */

/* ------------------------------------------------------------------ *
 * §7 compliance types — mirror src/api/compliance-matrix.ts verbatim.
 * ------------------------------------------------------------------ */

/** Finding honesty class (DESIGN §7 legend: ✅🟡🔌📝🔒). */
export type ComplianceClass =
  | 'verified'
  | 'heuristic'
  | 'active-only'
  | 'attestation'
  | 'enforced'
  | 'none';

/** Derived display status the matrix renders as a badge (no recompute). */
export type DisplayStatus =
  | 'pass'
  | 'fail'
  | 'mixed'
  | 'untested'
  | 'not-exercised'
  | 'self-attestation'
  | 'enforced'
  | 'not-applicable';

/** Live per-requirement finding counts (DESIGN §8 severities). */
export interface FindingCounts {
  pass: number;
  fail: number;
  info: number;
}

/** One §7 matrix row joined with live counts + derived status. */
export interface ComplianceRow {
  requirement: string;
  summary: string;
  classes: ComplianceClass[];
  counts: FindingCounts;
  status: DisplayStatus;
}

/* ------------------------------------------------------------------ *
 * Session / transmission types — mirror src/api/sessions.ts responses.
 * ------------------------------------------------------------------ */

/** The §7 severity carried by a per-transmission finding. */
export type Severity = 'pass' | 'fail' | 'info';

/** A finding surfaced under a transmission's drill-down. */
export interface FindingView {
  requirement: string;
  severity: Severity;
  detail: string | null;
  pointer: string | null;
  /**
   * True for the §3.2 info finding raised when a transmission validated against a
   * valid-but-OUTDATED schema version — drives the dashboard's amber OUTDATED
   * SCHEMA tag (TransmissionsCard). False for every other finding.
   */
  outdated: boolean;
}

/** One transmission as the dashboard sees it (drill-down + findings). */
export interface TransmissionView {
  id: string;
  /** ISO timestamp string (serialized Date). */
  received_at: string;
  http_status: number | null;
  content_type: string | null;
  content_encoding: string | null;
  /** bigint serialized as a string by pg. */
  wire_bytes: string | null;
  schema_version: string | null;
  transfer_id: string | null;
  /**
   * SOURCE dimension (4h4.2) — derived server-side from `transfer_src` so the
   * list rows and the filter `<select>` share one derivation:
   *   - `source`      raw source key (empty string for the unknown bucket).
   *   - `sourceCode`  stable 3-letter UPPERCASE code (e.g. KAN) shown in the row.
   *   - `sourceLabel` human label (full source) shown as the row title attr.
   */
  source: string;
  sourceCode: string;
  sourceLabel: string;
  parse_ok: boolean | null;
  schema_ok: boolean | null;
  body: unknown;
  raw_body: string | null;
  findings: FindingView[];
}

/** §1.3 opt-in auth method (display only in M4). */
export type AuthMethod = 'header' | 'basic';

/** Session metadata the dashboard surfaces (no secrets). */
export interface SessionMeta {
  uuid: string;
  /** ISO timestamp string. */
  created_at: string;
  /** ISO timestamp string, or null when no POST has landed yet. */
  last_post_at: string | null;
  auth_enabled: boolean;
  auth_method: AuthMethod | null;
}

/** 201 response of POST /api/sessions. */
export interface CreateSessionResponse {
  uuid: string;
  /** Relative path, e.g. `/i/{uuid}`. */
  ingestUrl: string;
  /** Relative path, e.g. `/d/{uuid}`. */
  dashboardUrl: string;
}

/** 200 response of GET /api/sessions/:uuid. */
export interface SessionResponse {
  session: SessionMeta;
  transmissions: TransmissionView[];
  summary: ComplianceRow[];
  /** ISO timestamp string when the session expires (DESIGN §11). */
  expiresAt: string;
}

/** Optional body for POST /api/sessions/:uuid/auth (empty → defaults to `header`). */
export interface EnableAuthRequest {
  method?: AuthMethod;
  /** Custom header name for the `header` method (e.g. `X-CCE-Token`). */
  headerName?: string;
  /** Username for the `basic` method. */
  username?: string;
}

/**
 * 201 response of POST /api/sessions/:uuid/auth — mirror src/api/sessions.ts
 * verbatim. The `token` (header) / `password` (basic) is the show-once plaintext
 * (DESIGN §12); it is never returned again, so the UI must surface it now.
 */
export type EnableAuthResponse =
  | {
      uuid: string;
      auth_enabled: true;
      auth_method: 'header';
      auth_header_name: string;
      /** Show-once plaintext bearer token (§12). */
      token: string;
    }
  | {
      uuid: string;
      auth_enabled: true;
      auth_method: 'basic';
      username: string;
      /** Show-once plaintext password (§12). */
      password: string;
    };

/** 200 response of DELETE /api/sessions/:uuid/auth — mirror src/api/sessions.ts. */
export interface DisableAuthResponse {
  uuid: string;
  auth_enabled: false;
  auth_method: null;
}

/* ------------------------------------------------------------------ *
 * Client functions.
 * ------------------------------------------------------------------ */

/** Mint a new session. POST /api/sessions (no body). */
export async function createSession(): Promise<CreateSessionResponse> {
  const res = await fetch('/api/sessions', { method: 'POST' });
  if (!res.ok) {
    throw new Error(`createSession failed: HTTP ${res.status}`);
  }
  return (await res.json()) as CreateSessionResponse;
}

/** Discriminated result of {@link getSession}. */
export type GetSessionResult = { ok: true; data: SessionResponse } | { ok: false; status: number };

/**
 * Read a session by uuid. Returns a discriminated result: `{ ok: false }` for a
 * 404 (unknown/expired uuid) so the shell can render a friendly state; throws
 * only on network / unexpected (5xx) errors.
 */
export async function getSession(uuid: string): Promise<GetSessionResult> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(uuid)}`);
  if (res.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!res.ok) {
    throw new Error(`getSession failed: HTTP ${res.status}`);
  }
  return { ok: true, data: (await res.json()) as SessionResponse };
}

/**
 * Enable (or rotate) §1.3 opt-in auth for a session. POST /api/sessions/:uuid/auth.
 * Returns the show-once plaintext credential (token or password) — the caller MUST
 * surface it immediately; it is never returned again (§12).
 */
export async function enableAuth(
  uuid: string,
  body: EnableAuthRequest = {},
): Promise<EnableAuthResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(uuid)}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`enableAuth failed: HTTP ${res.status}`);
  }
  return (await res.json()) as EnableAuthResponse;
}

/** Disable §1.3 opt-in auth for a session. DELETE /api/sessions/:uuid/auth. */
export async function disableAuth(uuid: string): Promise<DisableAuthResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(uuid)}/auth`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`disableAuth failed: HTTP ${res.status}`);
  }
  return (await res.json()) as DisableAuthResponse;
}

/** 200 response of DELETE /api/sessions/:uuid/data — mirror src/api/sessions.ts. */
export interface DeleteSessionDataResponse {
  uuid: string;
  deleted: { transmissions: number };
}

/**
 * Delete all captured data for a session (the danger-zone "Delete all captured
 * data" control). DELETE /api/sessions/:uuid/data wipes the session's
 * transmissions + findings but KEEPS the session row + ingest URL alive, so the
 * caller should refetch afterward to render the empty state. Throws on a 404
 * (unknown/expired uuid) or any other non-ok status.
 */
export async function deleteSessionData(uuid: string): Promise<DeleteSessionDataResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(uuid)}/data`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`deleteSessionData failed: HTTP ${res.status}`);
  }
  return (await res.json()) as DeleteSessionDataResponse;
}
