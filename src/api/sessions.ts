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
  parseSource,
  parseWindow,
  passTrend,
  rollup,
  scopeTotals,
  scopeTransmissions,
} from './scope.js';
import { computeSignatures } from './signatures.js';
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
  listTransmissions,
} from '../db/repository.js';
import type { AuthMethod, FindingRow, Severity } from '../db/repository.js';

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
      const findingsByTx = new Map<string, FindingRow[]>();
      for (const f of findings) {
        const bucket = findingsByTx.get(f.transmission_id);
        if (bucket) bucket.push(f);
        else findingsByTx.set(f.transmission_id, [f]);
      }

      // Build the full per-transmission views (list + drill-down). `source` is the
      // raw key the scope predicate filters on; the camelCase finding fields feed
      // computeSignatures unchanged.
      const transmissionViews = transmissions.map((t) => {
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
          // Keep the raw transfer_src for the window-aware source counts below.
          transfer_src: t.transfer_src,
          // Raw source key + derived 3-letter code + human label (4h4.2).
          source: src,
          sourceCode,
          sourceLabel,
          parse_ok: t.parse_ok,
          schema_ok: t.schema_ok,
          body: t.body,
          raw_body: t.raw_body,
          findings: (findingsByTx.get(t.id) ?? []).slice().sort(byRequirement).map(toFindingView),
        };
      });

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

      // computeSignatures consumes the scoped views directly — they are
      // structurally compatible with SignatureTransmission (id, received_at ISO,
      // source, camelCase findings).
      const signatures = computeSignatures(
        scopedViews.map(
          (t): SignatureTransmission => ({
            id: t.id,
            received_at: new Date(t.received_at).toISOString(),
            source: t.source,
            findings: t.findings,
          }),
        ),
      );

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
}
