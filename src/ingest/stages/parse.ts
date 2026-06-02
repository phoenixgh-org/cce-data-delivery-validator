/**
 * Stage 6 — JSON parse (DESIGN.md §6 row 6: body is valid UTF-8 JSON, §1.1).
 * On parse failure → set `ctx.parseOk = false`, push a §1.1 fail finding, and
 * halt **400**. On success → set `ctx.parsedBody` + `ctx.parseOk = true`.
 *
 * Bytes-to-parse: the gzip-decoded buffer from stage 5 if one was stashed (via
 * the decoded-body WeakMap handoff), else the exact wire bytes `ctx.rawBody`.
 *
 * UTF-8 strictness (§1.1 requires UTF-8 JSON): we decode with a FATAL
 * `TextDecoder`, so non-UTF-8 bytes raise before `JSON.parse` and are reported
 * as a §1.1 failure → 400. The route persists `raw_body` regardless of the 400,
 * so a malformed transmission still drills down on the dashboard (DESIGN.md §8);
 * this stage only sets parseOk=false and halts.
 *
 * This stage owns parse only: it sets `ctx.parsedBody` + `ctx.parseOk`. It does
 * NOT populate `ctx.meta.*` / schema fields — stage 7 (schema) reads
 * `parsedBody.meta` and owns those slots.
 */

import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';
import { getDecodedBody } from './decoded-body.js';

/** Strict UTF-8 decoder: throws on any invalid byte sequence (§1.1). */
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function parseStage(): Stage {
  return {
    name: 'parse',
    run(ctx: PipelineContext): StageOutcome {
      // Decoded bytes from stage 5 (gzip) if present, else the exact wire bytes.
      const bytes = getDecodedBody(ctx) ?? ctx.rawBody;

      let parsed: unknown;
      try {
        const text = utf8.decode(bytes); // throws on non-UTF-8 bytes (§1.1)
        parsed = JSON.parse(text);
      } catch (err) {
        ctx.parseOk = false;
        const reason = err instanceof Error ? err.message : 'invalid JSON';
        ctx.findings.push({
          requirement: '1.1',
          severity: 'fail',
          detail: `body is not valid UTF-8 JSON: ${reason} (§1.1)`,
        });
        return halt(400);
      }

      ctx.parsedBody = parsed;
      ctx.parseOk = true;
      ctx.findings.push({
        requirement: '1.1',
        severity: 'pass',
        detail: 'body parsed cleanly as UTF-8 JSON (§1.1)',
      });
      return CONTINUE;
    },
  };
}
