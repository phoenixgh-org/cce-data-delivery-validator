/**
 * Stage 2 — opt-in auth enforcement (DESIGN.md §1.3, §3, §6 row 2; M6/ct4.2).
 *
 * §1.3 auth is an OPT-IN compliance layer, not a gate. The zero-friction default
 * (auth disabled) ingests unchanged: this stage CONTINUEs without inspecting any
 * credential. Only once a supplier opts in (`auth_enabled = true`) does a missing
 * or incorrect credential short-circuit with **401** — and UNLIKE the 404/405
 * pre-body halts, a transmission row IS persisted. This stage runs before the
 * §6/§8 persistence boundary, but the 401 is a GRADED §1.3 failure rather than a
 * bare reject, so src/ingest/route.ts special-cases `haltedAt === 'auth'` and
 * writes the row plus the §1.3 FAIL finding recorded below.
 *
 * Like {@link sessionStage} (stage 0), this re-fetches the session by uuid with an
 * injectable `db?` rather than threading the row through {@link PipelineContext}.
 * The extra PK lookup is accepted for v1 (DESIGN §14.6 / the M6 bite) — the frozen
 * pipeline contract is never widened. Credential verification itself is delegated
 * wholesale to {@link verifyCredential} (src/auth/credential.ts, ct4.1): this stage
 * only decides WHETHER to verify (skip when disabled) and maps the request headers
 * into a {@link PresentedCredential}; it re-implements no hashing.
 *
 * Two of the three DS01.3 methods — `basic` and `bearer` (RFC 6750) — SHARE the
 * `Authorization` header, so neither the verify nor the finding text may key off
 * header presence: both dispatch on the scheme token (case-insensitively, RFC 9110
 * §11.1). A `Basic` credential sent to a bearer-configured session 401s and is
 * reported as a scheme mismatch, not as an incorrect token.
 *
 * Ordering wrinkle (kept on purpose): stage 0 bumps `last_post_at` BEFORE this
 * stage runs, so a request that 401s here has still stamped session activity. That
 * is correct for the §11 retention clock — a 401 proves the session is live, and
 * the persisted row records the failure alongside it.
 */

import {
  authorizationScheme,
  verifyCredential,
  type PresentedCredential,
} from '../../auth/credential.js';
import type { AuthMethod, Queryable } from '../../db/repository.js';
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
 * The `Authorization` scheme token each method expects, in the capitalisation
 * RFC 7617 / RFC 6750 use when writing it. Methods absent from this map (today
 * only `header`) carry their credential in a configurable header instead, so no
 * scheme is involved. Matching is case-INSENSITIVE (RFC 9110 §11.1) — this is
 * display text, not the comparison key.
 */
const EXPECTED_SCHEME: Partial<Record<AuthMethod, string>> = {
  basic: 'Basic',
  bearer: 'Bearer',
};

/**
 * Longest scheme token echoed back in a finding. The presented scheme is
 * client-controlled, so the detail quotes a bounded slice of it.
 */
const MAX_ECHOED_SCHEME = 20;

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
      //   basic/bearer  → the raw `Authorization` header, told apart downstream by
      //                   their SCHEME token (they share the header, so presence
      //                   alone decides nothing).
      const expectedScheme = session.auth_method ? EXPECTED_SCHEME[session.auth_method] : undefined;
      // The header a credential is expected in, named for the §1.3 finding notes:
      // for `basic`/`bearer` it is always `Authorization`; for `header` it is the
      // configured `auth_header_name`.
      const expectedHeader = expectedScheme
        ? 'Authorization'
        : (session.auth_header_name ?? 'the configured');
      const presented: PresentedCredential = {
        headerValue:
          session.auth_method === 'header' && session.auth_header_name
            ? headerValue(ctx, session.auth_header_name)
            : undefined,
        authorization: headerValue(ctx, 'authorization'),
      };

      if (verifyCredential(presented, session)) {
        // §1.3 PASS — graded from real traffic.
        return record(ctx, {
          requirement: '1.3',
          severity: 'pass',
          detail: expectedScheme
            ? `Successful authorization via ${expectedHeader} header (${expectedScheme} scheme).`
            : `Successful authorization via ${expectedHeader} header.`,
        });
      }

      // Failed: distinguish "nothing presented" from "wrong scheme" from "wrong
      // credential" so the producer sees WHY. For `basic`/`bearer` the credential
      // rides in `Authorization` under a specific scheme; for `header` it is the
      // configured header's value.
      let detail: string;
      if (expectedScheme) {
        const scheme = authorizationScheme(presented.authorization);
        if (presented.authorization === undefined) {
          detail = `Failed authorization (no ${expectedHeader} header detected).`;
        } else if (scheme === null) {
          detail =
            `Failed authorization (malformed ${expectedHeader} header; ` +
            `the ${expectedScheme} scheme was expected).`;
        } else if (scheme !== session.auth_method) {
          // Shares the header with the other scheme — say so rather than calling
          // it an incorrect token, which would send the supplier hunting the
          // wrong bug. The echoed scheme is client-controlled, hence the slice.
          detail =
            `Failed authorization (${expectedHeader} header used the ` +
            `"${scheme.slice(0, MAX_ECHOED_SCHEME)}" scheme; ${expectedScheme} was expected).`;
        } else {
          detail = `Failed authorization (incorrect token transmitted in ${expectedHeader} header).`;
        }
      } else {
        const presentedSomething =
          typeof presented.headerValue === 'string' && presented.headerValue.length > 0;
        detail = presentedSomething
          ? `Failed authorization (incorrect token transmitted in ${expectedHeader} header).`
          : `Failed authorization (no ${expectedHeader} header detected).`;
      }

      // §1.3 FAIL — record BEFORE halting. The route persists the enabled-401 row
      // (a graded failure, unlike the 404/405 pre-body rejects) so this finding is
      // not lost: it increments the 1.3 fail counter and shows in Transmission detail.
      record(ctx, { requirement: '1.3', severity: 'fail', detail });
      return halt(401);
    },
  };
}
