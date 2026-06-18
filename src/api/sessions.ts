/**
 * Sessions API — `POST /api/sessions` (DESIGN.md §5).
 *
 * Mints a new validator session (auth disabled by default — zero-friction
 * onboarding, §3) and returns the capability paths a supplier needs:
 *
 *   - `ingestUrl`    — where transmissions are POSTed (`/i/{uuid}`, §6).
 *   - `dashboardUrl` — where results are viewed (`/d/{uuid}`; lands in M4).
 *
 * Both are RELATIVE path strings, not absolute URLs (DESIGN.md §5): the public
 * origin is owned by the reverse proxy, so the API does not fabricate a host.
 *
 * This endpoint takes NO request body. The app strips Fastify's body parsers and
 * keeps raw bytes for ingest (§1.4), so this handler must not read/parse a body.
 *
 * `GET /api/sessions/:uuid` reads back everything the dashboard surfaces
 * (DESIGN.md §10): session metadata, the reverse-chron transmission list with
 * each transmission's findings + drill-down bytes, and the §7 compliance summary
 * derived from the session's findings. JSON-only — no HTML/web UI (that's M4).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { computeComplianceSummary } from './compliance-matrix.js';
import type { FindingCountsByRequirement } from './compliance-matrix.js';
import {
  inScope,
  parseSource,
  parseWindow,
  passTrend,
  rollup,
  scopeTotals,
  scopeTransmissions,
  windowLowerBound,
} from './scope.js';
import { computeSignatures, txMatchesSig } from './signatures.js';
import type { SignatureTransmission } from './signatures.js';
import { deriveSourceView, sourceCounts } from './source.js';
import { generateCredential } from '../auth/credential.js';
import {
  RETENTION_MS,
  createSession,
  deleteSessionData,
  disableAuth,
  enableAuth,
  getSession,
  listFindingsForSession,
  listFindingsInWindow,
  listTransmissions,
  listTransmissionsInWindow,
} from '../db/repository.js';
import type { AuthMethod, FindingRow, Severity, TransmissionRow } from '../db/repository.js';

/** Findings as surfaced per-transmission on the dashboard (drill-down detail). */
function toFindingView(f: FindingRow) {
  return {
    requirement: f.requirement,
    severity: f.severity,
    detail: f.detail,
    pointer: f.pointer,
    outdated: f.outdated,
    // Structured signature fields (4h4.1): schema errors carry keyword/
    // instancePath/param; transport/heuristic findings carry a stable code.
    keyword: f.keyword,
    instancePath: f.instance_path,
    param: f.param,
    code: f.code,
  };
}

/**
 * Order findings ascending by §-number for the per-tx drill-down. Requirements are
 * dotted ids ("1.2", "1.10", "3.2"), so a plain string sort would mis-rank "1.10"
 * before "1.2"; `numeric: true` compares each numeric run by VALUE, giving true
 * section order. Sort is stable, so multiple findings under one requirement keep
 * their insertion (pipeline) order.
 */
function byRequirement(a: FindingRow, b: FindingRow): number {
  return a.requirement.localeCompare(b.requirement, undefined, { numeric: true });
}

/**
 * Build the per-transmission view (list row + drill-down detail) from a
 * transmission row and its pre-grouped findings. Shared by the summary read
 * (`GET /api/sessions/:uuid`) and the paginated list (`…/transmissions`) so the
 * row shape — source dimension (4h4.2) + inlined findings — is IDENTICAL on both.
 */
function toTransmissionView(t: TransmissionRow, findings: readonly FindingRow[]) {
  // SOURCE dimension (4h4.2): derive the presentation pair from the raw
  // transfer_src so list rows + the filter <select> agree (src/api/source.ts).
  const { source: src, sourceCode, sourceLabel } = deriveSourceView(t.transfer_src);
  return {
    id: t.id,
    received_at: t.received_at,
    http_status: t.http_status,
    content_type: t.content_type,
    content_encoding: t.content_encoding,
    // wire_bytes is a bigint → pg returns a string; pass it through as-is.
    wire_bytes: t.wire_bytes,
    schema_version: t.schema_version,
    transfer_id: t.transfer_id,
    // Keep the raw transfer_src for the window-aware source counts.
    transfer_src: t.transfer_src,
    // Raw source key + derived 3-letter code + human label (4h4.2).
    source: src,
    sourceCode,
    sourceLabel,
    parse_ok: t.parse_ok,
    schema_ok: t.schema_ok,
    body: t.body,
    raw_body: t.raw_body,
    findings: findings.slice().sort(byRequirement).map(toFindingView),
  };
}

type TransmissionView = ReturnType<typeof toTransmissionView>;

