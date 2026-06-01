/**
 * Semantic check — §1.8 duplicate detection (owning issue: 8ji.1).
 *
 * STUB: returns no findings so the pipeline stays green until 8ji.1 lands. The
 * real check uses `deps.findPriorTransmissions(ctx.sessionUuid, { transferId,
 * contentHash })` (transferId from `ctx.meta.transferId`, contentHash = sha256
 * of `ctx.rawBody`) to flag same-transferId / exact-replay repeats.
 */

import type { SemanticCheck } from '../semantic.js';

// TODO(8ji.1): implement §1.8 duplicate detection (same-transferId + exact replay).
export const duplicateCheck: SemanticCheck = () => [];
