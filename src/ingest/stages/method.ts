/**
 * Stage 1 — method / TLS (DESIGN.md §6 row 1: "POST over HTTPS").
 *
 * METHOD is the real gate here: the route registers `/i/:uuid` for ALL methods
 * (so a non-POST gets our **405**, not Fastify's default 404). This stage
 * confirms the method is POST and short-circuits **405** otherwise, with NO
 * transmission row persisted.
 *
 * TLS / scheme is intentionally LENIENT (DESIGN.md §7 row 1.1): HTTPS is 🔒
 * enforced at the Caddy edge — non-HTTPS never reaches the app, so it always
 * "passes" and is NOT a test of the supplier's choice. Behind the proxy the app
 * sees `X-Forwarded-Proto` (trusted scoped to Caddy) via `request.protocol`;
 * locally that header is absent and `protocol` is plain `http`. We therefore
 * read `request.protocol` for awareness but do NOT reject on a non-https scheme.
 */

import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';

export function methodStage(): Stage {
  return {
    name: 'method',
    run(ctx: PipelineContext): StageOutcome {
      if (ctx.request.method !== 'POST') {
        // Non-POST on the ingest path → 405, no transmission row.
        return halt(405);
      }
      // §1.1 HTTPS is edge-enforced (🔒). `request.protocol` is informational
      // only here; we are deliberately lenient on scheme (header absent locally)
      // and never 400/reject on a non-https scheme.
      return CONTINUE;
    },
  };
}
