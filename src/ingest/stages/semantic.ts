/**
 * Stage 8 — semantic checks (DESIGN.md §6 row 8; §1.8 duplicate, §2.1
 * concurrency, §3.x interval + inventory + §3.1 custom-object declaration;
 * milestone M5).
 *
 * This stage is the FROZEN shared contract for the semantic checks. Each
 * check is a {@link SemanticCheck}: it inspects the (already parse+schema-valid)
 * {@link PipelineContext} plus the {@link SemanticDeps} the handler supplies, and
 * returns its findings. The orchestrator awaits each check and pushes all
 * returned findings onto `ctx.findings`.
 *
 * The semantic stage NEVER halts: it always returns {@link CONTINUE}. Every
 * §1.8/§2.1/§3.x concern is a TEACHING finding, not a rejection — the data is
 * accepted (2xx) and recorded. (Contrast stages 0-7, which short-circuit 4xx.)
 *
 * Defensive guard, mirroring schema.ts: the body-inspecting checks (duplicate,
 * interval, inventory) only have something to inspect when parse + schema both
 * continued. In the real pipeline stage 8 only runs after schema continued, so
 * `parseOk`/`schemaOk` are true and `parsedBody` is set — but should this stage
 * somehow run without a valid body, we SKIP the body-inspecting checks and run
 * ONLY the concurrency check (which is independent of the body).
 *
 * Subagents B/C/D fill the per-check stub bodies under `stages/semantic/*.ts`
 * WITHOUT editing this file. The signatures below are frozen.
 *
 * The one later addition to `BODY_CHECKS` is `advisoriesCheck` (pwd/bva), which
 * fans out to its own registry so the Advisories catalogue can grow without
 * further edits here. See `semantic/advisory.ts`.
 */

import type { PriorTransmission } from '../../db/repository.js';
import { CONTINUE, type Finding, type PipelineContext, type Stage } from '../pipeline.js';
import { advisoriesCheck } from './semantic/advisory.js';
import { concurrencyCheck } from './semantic/concurrency.js';
import { customDataSchemaCheck } from './semantic/custom-schema.js';
import { duplicateCheck } from './semantic/duplicate.js';
import { intervalCheck } from './semantic/interval.js';
import { inventoryCheck } from './semantic/inventory.js';

export type { PriorTransmission };

/**
 * Everything the semantic checks need that is NOT already on the
 * {@link PipelineContext}. Supplied by the route handler via the stage closure
 * so the frozen `ctx` type is never widened.
 */
export interface SemanticDeps {
  /** In-flight count for this session captured at handler entry (includes self; ≤1 ⇒ serial). */
  concurrentAtEntry: number;
  /** Prior-transmission lookup for duplicate detection (§1.8). */
  findPriorTransmissions: (
    sessionUuid: string,
    opts: { transferId?: string | null; contentHash?: Buffer | null },
  ) => Promise<PriorTransmission[]>;
}

/**
 * One semantic check: inspects `ctx` + `deps`, returns its findings (sync or
 * async). It NEVER halts — returning findings is its only output.
 */
export type SemanticCheck = (
  ctx: PipelineContext,
  deps: SemanticDeps,
) => Finding[] | Promise<Finding[]>;

/**
 * The body-inspecting checks: skipped when there is no parse+schema-valid body.
 *
 * `advisoriesCheck` is the WHOLE Advisories category behind one entry (pwd/bva):
 * it runs every check registered in `semantic/advisory.ts` `ADVISORY_CHECKS`, so
 * growing the advisory catalogue never touches this file. Advisories are
 * observations, not verdicts — they emit `severity: 'info'` under their own
 * `adv.*` id namespace and provably cannot move any §7 requirement's status; see
 * that module's header for how that is enforced rather than merely intended.
 */
const BODY_CHECKS: readonly SemanticCheck[] = [
  duplicateCheck,
  intervalCheck,
  inventoryCheck,
  customDataSchemaCheck,
  advisoriesCheck,
];

/**
 * Build the semantic stage closed over its `deps`. Composes the checks,
 * awaits each, and pushes every returned finding onto `ctx.findings`. Always
 * continues (never halts).
 */
export function semanticStage(deps: SemanticDeps): Stage {
  return {
    name: 'semantic',
    async run(ctx: PipelineContext) {
      // Concurrency is independent of the body — always run it.
      const checks: SemanticCheck[] = [concurrencyCheck];

      // Body-inspecting checks need a parse+schema-valid body. In the real
      // pipeline this guard is always satisfied; it is defensive (see schema.ts).
      if (ctx.parseOk === true && ctx.schemaOk === true && ctx.parsedBody != null) {
        checks.push(...BODY_CHECKS);
      }

      for (const check of checks) {
        const findings = await check(ctx, deps);
        for (const finding of findings) ctx.findings.push(finding);
      }

      return CONTINUE;
    },
  };
}
