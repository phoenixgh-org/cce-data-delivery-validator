/**
 * Semantic check — §3.x reading-interval check (owning issue: 8ji.2).
 *
 * STUB: returns no findings so the pipeline stays green until 8ji.2 lands. The
 * real check reads `ctx.parsedBody` (the `{ meta, data: Report[] }` shape, each
 * Report's `records[].ABST` UTC timestamps) to grade reading cadence.
 */

import type { SemanticCheck } from '../semantic.js';

// TODO(8ji.2): implement §3.x reading-interval check over records[].ABST.
export const intervalCheck: SemanticCheck = () => [];
