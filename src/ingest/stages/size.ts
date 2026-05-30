/**
 * Stage 3 — size (DESIGN.md §6 row 3: wire body ≤ 1MB after content-encoding,
 * §1.4). On failure → **413** + finding.
 *
 * The §1.4 cap is measured on the EXACT wire bytes — `ctx.rawBody.length` — which
 * are the bytes ON THE WIRE, i.e. AFTER any `Content-Encoding` (DESIGN.md §4.1,
 * §6 size note). We deliberately do NOT decompress before measuring: the
 * requirement bounds what the supplier actually transmits, and measuring the
 * decompressed size would also expose us to zip-bomb expansion.
 */

import { halt, record, type PipelineContext, type Stage, type StageOutcome } from '../pipeline.js';

/** §1.4 wire-byte cap: 1MB = 1024 × 1024 bytes. */
const MAX_WIRE_BYTES = 1_048_576;

export function sizeStage(): Stage {
  return {
    name: 'size',
    run(ctx: PipelineContext): StageOutcome {
      const wireBytes = ctx.rawBody.length;
      if (wireBytes > MAX_WIRE_BYTES) {
        // Over the §1.4 cap → record the teaching finding, then 413.
        ctx.findings.push({
          requirement: '1.4',
          severity: 'fail',
          detail: `wire body ${wireBytes} bytes exceeds the 1MB cap (${MAX_WIRE_BYTES} bytes)`,
        });
        return halt(413);
      }
      // Within the cap: a pass finding feeds the §7 teaching matrix (1.4 is ✅
      // passively verified by measuring wire bytes), then continue.
      return record(ctx, {
        requirement: '1.4',
        severity: 'pass',
        detail: `wire body ${wireBytes} bytes is within the 1MB cap`,
      });
    },
  };
}
