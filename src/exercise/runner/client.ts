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

import type { Severity } from '../../db/repository.js';
import type { WireRequest } from '../transforms/transport.js';
import type { ObservedFinding } from './assertions.js';

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

interface ListedTransmission {
  id?: unknown;
  findings?: unknown;
}

/**
 * Read every transmission of the session, following the list endpoint's cursor,
 * and index the inlined findings by transmission id — the attribution key the
 * assertions pool a case's evidence on.
 *
 * The PAGINATED list is used rather than the session summary read: the summary
 * still ships the whole transmission array in one response, which is fine today
 * and stops being fine as 8qa.3–.5 grow the table.
 */
export async function fetchFindingsByTransmission(
  baseUrl: string,
  uuid: string,
): Promise<Map<string, ObservedFinding[]>> {
  const byTransmission = new Map<string, ObservedFinding[]>();
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
      const findings = Array.isArray(raw.findings) ? raw.findings : [];
      byTransmission.set(
        raw.id,
        findings
          .filter(
            (f: { requirement?: unknown; severity?: unknown }) =>
              typeof f.requirement === 'string' && SEVERITIES.has(f.severity as string),
          )
          .map((f: { requirement: string; severity: string }) => ({
            requirement: f.requirement,
            severity: f.severity as Severity,
          })),
      );
    }
    if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) break;
    cursor = page.nextCursor;
  }

  return byTransmission;
}
