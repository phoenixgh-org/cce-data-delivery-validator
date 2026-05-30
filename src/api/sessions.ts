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
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createSession } from '../db/repository.js';

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
}
