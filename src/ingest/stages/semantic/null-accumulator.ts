/**
 * ADVISORY — `adv.null_accumulator`: a mains EMS record whose compressor runtime
 * arrived as `null` in a period the same record says had no AC supply at all
 * (owning issue: agj.9, epic agj — the PQS "common EMS data issues" list).
 *
 * The motivating case is PQS's own: "CMPR field null rather than 0 during a
 * power interruption. The above might apply to other fields, too, like SVA."
 * The per-period objects are TOTALS over a 15-minute window, so "nothing
 * happened" has a value — 0 — and a null throws it away. A country receiving
 * the record cannot then separate a quiet period from a reading the device
 * could not obtain.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace
 * via {@link advisory}, so it provably cannot move any §7 requirement's
 * pass/fail status (advisory.ts's header explains how that is enforced).
 *
 * ── THE CORRELATED FORM ONLY, AND WHY ───────────────────────────────────────
 * A bare intermittent null says little: the receiving side cannot tell a total
 * of zero from a reading that was not taken, which is the whole complaint. What
 * makes the PQS case sharp is the SIBLING: `SVA === 0` says the AC supply sat
 * within the appliance's operating bounds for none of the period, so the
 * compressor could not have run and the period's true runtime is a KNOWN 0.
 * That is the form this check reads, and only that form.
 *
 * The condition, per record:
 *
 *   1. `meta.transferType === 'ems'` (the branch), and the record is a MAINS
 *      record — see below.
 *   2. `SVA === 0` — the period was observed and carried no supply.
 *   3. The accumulator ({@link ACCUMULATOR_KEYS}: CMPR, and CMPR2 where the key
 *      is present) is PRESENT and `null`.
 *   4. The record carries NO explanation for the null: LERR and EERR are both
 *      absent, null, or empty/whitespace-only — the same rule, and the same
 *      {@link explains} helper shape, as ./unexplained-null-temp.ts. A null
 *      beside a populated code is an explained null (a logger or device fault
 *      the supplier is already reporting), not a zero sent as null, and is
 *      therefore not this advisory's case.
 *   5. The SAME accumulator arrives as a NUMBER in at least one other record of
 *      the same report — the exclusivity rule below.
 *
 * ── DEFERRED FORMS ──────────────────────────────────────────────────────────
 * Deliberately NOT read here (agj.9 defers them; extending this module to them
 * is a fresh decision, not a tidy-up):
 *
 *   - The door accumulators DORV, DORF, DRCV and DRCF. Nothing on the record
 *     establishes that a door total of zero is the fact, so a null there is the
 *     weak bare-intermittent case rather than the correlated one.
 *   - `SVA > 0` with a null compressor runtime. Supply was available for some
 *     of the period, so the true runtime is unknown from here — it may well be
 *     a reading the device could not take.
 *   - A null SVA itself. On a mains record that says the supply reading is
 *     missing, not that supply was zero; reading it as zero is exactly the
 *     conflation ./compressor-supply.ts refuses to make.
 *
 * ── EMS MAINS RECORDS ONLY ──────────────────────────────────────────────────
 * RTMDs do not measure compressor runtime, so `transferType: 'rtm'` is skipped
 * entirely rather than graded and found silent — the same boundary
 * ./compressor-supply.ts draws, for the same reason: `rtmd-record` declares
 * CMPR/CMPR2/SVA as optional properties but carries no mains/solar partition,
 * so the discriminator below would have nothing to read there.
 *
 * `ems-record.allOf[0]` is an EXCLUSIVE `oneOf`, present in both registered
 * versions (0.8.0 and 0.8.1):
 *
 *     mains: required [SVA],        not required [DCSV, DCCD]
 *     solar: required [DCSV, DCCD], not required [SVA]
 *
 * So the PRESENCE of `SVA` is the schema-sanctioned mains/solar discriminator,
 * and {@link isMainsRecord} reads that presence rather than testing SVA for
 * null. A solar record is not merely skipped for convenience: DCSV is "Average
 * DC supply voltage", a VOLTAGE bounded 0..999.9, and no DC-availability-in-
 * seconds object exists anywhere in PQS-DS01-objects through 0.8.4 — so nothing
 * on the solar branch can say the compressor could not have run, and NOTHING
 * MAY SUBSTITUTE FOR SVA. Do not later "extend" this check to that branch.
 *
 * The helper is a LOCAL copy of compressor-supply.ts's, not an import: the
 * advisory modules stay independent of one another (each is a leaf beside
 * ./advisory-finding.ts), so the same rule is restated here with its reasoning
 * rather than coupled across two checks that happen to agree today.
 *
 * ── EXCLUSIVE WITH `adv.null_padding`, BY CONSTRUCTION ──────────────────────
 * `adv.null_padding` (./null-padding.ts) fires for a property that is null in
 * EVERY record that carried it, over at least twelve records — a column padded
 * out for a sensor that is not fitted. This advisory fires only where the same
 * accumulator arrives as a NUMBER in at least one other record of the same
 * report, i.e. where the null is INTERMITTENT. The two conditions cannot both
 * hold for one property, so the two advisories never name the same property on
 * the same transmission, and a supplier is never told both that a column is
 * empty and that one of its values went missing. ./null-accumulator.test.ts
 * pins the boundary from both sides.
 *
 * ── ONE FINDING PER TRANSMISSION ────────────────────────────────────────────
 * Like every advisory in this category: the compliance column carries a single
 * signature row per advisory id, so a finding per record would add no row and
 * only stack lines in the transmission block. The pointer addresses the FIRST
 * offending record, `/data/<r>/records/<i>`, for the raw-payload drill-down, and
 * the detail counts RECORDS across the reports that hold them and names the
 * accumulators involved — "2 of 96 records" is what tells a supplier a single
 * outage from a habit.
 *
 * ── THE DS01.3 SHADOW RESTATES THIS ONE, AND NEEDS NO GATE ──────────────────
 * Measured 2026-09-15 against src/schemas/pqs-e006-ds01-annex4-1.json: the
 * draft's `ems-record` carries SEVEN allOf/oneOf rules where 0.8.x carries two,
 * and five of them tie a null reading to a non-null error code: four require
 * LERR to explain a null CMPR, DORV, TAMB or BLOG, and the fifth requires EERR
 * to explain a null BEMD. (The draft's two remaining rules — the mains/solar
 * partition and TVC null requiring LERR — are the two 0.8.x already carries.)
 * So under the draft an UNEXPLAINED null CMPR is already a clause 5.3.2 failure,
 * and the shadow run restates this advisory's case the way it restates
 * ./null-identity.ts's. The check is NOT gated to the contract profile,
 * for the reason null-identity.ts gives: stage order already settles which
 * surface speaks. A payload declaring the Annex 4 lineage is rejected 422 at
 * stage 7 before stage 8 runs; a payload declaring the 0.8.x lineage — where a
 * null CMPR needs no explanation — is accepted, and the advisory is the only
 * surface that speaks to it there.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many of the
 * transmission's records carry a compressor accumulator as null in a period
 * whose SVA is 0, with neither error code beside it. `detail` is the RATIONALE:
 * what the period's total should have been, what a null costs the receiving
 * country, and the mechanism the numeric records elsewhere in the report point
 * at.
 *
 * THE RATIONALE IS STATIC (synm, approved 2026-09-18). Its third sentence used
 * to name the accumulators the scan actually found, substituted from
 * {@link ACCUMULATOR_KEYS} with the verb agreeing with the list. The compliance
 * column now carries a single expandable row per advisory id, which has one
 * rationale to show and no payload in front of it, so that sentence is stated in
 * general terms instead; the summary already names the accumulators this
 * transmission raised the advisory on. See {@link NULL_ACCUMULATOR_RATIONALE}.
 *
 * Observe, never conclude. We say what arrived and what the receiving country
 * therefore cannot tell apart. We do not say the device broke and we do not say
 * the supplier dropped anything. The remedy follows 52r's settled framing — a
 * period in which nothing happened is a total of 0 — and the compressor
 * controller going offline during an outage is named as what the numeric records
 * SUGGEST, not as a cause established from the payload.
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
export const NULL_ACCUMULATOR_ID = 'adv.null_accumulator' as const;

/** The per-period compressor-runtime accumulators this advisory reads. */
export const ACCUMULATOR_KEYS: readonly string[] = ['CMPR', 'CMPR2'];

