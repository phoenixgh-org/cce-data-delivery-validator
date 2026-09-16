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
 * ── ONE FINDING PER TRANSMISSION, COUNTED BY FIELD ───────────────────────────
 * Like every advisory, this emits ONE finding per transmission: the compliance
 * column carries a single signature row per advisory id — title, and a count of
 * the DISTINCT transmissions it appeared in, with no detail — while the prose is
 * read per transmission, in the transmission block. A finding per offending
 * value would therefore add no row, only stack near-identical lines in that
 * block.
 *
 * Offending values are still folded BY FIELD rather than per occurrence, because
 * the count the observation states is a count of FIELDS: a transmission may
 * carry hundreds of records, and a record-level EDOP mis-shaped in every one of
 * them is one field in another form, not hundreds.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many date
 * fields arrived in another form, then the FIRST of them with its pointer and
 * its value as sent. `detail` is the RATIONALE, static and carrying no numbers:
 * what the DS01 date objects are, that Annex 1 prescribes YYYY-MM-DD, and what
 * uniform field widths buy a receiving system.
 *
 * ONLY THE FIRST FIELD IS NAMED (agj.17). The approved observation is one line,
 * so the remaining fields are reached through the raw-payload drill-down the
 * finding's pointer opens rather than listed in the prose; the count tells the
 * reader how many there are to find.
 *
 * Observe, never conclude. We state the field, the value AS SENT, the ISO-8601
 * form, and what a receiving system cannot do with dates whose field widths
 * vary. We never re-write a supplier's value into what we think it meant:
 * `2026-7-4` looks obvious and `07/04/2026` is genuinely ambiguous, and guessing
 * either would be the concluding language this category is forbidden.
 *
 * ── THE DS01.3 SHADOW SAYS THE SAME THING, AND NEEDS NO GATE ─────────────────
 * The DS01.3 Annex 4 draft DOES pattern the five report-level date objects and
 * record-level EDOP, so a mis-shaped date is a clause 5.3.2 schema failure under
 * the shadow profile the schema stage now also grades (bd by1c.6). This check is
 * deliberately NOT gated to the 2025 profile, because the order of the stages
 * already settles which surface speaks:
 *
 *   - a payload declaring the 0.8.x lineage is accepted (0.8.1 has nothing to
 *     say about a date), so this advisory fires AND the shadow run records the
 *     5.3.2 failure — one fact on two surfaces, which is the point: the advisory
 *     says what the contract cannot grade, the shadow says what the successor
 *     would;
 *   - a payload declaring the Annex 4 lineage is rejected 422 at stage 7, before
 *     stage 8 runs at all, so nothing is double-reported.
 *
 * Both directions are pinned in ./date-format.test.ts.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/**
 * THIS CHECK'S ADVISORY ID, exported so the registry can collect it (axdd).
 * `ADVISORY_IDS` in ./advisory.ts is built from these constants rather than from
 * a second hand-maintained list, so the id the check emits and the id the
 * coverage join asks about cannot drift apart.
 */
export const DATE_FORMAT_ID = 'adv.date_format' as const;

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

/** One offending field, folded across every place it arrived in another form. */
interface FieldStats {
  /** Pointer to the FIRST value seen in another form. */
  firstPointer: string;
  /** That first value, as sent. */
  firstValue: string;
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

/** The `adv.date_format` check, registered in `ADVISORY_CHECKS`. */
export const dateFormatCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Insertion order is document order, so the first entry is also the first
  // offending value in the payload — which is what the finding points at.
  const offenders = new Map<string, FieldStats>();

  // Folded BY FIELD: only the FIRST occurrence of each field is kept, which is
  // the one the observation names. Later occurrences need no state — the count
  // the observation states counts fields, and the pointer opens the raw payload
  // where the rest of them can be read.
  const note = (field: string, pointer: string, value: string): void => {
    if (offenders.has(field)) return;
    offenders.set(field, { firstPointer: pointer, firstValue: value });
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
  const [firstField, firstStats] = entries[0]!;
  const fieldNoun = entries.length === 1 ? 'date field' : 'date fields';
  const areIs = entries.length === 1 ? 'is' : 'are';

  return [
    advisory({
      id: DATE_FORMAT_ID,
      pointer: firstStats.firstPointer,
      summary:
        `${entries.length} ${fieldNoun} ${areIs} not YYYY-MM-DD — ${firstField} at ` +
        `${firstStats.firstPointer} arrived as ${quote(firstStats.firstValue)}.`,
      detail:
        'The DS01 date objects (ADOP, LDOP, EDOP, CDAT, CDAT2) are plain strings, so a date ' +
        'arrives in whatever form it was written. YYYY-MM-DD, the ISO 8601 calendar date ' +
        'format, is prescribed by DS01 Annex 1, ensuring that every date representation has ' +
        'the same field widths, which is what lets a receiving system order and compare them.',
    }),
  ];
};
