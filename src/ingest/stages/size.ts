/**
 * Stage 3 — size (DESIGN.md §6 row 3: wire body ≤ 1MB after content-encoding,
 * §1.4). On failure → **413** + finding.
 *
 * STUB: no-op continue for now so the spine's happy path persists. A throw here
 * would break the full-flow test; a no-op lets a valid POST flow through to the
 * terminal persist. The size cap reads `ctx.rawBody.length` (the §1.4 wire-byte
 * measurement is taken AFTER encoding — the raw request length, not decompressed).
 *
 * TODO(3bn.4): implemented by Subagent B/C.
 */

import { CONTINUE, type Stage, type StageOutcome } from '../pipeline.js';

export function sizeStage(): Stage {
  return {
    name: 'size',
    run(): StageOutcome {
      return CONTINUE;
    },
  };
}
