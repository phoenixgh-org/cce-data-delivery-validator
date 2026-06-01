/**
 * Semantic check — §3.3 present-object inventory (owning issue: 8ji.4).
 *
 * §3.3 ("transmit all collected objects") is classed 📝 self-attestation in the
 * §7 teaching matrix: a validator that only ever sees what arrives CANNOT know
 * what the supplier collected but omitted. So this check NEVER grades. It emits
 * exactly ONE `info` finding that inventories which DS01 object types are
 * PRESENT across the payload, with a per-type count, plus the honesty framing
 * that we can only report what we received. The §7 `deriveStatus` ignores `info`
 * severities, so the row stays 'self-attestation' regardless of this finding.
 *
 * DS01 object types appear as the object-valued (or scalar) keys of each Report
 * and each Record. We identify them STRUCTURALLY rather than against a fixed
 * allow-list: a key is treated as a DS01 object code when it matches
 * {@link DS01_CODE} — 3-4 uppercase letters with an optional trailing digit
 * (e.g. `AMID`, `ABST`, `CMPR2`, `CDAT2`) — and is not the structural `records`
 * key (which holds the record array, not an object type). Counts tally how many
 * reports/records carry each code (one per containing object, not per value).
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';

/**
 * DS01 object-code shape: 3-4 uppercase letters, optional trailing digit
 * (covers `CID`, `AMID`, `ABST`, and the digit-suffixed `CMPR2`/`CDAT2`).
 */
const DS01_CODE = /^[A-Z]{3,4}[0-9]?$/;

/** Structural keys that look code-ish but are NOT DS01 object types. */
const NON_DS01_KEYS = new Set<string>(['records']);

function isDs01Code(key: string): boolean {
  return DS01_CODE.test(key) && !NON_DS01_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tally each present DS01 code on `obj` into `counts` (one per containing object). */
function tally(obj: Record<string, unknown>, counts: Map<string, number>): void {
  for (const key of Object.keys(obj)) {
    if (isDs01Code(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
}

export const inventoryCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const body = ctx.parsedBody as { data?: unknown } | null | undefined;
  const data = body?.data;

  // Nothing to inventory: no/empty data array → no finding.
  if (!Array.isArray(data) || data.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();

  for (const report of data) {
    if (!isPlainObject(report)) continue;
    // Report-level object codes (e.g. AMID, CID, EDOP, EMFR, ACAT, ASER).
    tally(report, counts);
    // Record-level object codes inside each Report's `records[]`.
    const records = report.records;
    if (Array.isArray(records)) {
      for (const record of records) {
        if (isPlainObject(record)) tally(record, counts);
      }
    }
  }

  // Genuinely nothing recognizable to inventory → no finding.
  if (counts.size === 0) {
    return [];
  }

  // Deterministic order: alphabetical by code so the detail is stable.
  const inventory = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, n]) => `${code}×${n}`)
    .join(', ');

  return [
    {
      requirement: '3.3',
      severity: 'info',
      detail:
        `present DS01 objects: ${inventory}. ` +
        '§3.3 is self-attestation: this inventories only what was PRESENT in the ' +
        'transmission — we cannot know what the supplier collected but omitted.',
    },
  ];
};
