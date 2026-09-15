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

/**
 * Derived display status the matrix renders as a badge (no recompute).
 * `pass-outdated` (2kx) = checked and passed, but against a registered-but-OLDER
 * schema version; distinct from `pass` so the badge can say so, and never
 * `untested`, which would claim we did not check at all.
 */
export type DisplayStatus =
  | 'pass'
  | 'pass-outdated'
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
  /**
   * How many of this requirement's findings carry the `outdated` flag (2kx) —
   * a modifier, not a severity, hence its own field beside `counts`. Nonzero is
   * exactly what makes `status` `pass-outdated`.
   */
  outdated: number;
  status: DisplayStatus;
}

/* ------------------------------------------------------------------ *
 * Session / transmission types — mirror src/api/sessions.ts responses.
 * ------------------------------------------------------------------ */

/** The §7 severity carried by a per-transmission finding. */
export type Severity = 'pass' | 'fail' | 'info';

/**
 * The requirement lineage a finding grades against (by1c.5): '2025' is the
 * contract in force, 'ds013' the DS01.3 shadow run. Re-declared here from
 * `Profile` in src/db/repository.ts for the same reason as the unions above —
 * this file is browser code and imports no backend module.
 */
export type Profile = '2025' | 'ds013';

/**
 * Which lineage is the contract in force — MIRRORS `CONTRACT_PROFILE` in
 * src/schema-registry.ts, re-declared rather than imported for the same reason
 * as the unions above (browser code imports no backend module).
 *
 * Every dashboard surface that names "the" schema version selects on this, so
 * the day the backend constant flips, these follow by editing one literal.
 */
export const CONTRACT_PROFILE: Profile = '2025';

/**
 * One lineage's verdict on one transmission — mirror `Verdict` in
 * src/api/verdicts.ts (browser code, re-declared; see the header).
 *
 * `null` is a SHADOW-ONLY answer and it is NOT a soft fail: that lineage never
 * ran on the transmission (an unparseable body, a `meta.schemaVersion` outside
 * both lineages, a transport stage that halted first). Render it as "not
 * measured", never as a failure.
 */
export type Verdict = 'pass' | 'fail' | null;

/**
 * A transmission's verdicts KEYED BY PROFILE ID — mirror `VerdictsByProfile` in
 * src/api/sessions.ts. `{ '2025': 'pass', 'ds013': 'fail' }` reads "conforms
 * today, would not under DS01.3".
 *
 * Keyed by lineage rather than by primary/shadow role because the role varies
 * per transmission in a mixed stream while the dashboard's contract column does
 * not. A key is ABSENT only when the service registers no such lineage — read it
 * through {@link SessionMeta.shadowProfile}, which is null in exactly that case.
 */
export type VerdictsByProfile = Partial<Record<Profile, Verdict>>;

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
  /**
   * Structured signature fields (4h4.1) — mirror toFindingView at
   * src/api/sessions.ts. Schema (Ajv) errors carry `keyword`/`instancePath`/
   * `param`; transport/heuristic findings carry a stable `code`. The web
   * `instancePath` mirrors the backend `f.instance_path`.
   */
  keyword: string | null;
  instancePath: string | null;
  param: string | null;
  code: string | null;
  /**
   * Which requirement lineage this finding graded against (by1c.5): the contract
   * in force, or the DS01.3 shadow run. Since by1c.6 a single transmission
   * carries findings of both lineages, and everything on this side that grades
   * (the verdict dots, the findings cell, the profile-disjoint signature list)
   * reads this field to tell them apart.
   */
  profile: Profile;
}

/**
 * Namespace prefix that separates ADVISORY ids from §7 requirement ids
 * (`adv.null_padding` versus `3.2`). MIRRORED from `ADVISORY_PREFIX` in
 * src/ingest/stages/semantic/advisory.ts rather than imported — this file is
 * browser code and imports no backend module (see the header), the same rule
 * that re-declares the §7 unions above. Keep the two in step; the prefix is
 * unambiguous because every §7 id is digits and dots, so no requirement can
 * ever start with `adv.`.
 */
