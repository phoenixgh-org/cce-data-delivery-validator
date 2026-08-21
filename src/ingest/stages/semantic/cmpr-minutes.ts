/**
 * ADVISORY — `adv.cmpr_minutes`: an EMS transmission whose compressor runtimes
 * never cross 15, the shape a MINUTES-valued feed takes on a SECONDS-valued
 * envelope (owning issue: agj.7, epic agj — the PQS "common EMS data issues"
 * list).
 *
 * The motivating questions (agj.7, quoting PQS): "In an AC fridge, CMPR = 15
 * when SVA > 15. CMPR might be incorrectly in minutes." and "In any fridge,
 * CMPR <= 15 always. CMPR might be incorrectly in minutes."
 *
 * ── THE ROOT CAUSE IS A SPECIFICATION ERRATUM, NOT A CARELESS SUPPLIER ──────
 * CMPR's unit CHANGED. The correction landed between cce-interop 0.7.2 and
 * 0.8.0 — measured across the published schema history at
 * https://docs.2to8.cc/cce-data-interop/schemas/cce-interop-<version>.json,
 * re-fetched 2026-08-20:
 *
 *   0.1.1 .. 0.7.2                    "measured in minutes"  maximum 15   e.g. 7
 *   DS01.2 Annex 2 schema (20231128)  "measured in minutes"  maximum 15   e.g. 7
 *   0.8.0 .. 0.8.4                    "measured in seconds"  maximum 900  e.g. 120
 *   Annex 1 spreadsheet               "measured in seconds"
 *
 * Those ranges are not dense, and the host is honest about it: the versions
 * actually published there are 0.1.1, 0.2.0, 0.3.0, 0.4.0, 0.5.0, 0.6.0, 0.7.0,
 * 0.7.2, 0.8.0, 0.8.1, 0.8.2 and 0.8.4. There is no 0.7.1, and 0.8.3 returns
 * 404 — so the 0.8.x row is measured over the four 0.8.x artifacts that ARE
 * published, not all five. Every one of them was fetched; none contradicts the
 * rows above.
 *
 * CMPR2 followed the identical path. SVA never changed — "the number of seconds
 * within each 15-minute period" in every version — which is why it is the one
 * neighbouring accumulator this check reads against.
 *
 * The pre-correction schema did not merely SAY minutes in prose: it ENFORCED
 * `maximum: 15` and exemplified 7. A supplier implementing against 0.7.2, or
 * against the published PQS DS01.2 Annex 2, was held to minutes BY THEIR OWN
 * VALIDATOR. Values shaped this way are a schema-conformant implementation
 * against a superseded artifact, and both the module and the prose it emits are
 * required to say so rather than imply carelessness (agj.7 acceptance).
 *
 * ANNEX 1 IS AUTHORITATIVE ON UNITS (CLAUDE.md: where prose and schema disagree
 * the schema wins, EXCEPT on data-object bounds and units, where Annex 1
 * outranks it). So the remedy this advisory names is "re-check CMPR and CMPR2
 * against Annex 1", not "against the version you happen to be sending".
 *
 * ── WHY NOTHING ELSE CATCHES IT ─────────────────────────────────────────────
 * The correction WIDENED the range: 0–15 is a subset of 0–900. A minutes-
 * emitting feed therefore validates cleanly against both registered versions
 * (0.8.0 and 0.8.1) while understating compressor duty sixtyfold for everyone
 * downstream. No schema check can see it — precisely the DESIGN §7.1 case for an
 * advisory. Independently reached from the sender side by a supplier running
 * their own corpus through this validator (Muhammed, eHA GHM, August 2026), who
 * proposed the same instrument: an advisory, not a failure.
 *
 * No version gate is needed today: BOTH registered versions are post-correction,
 * so any payload reaching this check is on a seconds-valued envelope. Registering
 * a pre-0.8.0 version would change that and this check would need one.
 *
 * ── SCOPE: CMPR AND CMPR2 ONLY ──────────────────────────────────────────────
 * SVA, DORV and DORF are explicitly OUT OF SCOPE. The erratum was CMPR-specific;
 * those objects were seconds in every version, so a low value there is a quiet
 * period, not a units question, and reading them the same way would raise this
 * advisory on correct payloads. Do not generalize this check across the 0–900
 * accumulator family.
 *
 * ── EMS ONLY ────────────────────────────────────────────────────────────────
 * RTMDs do not measure compressor runtime, so `transferType: 'rtm'` is skipped
 * entirely (Benson, 2026-08-18). rtmd-record does declare CMPR/CMPR2 as optional
 * properties in 0.8.1, but an RTMD emitting compressor runtime is a different
 * matter, not this check's business.
 *
 * ── THE TWO SIGNALS ─────────────────────────────────────────────────────────
 * 1. THE CEILING (what raises the advisory). Across at least {@link MIN_RECORDS}
 *    records carrying a numeric value, every one is <= 15 and at least one is
 *    > 0 — the superseded `maximum: 15` showing through as a ceiling the data
 *    never crosses. The floor is reused from ./null-padding.ts for the same
 *    reason it exists there: a handful of low readings is a quiet fridge, and 12
 *    records is three hours of 15-minute periods.
 *
 *    The floor counts records carrying a NUMERIC value, not records carrying the
 *    PROPERTY. A null says nothing about where a ceiling sits, so letting eleven
 *    nulls and one reading clear a bar meant to require twelve observations
 *    would defeat the floor. This is the strict reading of agj.7's "records
 *    carrying the object" and can only under-report.
 *
 * 2. SATURATION (what sharpens it). A record whose value is EXACTLY 15 while the
 *    same record's SVA is above 15. Under the minutes definition 15 is
 *    saturation — a compressor that ran the entire 15-minute period. Under the
 *    seconds definition it is 15 seconds out of the seconds SVA reports the supply
 *    was available. The repeated appearance of exactly 15 is the tell.
 *
 *    Signal 2 is MAINS-ONLY BY CONSTRUCTION, not by choice: `ems-record.allOf[0]`
 *    forbids SVA on the solar branch (solar records carry DCSV + DCCD instead),
 *    so a solar-supplied appliance cannot produce the pairing at all and falls
 *    back to signal 1 alone. DCSV is no substitute — it is "Average DC supply
 *    voltage", a VOLTAGE bounded 0..999.9, and no DC-availability-in-seconds
 *    object exists through 0.8.4. Signal 2 therefore never gates the advisory;
 *    it is counted and named when present, and its absence is said out loud.
 *
 * ── NOT A BACKSTOP FOR adv.compressor_exceeds_supply, AND VICE VERSA ────────
 * ./compressor-supply.ts (agj.3) grades CMPR > SVA and is STRUCTURALLY BLIND to
 * this population: minutes-valued CMPR is always <= 15 while seconds-valued SVA
 * runs to 900, so a minutes-emitting feed essentially never trips it. The two
 * are complementary; neither covers the other's population.
 *
 * ── EVALUATED PER OBJECT, ONE FINDING PER TRANSMISSION ──────────────────────
 * CMPR and CMPR2 are graded INDEPENDENTLY — a supplier may have migrated one and
 * not the other, and a secondary compressor that genuinely idles is a different
 * story from a primary one that never crosses 15 — and the finding names which
 * of them the observation is about. Like every advisory it emits ONE finding per
 * transmission (the compliance column carries a single signature row per advisory
 * id — title, and a count of the DISTINCT transmissions it appeared in, with no
 * detail — while the detail prose is read per transmission in the transmission
 * block).
 *
 * Values are pooled ACROSS the whole transmission, which is what agj.7 asks for
 * ("every non-null CMPR <= 15 across the transmission"). A transmission mixing a
 * migrated appliance with an un-migrated one therefore stays silent — the
 * migrated readings lift the ceiling — which under-reports rather than over-.
 *
 * ── WORDING ─────────────────────────────────────────────────────────────────
 * Observe, never conclude, and never imply carelessness. We state the shape of
 * what arrived, the documented unit change that produces exactly that shape, and
 * the remedy — and we say what the readings would mean downstream IF they are
 * minutes, conditionally, because a fridge that genuinely barely runs looks
 * identical from here.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';
import { COMPRESSOR_KEYS, SUPPLY_KEY } from './compressor-supply.js';
import { MIN_RECORDS } from './null-padding.js';

/**
 * The superseded `maximum` on CMPR/CMPR2, in minutes — the ceiling a feed built
 * against 0.7.2 or the DS01.2 Annex 2 schema was held to by its own validator.
 */
