/**
 * ADVISORY — `adv.null_padding`: a property sent as `null` in every record that
 * carried it (owning issue: pwd, bite bva slice C; remedy wording decided in
 * 52r).
 *
 * The motivating habit (pwd): a supplier emits EVERY property the schema
 * defines and sets to JSON `null` everything they have no reading for. It is
 * schema-legal (most DS01 objects are nullable) and requirement-legal, but it
 * erases a distinction the receiving country cares about: a null reads as
 * "this device sometimes produces a value for this property (just not right
 * now)", while omission reads as "this device never produces a value for this
 * property". A device that pads every defined property says the first thing
 * when it means the second.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace
 * via {@link advisory}, so it provably cannot move any §7 requirement's
 * pass/fail status (advisory.ts's header explains how that is enforced).
 *
 * ── PER TRANSMISSION, ONE FINDING ────────────────────────────────────────────
 * pwd is explicit that the session-level view comes from aggregating findings
 * the dashboard already fetches, with no new read path — so this emits per
 * transmission. It emits ONE finding naming every padded property rather than
 * one per property: the dashboard folds advisories by id and shows only the most
 * recent occurrence's detail, so a finding-per-property would render as a count
 * with a single arbitrary property's prose behind it. The detail names EVERY
 * padded property (52r retired the old six-name cap): the list is the
 * actionable part, and it is bounded by the schema's property count.
 *
 * ── THE FLOOR ON N — 12 RECORDS ──────────────────────────────────────────────
 * A property null in both records of a 2-record transmission proves nothing, so
 * a property qualifies only once at least {@link MIN_RECORDS} records carried
 * it. DS01's per-period objects (CMPR, DORV, SVA…) are defined over a 15-minute
 * sampling period, so 12 records is three hours of continuous monitoring — a
 * property null through every one of those is a pattern rather than a quiet
 * stretch. For scale, the repo's own fully conformant EMS baseline
 * (src/exercise/baseline.ts) is 3 records — four times under the floor, so
 * short well-behaved transmissions stay silent. (An earlier revision also
 * argued the floor from wire bytes; 52r retired the byte-cost framing, and the
 * evidence argument stands on its own.)
 *
 * ── WHAT IS EXCLUDED, AND WHY ────────────────────────────────────────────────
 * {@link CONDITION_CODES} — ALRM, EERR, LERR — are skipped. For those three the
 * schema defines `null` as the value MEANING "no condition present" ("Presence
 * of defined alarm conditions"; "codes corresponding to conditions that may
 * impair normal operation"). A device that raised no alarm and logged no error
 * all period correctly sends null in every record — an explicit "all's well" —
 * so counting them would report a healthy device as a padded one. The repo's
 * own conformant EMS baseline is exactly that shape.
 *
 * Only RECORD-level properties are considered. Report-level nulls exist too,
 * but they occur once per device rather than once per reading, and the
 * report-level identity case has its own advisory (`adv.null_identity`).
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, then teach the two encodings — never conclude. A 100 %-null rate is
 * strong evidence, never proof: a genuinely broken sensor looks identical from
 * here, so the detail states what arrived and what each encoding says, and
 * leaves what the nulls MEAN to the only party that knows.
 *
 * The remedy is hedged ON PURPOSE: "should generally be omitted — unless the
 * record schema requires it" (52r). Several DS01 objects (BEMD, CMPR, DORV on
 * the EMS branch) are required AND nullable, so an unconditional "leave it out"
 * would coach a supplier into failing `required` and losing §3.2 — the bug 52r
 * fixed. The hedge keeps the advice legal for every property WITHOUT this
 * check learning per-branch, per-version required sets: `schemaVersion` stays
 * an opaque registry key project-wide, and the supplier — who knows which
 * record branch they send — resolves the hedge. For a required-nullable
 * property the closing sentence still earns its place: a steady null is
 * exactly how such a property says "no reading".
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory.js';

/**
 * Minimum number of records that must carry a property before its being null in
 * all of them says anything. See the header for why 12.
 */
export const MIN_RECORDS = 12;

/**
 * DS01 objects where `null` is the DEFINED encoding for "nothing to report",
 * not an absent reading. Skipped — see the header.
 */
const CONDITION_CODES = new Set<string>(['ALRM', 'EERR', 'LERR']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thousands separators without a locale dependency (tests pin these strings). */
function group(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `a`, `a and b`, `a, b and c`. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

interface KeyStats {
  /** Records that carried the key at all. */
  carried: number;
  /** Of those, how many carried `null`. */
  nulls: number;
  /** Pointer to the first record that carried it, for the drill-down. */
  firstPointer: string;
}

/**
 * A FUNCTION DECLARATION rather than the sibling `export const check:
 * SemanticCheck =` idiom, for the ESM-cycle reason spelled out at the same place
 * in null-identity.ts: this module and advisory.ts import each other, and a
 * hoisted declaration is initialized before any module body runs, so
 * `ADVISORY_CHECKS` can name it whichever module loads first.
 */
export function nullPaddingCheck(ctx: PipelineContext): Finding[] {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const stats = new Map<string, KeyStats>();
  let totalRecords = 0;

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      totalRecords += 1;

      for (const key of Object.keys(record)) {
        if (CONDITION_CODES.has(key)) continue;
        const existing = stats.get(key);
        const isNull = record[key] === null;
        if (existing === undefined) {
          stats.set(key, {
            carried: 1,
            nulls: isNull ? 1 : 0,
            firstPointer: `/data/${reportIndex}/records/${recordIndex}/${key}`,
          });
          continue;
        }
        existing.carried += 1;
        if (isNull) existing.nulls += 1;
      }
    }
  }

  // Padded: null in EVERY record that carried it, over enough records to say so.
  const padded = [...stats.entries()]
    .filter(([, s]) => s.carried >= MIN_RECORDS && s.nulls === s.carried)
    .sort(([aKey, a], [bKey, b]) => b.nulls - a.nulls || aKey.localeCompare(bKey));

  if (padded.length === 0) return [];

  const list = joinPhrases(padded.map(([key]) => key));
  const carried = padded.length === 1 ? 'it' : 'them';

  return [
    advisory({
      id: 'adv.null_padding',
      pointer: padded[0]![1].firstPointer,
      detail:
        `Across the ${group(totalRecords)} records in this transmission, ${list} arrived as ` +
        `null in every record that carried ${carried}. A consistent null is acceptable for a ` +
        `property the device will sometimes populate with a real value or measurement. But a ` +
        `property that never carries a value should generally be omitted — unless the record ` +
        `schema requires it. Sending null says "this device sometimes produces a value for ` +
        `this property (just not right now)", while omission says "this device never produces ` +
        `a value for this property".`,
    }),
  ];
}

/** The frozen stage-8 signature, checked without giving up the hoisting above. */
nullPaddingCheck satisfies SemanticCheck;
