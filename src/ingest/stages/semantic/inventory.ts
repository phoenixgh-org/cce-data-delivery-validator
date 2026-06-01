/**
 * Semantic check — §3.x inventory / object-code check (owning issue: 8ji.4).
 *
 * STUB: returns no findings so the pipeline stays green until 8ji.4 lands. The
 * real check reads `ctx.parsedBody` (each Report's `records[]` and their
 * 4-letter DS01 object-code keys) to grade the reported inventory.
 */

import type { SemanticCheck } from '../semantic.js';

// TODO(8ji.4): implement §3.x inventory / object-code check over parsedBody.
export const inventoryCheck: SemanticCheck = () => [];
