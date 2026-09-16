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
 * pipeline does not have today (DESIGN §8 — `transmission.content_hash` is a
 * per-transmission hash; we hold no per-record ones). Whether cross-transmission
 * overlap is in scope for v1 is the open question tracked as agj.14. Until that
 * is decided, an observation this check does NOT make is one nobody should read
 * into its silence: a payload whose every record repeats the PREVIOUS
 * transmission is silent here, correctly, because from inside itself it repeats
 * nothing.
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
 * carries what agj.8 asks for: the COUNTS under both comparisons, and a pointer
 * to the FIRST repeat in document order.
 *
 * ── WORDING: AN OBSERVATION AND A RATIONALE (agj.17) ─────────────────────────
 * Two pieces of prose, not one. `summary` is the OBSERVATION — how many records
 * repeat an earlier record in the same report, and the two comparisons' counts
 * side by side. `detail` is the RATIONALE, static and carrying no numbers: what
 * a shared timestamp costs the receiving country, and why requirements clause
 * 1.8's allowance for a repeated TRANSMISSION does not explain a repeat inside
 * one.
 *
 * The two counts are stated as bare numbers, `3 by ABST, 1 identical in full`,
 * and they do NOT sum: a deep-equal record carrying a string ABST is counted
 * under both comparisons by construction. Either count may be zero, and zero is
 * written as a number rather than as "none", so the line keeps one shape.
 *
 * Observe, never conclude. A repeated reading has everyday causes a receiving
 * country cannot tell apart — a chunk of one file re-appended to the next, a
 * record re-sent without being re-stamped, an assembly that reads its store
 * twice, a logger that genuinely reported twice — so the observation states what
 * arrived and leaves the cause to the only party that knows. We also never name
 * one copy as the spurious one: from the receiving side the two are
 * interchangeable.
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
  /** It carries the same `ABST` string as an earlier record. */
  sameAbst: boolean;
  /** It is deep-equal to an earlier record — the stronger signal. */
  identical: boolean;
}

/**
 * Walk one report's records in document order and collect every one that repeats
 * an earlier record, under either comparison. The first record carrying a given
 * ABST (or a given identity) is the one later repeats are measured against, so a
 * value sent three times yields two repeats.
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
      // The two comparisons are counted SEPARATELY, and a record can be both:
      // with records [T/3.2, T/9.9, T/9.9] the third matches record 0 by ABST
      // and record 1 in full, and the observation states each count in its own
      // right rather than partitioning the repeats between them.
      repeats.push({
        pointer,
        sameAbst: abstTwin !== undefined,
        identical: identityTwin !== undefined,
      });
    }

    if (abst !== null && !firstByAbst.has(abst)) firstByAbst.set(abst, pointer);
    if (!firstByIdentity.has(identity)) firstByIdentity.set(identity, pointer);
  }
  return repeats;
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

  return [
    advisory({
      id: 'adv.duplicate_records',
      pointer: first.pointer,
      summary:
        `${repeats.length} ${noun} ${verb} an earlier record in the same report — ` +
        `${sameAbst} by ABST, ${identical} identical in full.`,
      detail:
        'Two records that share the same timestamp force the country to perform the ' +
        'de-duplication or to risk duplicate records landing twice in every average, total ' +
        'and alarm tally. Countries should anticipate occasional duplicate transmissions, ' +
        'which requirements clause 1.8 allows after a delivery failure or on request, but ' +
        'duplicate records within a single transmission cannot be explained by ' +
        "retransmission and are worth checking in the supplier's assembly step.",
    }),
  ];
};