/** The AC supply-availability accumulator that establishes the period's total. */
const SUPPLY_KEY = 'SVA';

/** The codes that can explain a null, in the order the prose names them. */
const ERROR_CODES = ['LERR', 'EERR'] as const;

/**
 * THE RATIONALE, static per advisory id and approved verbatim (synm, Benson,
 * 2026-09-18). This module is its single owner: ./advisory.ts collects it into
 * `ADVISORY_RATIONALES`, the API serves it on the advisory signature, and the
 * browser holds no copy of its own.
 *
 * It names no accumulator and carries no counts — the summary does both.
 */
export const NULL_ACCUMULATOR_RATIONALE =
  'With no supplied electricity the compressor could not have run, so the ' +
  "period's total should be an explicit 0 that the receiving country can add up. A null " +
  'value here leaves the country unable to distinguish a period in which the compressor did ' +
  'not run from a period in which the compressor runtime could not be measured. Where the ' +
  'same objects arrive as numbers in the other records of a report, the null appears when ' +
  'the compressor controller goes offline during a power outage, and a logger that already ' +
  'knows no power was supplied can report a runtime of 0 rather than null.';

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
 * cce-interop verbatim: `meta.transferType` matching `^ems$` selects
 * `ems-report`/`ems-record`, and everything else (including `rtm`) falls to the
 * rtmd branch, which this check has nothing to say about.
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
function isMainsRecord(record: Record<string, unknown>): boolean {
  return SUPPLY_KEY in record;
}