export const ADVISORY_PREFIX = 'adv.';

/**
 * Whether a finding is an ADVISORY — an observation the service holds no verdict
 * on — rather than a §7 compliance finding. Advisories carry their `adv.*` id in
 * BOTH `requirement` (which is why the §7 matrix ignores them) and `code`.
 *
 * Every consumer that renders, counts, or colours findings must branch on this:
 * an advisory has no requirement to cross-link to and no verdict to display, and
 * it must never reach a pass/fail tally. See src/web/advisories.ts.
 */
export function isAdvisory(f: Pick<FindingView, 'requirement'>): boolean {
  return f.requirement.startsWith(ADVISORY_PREFIX);
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
  /**
   * This transmission's verdict under each registered lineage (by1c.9), served
   * on the summary read AND on every paginated list row, so the list renders its
   * verdict dots without a second fetch.
   */
  verdicts: VerdictsByProfile;
  /**
   * Which lineage drove the HTTP status — the one `schema_version` resolved to.
   * Null when nothing resolved (no version, or one outside both lineages), where
   * no primary validator ran. Derived server-side from the registry; it is NOT
   * the same question as `verdicts`, which reports every lineage's answer.
   */
  primaryProfile: Profile | null;
}

/**
 * §1.3 opt-in auth method — mirrors `AuthMethod` in src/db/repository.ts (kept as
 * a local re-declaration: this file is browser code and imports no backend
 * module). Read back on {@link SessionMeta} for display AND sent on
 * {@link EnableAuthRequest} by the Setup panel's method picker.
 *
 * `bearer` is the DS01.3 clause 5.1.5 / RFC 6750 addition — `Authorization:
 * Bearer <token>`. It is DISTINCT from `header`, whose token rides in a
 * configurable header (e.g. `X-CCE-Token`) with no scheme prefix.
 */
export type AuthMethod = 'header' | 'basic' | 'bearer';

/** Session metadata the dashboard surfaces (no secrets). */
export interface SessionMeta {
  uuid: string;
  /** ISO timestamp string. */
  created_at: string;
  /** ISO timestamp string, or null when no POST has landed yet. */
  last_post_at: string | null;
  auth_enabled: boolean;
  auth_method: AuthMethod | null;
  /**
   * The lineage in force — what the 27-row matrix, the scorecard, the pass rate
   * and the response code grade (by1c.9). Served rather than assumed so a
   * surface can name the contract without mirroring the constant a third time.
   */
  contractProfile: Profile;
  /**
   * The lineage previewed beside it, or null when the service registers only
   * one. NULL IS THE HIDE SIGNAL: with no shadow lineage there is no readiness
   * strip, no second verdict dot and no "would also fail" group, and no surface
   * needs to test for a version by name to know it.
   */
  shadowProfile: Profile | null;
}

/** 201 response of POST /api/sessions. */
export interface CreateSessionResponse {
  uuid: string;
  /** Relative path, e.g. `/i/{uuid}`. */
  ingestUrl: string;
  /** Relative path, e.g. `/d/{uuid}`. */
  dashboardUrl: string;
}

/**
 * One aggregated signature — mirror src/api/signatures.ts `Signature`
 * (SignatureView). Pre-rolled server-side so the browser never needs the raw
 * findings to render the §3.2 compliance signatures.
 */
