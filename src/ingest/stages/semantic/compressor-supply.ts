/**
 * ADVISORY — `adv.compressor_exceeds_supply`: a mains EMS record whose
 * compressor ran for more seconds than the record itself reports AC supply was
 * available (owning issue: agj.3, epic agj — the PQS "common EMS data issues"
 * list).
 *
 * The motivating question (agj.3, quoting PQS): "In an AC fridge, CMPR <= SVA.
 * How can the compressor run longer than power was available?" Both objects are
 * 0–900 second accumulators over the SAME 15-minute period, so the comparison is
 * deterministic per-record arithmetic on delivered data with no threshold to
 * tune. Nothing checks it today: the schema bounds each object independently
 * (`minimum: 0`, `maximum: 900` on each) and has no vocabulary for relating two
 * properties of the same record, so a record carrying `CMPR: 900, SVA: 120`
 * validates exactly like a conformant one.
 *
 * ── EMS ONLY ────────────────────────────────────────────────────────────────
 * RTMDs do not measure compressor runtime, so `transferType: 'rtm'` is skipped
 * entirely rather than graded and found silent (Benson, 2026-08-18). The rtmd
 * branch does declare CMPR/CMPR2/SVA as optional properties in 0.8.1, but an
 * RTMD emitting compressor runtime is a different matter, not this check's
 * business — and rtmd-record carries no mains/solar partition to select on, so
 * the discriminator below would have nothing to read there.
 *
 * ── THE MAINS/SOLAR PARTITION IS THE SCHEMA'S, NOT A HEURISTIC ──────────────
 * `ems-record.allOf[0]` is an EXCLUSIVE `oneOf`, present in both registered
 * versions (0.8.0 and 0.8.1):
 *
 *     mains: required [SVA],        not required [DCSV, DCCD]
 *     solar: required [DCSV, DCCD], not required [SVA]
 *
 * (Verified with Ajv against the vendored 0.8.1: DCSV+DCCD without SVA is VALID;
 * SVA together with DCSV is INVALID; neither is INVALID.) So the PRESENCE of the
 * `SVA` property is the schema-sanctioned mains/solar discriminator, and this
 * check reads that presence — {@link isMainsRecord} — rather than testing SVA
 * for null, which would conflate "this is a DC appliance" with "this mains
 * appliance had no supply reading".
 *
 * ── SOLAR RECORDS ARE OUT OF SCOPE, AND NOTHING MAY SUBSTITUTE FOR SVA ──────
 * A solar record is not merely skipped for convenience: there is NOTHING on it
 * to read CMPR against. DCSV is "Average DC supply voltage to appliance within
 * each 15 minute period" — a VOLTAGE, bounded 0..999.9, not a duration. The
 * phrase "samples collected at intervals not longer than 10 seconds" in its
 * description is the SAMPLING RATE, not the unit. No DC-availability-in-seconds
 * object exists anywhere in PQS-DS01-objects through 0.8.4, so comparing CMPR to
 * DCSV would be comparing seconds against volts. DCSV can establish that DC
 * power was PRESENT; it can never say for how long, so it cannot bound CMPR.
 * Do not later "extend" this check to the solar branch by substituting DCSV.
 *
 * ── NOT A BACKSTOP FOR adv.cmpr_minutes, AND VICE VERSA ─────────────────────
 * This check is STRUCTURALLY BLIND to the pre-0.8.0 CMPR minutes erratum that
 * ./cmpr-minutes.ts (agj.7) observes, and that blindness is a property of the
 * arithmetic rather than an oversight: a supplier still emitting MINUTES has
 * CMPR <= 15 while seconds-valued SVA runs to 900, so `CMPR > SVA` essentially
 * never fires for them. The two checks are complementary; neither covers the
 * other's population, and removing either loses a distinct signal.
 *
 * ── NULLS ARE SKIPPED ───────────────────────────────────────────────────────
 * Both objects are nullable, and a null on either side leaves the arithmetic
 * with no two numbers to compare. A null CMPR beside a numeric SVA says nothing
 * about compressor duty, and a null SVA on a mains record says the supply
 * reading is missing, not that it was zero — reading it as zero would turn every
 * running compressor into an observation. Skipping can only under-report.
 *
 * ── ONE FINDING PER TRANSMISSION ────────────────────────────────────────────
 * Like every advisory (the compliance column carries a single signature row per
 * advisory id — title, and a count of the DISTINCT transmissions it appeared in,
 * with no detail — while the detail prose is read per transmission in the
 * transmission block), this emits ONE finding carrying the three things
 * agj.3 asks for: HOW MANY records exceed their own supply, the WORST excess in
 * seconds, and a pointer to the FIRST one in document order.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many records
 * report a compressor runtime larger than their own SVA, which compressor
 * objects those were, and the largest excess. `detail` is the RATIONALE, static
 * and carrying no numbers: what the two objects share, and why one running past
 * the other is unexpected.
 *
 * The excess is stated in SECONDS, not the minutes the duration rule gives
 * elapsed-time phrases (decided 2026-09-15): it is the difference between two
 * schema objects whose own declared unit is seconds, so seconds is what it
 * quotes.
 *
 * THE SOLAR SENTENCE IS NOT IN THE RATIONALE (decided 2026-09-15). The check
 * already skips solar records, so the supplier reading this finding is holding a
 * mains record; the reason nothing on the solar branch substitutes for SVA lives
 * in this header, where the next contributor is the one who needs it.
 *
 * Observe, never conclude. From the receiving side a record with `CMPR: 420,
 * SVA: 200` is equally consistent with a mis-scaled CMPR, a mis-scaled SVA, an
 * accumulator that was not reset, and a genuine metering fault. We state what
 * arrived and what the two objects share — and name no cause.
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
export const COMPRESSOR_EXCEEDS_SUPPLY_ID = 'adv.compressor_exceeds_supply' as const;

/** The compressor-runtime objects, in the order they are reported. */
export const COMPRESSOR_KEYS: readonly string[] = ['CMPR', 'CMPR2'];

