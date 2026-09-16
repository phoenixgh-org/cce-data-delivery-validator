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
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many records
 * carry an ABST no later than the one before, and the widest step back among
 * them. `detail` is the RATIONALE, static and carrying no numbers: what E006
 * reads a records array as, what a receiving country does with the order, and
 * the remedy.
 *
 * ELAPSED TIME IS STATED IN MINUTES (decided 2026-09-15), including large values
 * — `165 min`, never `2 h 45 min`. Seconds are reserved for values that quote a
 * schema object whose own unit is seconds, which a step between two ABSTs is
 * not. {@link minutesPhrase} keeps a positive step from rounding to `0 min`,
 * because zero is exactly how a REPEATED timestamp reads there.
 *
 * Observe, never conclude. We state what arrived — how many records, how far
 * back — and what a receiving system can and cannot do with a series in that
 * order. We do NOT say which record is the misplaced one: from the receiving
 * side, a pair `[10:15, 10:00]` is equally consistent with a record out of
 * position, a mis-stamped timestamp, and a genuinely re-clocked logger, and
 * picking one would be the concluding language this category forbids.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';
import { parseAbst } from './interval.js';

/**
 * THIS CHECK'S ADVISORY ID, exported so the registry can collect it (axdd).
 * `ADVISORY_IDS` in ./advisory.ts is built from these constants rather than from
 * a second hand-maintained list, so the id the check emits and the id the
 * coverage join asks about cannot drift apart.
 */
export const TIME_NOT_INCREASING_ID = 'adv.time_not_increasing' as const;

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
   * rounding it away would let the observation describe it as a tie it is not —
   * see {@link minutesPhrase}, which is what protects that.
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
 * A step back rendered in MINUTES — `45 min`, `0.5 min`, `0 min` for a repeat.
 * Minutes is the unit every advisory observation states elapsed time in, however
 * large the value (decided 2026-09-15).
 *
 * A POSITIVE STEP NEVER RENDERS AS `0 min`. ABST's pattern admits a fractional
 * part, so a reversal of a few hundred milliseconds is two DIFFERENT timestamps
 * in the payload as sent (1dda); rounding it away would read as the tie it is
 * not, and zero is reserved for an exactly repeated timestamp. Steps under a
 * thousandth of a minute therefore keep one significant figure instead.
 */
function minutesPhrase(ms: number): string {
  const minutes = ms / 60_000;
  const shown = minutes >= 0.001 ? Number(minutes.toFixed(3)) : Number(minutes.toPrecision(1));
  return `${shown} min`;
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
  const recordNoun = found.length === 1 ? 'record' : 'records';
  const carry = found.length === 1 ? 'carries' : 'carry';

  return [
    advisory({
      id: TIME_NOT_INCREASING_ID,
      pointer: first.pointer,
      summary:
        `${found.length} ${recordNoun} ${carry} an ABST no later than the one before; the ` +
        `widest step back is ${minutesPhrase(worstMs)}.`,
      detail:
        "E006 reads a report's records as a time series with ABST strictly increasing down " +
        'the array, and the receiving country stores them in the order sent. Sorting records ' +
        'oldest-first before assembling the array ensures that the order in the payload ' +
        'reflects the order of the physical readings.',
    }),
  ];
};
