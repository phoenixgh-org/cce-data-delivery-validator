/**
 * Stage 4 — Content-Type (DESIGN.md §6 row 4: `application/json; charset=utf-8`,
 * §1.2). On mismatch → finding; continue (415 optional).
 *
 * STUB: no-op continue for now (see size.ts for why no-op vs throw). The real
 * stage inspects `ctx.contentType` (already lifted from the request header by
 * the route) and pushes a §1.2 finding on mismatch.
 *
 * TODO(3bn.4): implemented by Subagent B/C.
 */

import { CONTINUE, type Stage, type StageOutcome } from '../pipeline.js';

export function contentTypeStage(): Stage {
  return {
    name: 'content-type',
    run(): StageOutcome {
      return CONTINUE;
    },
  };
}
