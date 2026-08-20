/**
 * ADVISORY — `adv.date_format`: a production date sent in a form other than the
 * ISO-8601 calendar date `YYYY-MM-DD` (owning issue: agj.1, epic agj — the PQS
 * "common EMS data issues" list).
 *
 * The motivating habit (agj.1): production dates arriving unpadded, e.g.
 * `2026-7-4` where the DS01 examples all read `2026-07-04`.
 *
 * ── THE GAP IS TOTAL, AND MEASURED ───────────────────────────────────────────
 * In cce-interop-0.8.1, all five date objects are declared as bare strings with
 * NO `format` and NO `pattern`:
 *
 *   ADOP, EDOP, CDAT, CDAT2   `["string","null"]`
 *   LDOP                      `"string"`
 *
 * So `2026-7-4`, `07/04/2026` and `next Tuesday` all pass Ajv, and nothing
 * downstream of the schema looks at them either. This is the same shape as
 * custom-schema.ts: the schema deliberately does not express the constraint, so
 * the employer layer is the only place it can be observed at all.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace
 * via {@link advisory}, so it provably cannot move any §7 requirement's pass/fail
 * status (advisory.ts's header explains how that is enforced rather than merely
 * intended). A supplier whose dates read `2026-7-4` has broken no requirement —
 * the schema accepts the value — which is exactly why this is an advisory.
 *
 * ── WHERE THE DATES LIVE ─────────────────────────────────────────────────────
 * {@link REPORT_DATE_FIELDS} at REPORT level, and EDOP again at RECORD level.
 * Record-level EDOP is in scope deliberately (Benson, 2026-08-18): `ems-record`
 * and `rtmd-record` both declare it as an optional bare string, with the same
 * total format gap as the report-level five, so an advisory that skipped it
 * would be silent on half the places a mis-shaped date can arrive.
 *
 * BRANCH-AGNOSTIC BY CONSTRUCTION. Both report branches declare the same five
 * codes and both record branches declare EDOP, so this check needs no
 * `meta.transferType` discriminator: it looks for the names wherever they are,
 * which covers EMS and RTMD payloads with one pass and cannot go stale if a
 * branch gains a date object it did not have.
 *
 * ── NULL IS SOMEBODY ELSE'S BUSINESS ─────────────────────────────────────────
 * A `null` date is skipped outright. Four of the five are nullable, and a null
 * is an absent value rather than a mis-shaped one — whether that absence is
 * worth saying anything about is `adv.null_padding`'s question, not this one.
 * Non-string values are skipped for the mirror reason: a number where a date
 * belongs is a §3.2 schema matter Ajv already grades, and this check only ever
 * speaks about text it can compare against the ISO form.
 *
 * ── ONE FINDING PER TRANSMISSION, GROUPED BY FIELD ───────────────────────────
 * Like every advisory, this emits ONE finding per transmission: the compliance
 * column carries a single signature row per advisory id — title, and a count of
 * the DISTINCT transmissions it appeared in, with no detail — while the detail
 * prose is read per transmission, in the transmission block. A finding per
 * offending value would therefore add no row, only stack near-identical lines in
 * that block.
 *
 * Within that one finding the prose is grouped BY FIELD, not per occurrence,
 * naming each offending field once with the pointer and value of its first
 * occurrence and a count of the rest. A transmission may carry hundreds of
 * records, so listing every occurrence of a mis-shaped record-level EDOP would
 * be an unreadable finding; grouping bounds the prose at six entries (the five
 * report-level codes plus record-level EDOP) while still naming every field that
 * arrived in another form, with a pointer to somewhere it really happened.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We state the field, the value AS SENT, the ISO-8601
 * form, and what a receiving system cannot do with dates whose field widths
 * vary. We never re-write a supplier's value into what we think it meant:
 * `2026-7-4` looks obvious and `07/04/2026` is genuinely ambiguous, and guessing
 * either would be the concluding language this category is forbidden.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory.js';

/** The strict ISO-8601 calendar date: four-digit year, two-digit month and day. */
export const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** The DS01 date objects declared at REPORT level, in the order they are reported. */
export const REPORT_DATE_FIELDS = ['ADOP', 'LDOP', 'EDOP', 'CDAT', 'CDAT2'] as const;

