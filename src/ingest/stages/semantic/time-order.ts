/**
 * ADVISORY — `adv.time_not_increasing`: a report whose `records[].ABST` does not
 * step forward from one array position to the next (owning issue: agj.4, epic
 * agj — the PQS "common EMS data issues" list).
 *
 * The motivating habit (agj.4): "Time must be strictly increasing. The same goes
 * for ABST." A report's `records` array is a time series, and a supplier who
 * assembles it from an unordered store — or who re-sends a record without
 * re-stamping it — delivers a series that steps backwards, or repeats a
 * timestamp, while every individual value is a perfectly well-formed ABST.
 *
 * (PQS states the rule for RELT as well. RELT does not exist in cce-interop, so
 * this is the ABST half only, and there is nothing for the other half to grade
 * until a schema version carries the object.)
 *
 * ── THE GAP IT FILLS IS IN OUR OWN CODE ──────────────────────────────────────
 * Nothing in the pipeline looks at record ORDER. The schema constrains each ABST
 * value's shape and says nothing about its neighbours, and the one check that
 * reads the timestamps at all — §3.4's `intervalCheck` (./interval.ts) — grades
 * `[...timestamps].sort((a, b) => a - b)`. It grades the SORTED series by
 * design, because it is asking a question about CADENCE (are readings evenly
 * spaced?) that ordering would only add noise to. The consequence is precise: a
 * report whose records step backwards, or repeat a timestamp, is graded as if it
 * had arrived in order and can score a perfectly regular CV. That blind spot is
 * exactly what this check covers, and it covers it from OUTSIDE §3.4.
 *
 * ── AN ADVISORY, AND §3.4'S VERDICT DOES NOT MOVE ────────────────────────────
 * `severity: 'info'` under the `adv.*` namespace via {@link advisory}, so it
 * provably cannot move any §7 requirement's pass/fail status (advisory.ts's
 * header explains how that is enforced rather than merely intended). This is
 * deliberate and is agj.4's own instruction: §3.4 OWNS cadence regularity, and
 * its grade must read the same before and after this module existed (DESIGN §7.1
 * — a requirement's verdict is the product's contract with the supplier). So
 * this module touches ./interval.ts not at all: it imports {@link parseAbst}
 * from it and grades a different question in a different namespace.
 *
 * ── WHAT COUNTS AS A STEP THAT IS NOT FORWARD ────────────────────────────────
 * Within ONE report, records are walked in ARRAY ORDER and each parseable ABST
 * is compared against the previous parseable one. A pair is noted when the later
 * position's timestamp is EARLIER than (steps back) or EQUAL to (repeats) the
 * one before it — "strictly increasing" makes a repeat as much of an observation
 * as a reversal, and a repeat is the commoner of the two in practice (a series
 * re-stamped at whole-minute resolution, a record duplicated in assembly).
 *
 * Reports are independent. Two devices' series have no ordering relationship to
 * each other, so the walk never crosses a report boundary; the counts are then
 * summed across reports for the one per-transmission finding.
 *
 * ── UNPARSEABLE AND MISSING ABST ARE SKIPPED ─────────────────────────────────
 * A record whose ABST is absent, null, or not in the compact
 * `YYYYMMDDThhmmss(.fff)Z` form is passed over, and the comparison continues from
 * the last value that DID parse. The schema owns format enforcement — ABST
 * carries a `pattern` and is required on both record branches, so a mis-shaped
 * value is already a §3.2 matter Ajv grades — and inventing a second opinion
 * about it here would be an advisory speaking about a defect somebody else has
 * already recorded. Skipping rather than breaking the chain is the conservative
 * choice: it can only under-report.
 *
 * ── ONE FINDING PER TRANSMISSION ─────────────────────────────────────────────
 * Like every advisory, this emits ONE finding per transmission (the compliance
 * column carries a single signature row per advisory id — title, and a count of
 * the DISTINCT transmissions it appeared in, with no detail — while the detail
 * prose is read per transmission in the transmission block, so a finding per pair
 * would add no row, only stack near-identical lines in that block). It carries
 * the three things agj.4 asks for: HOW MANY positions are
 * not forward of their predecessor, the WORST backward step (in seconds, or in
 * milliseconds when ABST's sub-second precision puts it under one), and a
 * pointer to the FIRST such record in document order.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. We state what arrived — which position, how far back,
 * how many others — and what a receiving system can and cannot do with a series
 * in that order. We do NOT say which record is the misplaced one: from the
 * receiving side, a pair `[10:15, 10:00]` is equally consistent with a record
 * out of position, a mis-stamped timestamp, and a genuinely re-clocked logger,
 * and picking one would be the concluding language this category forbids.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';
import { parseAbst } from './interval.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One array position whose ABST is not later than the previous parseable one. */
interface NotForward {
  /** JSON Pointer to the ABST at that position. */
  pointer: string;
  /**
   * How far back it steps from the previous parseable ABST, in MILLISECONDS —
   * the resolution {@link parseAbst} resolves ABST to, kept unrounded because
   * the repeat-vs-reversal distinction is made on this value. Zero, and only
   * exactly zero, means the timestamp REPEATS rather than reverses: ABST's
   * pattern admits a fractional part, so a step back of a few hundred
   * milliseconds is two DIFFERENT timestamps in the payload as sent, and
   * rounding it to a whole second would let us describe it as a tie it is not.
   */
  backwardMs: number;
}

