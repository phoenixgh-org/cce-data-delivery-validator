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
  createSession,
  getSession,
  listFindingsForSession,
  listTransmissions,
} from '../db/repository.js';
import type { FindingRow, Severity } from '../db/repository.js';

/** 30-day inactivity retention window (DESIGN.md §11). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Findings as surfaced per-transmission on the dashboard (drill-down detail). */
function toFindingView(f: FindingRow) {
  return {
    requirement: f.requirement,
    severity: f.severity,
    detail: f.detail,
    pointer: f.pointer,
  };
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

  app.get(
    '/api/sessions/:uuid',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const [transmissions, findings] = await Promise.all([
        listTransmissions(uuid),
        listFindingsForSession(uuid),
      ]);

      // Group findings by transmission_id for per-tx drill-down, and aggregate
      // them by requirement+severity for the §7 summary in a single pass.
      const findingsByTx = new Map<string, FindingRow[]>();
      const countsByRequirement: FindingCountsByRequirement = {};
      for (const f of findings) {
        const bucket = findingsByTx.get(f.transmission_id);
        if (bucket) bucket.push(f);
        else findingsByTx.set(f.transmission_id, [f]);

        const counts = (countsByRequirement[f.requirement] ??= { pass: 0, fail: 0, info: 0 });
        counts[f.severity as Severity] += 1;
      }

      const transmissionViews = transmissions.map((t) => ({
        id: t.id,
        received_at: t.received_at,
        http_status: t.http_status,
        content_type: t.content_type,
        content_encoding: t.content_encoding,
        // wire_bytes is a bigint → pg returns a string; pass it through as-is.
        wire_bytes: t.wire_bytes,
        schema_version: t.schema_version,
        transfer_id: t.transfer_id,
        parse_ok: t.parse_ok,
        schema_ok: t.schema_ok,
        body: t.body,
        raw_body: t.raw_body,
        findings: (findingsByTx.get(t.id) ?? []).map(toFindingView),
      }));

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
        transmissions: transmissionViews,
        summary: computeComplianceSummary(countsByRequirement),
        expiresAt,
      });
    },
  );
}
