/**
 * Stage 6 — JSON parse (DESIGN.md §6 row 6: body is valid UTF-8 JSON, §1.1).
 * On parse failure → **400**.
 *
 * STUB: no-op continue for now (see size.ts for why no-op vs throw). The real
 * stage parses `ctx.rawBody` (or the decoded body from stage 5) as UTF-8 JSON,
 * sets `ctx.parsedBody` + `ctx.parseOk`, and halts 400 on failure. Until then,
 * `ctx.parseOk` stays null and `ctx.parsedBody` stays null, which the terminal
 * persist records faithfully.
 *
 * TODO(3bn.5): implemented by Subagent B/C.
 */

import { CONTINUE, type Stage, type StageOutcome } from '../pipeline.js';

export function parseStage(): Stage {
  return {
    name: 'parse',
    run(): StageOutcome {
      return CONTINUE;
    },
  };
}
