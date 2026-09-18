/**
 * The 2025 → DS01.3 clause translation in the browser (by1c.14, tfnv.7) —
 * re-declared from src/api/clause-map.ts, src/api/verdicts.ts and
 * src/api/lens.ts, whose own authority is the prose table in
 * `docs/clause-mapping.md`.
 *
 * WHY a mirror: under the grading lens the docked detail and the list row number
 * a transmission's findings in the SELECTED package's ids, and that translation
 * happens in the browser — per-finding ids are served on 2025 numbering
 * (`requirement-numbering-2025-retained`), and only signatures carry a
 * server-computed `requirementUnderLens`. The server modules are pure and
 * dependency-free by design, but they sit under src/api, which browser code does
 * not import (src/web/api.ts's header states the rule).
 *
 * WHAT IS MIRRORED, and what is not. The forward map, the re-run set, the
 * tightened set and the custom-object check's two codes are here because
 * {@link clauseUnderLens} and {@link tightenedUnderLens} read them. `NEW_IN_DS013`
 * and `DS013_TITLE` still have no browser consumer — the DS01.3 matrix arrives
 * on the session response — so copying them would put two more tables on the
 * drift list for nothing.
 *
 * Every table below is held equal to its server original by clauseMap.test.ts,
 * and {@link clauseUnderLens} is held equal to the server's own fold on a fixture
 * table, so a rule changed on one side and not the other fails a test rather than
 * misnumbering a finding a supplier reads.
 */
import { isAdvisory } from './api';

/**
 * Forward map: 2025 requirement id → DS01.3 clause id. All 27 rows of the §7
 * matrix, in document order. Several 2025 clauses collapse into one DS01.3
 * clause (1.1 + 1.2 → 5.1.3; 4.1 + 4.2 + 4.3 → 5.4.1; 5.1 + 5.2 + 5.3 → 5.4.4),
 * so the values are not unique.
 */
export const FORWARD: Readonly<Record<string, string>> = {
  '1.1': '5.1.3',
  '1.2': '5.1.3',
  '1.3': '5.1.5',
  '1.4': '5.1.6',
  '1.5': '5.1.7',
  '1.6': '5.1.8',
  '1.7': '5.1.9',
  '1.8': '5.1.10',
  '2.1': '5.2.1',
  '2.2': '5.2.2',
  '2.3': '5.2.3',
  '3.1': '5.3.3',
  '3.2': '5.3.2',
  '3.3': '5.3.4',
  '3.4': '5.3.6',
  '4.1': '5.4.1',
  '4.2': '5.4.1',
  '4.3': '5.4.1',
  '4.4': '5.4.2',
  '4.5': '5.4.2',
  '4.6': '5.4.3',
  '4.7': '5.4.5',
  '4.8': '5.4.6',
  '4.9': '5.4.7',
  '5.1': '5.4.4',
  '5.2': '5.4.4',
  '5.3': '5.4.4',
};

/**
 * The DS01.3 clause a 2025 requirement id maps to, or `null` when there is none.
 *
 * `null` is the right answer for an advisory id (`adv.*`, which carries no
 * requirement at all) and for any id outside the 27-row matrix, so a caller can
 * pass a raw `finding.requirement` through without pre-filtering.
 */
export function forwardClause(req: string): string | null {
  return Object.prototype.hasOwnProperty.call(FORWARD, req) ? (FORWARD[req] ?? null) : null;
}

/**
 * The 2025 ids the DS01.3 package RE-RUNS rather than inherits — mirror
 * `RE_RUN_UNDER_SHADOW` in src/api/verdicts.ts.
 *
 * Only §3.2 qualifies. Transport and semantic checks are graded once and shared
 * between the packages, so a §1.4 failure is a 5.1.6 failure; §3.2's counterpart
 * (5.3.2) is genuinely re-run by the Annex 4 validator, which writes its own
 * findings. Translating the 2025 schema result onto 5.3.2 as well would report a
 * defect the DS01.3 run never measured, on a body that may satisfy Annex 4.
 */
export const RE_RUN_UNDER_SHADOW: ReadonlySet<string> = new Set(['3.2']);

/**
 * The 2025 ids whose DS01.3 clause changes what conformance MEANS rather than
 * where the text lives — mirror `TIGHTENED` in src/api/clause-map.ts, which
 * carries the clause-by-clause reasoning.
 */
export const TIGHTENED: ReadonlySet<string> = new Set(['1.8', '3.1', '3.2', '4.3']);

/**
 * The custom-object check's two outcome codes — mirror `CUSTOM_SCHEMA_CODES` in
 * src/ingest/stages/semantic/custom-schema.ts.
 *
 * DS01.3 splits §3.1 in two: the transmission-metadata duties stay together at
 * 5.3.3, while the duty to describe manufacturer-specific objects with a schema
 * becomes 5.3.5. A §3.1 finding carrying either code is the second half, so it is
 * the code — not the requirement id — that decides where it lands.
 */
