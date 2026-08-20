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
 * agj.3 asks for: HOW MANY readings exceed their record's supply, the WORST
 * excess in seconds, and a pointer to the FIRST one in document order.
 *
 * ── WORDING ─────────────────────────────────────────────────────────────────
 * Observe, never conclude. From the receiving side a record with `CMPR: 420,
 * SVA: 200` is equally consistent with a mis-scaled CMPR, a mis-scaled SVA, an
 * accumulator that was not reset, and a genuine metering fault. We state the two
 * numbers as sent, what each object counts, and what a receiving country does
 * with them — and name no cause.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory.js';

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
  /** The compressor runtime, in seconds, as sent. */
  runtime: number;
  /** The same record's SVA, in seconds, as sent. */
  supply: number;
  /** How far the runtime runs past the supply, in seconds. */
  excess: number;
}

/**
 * A FUNCTION DECLARATION rather than the `export const check: SemanticCheck =`
 * idiom the §7 checks use, for the ESM-cycle reason spelled out at the same place
 * in null-padding.ts, null-identity.ts, date-format.ts and time-order.ts: this
 * module imports {@link advisory} from advisory.ts while advisory.ts names this
 * check in `ADVISORY_CHECKS`, and only a hoisted declaration is initialized
 * before either module body runs.
 */
export function compressorSupplyCheck(ctx: PipelineContext): Finding[] {
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
          runtime,
          supply,
          excess: runtime - supply,
        });
      }
    }
  }

  if (found.length === 0) return [];

  const first = found[0]!;
  const worst = found.reduce((max, one) => Math.max(max, one.excess), 0);
  const readingNoun = found.length === 1 ? 'reading' : 'readings';
  const named = joinPhrases([...new Set(found.map((one) => one.key))]);
  // With one reading, the first IS the worst — naming it twice reads as two
  // separate observations.
  const worstSentence =
    found.length === 1 ? '' : `The largest excess across the transmission is ${worst} s. `;

  return [
    advisory({
      id: 'adv.compressor_exceeds_supply',
      pointer: first.pointer,
      detail:
        `This transmission carries ${found.length} ${readingNoun} where ${named} is larger than ` +
        `${SUPPLY_KEY} in the same record. The first is at ${first.pointer}, where ${first.key} ` +
        `is ${first.runtime} s and ${SUPPLY_KEY} is ${first.supply} s — ${first.excess} s of ` +
        `compressor runtime beyond the supply that record accounts for. ${worstSentence}` +
        `On a mains appliance the two are accumulators over the same 15-minute period: ` +
        `${SUPPLY_KEY} counts the seconds the AC supply sat within the bounds the appliance ` +
        `operates in, and ${named} counts the seconds the compressor ran, so a receiving ` +
        `country reads compressor runtime as a duration inside the window ${SUPPLY_KEY} ` +
        `describes. Records that carry DCSV and DCCD instead of ${SUPPLY_KEY} are ` +
        `solar-supplied and are not read here: DS01 defines no DC supply availability in ` +
        `seconds, so such a record carries nothing to read a compressor runtime against.`,
    }),
  ];
}

/** The frozen stage-8 signature, checked without giving up the hoisting above. */
compressorSupplyCheck satisfies SemanticCheck;
