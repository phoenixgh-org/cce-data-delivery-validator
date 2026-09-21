/**
 * ADVISORY — `adv.identifier_disagreement`: two reports of ONE transmission that
 * carry the same appliance-side identifier beside different companion identifiers
 * (owning issue: 7yuv, decided 2026-09-21).
 *
 * The sibling observation is `./identifier-collision.ts`, which compares this
 * delivery against the identities EARLIER accepted deliveries in the session left
 * behind. It cannot see this shape at all: `computeUnitIdentities`
 * (src/identity/unit-key.ts) keeps the FIRST report per unit key and drops any
 * later one, so a single POST carrying one appliance serial under two different
 * platform handles never reaches that lookup. This check therefore reads the RAW
 * REPORTS itself (decided 2026-09-21) — the extractor keeps its first-wins
 * contract and its return shape, and nothing here touches the write path.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace via
 * {@link advisory}, so it provably cannot move any §7 requirement's pass or fail
 * status (advisory.ts's header explains how that is enforced).
 *
 * ── WHY IT IS ITS OWN ID AND NOT AN ARM OF `adv.identifier_collision` ────────
 * Each advisory carries ONE static rationale, served on a compliance row with no
 * payload in front of it, and the two cases owe different prose. Across two
 * deliveries, an identifier the supplier corrected between them and two appliances
 * sharing one identifier look the same, so that rationale names neither. Here both
 * reports arrived in one transmission, so nothing separates them in time and the
 * correction reading is not open. One rationale covering both would have to go
 * vague to do it, which is why the owner settled on a second id (7yuv).
 *
 * ── WHAT DISAGREES ──────────────────────────────────────────────────────────
 * The same rule the sibling applies, read within one body: two reports share one
 * appliance-side identifier VALUE and disagree on another that BOTH carry. The
 * appliance-side identifiers are exactly three — `ASER` (the manufacturer's
 * serial), `AMID` (the supplier platform's handle, an `rtmd-report` property only)
 * and `AID` (the employer's asset id, optional on both branches) — so the pairs
 * compared are (ASER, AMID), (ASER, AID) and (AMID, AID), each in both directions
 * ({@link COMPARISONS}).
 *
 *   - A value ABSENT, null or blank on either report is not compared:
 *     {@link identifier} (src/identity/unit-key.ts) yields `null` for it, and one
 *     report carrying no asset id says nothing about the other's.
 *   - Values are TRIMMED, never case-folded — the rule is `identifier`'s own, and
 *     it is reused rather than restated so the two checks cannot drift.
 *   - `LSER`, `ESER`, `LID` and `EID` are NOT compared, for the reason
 *     `unitKey`'s docblock gives: they name the logger and the monitoring device,
 *     and one appliance re-instrumented or one logger moved is ordinary
 *     operation. Remarking on it would grade maintenance.
 *
 * ── WHAT IT READS ───────────────────────────────────────────────────────────
 * `ctx.parsedBody.data[]` and nothing else. PURE, with no lookup and no storage:
 * a disagreement inside one body needs no cross-transmission state, which is the
 * whole reason this check can be a plain function of the payload while its
 * sibling needs a table.
 *
 * ── ONE ADVISORY PER PAIR OF REPORTS ────────────────────────────────────────
 * PINNED, and the test pins it. A body is walked in {@link COMPARISONS} order;
 * for each shared value the reports carrying it are collected in payload order,
 * the FIRST of them carrying a companion anchors the observation, and the first
 * later report disagreeing on that companion is the one named. A pair of reports
 * already named is not named again, which is what keeps one disagreement to one
 * finding: reports that differ on `AMID` while sharing both `ASER` and `AID`
 * disagree under two comparisons and are reported once, under the serial.
 *
 * Two consequences worth stating plainly. A body holding two separate
 * disagreements — two appliance serials, each under two handles — raises two
 * findings, one per pair. And a third report disagreeing with the first two is
 * NOT named: the advisory reports that the delivery disagrees with itself and
 * where to look, and a census of every report would lengthen the line without
 * changing what the supplier has to go and check.
 *
 * ── THE VALUES ARE IN THE OBSERVATION, THE REASON IS STATIC ─────────────────
 * The identifiers are in `summary` (synm), which is the half of the copy that
 * carries this transmission's own values. `detail` is one static text per advisory
 * id, because the compliance column shows a single expandable row with no payload
 * in front of it; see {@link IDENTIFIER_DISAGREEMENT_RATIONALE}.
 *
 * THE SUMMARY KEEPS TO THE ROUGHLY-90-CHARACTER GUIDANCE on `AdvisoryInput`
 * (./advisory-finding.ts). Unlike its sibling it cites NO prior delivery — both
 * reports are in the body the supplier is already looking at — so it names three
 * values rather than four, needs no receipt time, and is deliberately absent from
 * `ADVISORY_IDS_CITING_A_PRIOR` (./advisory.ts).
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * The copy OBSERVES and never concludes. It says which identifier repeated, which
 * companions travelled with it, and what the receiving side cannot do — it does
 * NOT say that two appliances exist, that either value is the right one, or that
 * anything went wrong. "Disagreement" is the id's word and stays out of the prose,
 * which quotes the values instead.
 */