export const CUSTOM_SCHEMA_CODES = {
  /** The conditional was satisfied — declared, or no custom objects to declare. */
  pass: 'tx.custom_schema_ok',
  /** Custom objects present with no `meta.customDataSchema` naming a schema. */
  fail: 'tx.missing_custom_schema',
} as const;

/** The minimal finding shape the translation reads. */
export interface LensFindingView {
  requirement: string;
  /** Which package produced the finding (by1c.5) — the translation's first question. */
  profile: string;
  /** Stable check code, where the finding carries one. */
  code?: string | null;
}

/**
 * The clause id a finding is shown under in the selected package, or `null` when
 * that package shows it nowhere. Mirror of `rowFor`/`clauseUnderLens` in
 * src/api/lens.ts, held equal to the server's fold by clauseMap.test.ts.
 *
 * The rule, in the order it is asked:
 *
 *   - Under the CONTRACT lens: a contract finding keeps its own id, and the other
 *     package's findings are shown nowhere. This is the identity the detail pane
 *     always had, so the default view is unchanged by construction.
 *   - Under another lens: a finding of THAT package keeps its own id — it was
 *     numbered in that package when it was written. A CONTRACT finding is
 *     translated: `null` for {@link RE_RUN_UNDER_SHADOW}, 5.3.5 when it is a §3.1
 *     finding carrying a {@link CUSTOM_SCHEMA_CODES} code, else its
 *     {@link forwardClause} — `null` when the map does not carry it forward,
 *     which is also the right answer for an `adv.*` id.
 *
 * Advisories are not the caller's to pass here: they are split off and rendered
 * in their own block, and an advisory id translates to `null` in any case.
 */
export function clauseUnderLens(
  f: LensFindingView,
  lens: string,
  contractProfile: string,
): string | null {
  if (lens === contractProfile) return f.profile === contractProfile ? f.requirement : null;
  if (f.profile === lens) return f.requirement;
  if (f.profile !== contractProfile) return null;
  if (RE_RUN_UNDER_SHADOW.has(f.requirement)) return null;
  if (f.code === CUSTOM_SCHEMA_CODES.pass || f.code === CUSTOM_SCHEMA_CODES.fail) return '5.3.5';
  return forwardClause(f.requirement);
}

/**
 * The DS01.3 clauses whose conformance TIGHTENED — {@link TIGHTENED} carried
 * through the forward map, never hand-typed, so a re-pointed row moves both
 * halves together. Today: 5.1.10, 5.3.2, 5.3.3, 5.4.1.
 */
const TIGHTENED_CLAUSES: ReadonlySet<string> = new Set(
  [...TIGHTENED].map((req) => forwardClause(req)).filter((c): c is string => c !== null),
);

/**
 * Whether a DS01.3 clause id is one the draft TIGHTENED — the detail row's
 * TIGHTENED tag.
 *
 * Asked of a DS01.3 clause id, never of a 2025 one: under the contract lens
 * nothing is tightened, because the contract package is what a tightening would
 * be measured against.
 */
export function tightenedUnderLens(clause: string): boolean {
  return TIGHTENED_CLAUSES.has(clause);
}

/**
 * How many findings FAIL a transmission under the selected package — the number
 * in the row's `{n}f` cell and in the verdict tooltip's parenthetical.
 *
 * It is the failures the docked detail would list under that lens: a finding the
 * lens shows nowhere cannot be one of its failures. So under the DS01.3 lens a
 * 2025 §3.2 failure does NOT count (Annex 4 re-runs that clause and files its
 * own), a DS01.3 5.3.2 failure does, and a §1.4 transport failure still does,
 * under 5.1.6. It replaces `shadowFailCount`, which asked the same question of
 * one package only.
 *
 * It counts FINDINGS, not rows: the detail collapses several missing properties
 * at one path into one line, and a count of rows would read as a second, smaller
 * total sitting under the first (by1c.39).
 *
 * ADVISORIES ARE EXCLUDED OUTRIGHT, the rule every count on this row follows: an
 * advisory is raised against a payload that broke no rule, and it must never give
 * a conformant transmission a number to explain. They are `info` today, so the
 * severity test would drop them anyway; the exclusion is stated rather than
 * inherited, because {@link clauseUnderLens} deliberately passes an `adv.*` id
 * through under the contract lens (the server's fold does the same, and drops it
 * downstream where no matrix row claims the key).
 */
export function failCountUnderLens(
  findings: readonly (LensFindingView & { severity: string })[],
  lens: string,
  contractProfile: string,
): number {
  return findings.filter(
    (f) =>
      f.severity === 'fail' && !isAdvisory(f) && clauseUnderLens(f, lens, contractProfile) !== null,
  ).length;
}