/**
 * Whether `key` on `record` carries an explanation. Absent, `null`, and an empty
 * or whitespace-only string explain nothing; ANY other value (including a
 * non-string code) is read as an explanation — we grade what we can prove.
 */
function explains(record: Record<string, unknown>, key: string): boolean {
  if (!(key in record)) return false;
  const value = record[key];
  if (value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** The accumulators this report sends as a number at least once. */
function numericAccumulatorsIn(records: readonly unknown[]): Set<string> {
  const numeric = new Set<string>();
  for (const record of records) {
    if (!isPlainObject(record)) continue;
    for (const key of ACCUMULATOR_KEYS) {
      if (typeof record[key] === 'number') numeric.add(key);
    }
  }
  return numeric;
}

/**
 * The accumulators this record sends as an unexplained null in a period with no
 * AC supply — empty unless every condition in the header holds.
 */
function offendingKeysIn(
  record: Record<string, unknown>,
  numericElsewhere: ReadonlySet<string>,
): string[] {
  if (!isMainsRecord(record)) return [];
  if (record[SUPPLY_KEY] !== 0) return [];
  if (ERROR_CODES.some((key) => explains(record, key))) return [];
  return ACCUMULATOR_KEYS.filter((key) => record[key] === null && numericElsewhere.has(key));
}

/** The `adv.null_accumulator` check, registered in `ADVISORY_CHECKS`. */
export const nullAccumulatorCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  // RTMD is out of scope entirely — see the header.
  if (!isEmsBranch(ctx)) return [];

  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  let totalRecords = 0;
  let affected = 0;
  let pointer: string | null = null;
  const named = new Set<string>();

  for (const [reportIndex, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    const records = report.records;
    if (!Array.isArray(records)) continue;

    // Per REPORT, not per transmission: one report is one appliance, and an
    // accumulator numeric on a different appliance says nothing about this one.
    const numericElsewhere = numericAccumulatorsIn(records);

    for (const [recordIndex, record] of records.entries()) {
      if (!isPlainObject(record)) continue;
      totalRecords += 1;

      const keys = offendingKeysIn(record, numericElsewhere);
      if (keys.length === 0) continue;

      affected += 1;
      for (const key of keys) named.add(key);
      pointer ??= `/data/${reportIndex}/records/${recordIndex}`;
    }
  }

  if (affected === 0) return [];

  const recordNoun = totalRecords === 1 ? 'record' : 'records';
  const verb = affected === 1 ? 'carries' : 'carry';
  const list = joinPhrases([...named].sort());

  return [
    advisory({
      id: NULL_ACCUMULATOR_ID,
      pointer,
      summary:
        `${affected} of ${totalRecords} ${recordNoun} ${verb} ${list} as null in a period ` +
        `whose ${SUPPLY_KEY} is 0, with ${ERROR_CODES.join(' and ')} blank.`,
      detail: NULL_ACCUMULATOR_RATIONALE,
    }),
  ];
};