import { identifier } from '../../../identity/unit-key.js';
import type { Finding, PipelineContext } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/** The advisory id, exported for `ADVISORY_IDS` (see ./advisory.ts). */
export const IDENTIFIER_DISAGREEMENT_ID = 'adv.identifier_disagreement' as const;

/**
 * THE RATIONALE, static per advisory id. This module is its single owner:
 * ./advisory.ts collects it into `ADVISORY_RATIONALES`, the API serves it on the
 * advisory signature, and the browser holds no copy of its own.
 *
 * It names no identifier and no report index — those are in the summary, which is
 * the half of the copy that speaks about one delivery — and it names no cause. It
 * does say what the single-body case rules out, because that is exactly what
 * distinguishes it from `adv.identifier_collision`'s rationale.
 */
export const IDENTIFIER_DISAGREEMENT_RATIONALE =
  'Two reports of one delivery that name the same appliance identifier beside different ' +
  'companion identifiers leave the receiving country with no way to record which names ' +
  'belong together. Across two separate deliveries, one reading is that the supplier ' +
  'corrected an identifier between them. That reading is not open here, because both ' +
  'reports arrived in the same transmission and nothing separates them in time. Only the ' +
  'supplier can say whether the two reports describe one appliance under two names or two ' +
  'appliances that share a name, and until it does the country cannot place the records ' +
  'against a single unit in its inventory.';

/** The appliance-side identifier fields, the only three this check compares. */
type IdentifierField = 'aser' | 'amid' | 'aid';

/** The wire property each field is read from. */
const WIRE_KEY: Readonly<Record<IdentifierField, string>> = {
  aser: 'ASER',
  amid: 'AMID',
  aid: 'AID',
};

/**
 * How each field reads in the copy, spelled out exactly as
 * ./identifier-collision.ts spells it: the prose name with the wire key beside it,
 * so a supplier can go straight to the property.
 */
const FIELD_NOUN: Readonly<Record<IdentifierField, string>> = {
  aser: 'appliance serial ASER',
  amid: 'appliance id AMID',
  aid: 'asset id AID',
};

/**
 * The directed comparisons, in the order a disagreement is reported — the
 * sibling's list, unchanged, because the pairs are a property of the identifiers
 * rather than of where the second report came from.
 *
 * ORDER IS THE REPORTING PRIORITY: the appliance's own serial is the name a
 * country recognises, so a disagreement involving it is named ahead of one
 * between the supplier's handle and the employer's asset id.
 */
const COMPARISONS: readonly (readonly [shared: IdentifierField, companion: IdentifierField])[] = [
  ['aser', 'amid'],
  ['aser', 'aid'],
  ['amid', 'aser'],
  ['amid', 'aid'],
  ['aid', 'aser'],
  ['aid', 'amid'],
];

/** Whether a value is a plain (non-array) object we can read keys off. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The three appliance-side identifiers one report carried, and where it sits. */
interface ReportIdentifiers {
  /** Index in `data[]`, which is what the pointer drill-down needs. */
  index: number;
  aser: string | null;
  amid: string | null;
  aid: string | null;
}

