/**
 * The runner's LIVE half (8qa.2) — the only module in the exercise suite that
 * opens a socket.
 *
 * It speaks to a DEPLOYED validator over its public HTTP surface, exactly as a
 * supplier's system would: mint a session through the normal capability-URL path
 * (`POST /api/sessions`), POST transmissions at `/i/{uuid}`, and read the results
 * back through the dashboard API (`GET /api/sessions/{uuid}/transmissions`). It
 * imports no database code and no pipeline code on purpose — a harness that
 * reached inside the service would stop being a test of the interface.
 *
 * FAIL FAST, AND SAY WHERE. Every request is wrapped so a refused connection, a
 * DNS miss or a timeout surfaces as an {@link ExerciseHttpError} naming the URL
 * and what the operator should check, rather than as a bare `TypeError: fetch
 * failed` from three frames down.
 */

import type { Verdict } from '../../api/verdicts.js';
import type { Severity } from '../../db/repository.js';
import type { Profile } from '../../schema-registry.js';
import type { WireRequest } from '../transforms/transport.js';
import type {
  LensSummaryRow,
  ObservedFinding,
  VerdictsByProfile,
  VerdictsByTransmission,
} from './assertions.js';

/** Per-request timeout. Generous: the 1MB §1.4 body is the slowest thing sent. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many transmissions to pull per page of the dashboard list (its own cap). */
const PAGE_SIZE = 200;

/** Anything that went wrong talking to the target instance. */
export class ExerciseHttpError extends Error {}

/** What `POST /api/sessions` hands back (DESIGN.md §5): RELATIVE capability paths. */
export interface SessionHandle {
  readonly uuid: string;
  /** e.g. `/i/{uuid}` — relative, because the origin belongs to the proxy. */
  readonly ingestUrl: string;
  /** e.g. `/d/{uuid}`. */
  readonly dashboardUrl: string;
}

/** The result of one played POST, before it is judged. */
export interface IngestResult {
  readonly status: number;
  /** The id the ingest response named, or `null` for a pre-persistence halt. */
  readonly transmissionId: string | null;
}