/** The AC supply-availability accumulator the compressor keys are read against. */
export const SUPPLY_KEY = 'SVA';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `a`, `a and b` — the house list style. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Which report branch the schema applied. Mirrors the root `if/then/else` of
 * cce-interop verbatim, as ./null-identity.ts does: `meta.transferType` matching
 * `^ems$` selects `ems-report`/`ems-record`, and everything else (including
 * `rtm`) falls to the rtmd branch, which this check has nothing to say about.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/**
 * Whether a record is on the MAINS branch of `ems-record.allOf[0]`, read the way
 * the schema reads it: by the PRESENCE of the `SVA` property. A solar record
 * cannot carry it (the branch's `not` forbids it), so presence is exclusive —
 * see the header for why nothing on the solar branch substitutes for it.
 */
export function isMainsRecord(record: Record<string, unknown>): boolean {
  return SUPPLY_KEY in record;
}

/** One reading whose compressor runtime is longer than its record's supply. */
interface Excess {
  /** JSON Pointer to the compressor value that exceeded. */
  pointer: string;
  /** Which compressor object it was — CMPR or CMPR2. */
  key: string;
  /** How far the runtime runs past the record's own supply, in seconds. */
  excess: number;
}

/** The `adv.compressor_exceeds_supply` check, registered in `ADVISORY_CHECKS`. */
export const compressorSupplyCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  // RTMD is out of scope entirely — see the header.
  if (!isEmsBranch(ctx)) return [];

  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Document order throughout, so the first entry collected is the first one in
  // the payload — which is what the finding points at.
  const found: Excess[] = [];

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      // Solar records (DCSV + DCCD, no SVA) are out of scope: there is nothing
      // on them to read a compressor runtime against.
      if (!isMainsRecord(record)) continue;

      const supply = record[SUPPLY_KEY];
      if (typeof supply !== 'number') continue;

      for (const key of COMPRESSOR_KEYS) {
        const runtime = record[key];
        if (typeof runtime !== 'number') continue;
        if (runtime <= supply) continue;
        found.push({
          pointer: `/data/${reportIndex}/records/${recordIndex}/${key}`,
          key,
          excess: runtime - supply,
        });
      }
    }
  }

  if (found.length === 0) return [];

  const first = found[0]!;
  const worst = found.reduce((max, one) => Math.max(max, one.excess), 0);
  // ONE RECORD CAN HOLD TWO EXCESSES — CMPR and CMPR2 both past the same SVA —
  // so the observation counts RECORDS rather than the readings collected above,
  // which is what makes "N records report ..." a true sentence in that case.
  const records = new Set(found.map((one) => one.pointer.slice(0, one.pointer.lastIndexOf('/'))));
  const recordNoun = records.size === 1 ? 'record' : 'records';
  const reports = records.size === 1 ? 'reports' : 'report';
  // The list names each compressor object once, however many readings it put
  // past SVA.
  const named = joinPhrases([...new Set(found.map((one) => one.key))]);

  return [
    advisory({
      id: COMPRESSOR_EXCEEDS_SUPPLY_ID,
      pointer: first.pointer,
      summary:
        `${records.size} ${recordNoun} ${reports} ${named} larger than ${SUPPLY_KEY}; the ` +
        `largest excess is ${worst} s.`,
      detail:
        'On a mains appliance SVA and CMPR are both represented as seconds within the same ' +
        '15-minute period. It is unexpected for the compressor to run for longer than power ' +
        'was available within the period.',
    }),
  ];
};