/** Group findings by transmission_id (preserves per-tx insertion order). */
function groupFindingsByTx(findings: readonly FindingRow[]): Map<string, FindingRow[]> {
  const byTx = new Map<string, FindingRow[]>();
  for (const f of findings) {
    const bucket = byTx.get(f.transmission_id);
    if (bucket) bucket.push(f);
    else byTx.set(f.transmission_id, [f]);
  }
  return byTx;
}

/**
 * Adapt a built view to the SignatureTransmission shape txMatchesSig/sigKey
 * consume — `received_at` as an ISO string, raw source key, camelCase findings.
 * Reusing the same projection the summary feeds computeSignatures keeps the
 * list's signatureKey cross-filter membership EQUAL to the signature engine.
 */
function asSignatureTx(t: TransmissionView): SignatureTransmission {
  return {
    id: t.id,
    received_at: new Date(t.received_at).toISOString(),
    source: t.source,
    findings: t.findings,
  };
}

/** The opaque list cursor: the (received_at, id) of the last row of a page. */
interface ListCursor {
  receivedAt: number;
  id: string;
}

/** Encode a cursor as a URL-safe base64 token (received_at epoch ms + id). */
function encodeCursor(c: ListCursor): string {
  return Buffer.from(`${c.receivedAt}:${c.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a list cursor token, or `null` for an absent/malformed value (the page
 * just starts from the top — the list, like scope parsing, never 400s on a bad
 * query param).
 */
function decodeCursor(raw: unknown): ListCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    const receivedAt = Number(text.slice(0, sep));
    const id = text.slice(sep + 1);
    if (!Number.isFinite(receivedAt) || id.length === 0) return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
}

/** Default and hard-cap page sizes for the transmission list. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Parse a `limit` query value, clamped to [1, MAX_PAGE_SIZE], default otherwise. */
function parsePageSize(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}

/**
 * Strict reverse-chron compare for the cursor: a row comes AFTER the cursor when
 * its (received_at DESC, id DESC) sort key is strictly past the cursor's — i.e.
 * older received_at, or same received_at with a smaller id. Matches the SQL
 * `ORDER BY received_at DESC, id DESC` total order exactly.
 */
function afterCursor(receivedAt: number, id: string, cursor: ListCursor): boolean {
  if (receivedAt < cursor.receivedAt) return true;
  if (receivedAt > cursor.receivedAt) return false;
  return id < cursor.id;
}

/** Register the sessions API on `app`. */
export function registerSessionsApi(app: FastifyInstance): void {
  app.post('/api/sessions', async (_request: FastifyRequest, reply: FastifyReply) => {
    // No arguments → mints with auth disabled by default; DB defaults the uuid.
    const session = await createSession();
    return reply.code(201).send({
      uuid: session.uuid,
      ingestUrl: `/i/${session.uuid}`,
      dashboardUrl: `/d/${session.uuid}`,
    });
  });

  // §1.3 opt-in auth toggle (DESIGN.md §3, §10, §12). The dashboard generates the
  // credential; the service stores ONLY its salted hash and echoes the plaintext
  // exactly ONCE here. Enabling is idempotent in effect — re-POSTing rotates the
  // credential (a fresh secret is minted each time).
  //
  // The app keeps raw bytes for ingest (§1.4) and registers no JSON parser, so the
  // body arrives as a Buffer; parse it here. An absent/empty body defaults to the
  // `header` method (zero-config opt-in).
  app.post(
    '/api/sessions/:uuid/auth',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;

      let body: { method?: unknown; headerName?: unknown; username?: unknown } = {};
      if (Buffer.isBuffer(request.body) && request.body.length > 0) {
        try {
          const parsed = JSON.parse(request.body.toString('utf8'));
          if (parsed && typeof parsed === 'object') body = parsed as typeof body;
        } catch {
          return reply.code(400).send({ error: 'invalid_json' });
        }
      }

      const method: AuthMethod = body.method === 'basic' ? 'basic' : 'header';
      const headerName = typeof body.headerName === 'string' ? body.headerName : undefined;
      const username = typeof body.username === 'string' ? body.username : undefined;

      const credential = generateCredential(method, { headerName, username });
      const view = await enableAuth(uuid, {
        authMethod: credential.store.auth_method,
        authHeaderName: credential.store.auth_header_name,
        authSecretHash: credential.store.auth_secret_hash,
      });
      if (!view) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      // Echo the plaintext credential EXACTLY ONCE (§12) plus the config it
      // implies. The salted hash is never returned. `header` → token + header
      // name; `basic` → username + password.
      if (method === 'header') {
        return reply.code(201).send({
          uuid: view.uuid,
          auth_enabled: view.auth_enabled,
          auth_method: view.auth_method,
          auth_header_name: view.auth_header_name,
          token: credential.plaintext,
        });
      }
      return reply.code(201).send({
        uuid: view.uuid,
        auth_enabled: view.auth_enabled,
        auth_method: view.auth_method,
        username: view.auth_header_name,
        password: credential.plaintext,
      });
    },
  );

  // Disable §1.3 auth: clears the stored credential and flips auth_enabled off.
  app.delete(
    '/api/sessions/:uuid/auth',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;
      const view = await disableAuth(uuid);
      if (!view) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }
      return reply.send({
        uuid: view.uuid,
        auth_enabled: view.auth_enabled,
        auth_method: view.auth_method,
      });
    },
  );

  // Delete all CAPTURED DATA for a session (DESIGN.md §8 user-triggered purge):
  // wipes its transmissions + findings but KEEPS the session row + ingest URL
  // alive, so the supplier can start a fresh test protocol against the same
  // endpoint. Drives the dashboard's "Delete all captured data" danger zone.
  // 404 when the session is unknown/expired; otherwise reports how many
  // transmissions were removed (0 is a valid no-op for an already-empty session).
  app.delete(
    '/api/sessions/:uuid/data',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const deletedTransmissions = await deleteSessionData(uuid);
      return reply.send({ uuid, deleted: { transmissions: deletedTransmissions } });
    },
  );

  // SCOPE-AWARE session read (4h4.4). Accepts a time `window` (15m|1h|6h|all,
  // default all) + `source` (a raw source key | all, default all) and returns,
  // over the SCOPED transmission set, a pre-aggregated payload so the browser
  // never holds every raw finding to render the scorecard/compliance/sparkline/
  // signatures: { session, summary, rollup, signatures, trend, sources, scoped }.
  // Unknown/invalid window/source values FALL BACK to defaults (no 400) to keep
  // the dashboard resilient. 404/meta/expiresAt and the per-tx findings drill-down
  // are preserved.
  //
  // LIST/SUMMARY SPLIT (DECISION): the full `transmissions` list STILL ships in
  // this response for now — the docked detail pane reads it. The paginated/
  // filterable LIST endpoint (4h4.5) supersedes this list path later; this
  // handler is the summary half of that split.
  app.get(
    '/api/sessions/:uuid',
    async (
      request: FastifyRequest<{
        Params: { uuid: string };
        Querystring: { window?: string; source?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { uuid } = request.params;

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const window = parseWindow(request.query.window);
      const source = parseSource(request.query.source);

      const [transmissions, findings] = await Promise.all([
        listTransmissions(uuid),
        listFindingsForSession(uuid),
      ]);

      // Group findings by transmission_id once for the per-tx drill-down; the
      // scope-relative summary counts are recomputed over the SCOPED set below.
      const findingsByTx = groupFindingsByTx(findings);

      // Build the full per-transmission views (list + drill-down). `source` is the
      // raw key the scope predicate filters on; the camelCase finding fields feed
      // computeSignatures unchanged.
      const transmissionViews = transmissions.map((t) =>
        toTransmissionView(t, findingsByTx.get(t.id) ?? []),
      );

      const now = Date.now();

      // Window-only set (NOT narrowed by the selected source) — the filter
      // <select> must show every source's in-window count, regardless of which
      // source is currently selected.
      const windowViews = scopeTransmissions(transmissionViews, window, 'all', now);
      const sources = sourceCounts(windowViews);

      // The fully SCOPED set drives every scope-relative aggregate.
      const scopedViews = scopeTransmissions(transmissionViews, window, source, now);

      // Scope-relative §7 summary: recompute countsByRequirement over the scoped
      // set, then feed the existing server-side computeComplianceSummary.
      const scopedCounts: FindingCountsByRequirement = {};
      for (const t of scopedViews) {
        for (const f of t.findings) {
          const counts = (scopedCounts[f.requirement] ??= { pass: 0, fail: 0, info: 0 });
          counts[f.severity as Severity] += 1;
        }
      }
      const summary = computeComplianceSummary(scopedCounts);

      // computeSignatures consumes the scoped views via the shared signature-tx
      // projection (same one the list endpoint's cross-filter uses).
      const signatures = computeSignatures(scopedViews.map(asSignatureTx));

      const base = session.last_post_at ?? session.created_at;
      const expiresAt = new Date(base.getTime() + RETENTION_MS).toISOString();

      // Expose only auth_enabled/auth_method — never leak auth_secret_hash.
      return reply.send({
        session: {
          uuid: session.uuid,
          created_at: session.created_at,
          last_post_at: session.last_post_at,
          auth_enabled: session.auth_enabled,
          auth_method: session.auth_method,
        },
        // Full list still ships here for the docked detail pane (see split note).
        transmissions: transmissionViews,
        summary,
        rollup: rollup(summary),
        signatures,
        trend: passTrend(scopedViews),
        sources,
        scoped: scopeTotals(scopedViews, signatures.length),
        expiresAt,
      });
    },
  );

  // PAGINATED, FILTERABLE transmission list (4h4.5). Backs the dashboard's list
  // region "Transmissions · showing {visible} of {scoped}" at thousands of rows,
  // where shipping the whole list (the summary read above) does not scale.
  //
  // Query params (all resilient — unknown values fall back, never 400):
  //   - window   15m|1h|6h|all (default all) — same scope semantics as the summary.
  //   - source   a raw source key | all (default all) — TRIMMED transfer_src, the
  //              null/blank bucket is the empty-string key (deriveSourceView).
  //   - failuresOnly  true|1 → keep only tx with ≥1 fail finding.
  //   - signatureKey  keep only tx exhibiting that signature (txMatchesSig) — the
  //              cross-filter from a clicked signature row.
  //   - cursor   opaque (received_at,id) token from a prior page's nextCursor.
  //   - limit    page size, clamped to [1, MAX_PAGE_SIZE], default DEFAULT_PAGE_SIZE.
  //
  // APPROACH (the 4h4.5 trade-off, app-filter side): push only the window
  // time-bound + reverse-chron ORDER into SQL (reuse the (session_uuid,
  // received_at DESC) index via listTransmissionsInWindow), fetch the windowed
  // candidates + their findings, then apply source / failuresOnly / signatureKey
  // / cursor pagination IN APP. Per-session volume is bounded by the 7-day
  // retention window, so the bounded scan is cheap — and source-normalization
  // (source.ts) + signatureKey membership (signatures.ts txMatchesSig) stay
  // single-sourced instead of being re-implemented in SQL (which would drift).
  //
  // Response: { transmissions: [page of rows], scoped, nextCursor, hasMore }.
  //   - each row is the SAME view as the summary (TransmissionView + source/
  //     sourceCode/sourceLabel) with its findings INLINED — the docked detail pane
  //     renders StatusPill/§links/OUTDATED tag/pointer/inventory straight off the
  //     row, no second fetch (volume is page-bounded, so inlining is cheap).
  //   - `scoped` is the count AFTER all four filters — the "of {scoped}"
  //     denominator the header means (visible = transmissions.length ≤ scoped).
  app.get(
    '/api/sessions/:uuid/transmissions',
    async (
      request: FastifyRequest<{
        Params: { uuid: string };
        Querystring: {
          window?: string;
          source?: string;
          failuresOnly?: string;
          signatureKey?: string;
          cursor?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { uuid } = request.params;

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const window = parseWindow(request.query.window);
      const source = parseSource(request.query.source);
      const failuresOnly =
        request.query.failuresOnly === 'true' || request.query.failuresOnly === '1';
      const signatureKey =
        typeof request.query.signatureKey === 'string' && request.query.signatureKey.length > 0
          ? request.query.signatureKey
          : null;
      const cursor = decodeCursor(request.query.cursor);
      const limit = parsePageSize(request.query.limit);

      const now = Date.now();
      const lo = windowLowerBound(window, now);

      // SQL does the window slice + reverse-chron order; the app does the rest.
      const [transmissions, findings] = await Promise.all([
        listTransmissionsInWindow(uuid, lo),
        listFindingsInWindow(uuid, lo),
      ]);

      const findingsByTx = groupFindingsByTx(findings);
      const views = transmissions.map((t) => toTransmissionView(t, findingsByTx.get(t.id) ?? []));

      // Apply scope (source + the window's [lo, now] bound) + failuresOnly +
      // signatureKey app-side, single-sourced from scope.ts (inScope — the SAME
      // predicate the summary endpoint scopes with, so the shared "showing
      // {visible} of {scoped}" header agrees, incl. the received_at <= now upper
      // bound) and signatures.ts (txMatchesSig). The SQL already pushed the lo
      // bound; inScope re-applies it harmlessly and adds the now upper bound.
      const filtered = views.filter((t) => {
        if (!inScope(t, window, source, now)) return false;
        if (failuresOnly && !t.findings.some((f) => f.severity === 'fail')) return false;
        if (signatureKey !== null && !txMatchesSig(asSignatureTx(t), signatureKey)) return false;
        return true;
      });

      // `scoped` = the post-filter denominator the header reads "of {scoped}".
      const scoped = filtered.length;

      // Cursor pagination over the (already reverse-chron) filtered set: drop rows
      // up to and including the cursor, take `limit`, expose hasMore + nextCursor.
      const afterCursorViews =
        cursor === null
          ? filtered
          : filtered.filter((t) => afterCursor(new Date(t.received_at).getTime(), t.id, cursor));
      const page = afterCursorViews.slice(0, limit);
      const hasMore = afterCursorViews.length > page.length;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({ receivedAt: new Date(last.received_at).getTime(), id: last.id })
          : null;

      return reply.send({
        transmissions: page,
        scoped,
        nextCursor,
        hasMore,
      });
    },
  );
}
