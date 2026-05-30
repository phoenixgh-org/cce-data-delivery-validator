/**
 * Stage 7 — schema validate (DESIGN.md §6 row 7: Ajv against
 * `meta.schemaVersion`, §3.1/§3.2). On failure → **422** + per-error findings.
 *
 * STUB: no-op continue for now (see size.ts for why no-op vs throw). The real
 * stage reads `ctx.parsedBody.meta.schemaVersion`, resolves it via
 * `ctx.registry.lookup(...)` (setting `ctx.normalizedSchemaVersion` and
 * `ctx.meta.*`), runs the compiled validator, sets `ctx.schemaOk`, and emits one
 * finding per Ajv error (with a JSON Pointer) before halting 422. Until then,
 * `ctx.schemaOk` stays null.
 *
 * TODO(3bn.6): implemented by Subagent B/C.
 */

import { CONTINUE, type Stage, type StageOutcome } from '../pipeline.js';

export function schemaStage(): Stage {
  return {
    name: 'schema',
    run(): StageOutcome {
      return CONTINUE;
    },
  };
}