export const MINUTES_CEILING = 15;

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
 * `^ems$` selects the ems branch, and everything else (including `rtm`) falls to
 * the rtmd branch, which this check has nothing to say about.
 */
function isEmsBranch(ctx: PipelineContext): boolean {
  return ctx.meta.transferType === 'ems';
}

/** What one compressor object looked like across the whole transmission. */
interface KeyTally {
  /** The object — CMPR or CMPR2. */
  key: string;
  /** How many records carried a NUMERIC value for it (the floor counts these). */
  values: number;
  /** The highest value seen, or null when nothing numeric arrived. */
  highest: number | null;
  /** Whether any value was above 0 — an all-zero series says nothing. */
  anyAboveZero: boolean;
  /** Whether every numeric value sat at or below {@link MINUTES_CEILING}. */
  everyAtOrBelowCeiling: boolean;
  /** Pointer to the first numeric value, for the drill-down. */
  firstPointer: string | null;
  /** Records pairing a value of exactly 15 with an SVA above 15 (signal 2). */
  saturated: number;
  /** Pointer to the first of those, which is the sharpest place to look. */
  firstSaturatedPointer: string | null;
}

function emptyTally(key: string): KeyTally {
  return {
    key,
    values: 0,
    highest: null,
    anyAboveZero: false,
    everyAtOrBelowCeiling: true,
    firstPointer: null,
    saturated: 0,
    firstSaturatedPointer: null,
  };
}

