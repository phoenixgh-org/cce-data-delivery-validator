/**
 * ADVISORY — `adv.sample_gap`: two consecutive readings in one report taken more
 * than a 15-minute sampling period apart (owning issue: agj.6, epic agj — the
 * PQS "common EMS data issues" list).
 *
 * The motivating habit (agj.6, quoting PQS): "RELT delta seconds <= 900 + epsilon.
 * Sample intervals must be no longer than 900 seconds, though we should give some
 * leeway." This is the ABST half only — RELT does not exist in cce-interop, so
 * there is nothing for the other half to grade until a schema version carries the
 * object.
 *
 * ── 900 IS NOT AN ARBITRARY NUMBER ──────────────────────────────────────────
 * DS01's per-period accumulators are DEFINED over a 15-minute period, and the
 * schema's own maxima say so out loud: CMPR, CMPR2, SVA, DORV and DORF are each
 * bounded 0..900 — literally "the number of seconds within each 15-minute
 * period". So 900 s is the sampling period the whole data model is written
 * around, and two readings further apart than that leave the accumulators
 * between them with no period they can be attributed to: the receiving country
 * holds totals it cannot reconcile against the readings on either side.
 *
 * That argument is about the STANDARD, not about one record branch, so this
 * check reads both. An rtmd-report carries none of the accumulators, but its
 * readings are stamped against the same 15-minute period, and PQS states the
 * rule without qualifying it by device class.
 *
 * ── WHY §3.4 CANNOT SEE THIS ────────────────────────────────────────────────
 * ./interval.ts (§3.4) grades the COEFFICIENT OF VARIATION of the consecutive
 * intervals, which is scale-free BY DESIGN — it is asking whether a logger keeps
 * a steady cadence, a question that has to be answerable for a 15-minute logger
 * and an hourly one alike. The consequence is precise: a perfectly regular
 * ONE-HOUR series has CV 0 and earns a §3.4 pass while every one of its periods
 * is four times the one DS01 defines. The ABSOLUTE cap is a different question
 * from cadence regularity, and it belongs in its own check, outside §3.4.
 *
 * ── AN ADVISORY, AND §3.4'S VERDICT DOES NOT MOVE ───────────────────────────
 * `severity: 'info'` under the `adv.*` namespace via {@link advisory}, so it
 * provably cannot move any §7 requirement's pass/fail status (advisory.ts's
 * header explains how that is enforced rather than merely intended). §3.4 OWNS
 * cadence regularity and its grade must read the same before and after this
 * module existed (DESIGN §7.1 — a requirement's verdict is the product's
 * contract with the supplier), so this module touches ./interval.ts not at all:
 * it imports {@link parseAbst} from it and grades a different question in a
 * different namespace. ./sample-gap.test.ts pins that both ways.
 *
 * ── THE TOLERANCE — 60 SECONDS ──────────────────────────────────────────────
 * agj.6 leaves epsilon open and suggests 60 s (~6.7 %) as a starting point. 60 s
 * is what {@link SAMPLE_GAP_EPSILON_MS} carries, and the reason is QUANTIZATION
 * rather than generosity:
 *
 *   A great many feeds stamp ABST at whole-minute resolution (the schema admits
 *   sub-second precision; the field practice is `...T033000Z`). Quantizing a
 *   nominal 900 s cadence to whole minutes makes every delta a multiple of 60,
 *   so consecutive readings land at 840 s or 960 s without a single reading
 *   having been missed. 960 s is therefore the largest delta a well-behaved
 *   15-minute logger can produce from rounding alone, and 900 + 60 is exactly
 *   the bar that lets it through. The next multiple, 1020 s, is a real two-minute
 *   overrun and is observed.
 *
 * The tolerance cannot mask a MISSED reading, which is the thing this check
 * exists to notice: skipping one period puts the delta at 1800 s, nearly double
 * the bar. Any epsilon under 900 has that property, so 60 is chosen as the
 * SMALLEST value that absorbs whole-minute stamping — it buys silence on the one
 * legitimate artefact and gives up nothing else. (Compare ./null-padding.ts's
 * MIN_RECORDS, chosen the same way: the smallest floor that makes the signal
 * mean what it claims.)
 *
 * ── ORDER IS NOT THIS CHECK'S BUSINESS ──────────────────────────────────────
 * Each report's parseable timestamps are SORTED before the deltas are taken,
 * exactly as §3.4 sorts them and for the same reason: "how far apart were these
 * readings taken?" is a question about the set of INSTANTS, not about the array
 * positions they arrived in. A series that steps backwards is ./time-order.ts's
 * observation (`adv.time_not_increasing`), and measuring gaps off the unsorted
 * array would report that one defect a second time, under a second id, as a gap
 * that nothing about the readings supports. So a swapped pair of otherwise
 * quarter-hourly readings raises time-order alone and stays silent here.
 *
 * ── UNPARSEABLE AND MISSING ABST ARE SKIPPED ────────────────────────────────
 * A record whose ABST is absent, null, or not in the compact
 * `YYYYMMDDThhmmss(.fff)Z` form is passed over, and the neighbouring readings
 * that DID parse become consecutive. The schema owns format enforcement — ABST
 * carries a `pattern` and is required on both record branches, so a mis-shaped
 * value is already a §3.2 matter Ajv grades. This does mean a skipped record can
 * widen a delta into a gap; that is the honest reading, since a timestamp we
 * cannot place is a reading we cannot attribute to a period either.
 *
 * Reports are independent. Two devices' series say nothing about each other's
 * sampling, so the walk never crosses a report boundary; the gaps are then
 * pooled across reports for the one per-transmission finding.
 *
 * ── ONE FINDING PER TRANSMISSION ────────────────────────────────────────────
 * Like every advisory, this emits ONE finding per transmission (the compliance
 * column carries a single signature row per advisory id — title, and a count of
 * the DISTINCT transmissions it appeared in, with no detail — while the detail
 * prose is read per transmission in the transmission block, so a finding per gap
 * would add no row, only stack near-identical lines in that block) — and agj.6
 * asks for exactly that shape: HOW MANY gaps, and the
 * WIDEST one. The pointer goes to the reading that CLOSES the widest gap, ties
 * broken by the earliest, so the drill-down lands on the most informative place
 * rather than an arbitrary one.
 *
 * ── WORDING ─────────────────────────────────────────────────────────────────
 * Observe, never conclude. Legitimate gaps are ordinary — a power outage, an
 * appliance switched off between campaigns, a logger that transmits in windows —
 * and from the receiving side every one of those looks identical to a logger
 * configured for the wrong period. So the detail states what arrived, states
 * what a receiving country cannot reconstruct from it, and leaves the cause to
 * the only party that knows.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory.js';
import { parseAbst } from './interval.js';

/**
 * The sampling period DS01 is written around, in milliseconds: 900 s, which is
 * also the schema's own `maximum` on every per-period accumulator (CMPR, CMPR2,
 * SVA, DORV, DORF). See the header.
 */
