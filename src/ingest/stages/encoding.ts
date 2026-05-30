/**
 * Stage 5 — Content-Encoding (DESIGN.md §6 row 5: if `gzip`, decompress; detect
 * illegal double-encoding e.g. base64, §1.6). On undecodable → **400**; else
 * finding + continue.
 *
 * STUB: no-op continue for now (see size.ts for why no-op vs throw). The real
 * stage inspects `ctx.contentEncoding` and, on `gzip`, decompresses for downstream
 * parse; double-encoding is a §1.6 finding.
 *
 * TODO(3bn.4): implemented by Subagent B/C.
 */

import { CONTINUE, type Stage, type StageOutcome } from '../pipeline.js';

export function encodingStage(): Stage {
  return {
    name: 'encoding',
    run(): StageOutcome {
      return CONTINUE;
    },
  };
}