/**
 * Every report of a parsed body with its appliance-side identifiers, in payload
 * order. Deliberately NOT `computeUnitIdentities`: that one is keyed by appliance
 * and keeps the first report per key, which drops exactly the second report this
 * check exists to see. The identifier rule itself is reused from {@link
 * identifier}, so the trim-never-case-fold decision lives in one place.
 *
 * A body that is not an object with an array `data` contributes nothing, and an
 * entry that is not an object is not a report.
 */
function reportIdentifiers(body: unknown): ReportIdentifiers[] {
  if (!isPlainObject(body)) return [];
  const data = body['data'];
  if (!Array.isArray(data)) return [];

  const reports: ReportIdentifiers[] = [];
  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    reports.push({
      index,
      aser: identifier(report[WIRE_KEY.aser]),
      amid: identifier(report[WIRE_KEY.amid]),
      aid: identifier(report[WIRE_KEY.aid]),
    });
  }
  return reports;
}

/** Two reports sharing a value and disagreeing on a companion they both carry. */
interface Disagreement {
  shared: IdentifierField;
  companion: IdentifierField;
  /** The shared value, as both reports carried it. */
  value: string;
  /** The first report carrying a companion, and the first later one that differs. */
  anchor: ReportIdentifiers;
  other: ReportIdentifiers;
}

/**
 * The reports of `reports` that carry `field`, grouped by the value they carry —
 * insertion-ordered, so every group follows payload order.
 */
function groupByValue(
  reports: readonly ReportIdentifiers[],
  field: IdentifierField,
): Map<string, ReportIdentifiers[]> {
  const groups = new Map<string, ReportIdentifiers[]>();
  for (const report of reports) {
    const value = report[field];
    // A value absent, null or blank is not evidence of agreement and not
    // evidence of disagreement, so the report simply does not join a group.
    if (value === null) continue;
    const group = groups.get(value);
    if (group === undefined) groups.set(value, [report]);
    else group.push(report);
  }
  return groups;
}

/**
 * Every disagreement in one body, in {@link COMPARISONS} order, with each pair of
 * reports named at most once — see the header for why the pair rather than the
 * value is what de-duplicates.
 */
function disagreements(reports: readonly ReportIdentifiers[]): Disagreement[] {
  const found: Disagreement[] = [];
  const namedPairs = new Set<string>();

  for (const [shared, companion] of COMPARISONS) {
    for (const [value, group] of groupByValue(reports, shared)) {
      if (group.length < 2) continue;
      const anchor = group.find((report) => report[companion] !== null);
      if (anchor === undefined) continue;
      const other = group.find(
        (report) => report[companion] !== null && report[companion] !== anchor[companion],
      );
      if (other === undefined) continue;

      const pair = `${anchor.index}|${other.index}`;
      if (namedPairs.has(pair)) continue;
      namedPairs.add(pair);
      found.push({ shared, companion, value, anchor, other });
    }
  }

  return found;
}

/** The `adv.identifier_disagreement` check, registered in `ADVISORY_CHECKS`. */
export const identifierDisagreementCheck: SemanticCheck = (ctx: PipelineContext): Finding[] => {
  const reports = reportIdentifiers(ctx.parsedBody);
  // One report cannot disagree with itself, and a body with none is nothing to read.
  if (reports.length < 2) return [];

  return disagreements(reports).map(({ shared, companion, value, anchor, other }) =>
    advisory({
      id: IDENTIFIER_DISAGREEMENT_ID,
      // The earlier of the two reports named: it is where the shared value first
      // appears, and the drill-down only has to land the reader on the delivery.
      pointer: `/data/${anchor.index}`,
      summary:
        `Two reports carry ${FIELD_NOUN[shared]} ${value} beside ` +
        `${FIELD_NOUN[companion]} ${anchor[companion]} and ${other[companion]}.`,
      detail: IDENTIFIER_DISAGREEMENT_RATIONALE,
    }),
  );
};
