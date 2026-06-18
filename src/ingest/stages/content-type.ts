/**
 * Stage 4 — Content-Type (DESIGN.md §6 row 4: `application/json; charset=utf-8`,
 * §1.2). On mismatch → finding; CONTINUE (415 is "optional" per §6, so we record
 * the finding and keep grading rather than short-circuit).
 *
 * Matching rule (§1.2 wants the full `application/json; charset=utf-8`):
 *   - Parse `ctx.contentType` into a media type + parameters, splitting on `;`.
 *   - The media type must be `application/json` (compared case-insensitively;
 *     RFC 7231 media types are case-insensitive).
 *   - A `charset` parameter must be present and equal to `utf-8`
 *     (case-insensitive). A bare `application/json` with no charset is a
 *     (lesser) finding — the requirement names the charset explicitly.
 * Any deviation is a single §1.2 fail finding (we never halt here); an exact
 * match emits a §1.2 pass finding for the §7 teaching matrix.
 */

import { record, type PipelineContext, type Stage, type StageOutcome } from '../pipeline.js';

/** Split a Content-Type header into its lowercased media type + params map. */
function parseContentType(raw: string): { mediaType: string; params: Map<string, string> } {
  const segments = raw.split(';').map((s) => s.trim());
  const mediaType = (segments.shift() ?? '').toLowerCase();
  const params = new Map<string, string>();
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    // Strip optional surrounding quotes from the value; lowercase for compare.
    const value = segment
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '')
      .toLowerCase();
    if (key) params.set(key, value);
  }
  return { mediaType, params };
}

export function contentTypeStage(): Stage {
  return {
    name: 'content-type',
    run(ctx: PipelineContext): StageOutcome {
      const raw = ctx.contentType;
      if (raw === null) {
        return record(ctx, {
          requirement: '1.2',
          severity: 'fail',
          detail: 'Content-Type header is missing; expected application/json; charset=utf-8 (§1.2)',
          code: 'tx.bad_media_type',
        });
      }

      const { mediaType, params } = parseContentType(raw);
      const charset = params.get('charset');

      if (mediaType !== 'application/json') {
        return record(ctx, {
          requirement: '1.2',
          severity: 'fail',
          detail: `Content-Type media type "${mediaType}" is not application/json (§1.2)`,
          code: 'tx.bad_media_type',
        });
      }
      if (charset !== 'utf-8') {
        return record(ctx, {
          requirement: '1.2',
          severity: 'fail',
          detail:
            charset === undefined
              ? 'Content-Type is application/json but omits the required charset=utf-8 (§1.2)'
              : `Content-Type charset "${charset}" is not utf-8 (§1.2)`,
          code: 'tx.missing_charset',
        });
      }

      // Exact `application/json; charset=utf-8` → pass finding, continue.
      return record(ctx, {
        requirement: '1.2',
        severity: 'pass',
        detail: 'Content-Type is application/json; charset=utf-8 (§1.2)',
      });
    },
  };
}
