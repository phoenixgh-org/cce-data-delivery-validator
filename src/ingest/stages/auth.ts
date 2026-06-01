/**
 * Stage 2 — opt-in auth enforcement (DESIGN.md §1.3, §3, §6 row 2; M6/ct4.2).
 *
 * §1.3 auth is an OPT-IN compliance layer, not a gate. The zero-friction default
 * (auth disabled) ingests unchanged: this stage CONTINUEs without inspecting any
 * credential. Only once a supplier opts in (`auth_enabled = true`) does a missing
 * or incorrect credential short-circuit with **401** — and, like the 404/405
 * pre-body halts, NO transmission row is persisted (this stage sits before the
 * §6/§8 persistence boundary).
 *
 * Like {@link sessionStage} (stage 0), this re-fetches the session by uuid with an
 * injectable `db?` rather than threading the row through {@link PipelineContext}.
 * The extra PK lookup is accepted for v1 (DESIGN §14.6 / the M6 bite) — the frozen
 * pipeline contract is never widened. Credential verification itself is delegated
 * wholesale to {@link verifyCredential} (src/auth/credential.ts, ct4.1): this stage
 * only decides WHETHER to verify (skip when disabled) and maps the request headers
 * into a {@link PresentedCredential}; it re-implements no hashing.
 *
 * Ordering wrinkle (kept on purpose): stage 0 bumps `last_post_at` BEFORE this
 * stage runs, so a request that 401s here has still stamped session activity. That
 * is correct for the §11 retention clock — a 401 proves the session is live; the
 * row simply isn't persisted.
 */

import { verifyCredential, type PresentedCredential } from '../../auth/credential.js';
import type { Queryable } from '../../db/repository.js';
import { getSession } from '../../db/repository.js';
import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';

/**
 * Read a single request header value as a string. Fastify lowercases header names
 * and may surface a repeated header as an array; take the first value in that case.
 */
function headerValue(ctx: PipelineContext, name: string): string | undefined {
  const raw = ctx.request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Build the stage. `db` is injectable (mirrors {@link sessionStage}) so tests can
 * supply a fake session source; defaults to the shared pool.
 */
export function authStage(db?: Queryable): Stage {
  return {
    name: 'auth',
    async run(ctx: PipelineContext): Promise<StageOutcome> {
      const session = await getSession(ctx.sessionUuid, db);
      // Stage 0 already 404'd a missing session; if it is somehow gone now, treat
      // a non-existent session as "nothing to enforce" and continue — stage 0 owns
      // the 404, not this stage.
      if (!session || !session.auth_enabled) {
        // Zero-friction default (§3): auth not enabled → no-op.
        return CONTINUE;
      }

      // Enabled: assemble the request-side material verifyCredential expects.
      //   header method → the value of the configured header (`auth_header_name`).
      //   basic  method → the raw `Authorization` header.
      const presented: PresentedCredential = {
        headerValue: session.auth_header_name
          ? headerValue(ctx, session.auth_header_name)
          : undefined,
        authorization: headerValue(ctx, 'authorization'),
      };

      if (verifyCredential(presented, session)) {
        return CONTINUE;
      }
      // Missing/incorrect credential → 401, NO transmission row (pre-body halt).
      return halt(401);
    },
  };
}