/** Strip a trailing slash so `${base}${path}` never doubles it. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ExerciseHttpError(`not a valid base URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ExerciseHttpError(`base URL must be http(s): ${raw}`);
  }
  return trimmed;
}

/** One fetch, with a timeout and a connection error the operator can act on. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ExerciseHttpError(
      `cannot reach ${url}: ${reason}\n` +
        '  Is the validator running and reachable at that base URL? ' +
        '(locally: `docker compose up -d postgres && npm run dev`)',
    );
  }
}

/** Read a JSON body, or fail with the status + a snippet of what came back. */
async function readJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ExerciseHttpError(
      `${what}: HTTP ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Mint a fresh session through the normal capability-URL path — the suite never
 * assumes a fixture session, and it never touches a session it did not create.
 * This doubles as the reachability preflight: it is the first request made.
 */
export async function createExerciseSession(baseUrl: string): Promise<SessionHandle> {
  const url = `${baseUrl}/api/sessions`;
  const response = await send(url, { method: 'POST' });
  if (response.status !== 201) {
    throw new ExerciseHttpError(
      `POST /api/sessions returned HTTP ${response.status} (expected 201) — ` +
        'is that base URL really a CCE data delivery validator?',
    );
  }
  const body = (await readJson(response, 'POST /api/sessions')) as Partial<SessionHandle>;
  if (
    typeof body.uuid !== 'string' ||
    typeof body.ingestUrl !== 'string' ||
    typeof body.dashboardUrl !== 'string'
  ) {
    throw new ExerciseHttpError('POST /api/sessions returned an unrecognised body');
  }
  return { uuid: body.uuid, ingestUrl: body.ingestUrl, dashboardUrl: body.dashboardUrl };
}

/**
 * Opt the session into §1.3 bearer auth through the SAME dashboard API a supplier
 * would use (`POST /api/sessions/{uuid}/auth`, DS01.3 clause 5.1.4 / RFC 6750),
 * and return the show-once plaintext token for the runner's `TransportContext`.
 *
 * The service echoes the credential EXACTLY ONCE (DESIGN §12) — it stores only a
 * salted hash — so a lost token means re-POSTing here, which ROTATES it. The
 * runner therefore enables auth once per run and keeps the value.
 *
 * The app registers a single `*` content-type parser that keeps raw bytes for the
 * §1.4 size stage, so this route parses the JSON body itself; the header is sent
 * for honesty rather than because Fastify dispatches on it.
 *
 * STICKY: this flips `auth_enabled` on the session row, and the ingest pipeline
 * then 401s every unauthenticated POST to it. See `ExerciseCase.setup`
 * (../case.ts) and ./run.ts for how the runner orders around that.
 */
export async function enableBearerAuth(baseUrl: string, uuid: string): Promise<string> {
  const url = `${baseUrl}/api/sessions/${uuid}/auth`;
  const response = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'bearer' }),
  });
  if (response.status !== 201) {
    throw new ExerciseHttpError(
      `POST /api/sessions/{uuid}/auth returned HTTP ${response.status} (expected 201) — ` +
        'the §1.3 exercise cases cannot be played without a credential.',
    );
  }
  const body = (await readJson(response, 'POST /api/sessions/{uuid}/auth')) as {
    auth_enabled?: unknown;
    auth_method?: unknown;
    token?: unknown;
  };
  if (body.auth_enabled !== true || body.auth_method !== 'bearer') {
    throw new ExerciseHttpError(
      'enabling §1.3 bearer auth did not report an auth-enabled bearer session',
    );
  }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new ExerciseHttpError('enabling §1.3 bearer auth returned no token');
  }
  return body.token;
}

/**
 * Play one materialized POST at the ingest path, honoring its wire request
 * VERBATIM — method, headers and body bytes exactly as the transport wrappers
 * left them. That fidelity is the whole point: a runner that re-serialized the
 * payload would quietly repair the §1.1/§1.4/§1.6 defects it is meant to send.
 *
 * A non-JSON response body is not an error here: Fastify's own generic 4xx
 * (e.g. an outer body-limit 413) is a legitimate answer to some cases, and the
 * status is what the case asserts. Only the transmission id is lost, which is
 * exactly right — no row was written.
 */
export async function playPost(
  baseUrl: string,
  ingestUrl: string,
  request: WireRequest,
): Promise<IngestResult> {
  const response = await send(`${baseUrl}${ingestUrl}`, {
    method: request.method,
    headers: request.headers,
    // Buffer is a Uint8Array; undici sends the bytes unchanged (no re-encoding).
    body: new Uint8Array(request.body),
  });
  const text = await response.text();
  let transmissionId: string | null = null;
  try {
    const body = JSON.parse(text) as { transmissionId?: unknown };
    if (typeof body.transmissionId === 'string') transmissionId = body.transmissionId;
  } catch {
    // Not our response body (see the note above) — status still stands.
  }
  return { status: response.status, transmissionId };
}

const SEVERITIES = new Set<string>(['pass', 'fail', 'info']);

/**
 * The lineages a finding can name on the wire. Written as an EXHAUSTIVE record
 * over {@link Profile} rather than as a list of strings, so registering a third
 * lineage is a compile error here instead of a value this guard silently drops
 * (the same device as `LINEAGE_NAME` in src/web/components/Setup.tsx).
 */
const KNOWN_PROFILES: Readonly<Record<Profile, true>> = { '2025': true, ds013: true };

function asProfile(raw: unknown): Profile | undefined {
  return typeof raw === 'string' && raw in KNOWN_PROFILES ? (raw as Profile) : undefined;
}

interface ListedTransmission {
  id?: unknown;
  findings?: unknown;
  verdicts?: unknown;
}

const VERDICTS = new Set<string>(['pass', 'fail']);

/**
 * The per-lineage verdicts one listed row carries (by1c.9), keyed by profile id.
 *
 * TOLERANT LIKE THE FINDING FIELDS. A key whose value is neither 'pass', 'fail'
 * nor `null` is dropped, and a row with no `verdicts` object at all yields an
 * empty record — which the lens audit reads as "this instance does not serve
 * verdicts" rather than as a disagreement (./assertions.ts states the rule).
 */
function asVerdicts(raw: unknown): VerdictsByProfile {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: VerdictsByProfile = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in KNOWN_PROFILES)) continue;
    if (value === null || VERDICTS.has(value as string)) out[key as Profile] = value as Verdict;
  }
  return out;
}

/** Everything one session read brings back about the rows the run wrote. */
export interface SessionEvidence {
  /** Findings keyed by the transmission id they were recorded against. */
  readonly findings: Map<string, ObservedFinding[]>;
  /** The per-lineage verdicts each of those transmissions carries (tfnv.10). */
  readonly verdicts: VerdictsByTransmission;
}

/**
 * Read every transmission of the session, following the list endpoint's cursor,
 * and index the inlined findings by transmission id — the attribution key the
 * assertions pool a case's evidence on.
 *
 * The per-lineage VERDICTS ride along from the same pages (tfnv.10). They are on
 * the row already, so the lens audit costs no extra request; reading them in a
 * second pass would also risk auditing a different set of rows than the findings
 * came from.
 *
 * The PAGINATED list is used rather than the session summary read: the summary
 * still ships the whole transmission array in one response, which is fine today
 * and stops being fine as 8qa.3–.5 grow the table.
 */
export async function fetchSessionEvidence(
  baseUrl: string,
  uuid: string,
): Promise<SessionEvidence> {
  const byTransmission = new Map<string, ObservedFinding[]>();
  const verdicts = new Map<string, VerdictsByProfile>();
  let cursor: string | null = null;

  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor !== null) query.set('cursor', cursor);
    const url = `${baseUrl}/api/sessions/${uuid}/transmissions?${query.toString()}`;
    const response = await send(url, { method: 'GET' });
    if (response.status !== 200) {
      throw new ExerciseHttpError(`GET ${url} returned HTTP ${response.status} (expected 200)`);
    }
    const page = (await readJson(response, 'the transmission list')) as {
      transmissions?: unknown;
      nextCursor?: unknown;
    };
    const transmissions = Array.isArray(page.transmissions) ? page.transmissions : [];
    for (const raw of transmissions as ListedTransmission[]) {
      if (typeof raw.id !== 'string') continue;
      verdicts.set(raw.id, asVerdicts(raw.verdicts));
      const findings = Array.isArray(raw.findings) ? raw.findings : [];
      byTransmission.set(
        raw.id,
        findings
          .filter(
            (f: { requirement?: unknown; severity?: unknown }) =>
              typeof f.requirement === 'string' && SEVERITIES.has(f.severity as string),
          )
          .map(
            (f: {
              requirement: string;
              severity: string;
              profile?: unknown;
              outdated?: unknown;
              summary?: unknown;
              detail?: unknown;
              code?: unknown;
            }) => ({
              requirement: f.requirement,
              severity: f.severity as Severity,
              // WHICH LINEAGE graded it (by1c.15). `FindingView` has carried this
              // since the session read learned about profiles, and the case
              // expectations match on it, so dropping it here would collapse both
              // lineages into one pool and let a draft finding satisfy a contract
              // expectation.
              //
              // TOLERANT OF ABSENCE, and deliberately so: the runner points at
              // whatever instance the operator names, which may be older than the
              // field. An unrecognised value is treated the same way. Either way
              // the finding is graded as the contract's, which is what an instance
              // that does not know about lineages is in fact reporting — and a
              // shadow expectation then fails loudly rather than matching
              // something nobody graded.
              profile: asProfile(f.profile),
              // The `outdated` MODIFIER (73r). `FindingView` has served it since
              // 2kx, and a case may now name it, so the pass-outdated case asserts
              // the flag itself rather than inferring it from a §3.2 `info`.
              //
              // TOLERANT OF ABSENCE like `profile`, but normalized rather than left
              // undefined: a finding with no `outdated` key — from an older
              // instance, or from any grader that simply never sets it — is a
              // finding that is not flagged, which is exactly `false`. So the
              // grading side never sees a third state.
              outdated: f.outdated === true,
              // The two pieces of ADVISORY PROSE (y0w4): `summary` is the
              // one-line observation shown on the row, `detail` the rationale
              // behind its expander. Carried so the run-wide audit in
              // ./assertions.ts can hold a live instance's copy to the wording
              // bar — the only place that path is checked end to end.
              //
              // TOLERANT OF ABSENCE like `profile`, and NOT normalized: a
              // non-string (absent, or `null` for a row written before the
              // column existed) becomes `undefined`, and the audit reads a
              // whole run of undefined summaries as "this instance does not
              // serve the field" rather than as copy that is missing. Coercing
              // to `''` here would erase that distinction at the boundary.
              summary: typeof f.summary === 'string' ? f.summary : undefined,
              detail: typeof f.detail === 'string' ? f.detail : undefined,
              // The stable CHECK CODE (tfnv.10), carried for the lens audit
              // alone: the DS01.3 fold routes a §3.1 finding onto clause 5.3.5
              // or 5.3.3 by it. Normalized to `null` when the wire carried no
              // string, which is the value the server's own fold sees for a
              // finding that has no code — so the two sides agree by shape
              // rather than by a second reading of the absent case.
              code: typeof f.code === 'string' ? f.code : null,
            }),
          ),
      );
    }
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) break;
    cursor = page.nextCursor;
  }

  return { findings: byTransmission, verdicts };
}

interface ServedSummaryRow {
  requirement?: unknown;
  counts?: { pass?: unknown; fail?: unknown; info?: unknown };
}

/** A served count, or 0 — the shape the audit compares against its own fold. */
function asCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * Read the session summary under one requirement package and return its rows
 * (tfnv.10): `GET /api/sessions/{uuid}?lens={lens}`.
 *
 * `null` means the target does not know this lens. That is the one read here
 * that a 4xx does not make an operator problem: an instance older than the lens
 * parameter answers HTTP 400 `unknown_lens`, and failing the run on it would say
 * "this validator is broken" about a validator that simply predates the feature.
 * The audit reports the null as a note (./assertions.ts). Any other non-200 is
 * still an {@link ExerciseHttpError}, because it is not something a version
 * difference explains.
 */
export async function fetchLensSummary(
  baseUrl: string,
  uuid: string,
  lens: Profile,
): Promise<LensSummaryRow[] | null> {
  const url = `${baseUrl}/api/sessions/${uuid}?lens=${encodeURIComponent(lens)}`;
  const response = await send(url, { method: 'GET' });
  if (response.status === 400) return null;
  if (response.status !== 200) {
    throw new ExerciseHttpError(`GET ${url} returned HTTP ${response.status} (expected 200)`);
  }
  const body = (await readJson(response, 'the session summary')) as {
    summary?: unknown;
    lens?: unknown;
  };
  // An instance that echoes a different package than the one asked for is not
  // reporting what this audit believes it is reporting, so the rows are refused
  // rather than graded against the wrong fold.
  if (typeof body.lens === 'string' && body.lens !== lens) {
    throw new ExerciseHttpError(
      `GET ${url} echoed lens '${body.lens}' — the summary rows are not the ${lens} package`,
    );
  }
  const rows = Array.isArray(body.summary) ? (body.summary as ServedSummaryRow[]) : [];
  return rows
    .filter((row) => typeof row.requirement === 'string')
    .map((row) => ({
      requirement: row.requirement as string,
      counts: {
        pass: asCount(row.counts?.pass),
        fail: asCount(row.counts?.fail),
        info: asCount(row.counts?.info),
      },
    }));
}