/**
 * Walk one report's records in array order and collect every position whose ABST
 * is not strictly later than the previous parseable one.
 */
function scanReport(report: unknown, reportIndex: number): NotForward[] {
  const records = isPlainObject(report) ? report.records : undefined;
  if (!Array.isArray(records)) return [];

  const found: NotForward[] = [];
  let previous: number | null = null;
  for (const [recordIndex, record] of records.entries()) {
    const epochMs = parseAbst(isPlainObject(record) ? record.ABST : undefined);
    // Unparseable or absent: skipped, and the chain continues from the last
    // value that did parse. See the header.
    if (epochMs === null) continue;
    if (previous !== null && epochMs <= previous) {
      found.push({
        pointer: `/data/${reportIndex}/records/${recordIndex}/ABST`,
        backwardMs: previous - epochMs,
      });
    }
    previous = epochMs;
  }
  return found;
}

/**
 * `900 s (15 min)` — seconds always, with the minutes reading when it is exact.
 * A step finer than a second is read in milliseconds (`300 ms`) rather than as a
 * fraction of a second nobody wrote, and a step that is neither whole seconds
 * nor sub-second keeps its fraction (`1.5 s`). Callers pass a strictly positive
 * step: zero is a repeat and gets its own wording.
 */
function describeStep(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  const exactMinutes = ms % 60_000 === 0;
  return exactMinutes ? `${seconds} s (${seconds / 60} min)` : `${seconds} s`;
}

/** What the FIRST such position did, in the supplier's terms. */
function describeFirst(first: NotForward): string {
  return first.backwardMs === 0
    ? `carries the same ABST as the record before it`
    : `carries an ABST ${describeStep(first.backwardMs)} earlier than the record before it`;
}

/** The `adv.time_not_increasing` check, registered in `ADVISORY_CHECKS`. */
export const timeOrderCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Document order throughout: reports in array order, records in array order,
  // so the first entry collected is the first one in the payload.
  const found: NotForward[] = [];
  for (const [reportIndex, report] of data.entries()) {
    found.push(...scanReport(report, reportIndex));
  }
  if (found.length === 0) return [];

  const first = found[0]!;
  const worstMs = found.reduce((max, one) => Math.max(max, one.backwardMs), 0);
  const positionNoun = found.length === 1 ? 'record' : 'records';

  // With one record there is nothing for a worst step to be worst OF: the first
  // IS it, and describeFirst has already said what it did, so the plural sentence
  // would restate the same measurement as if it were a second observation (sl4y,
  // mirroring compressor-supply.ts). A zero worst step means every one of them
  // repeats a timestamp rather than reversing — there is no step back to name, so
  // naming one would be naming a zero. It takes an EXACTLY equal epoch value to
  // get here: a sub-second reversal is a positive number of milliseconds and is
  // named as one.
  const worstPhrase =
    found.length === 1
      ? ''
      : worstMs === 0
        ? `No timestamp steps back — each of these repeats the one before it. `
        : `The furthest any of them steps back is ${describeStep(worstMs)}. `;

  return [
    advisory({
      id: 'adv.time_not_increasing',
      pointer: first.pointer,
      detail:
        `This transmission carries ${found.length} ${positionNoun} whose ABST is not later ` +
        `than the ABST of the record before it in the same report. The first is at ` +
        `${first.pointer}, which ${describeFirst(first)}. ${worstPhrase}A report's records ` +
        `are a time series: E006 reads ABST as strictly increasing down the array, and a ` +
        `receiving country stores the records in the order they were sent, so a series that ` +
        `steps back or repeats reads as a different history than the logger recorded. ` +
        `Sorting the records oldest-first before assembling the array is what keeps the ` +
        `order on the wire the order the readings happened in.`,
    }),
  ];
};
