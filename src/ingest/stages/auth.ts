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
  record,
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
      // a non-existent session as "nothing to grade" and continue — stage 0 owns
      // the 404, not this stage (and there is no session to attribute a finding to).
      if (!session) {
        return CONTINUE;
      }

      if (!session.auth_enabled) {
        // Zero-friction default (§3): auth not enabled. We still call §1.3 — an
        // INFO note that auth was off (info never grades, so the row stays
        // `untested`, but the count surfaces in the matrix + Transmission detail).
        return record(ctx, {
          requirement: '1.3',
          severity: 'info',
          detail: 'Authorization disabled for this session; §1.3 not enforced.',
        });
      }

      // Enabled: assemble the request-side material verifyCredential expects.
      //   header method → the value of the configured header (`auth_header_name`).
      //   basic  method → the raw `Authorization` header.
      // The header a credential is expected in, named for the §1.3 finding notes:
      // for `basic` it is always `Authorization`; for `header` it is the
      // configured `auth_header_name`.
      const expectedHeader =
        session.auth_method === 'basic'
          ? 'Authorization'
          : (session.auth_header_name ?? 'the configured');
      const presented: PresentedCredential = {
        headerValue: session.auth_header_name
          ? headerValue(ctx, session.auth_header_name)
          : undefined,
        authorization: headerValue(ctx, 'authorization'),
      };

      if (verifyCredential(presented, session)) {
        // §1.3 PASS — graded from real traffic.
        return record(ctx, {
          requirement: '1.3',
          severity: 'pass',
          detail: `Successful authorization via ${expectedHeader} header.`,
        });
      }

      // Failed: distinguish "no credential presented" from "wrong credential" so
      // the producer sees WHY. For `basic` the credential rides in `Authorization`;
      // for `header` it is the configured header's value.
      const presentedSomething =
        session.auth_method === 'basic'
          ? presented.authorization !== undefined
          : typeof presented.headerValue === 'string' && presented.headerValue.length > 0;

      // §1.3 FAIL — record BEFORE halting. The route persists the enabled-401 row
      // (a graded failure, unlike the 404/405 pre-body rejects) so this finding is
      // not lost: it increments the 1.3 fail counter and shows in Transmission detail.
      record(ctx, {
        requirement: '1.3',
        severity: 'fail',
        detail: presentedSomething
          ? `Failed authorization (incorrect token transmitted in ${expectedHeader} header).`
          : `Failed authorization (no ${expectedHeader} header detected).`,
      });
      return halt(401);
    },
  };
}
