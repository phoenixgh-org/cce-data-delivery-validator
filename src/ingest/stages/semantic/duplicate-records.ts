/**
 * ADVISORY — `adv.duplicate_records`: the same record delivered twice INSIDE one
 * transmission (owning issue: agj.8, epic agj — the PQS "common EMS data issues"
 * list).
 *
 * The motivating habit, quoting PQS: "There should not be duplicate data. The
 * case I saw was spread over two files in an odd way. A chunk of records were
 * placed at the end of the previous data file. Each file ended up with a data gap
 * and then time would go backwards to the first record of the subsequent file."
 *
 * ── THE GAP IT FILLS IS IN OUR OWN CODE ──────────────────────────────────────
 * ./duplicate.ts grades §1.8, and it does so at WHOLE-TRANSMISSION granularity
 * only: the sha256 of the raw body against earlier bodies in the session, and
 * `meta.transferId` against earlier ids. Both are properties of the ENVELOPE. A
 * payload that carries the same record twice inside itself has bytes no earlier
 * transmission ever sent and an id nobody has used, so it is novel on both counts
 * and earns a §1.8 PASS while the country receives one reading twice. Nothing
 * else in the pipeline looks either: the schema constrains each record against
 * `ems-record`/`rtmd-record` independently and has no vocabulary for a record's
 * relationship to its siblings, and §3.4 grades the SORTED timestamps for cadence
 * spread, where a repeat contributes an interval of zero rather than a duplicate.
 *
 * ── INTRA-PAYLOAD ONLY, DELIBERATELY ─────────────────────────────────────────
 * This module compares records against other records IN THE SAME TRANSMISSION,
 * and never against anything stored from an earlier one. That is agj.8's own
 * boundary and it is a scope decision, not an oversight: the overlap PQS actually
 * described spans two files, and answering it needs a read path the ingest
 * pipeline does not have today (DESIGN §7.1 — we hold per-transmission content
 * hashes, not per-record ones). Whether cross-transmission overlap is in scope
 * for v1 is the open question tracked as agj.14. Until that is decided, an
 * observation this check does NOT make is one nobody should read into its
 * silence: a payload whose every record repeats the PREVIOUS transmission is
 * silent here, correctly, because from inside itself it repeats nothing.
 *
 * ── AN ADVISORY, AND §1.8'S VERDICT DOES NOT MOVE ────────────────────────────
 * `severity: 'info'` under the `adv.*` namespace via {@link advisory}, so it
 * provably cannot move any §7 requirement's pass/fail status (advisory.ts's
 * header explains how that is enforced rather than merely intended). §1.8 OWNS
 * re-delivery of a transmission and its grade must read the same before and after
 * this module existed (DESIGN §7.1 — a requirement's verdict is the product's
 * contract with the supplier), so this module touches ./duplicate.ts not at all
 * and asks a different question in a different namespace.
 * ./duplicate-records.test.ts pins that both ways.
 *
 * ── TWO SIGNALS, AND THEY ARE NOT THE SAME STRENGTH ──────────────────────────
 * Within ONE report, a record is counted when it repeats an EARLIER record in
 * document order, under either of two comparisons:
 *
 *   - SAME ABST. The record carries the same `ABST` value as an earlier one. Two
 *     readings claiming one instant are a genuine ambiguity for the receiving
 *     country — it holds two values for one moment with nothing in the payload to
 *     choose between them — but it is the WEAKER signal, because a logger that
 *     stamps at whole-minute resolution and samples faster than that produces it
 *     honestly.
 *   - IDENTICAL IN FULL. The record is deep-equal to an earlier one, every
 *     property and every value. That is the stronger signal: the later copy
 *     carries nothing the earlier one did not, so no reading is lost by keeping
 *     one of them, and no sampling artefact explains it.
 *
 * Both counts ride on the ONE finding when both occur, because they say different
 * things and the pair is more informative than either alone. Deep-equal records
 * carrying a string ABST are necessarily same-ABST as well, so the counts overlap
 * by construction and the prose states them side by side rather than as a
 * partition.
 *
 * ── HOW "IDENTICAL IN FULL" IS COMPUTED ──────────────────────────────────────
 * By STABLE SERIALIZATION: the record is walked recursively, every object's keys
 * are sorted, and the result is `JSON.stringify`ed; two records are identical
 * when those strings match. Sorting the keys is the substantive choice — JSON
 * object property ORDER carries no meaning, so `{"ABST":…,"TVC":4.7}` and
 * `{"TVC":4.7,"ABST":…}` are the same record and a serialization that respected
 * arrival order would miss the repeat for a cosmetic reason. Array order IS
 * preserved, since order is meaning inside an array. Numbers compare as JSON
 * writes them, so `4.7` and `4.70` match while `4.7` and `"4.7"` do not — a
 * string where a number belongs is a §3.2 matter Ajv already grades.
 *
 * ── WHICH ABST VALUES ARE COMPARED ───────────────────────────────────────────
 * The ABST comparison is on the value AS SENT — string equality, no parsing. Two
 * records "carry the same ABST" when the supplier wrote the same characters, and
 * that is both the most literal reading of the observation and the most
 * conservative: it can only under-report, since `…T033000Z` and `…T033000.000Z`
 * are one instant but two values and are left alone here (./time-order.ts, which
 * parses, is what notices that pair). A record whose ABST is absent, null, or not
 * a string is passed over by the ABST comparison entirely — a timestamp that did
 * not arrive is not one two records can share, and a report full of null ABSTs is
 * ./null-padding.ts's observation, not a report full of duplicates. Such a record
 * is still eligible for the identical-in-full comparison, which needs no
 * timestamp to mean what it says.
 *
 * Reports are independent. Two devices legitimately stamp readings at the same
 * instant, and two reports from one device are two series; so the scan never
 * crosses a report boundary and the counts are pooled across reports for the one
 * per-transmission finding. Records that are not objects are skipped — the schema
 * owns record shape on both branches.
 *
 * ── BOTH BRANCHES ────────────────────────────────────────────────────────────
 * `ems-report` and `rtmd-report` both carry `records[]` with a required `ABST`,
 * and "a reading delivered twice" is a statement about the series rather than
 * about a device class, so the scan reads whatever `records` array it finds.
 *
 * ── THE OVERLAP WITH adv.time_not_increasing IS THE POINT ────────────────────
 * PQS's example produces BOTH signals: a chunk re-appended to the previous file
 * leaves a repeated record here AND a series that stops stepping forward there.
 * NEITHER is suppressed when both fire (agj.8, explicitly). They are different
 * observations — one says a reading arrived twice, the other says the array is
 * not in time order — and a supplier reading them together can reconstruct the
 * assembly that produced them, which neither alone supports.
 *
 * ── ONE FINDING PER TRANSMISSION ─────────────────────────────────────────────
 * Like every advisory, this emits ONE finding per transmission (the compliance
 * column carries a single signature row per advisory id — title, and a count of
 * the DISTINCT transmissions it appeared in, with no detail — while the detail
 * prose is read per transmission in the transmission block, so a finding per
 * repeat would add no row, only stack near-identical lines in that block). It
 * carries what agj.8 asks for: the COUNTS under both comparisons,
 * and a pointer to the FIRST repeat in document order along with the earlier
 * record it repeats.
 *
 * ── WORDING ──────────────────────────────────────────────────────────────────
 * Observe, never conclude. A repeated reading has everyday causes a receiving
 * country cannot tell apart — a chunk of one file re-appended to the next, a
 * record re-sent without being re-stamped, an assembly that reads its store
 * twice, a logger that genuinely reported twice — so the detail states what
 * arrived and what it costs downstream, and leaves the cause to the only party
 * that knows. We also never name one copy as the spurious one: from the receiving
 * side the two are interchangeable.
 */

