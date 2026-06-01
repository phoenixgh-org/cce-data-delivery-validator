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