export interface Signature {
  /** Stable key the list cross-filter matches against (?signatureKey=). */
  key: string;
  /** The requirement this signature belongs to (e.g. "3.2"); '' for an advisory. */
  req: string;
  /**
   * The requirement lineage this signature belongs to (by1c.7); NULL for an
   * advisory, which grades against no lineage. Verdict surfaces filter this to
   * {@link CONTRACT_PROFILE} — a 'ds013' signature is shadow information and
   * must never land in a §7 matrix row or a defect count.
   */
  profile: Profile | null;
  /** Human title for the issue. */
  title: string;
  /**
   * 'schema' for Ajv-keyword defects, 'check' for transport/heuristic codes,
   * 'advisory' for an `adv.*` observation (keyed `adv|<adv.id>`, `req` '',
   * `sev` 'info'). An advisory signature is NOT a defect: it is excluded from
   * `scoped.distinctIssues` server-side and must never feed a verdict count.
   */
  kind: 'schema' | 'check' | 'advisory';
  /** Severity of the representative finding ('fail' or 'info' for outdated). */
  sev: Severity;
  /** Raw finding count across all transmissions. */
  count: number;
  /** Distinct transmissions exhibiting this signature. */
  txCount: number;
  /** Distinct sources exhibiting this signature ('' counts as one). */
  sourceCount: number;
  /** Earliest received_at (ISO string) exhibiting this signature. */
  first: string;
  /** Latest received_at (ISO string) exhibiting this signature. */
  last: string;
  /** Representative JSON Pointer for the issue (may be null). */
  examplePointer: string | null;
}

/**
 * One pass-rate trend bucket — mirror src/api/scope.ts `TrendBucket`. `rate` is
 * pass/(pass+fail), or null for an empty bucket (a RENDER concern downstream).
 */
export interface TrendBucket {
  tot: number;
  fail: number;
  rate: number | null;
}

/**
 * One filter `<select>` option — mirror src/api/source.ts `SourceCount`
 * (SourceView + count): a source view plus its in-scope count.
 */
export interface SourceCount {
  source: string;
  sourceCode: string;
  sourceLabel: string;
  /** How many transmissions in the scoped set carry this source. */
  count: number;
}

/**
 * The scope-relative gradeable rollup (scorecard numbers) — mirror
 * src/api/scope.ts `Rollup`.
 */
export interface Rollup {
  total: number;
  gradeable: number;
  passing: number;
  failing: number;
  untested: number;
}

/**
 * Scope totals for the readout above the list — mirror src/api/scope.ts
 * `ScopeTotals`. NOTE the nested `scoped.scoped`: this is the SUMMARY response's
 * `scoped` OBJECT, DISTINCT from the LIST response's plain-number `scoped`
 * denominator (see {@link ListTransmissionsResponse}). Do NOT share a type.
 */
export interface ScopeTotals {
  /** Total transmissions in the scope. */
  scoped: number;
  /** Transmissions exhibiting ≥1 fail finding. */
  withFailures: number;
  /** Distinct signature count over the scope. */
  distinctIssues: number;
  /**
   * Distinct CCE units reported on in the scope (p98) — AMID for RTMD reports,
   * AMFR+ASER for EMS reports; see src/api/scope.ts `unitTotals` for the key
   * rule and its schema citations. A count of what was RECEIVED, never fleet
   * coverage (DESIGN §7).
   */
  units: number;
  /** Reports in the scope that carried neither AMID nor ASER. */
  unidentifiedReports: number;
}

/**
 * 200 response of the scope-aware GET /api/sessions/:uuid?window&source — mirror
 * the LANDED reply.send at src/api/sessions.ts. The full `transmissions` array
 * still ships here (for the docked detail pane); the paginated list is a
 * separate read ({@link listTransmissions}).
 */