/** Whether a tally shows signal 1 — the ceiling the data never crosses. */
function trips(tally: KeyTally): boolean {
  return tally.values >= MIN_RECORDS && tally.everyAtOrBelowCeiling && tally.anyAboveZero;
}

/** `CMPR carries 24 values across this transmission, the highest 15`. */
function describeCeiling(tally: KeyTally): string {
  const noun = tally.values === 1 ? 'value' : 'values';
  return (
    `${tally.key} arrived as ${tally.values} numeric ${noun}, none above ` +
    `${MINUTES_CEILING} and the highest ${tally.highest}`
  );
}

/** The `adv.cmpr_minutes` check, registered in `ADVISORY_CHECKS`. */
export const cmprMinutesCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  // RTMD is out of scope entirely — see the header.
  if (!isEmsBranch(ctx)) return [];

  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const tallies = new Map<string, KeyTally>(
    COMPRESSOR_KEYS.map((key) => [key, emptyTally(key)] as const),
  );

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      // SVA is absent on the solar branch by construction, so `supply` is simply
      // not a number there and signal 2 never accrues — see the header.
      const supply = record[SUPPLY_KEY];

      for (const key of COMPRESSOR_KEYS) {
        const value = record[key];
        // Nulls and non-numbers are skipped: neither says where a ceiling sits.
        if (typeof value !== 'number') continue;

        const tally = tallies.get(key)!;
        const pointer = `/data/${reportIndex}/records/${recordIndex}/${key}`;
        tally.values += 1;
        tally.highest = tally.highest === null ? value : Math.max(tally.highest, value);
        if (value > 0) tally.anyAboveZero = true;
        if (value > MINUTES_CEILING) tally.everyAtOrBelowCeiling = false;
        tally.firstPointer ??= pointer;

        if (value === MINUTES_CEILING && typeof supply === 'number' && supply > MINUTES_CEILING) {
          tally.saturated += 1;
          tally.firstSaturatedPointer ??= pointer;
        }
      }
    }
  }

  const tripped = [...tallies.values()].filter(trips);
  if (tripped.length === 0) return [];

  const named = joinPhrases(tripped.map((t) => t.key));
  const ceilings = joinPhrases(tripped.map(describeCeiling));
  const saturated = tripped.reduce((sum, t) => sum + t.saturated, 0);
  const saturationPointer = tripped.find(
    (t) => t.firstSaturatedPointer !== null,
  )?.firstSaturatedPointer;

  // Signal 2 never GATES the advisory — it cannot arise on a solar record at all
  // — so its absence is stated rather than left as a silence.
  const saturationSentence =
    saturated > 0
      ? `${saturated} of ${saturated === 1 ? 'those readings sits' : 'those readings sit'} at ` +
        `exactly ${MINUTES_CEILING} in a record whose ${SUPPLY_KEY} is above ` +
        `${MINUTES_CEILING} (the first at ${saturationPointer}) — the saturation signature. ` +
        `Read as minutes, ${MINUTES_CEILING} is a compressor that ran for the whole 15-minute ` +
        `period; read as seconds it is ${MINUTES_CEILING} seconds out of the seconds ` +
        `${SUPPLY_KEY} reports the supply was available.`
      : `No reading here pairs a value of exactly ${MINUTES_CEILING} with an ${SUPPLY_KEY} ` +
        `above ${MINUTES_CEILING}, so the saturation signature is absent and this rests on ` +
        `the ceiling alone. ${SUPPLY_KEY} sits only on mains records — the schema keeps it off ` +
        `the solar branch — so a solar-supplied appliance carries nothing that signature could ` +
        `be read from.`;

  return [
    advisory({
      id: 'adv.cmpr_minutes',
      pointer: saturationPointer ?? tripped[0]!.firstPointer,
      detail:
        `Across this transmission, ${ceilings}. ${saturationSentence} The unit of ` +
        `${named} CHANGED between cce-interop 0.7.2 and 0.8.0: up to 0.7.2 — and in the ` +
        `DS01.2 Annex 2 schema — it was minutes, and the schema itself capped it at ` +
        `${MINUTES_CEILING} and gave 7 as its example; from 0.8.0 it is seconds, capped at ` +
        `900, with 120 as its example. An implementation built against the earlier definition ` +
        `was held to ${MINUTES_CEILING} by its own validator, and it keeps validating cleanly ` +
        `on a 0.8.x envelope because 0–${MINUTES_CEILING} sits inside 0–900 — so the change is ` +
        `visible to neither side's schema validation. If these readings are counts of minutes, ` +
        `a receiving country stores them as seconds and records a sixtieth of the compressor ` +
        `duty that happened. Annex 1 of E006/DS01 is authoritative on units: re-checking ` +
        `${named} against it is what tells you whether this feed is on the current definition.`,
    }),
  ];
};