/** The one DS01 date object declared at RECORD level, on both record branches. */
export const RECORD_DATE_FIELD = 'EDOP';

/** Longest value quoted verbatim in the prose; anything longer is elided. */
const MAX_QUOTED = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a`, `a and b`, `a, b and c` — the house list style. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** One offending field, folded across every place it arrived in another form. */
interface FieldStats {
  /** Pointer to the FIRST value seen in another form. */
  firstPointer: string;
  /** That first value, as sent. */
  firstValue: string;
  /** How many values of this field arrived in another form. */
  count: number;
}

/**
 * Whether `value` is a date this check has something to say about: a string, and
 * not one in the ISO form. Null and non-strings are skipped — see the header.
 */
function isNonIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !ISO_DATE.test(value);
}

/** The value as it will be quoted: verbatim, elided if it runs long. */
function quote(value: string): string {
  const shown = value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED)}…` : value;
  return `"${shown}"`;
}

/** `ADOP at /data/0/ADOP arrived as "2026-7-4"`, plus the count of any others. */
function describe(field: string, stats: FieldStats): string {
  const others = stats.count - 1;
  const more = others > 0 ? ` and in ${others} other ${others === 1 ? 'place' : 'places'}` : '';
  return `${field} at ${stats.firstPointer} arrived as ${quote(stats.firstValue)}${more}`;
}

/**
 * A FUNCTION DECLARATION rather than the `export const check: SemanticCheck =`
 * idiom the §7 checks use, for the ESM-cycle reason spelled out at the same place
 * in null-padding.ts and null-identity.ts: this module imports {@link advisory}
 * from advisory.ts while advisory.ts names this check in `ADVISORY_CHECKS`, and
 * only a hoisted declaration is initialized before either module body runs.
 */
export function dateFormatCheck(ctx: PipelineContext): Finding[] {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Insertion order is document order, so the first entry is also the first
  // offending value in the payload — which is what the finding points at.
  const offenders = new Map<string, FieldStats>();

  const note = (field: string, pointer: string, value: string): void => {
    const existing = offenders.get(field);
    if (existing === undefined) {
      offenders.set(field, { firstPointer: pointer, firstValue: value, count: 1 });
      return;
    }
    existing.count += 1;
  };

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;

    for (const field of REPORT_DATE_FIELDS) {
      const value = report[field];
      if (isNonIsoDate(value)) note(field, `/data/${reportIndex}/${field}`, value);
    }

    const records = report.records;
    if (!Array.isArray(records)) continue;
    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      const value = record[RECORD_DATE_FIELD];
      if (isNonIsoDate(value)) {
        note(
          RECORD_DATE_FIELD,
          `/data/${reportIndex}/records/${recordIndex}/${RECORD_DATE_FIELD}`,
          value,
        );
      }
    }
  }

  if (offenders.size === 0) return [];

  const entries = [...offenders.entries()];
  const list = joinPhrases(entries.map(([field, stats]) => describe(field, stats)));
  const fieldNoun = entries.length === 1 ? 'date field' : 'date fields';

  return [
    advisory({
      id: 'adv.date_format',
      pointer: entries[0]![1].firstPointer,
      detail:
        `This transmission carries ${entries.length} ${fieldNoun} in a form other than ` +
        `YYYY-MM-DD: ${list}. The DS01 date objects (ADOP, LDOP, EDOP, CDAT and CDAT2) are ` +
        `declared as plain strings, so a date arrives at the receiving country in whatever ` +
        `form it was written. YYYY-MM-DD — the ISO-8601 calendar date, as in 2026-07-04 — ` +
        `gives every date the same field widths, and a receiving system cannot order or ` +
        `compare dates whose field widths vary.`,
    }),
  ];
}

/** The frozen stage-8 signature, checked without giving up the hoisting above. */
dateFormatCheck satisfies SemanticCheck;