export const SAMPLE_PERIOD_MS = 900_000;

/**
 * The leeway allowed on top of {@link SAMPLE_PERIOD_MS} before a delta is read
 * as a gap: 60 s (~6.7 %). Chosen as the smallest tolerance that absorbs
 * whole-minute ABST stamping — which turns a nominal 900 s cadence into deltas
 * of 840 s or 960 s with no reading missed — and nothing else. The header
 * carries the full reasoning.
 */
export const SAMPLE_GAP_EPSILON_MS = 60_000;

/** A delta strictly wider than this is a gap. 960 s exactly stays silent. */
const GAP_THRESHOLD_MS = SAMPLE_PERIOD_MS + SAMPLE_GAP_EPSILON_MS;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One stretch between consecutive readings that is longer than the period. */
interface Gap {
  /** JSON Pointer to the ABST of the reading that CLOSES the gap. */
  pointer: string;
  /** How long the stretch is, in milliseconds — {@link parseAbst}'s resolution. */
  spanMs: number;
}

/**
 * Take one report's parseable ABST values, put them in time order, and collect
 * every consecutive pair further apart than {@link GAP_THRESHOLD_MS}. Sorting is
 * deliberate and is explained in the header: order is ./time-order.ts's subject,
 * not this one's.
 */
function scanReport(report: unknown, reportIndex: number): Gap[] {
  const records = isPlainObject(report) ? report.records : undefined;
  if (!Array.isArray(records)) return [];

  const stamped: { epochMs: number; pointer: string }[] = [];
  for (const [recordIndex, record] of records.entries()) {
    const epochMs = parseAbst(isPlainObject(record) ? record.ABST : undefined);
    // Unparseable or absent: skipped, and the readings around it become
    // consecutive. See the header.
    if (epochMs === null) continue;
    stamped.push({ epochMs, pointer: `/data/${reportIndex}/records/${recordIndex}/ABST` });
  }
  // Stable, so coincident timestamps keep the order they were sent in.
  stamped.sort((a, b) => a.epochMs - b.epochMs);

  const gaps: Gap[] = [];
  for (let i = 1; i < stamped.length; i += 1) {
    const spanMs = stamped[i]!.epochMs - stamped[i - 1]!.epochMs;
    if (spanMs > GAP_THRESHOLD_MS) gaps.push({ pointer: stamped[i]!.pointer, spanMs });
  }
  return gaps;
}