export interface SessionResponse {
  session: SessionMeta;
  transmissions: TransmissionView[];
  summary: ComplianceRow[];
  rollup: Rollup;
  signatures: Signature[];
  trend: TrendBucket[];
  sources: SourceCount[];
  /** SUMMARY `scoped` is a ScopeTotals OBJECT (`scoped.scoped` is nested). */
  scoped: ScopeTotals;
  /** ISO timestamp string when the session expires (DESIGN §11). */
  expiresAt: string;
  /**
   * The shadow lineage's current bytes, or null when none is registered (the
   * same condition as `session.shadowProfile === null`). The legend renders its
   * label from THIS — version, hash, and `draftDate` when the entry is an
   * unpublished proposal — never from a literal of its own (3cq, by1c.22).
   */
  shadow: ShadowProvenance | null;
  /**
   * How much of the scope's contract-conformant traffic would also pass the
   * shadow lineage, and what stands in the way. Null when no shadow lineage is
   * registered. Computed over the scoped set (window + source), NOT over the
   * list's `failuresOnly`/`signatureKey` filters.
   */
  readiness: Readiness | null;
  /**
   * The schema versions the service grades against, oldest first, each with the
   * sha256 the server computed over its vendored bytes at boot. The Setup
   * panel's provenance line renders THIS — never a literal of its own (3cq).
   */
  schemas: SchemaProvenance[];
}

/**
 * The shadow lineage's current bytes — mirror the `shadow` object built in
 * src/api/sessions.ts (browser code, re-declared; see the header).
 *
 * `draftDate` is present only for an UNPUBLISHED proposal, and its presence is
 * what licenses a surface to call the entry a draft; a published shadow schema
 * is identified by version and hash alone.
 */
export interface ShadowProvenance {
  version: string;
  sha256: string;
  draftDate?: string;
}

/**
 * The readiness strip's numbers — mirror `Readiness` in src/api/verdicts.ts.
 *
 * `reasons` are the shadow-lineage fail signatures of the CONTRACT-PASSING
 * transmissions, most widespread first: of the traffic that conforms today, what
 * would stop it conforming under the shadow lineage. A transmission already
 * failing the contract contributes no reason — it has a defect to fix either
 * way — and one whose shadow verdict is null counts in neither number.
 */
export interface Readiness {
  /** Transmissions in scope whose contract verdict is 'pass'. */
  passingContract: number;
  /** Of those, the ones whose shadow verdict is also 'pass'. */
  passingBoth: number;
  /** What stands between the two counts, txCount descending. */
  reasons: Signature[];
}

/** One registered schema — mirrors `SchemaProvenance` in src/schema-registry.ts. */
export interface SchemaProvenance {
  version: string;
  /** Lowercase hex SHA-256 of the vendored bytes, computed server-side. */
  sha256: string;
  /**
   * Which lineage the version belongs to. Not every registered schema is
   * contract-grade: the DS01.3 draft rides in this same list as the shadow
   * lineage, so any surface that names "the" schema version must select on this
   * (see CONTRACT_PROFILE in Setup.tsx) rather than taking the newest entry.
   */
  profile: Profile;
  /**
   * ISO date of the draft these bytes are a copy of, present only for an
   * unpublished proposal — what licenses a surface to label the entry a draft.
   */
  draftDate?: string;
}

/**
 * Optional body for POST /api/sessions/:uuid/auth. Every field is optional; an
 * omitted `method` still means `header` (back-compat), but an unrecognised one is
 * rejected with 400 `invalid_method` rather than silently falling back.
 */
export interface EnableAuthRequest {
  method?: AuthMethod;
  /** Custom header name for the `header` method (e.g. `X-CCE-Token`). */
  headerName?: string;
  /** Username for the `basic` method. */
  username?: string;
}

/**
 * 201 response of POST /api/sessions/:uuid/auth — mirror src/api/sessions.ts
 * verbatim. The `token` (header, bearer) / `password` (basic) is the show-once
 * plaintext (DESIGN §12); it is never returned again, so the UI must surface it
 * now.
 */