import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` with every object's keys in sorted order, arrays untouched.
 * The input is always a `JSON.parse` product, so there are no cycles, no
 * `undefined` and nothing `JSON.stringify` refuses to write.
 */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = withSortedKeys(value[key]);
  return sorted;
}

/**
 * The identity a record is compared under for "identical in full": its stable
 * serialization. See the header — property order is not meaning, so it is sorted
 * away before the comparison.
 */
function recordIdentity(record: Record<string, unknown>): string {
  return JSON.stringify(withSortedKeys(record));
}

/** One record that repeats an earlier record in the same report. */
interface Repeat {
  /** JSON Pointer to the repeating record. */
  pointer: string;
  /** JSON Pointer to the earlier record it repeats. */
  twinPointer: string;
  /** It carries the same `ABST` string as that earlier record. */
  sameAbst: boolean;
  /** It is deep-equal to an earlier record — the stronger signal. */
  identical: boolean;
}

/**
 * Walk one report's records in document order and collect every one that repeats
 * an earlier record, under either comparison. The first record carrying a given
 * ABST (or a given identity) is the one later repeats are attributed to, so a
 * value sent three times yields two repeats, both pointing at the first copy.
 */
function scanReport(report: unknown, reportIndex: number): Repeat[] {
  const records = isPlainObject(report) ? report.records : undefined;
  if (!Array.isArray(records)) return [];

  const firstByAbst = new Map<string, string>();
  const firstByIdentity = new Map<string, string>();
  const repeats: Repeat[] = [];

  for (const [recordIndex, record] of records.entries()) {
    // Not an object: the schema owns record shape on both branches.
    if (!isPlainObject(record)) continue;
    const pointer = `/data/${reportIndex}/records/${recordIndex}`;

    // Absent, null or non-string ABST is passed over by this comparison only —
    // see the header. The identity comparison below still reads the record.
    const abst = typeof record.ABST === 'string' ? record.ABST : null;
    const abstTwin = abst === null ? undefined : firstByAbst.get(abst);
    const identity = recordIdentity(record);
    const identityTwin = firstByIdentity.get(identity);

    if (abstTwin !== undefined || identityTwin !== undefined) {
      repeats.push({
        pointer,
        // The identical twin when there is one: it is the more specific, more
        // informative pointer. The two are NOT interchangeable — with records
        // [T/3.2, T/9.9, T/9.9] the third record's abstTwin is record 0 while
        // its identityTwin is record 1 — so this order is load-bearing, not a
        // free choice: the prose keys off `first.identical` (see firstPhrase
        // below), so it says "is identical in full to" for exactly the twin
        // preferred here.
        twinPointer: identityTwin ?? abstTwin!,
        sameAbst: abstTwin !== undefined,
        identical: identityTwin !== undefined,
      });
    }

    if (abst !== null && !firstByAbst.has(abst)) firstByAbst.set(abst, pointer);
    if (!firstByIdentity.has(identity)) firstByIdentity.set(identity, pointer);
  }
  return repeats;
}

/**
 * The two counts, side by side rather than as a partition — a deep-equal record
 * carrying a string ABST is counted under both, and saying so as "N … and M …"
 * states each comparison's result without implying they sum.
 */
function describeCounts(sameAbst: number, identical: number): string {
  const fullClause =
    identical === 0
      ? `none is identical to an earlier record in full`
      : `${identical} ${identical === 1 ? 'is' : 'are'} identical to an earlier record in full`;
  if (sameAbst === 0) return fullClause;
  const abstClause = `${sameAbst} ${sameAbst === 1 ? 'carries' : 'carry'} the same ABST as an earlier record`;
  return `${abstClause}, and ${fullClause}`;
}

/** The `adv.duplicate_records` check, registered in `ADVISORY_CHECKS`. */
export const duplicateRecordsCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const data = (ctx.parsedBody as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  // Document order throughout: reports in array order, records in array order,
  // so the first repeat collected is the first one in the payload.
  const repeats: Repeat[] = [];
  for (const [reportIndex, report] of data.entries()) {
    repeats.push(...scanReport(report, reportIndex));
  }
  if (repeats.length === 0) return [];

  const first = repeats[0]!;
  const sameAbst = repeats.filter((r) => r.sameAbst).length;
  const identical = repeats.filter((r) => r.identical).length;
  const noun = repeats.length === 1 ? 'record' : 'records';
  const verb = repeats.length === 1 ? 'repeats' : 'repeat';
  const firstPhrase = first.identical ? `is identical in full to` : `carries the same ABST as`;

  return [
    advisory({
      id: 'adv.duplicate_records',
      pointer: first.pointer,
      detail:
        `This transmission carries ${repeats.length} ${noun} that ${verb} an earlier record in ` +
        `the same report: ${describeCounts(sameAbst, identical)}. The first is at ` +
        `${first.pointer}, which ${firstPhrase} the record at ${first.twinPointer}. Two records ` +
        `stamped at one instant leave a receiving country holding two readings for that moment ` +
        `with nothing in the payload to choose between them; two that match in full carry ` +
        `nothing the earlier copy did not already carry. Either way the reading lands twice in ` +
        `every average, total and alarm tally taken over the series. Repeats like these have ` +
        `everyday causes — a chunk of one file re-appended to the next, a record re-sent ` +
        `without being re-stamped, a logger that reported twice — and a receiving country ` +
        `cannot tell those apart, so this states what arrived rather than why. Assembling each ` +
        `report's records so that one reading appears once, in time order, is what keeps one ` +
        `reading one row downstream.`,
    }),
  ];
};