/**
 * `3600 s (60 min)` — seconds always, with the minutes reading when the span is
 * an exact number of minutes. A gap is always wider than 960 s to get here, so
 * there is no sub-second case to word; a span that is not whole minutes keeps
 * its fraction (`1005.5 s`).
 */
function describeSpan(ms: number): string {
  const seconds = ms / 1000;
  return ms % 60_000 === 0 ? `${seconds} s (${seconds / 60} min)` : `${seconds} s`;
}

/**
 * A FUNCTION DECLARATION rather than the `export const check: SemanticCheck =`
 * idiom the §7 checks use, for the ESM-cycle reason spelled out at the same place
 * in null-padding.ts, null-identity.ts, date-format.ts and time-order.ts: this
 * module imports {@link advisory} from advisory.ts while advisory.ts names this
 * check in `ADVISORY_CHECKS`, and only a hoisted declaration is initialized
 * before either module body runs.
 */
export function sampleGapCheck(ctx: PipelineContext): Finding[] {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const gaps: Gap[] = [];
  for (const [reportIndex, report] of data.entries()) {
    gaps.push(...scanReport(report, reportIndex));
  }
  if (gaps.length === 0) return [];

  // Widest, ties broken by the earliest — the scan already runs each report in
  // time order and the reports in document order, so `>` alone keeps the first.
  const widest = gaps.reduce((worst, one) => (one.spanMs > worst.spanMs ? one : worst));
  const gapNoun = gaps.length === 1 ? 'stretch' : 'stretches';

  return [
    advisory({
      id: 'adv.sample_gap',
      pointer: widest.pointer,
      detail:
        `This transmission carries ${gaps.length} ${gapNoun} between consecutive readings ` +
        `longer than the 900 s (15 min) sampling period, allowing 60 s of leeway for ` +
        `timestamps stamped to the whole minute. The widest runs ` +
        `${describeSpan(widest.spanMs)}, ending at the reading at ${widest.pointer}. Stretches ` +
        `like these have everyday causes — a power outage, an appliance switched off, a ` +
        `logger that transmits in windows — and a receiving country cannot tell those apart ` +
        `from a logger set to a longer period, so this observes what arrived rather than why. ` +
        `What it costs downstream is the accounting: DS01 sizes its per-period accumulators ` +
        `(CMPR, CMPR2, SVA, DORV, DORF) as seconds within one 15-minute period, and the ` +
        `schema bounds each of them at 900 for that reason, so a stretch wider than the ` +
        `period leaves those totals with no period the readings on either side can attribute ` +
        `them to. A reading at least every 900 s is what keeps each period accountable.`,
    }),
  ];
}

/** The frozen stage-8 signature, checked without giving up the hoisting above. */
sampleGapCheck satisfies SemanticCheck;