export type EnableAuthResponse =
  | {
      uuid: string;
      auth_enabled: true;
      auth_method: 'header';
      /** The configurable header the token rides in, bare (no scheme prefix). */
      auth_header_name: string;
      /** Show-once plaintext token (§12). */
      token: string;
    }
  | {
      uuid: string;
      auth_enabled: true;
      auth_method: 'basic';
      username: string;
      /** Show-once plaintext password (§12). */
      password: string;
    }
  | {
      uuid: string;
      auth_enabled: true;
      auth_method: 'bearer';
      /** Always the literal `Authorization` — RFC 6750 fixes the header. */
      auth_header_name: string;
      /** Show-once plaintext token, sent as `Authorization: Bearer <token>` (§12). */
      token: string;
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
 * Read a session by uuid, optionally scoped by `window`/`source` (the scope-aware
 * summary, 4h4.4). Returns a discriminated result: `{ ok: false }` for a 404
 * (unknown/expired uuid) so the shell can render a friendly state; throws only on
 * network / unexpected (5xx) errors. `opts` is optional so existing no-arg
 * callers keep compiling; only provided keys are serialized into the query.
 */
export async function getSession(
  uuid: string,
  opts?: { window?: string; source?: string },
): Promise<GetSessionResult> {
  const params = new URLSearchParams();
  if (opts?.window !== undefined) params.set('window', opts.window);
  if (opts?.source !== undefined) params.set('source', opts.source);
  const qs = params.toString();
  const url = `/api/sessions/${encodeURIComponent(uuid)}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!res.ok) {
    throw new Error(`getSession failed: HTTP ${res.status}`);
  }
  return { ok: true, data: (await res.json()) as SessionResponse };
}

/**
 * 200 response of the paginated GET /api/sessions/:uuid/transmissions (4h4.5) —
 * mirror the LANDED reply.send at src/api/sessions.ts. The page rows are the SAME
 * TransmissionView the summary ships (source dimension + inlined findings).
 */
export interface ListTransmissionsResponse {
  transmissions: TransmissionView[];
  /**
   * LIST `scoped` is a plain NUMBER: the post-all-filters denominator the
   * "showing {visible} of {scoped}" header reads. DISTINCT from the summary's
   * {@link ScopeTotals} object — do NOT conflate them.
   */
  scoped: number;
  /** Opaque cursor for the next page, or null when there is no more. */
  nextCursor: string | null;
  hasMore: boolean;
}

/** Discriminated result of {@link listTransmissions} (mirrors GetSessionResult). */
export type ListTransmissionsResult =
  | { ok: true; data: ListTransmissionsResponse }
  | { ok: false; status: number };

/**
 * Read a page of a session's transmissions, scoped + filtered + cursor-paginated
 * (4h4.5). `failuresOnly` serializes as `failuresOnly=true`; falsy/absent params
 * are OMITTED. `cursor` is an OPAQUE token from a prior page's `nextCursor` —
 * passed back verbatim, never parsed client-side. Returns a discriminated result
 * ({ ok: false } for a 404 unknown/expired uuid) mirroring {@link getSession};
 * throws only on network / unexpected (5xx) errors.
 */
export async function listTransmissions(
  uuid: string,
  opts: {
    window?: string;
    source?: string;
    failuresOnly?: boolean;
    signatureKey?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<ListTransmissionsResult> {
  const params = new URLSearchParams();
  if (opts.window !== undefined) params.set('window', opts.window);
  if (opts.source !== undefined) params.set('source', opts.source);
  if (opts.failuresOnly) params.set('failuresOnly', 'true');
  if (opts.signatureKey !== undefined && opts.signatureKey.length > 0) {
    params.set('signatureKey', opts.signatureKey);
  }
  if (opts.cursor !== undefined && opts.cursor.length > 0) params.set('cursor', opts.cursor);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const url = `/api/sessions/${encodeURIComponent(uuid)}/transmissions${qs ? `?${qs}` : ''}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!res.ok) {
    throw new Error(`listTransmissions failed: HTTP ${res.status}`);
  }
  return { ok: true, data: (await res.json()) as ListTransmissionsResponse };
}

/**
 * Enable (or rotate) §1.3 opt-in auth for a session. POST /api/sessions/:uuid/auth.
 * `body.method` selects one of the three DS01.3 methods (default `header`); the
 * response arm is discriminated by the method the service actually configured.
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
