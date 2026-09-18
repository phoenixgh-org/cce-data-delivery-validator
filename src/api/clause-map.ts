/**
 * The 2025 ↔ DS01.3 clause map (by1c.4) — a PURE, dependency-free mirror of
 * `docs/clause-mapping.md`, which stays the prose authority. Every row here is
 * transcribed from that document's forward-map and reverse-map tables; when the
 * two disagree, the document is right and this module is the bug.
 *
 * WHY: internal requirement ids stay on the 2025 numbering (`1.1` … `5.3`, see
 * the 2026-07-31 decision in `docs/clause-mapping.md`), but the shadow surfaces
 * have to speak DS01.3 as well. They need to (a) show the DS01.3 clause id next
 * to a 2025 finding ("· also 5.3.2"), (b) title a readiness reason by its DS01.3
 * clause, and (c) know which clauses tightened. Transport and semantic checks
 * are emitted ONCE under 2025 numbering and RE-TAGGED for the shadow profile
 * rather than re-run — so this map is what makes a 2025 transport failure count
 * against DS01.3 too.
 *
 * No imports, no DB, no HTTP: `src/web` may need a mirror of this later, so keep
 * it browser-safe. The test joins against `src/api/compliance-matrix.ts` so that
 * a new matrix row cannot silently lack a mapping; the module itself must not
 * import it, or the dependency runs the wrong way.
 */

/**
 * Forward map: 2025 requirement id → DS01.3 clause id.
 *
 * All 27 rows of the §7 matrix, in document order. Several 2025 clauses collapse
 * into one DS01.3 clause (1.1 + 1.2 → 5.1.3; 4.1 + 4.2 + 4.3 → 5.4.1; 5.1 + 5.2
 * + 5.3 → 5.4.4), so the values are not unique.
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
 * The 2025 ids whose DS01.3 clause changes what conformance MEANS — not just
 * where the text lives. A renumbering alone does not qualify; these four do:
 *
 * - `1.8` → 5.1.10: "should not duplicate" becomes "shall not".
 * - `3.1` → 5.3.3: `meta.customDataSchema` added, `transferredAt` narrowed to
 *   UTC RFC 3339 with `Z`, `transferType` should → shall.
 * - `3.2` → 5.3.2: the schema-precedence tiebreaker is replaced by a duty to
 *   notify the employer of discrepancies.
 * - `4.3` → 5.4.1: "should abandon" on permanent failures becomes "shall not
 *   retry" (the response-code list itself is unchanged).
 *
 * Consumers use this to mark a shadow finding as a substantive change rather
 * than a relabelling. Every member is a key of {@link FORWARD}.
 */
export const TIGHTENED: ReadonlySet<string> = new Set(['1.8', '3.1', '3.2', '4.3']);

/**
 * DS01.3 clauses with no 2025 equivalent (the reverse map). Nothing in the 2025
 * contract obliges a supplier to satisfy them, and nothing here is emitted as a
 * finding under a DS01.3 clause id. They exist so the lens can say what DS01.3
 * adds beyond what the contract package grades.
 *
 * Such a clause is INFORMATIONAL unless a finding code feeds it — `NEW_FED_BY` in
 * ./matrix-ds013.js is the table that decides, and today it holds 5.3.5 alone,
 * fed by the §3.1 custom-object check. The other five carry no counts.
 */
export const NEW_IN_DS013: readonly string[] = [
  '5.1.1',
  '5.1.2',
  '5.1.11',
  '5.1.12',
  '5.3.1',
  '5.3.5',
];

/**
 * Short titles for the DS01.3 clauses that can reach the dashboard — every value
 * of {@link FORWARD} plus every entry of {@link NEW_IN_DS013}. Sentence-case noun
 * phrases, kept short enough to sit inline beside a 2025 requirement label;
 * wording is derived from the clause descriptions in `docs/clause-mapping.md`.
 */
export const DS013_TITLE: Readonly<Record<string, string>> = {
  '5.1.1': 'Employer data access rights',
  '5.1.2': 'Transport of data',
  '5.1.3': 'UTF-8 JSON over HTTPS',
  '5.1.5': 'Authentication method',
  '5.1.6': 'Payload size limit',
  '5.1.7': 'Response code handling',
  '5.1.8': 'Compression',
  '5.1.9': 'Custom headers',
  '5.1.10': 'No duplicates',
  '5.1.11': 'Transmission frequency',
  '5.1.12': 'Optional pull API',
  '5.2.1': 'Rate-limiting strategy',
  '5.2.2': 'Batching and timeliness',
  '5.2.3': 'Alarm timeliness',
  '5.3.1': 'General payload contents',
  '5.3.2': 'Validates against Annex 4',
  '5.3.3': 'Transmission metadata',
  '5.3.4': 'Completeness of recorded objects',
  '5.3.5': 'Custom data object schema',
  '5.3.6': 'Logger time resolution',
  '5.4.1': 'Retry on failure',
  '5.4.2': 'Backoff strategy',
  '5.4.3': 'Logging of failed attempts',
  '5.4.4': 'Retransmission on request',
  '5.4.5': 'Support contact and SLA',
  '5.4.6': 'Transmission monitoring',
  '5.4.7': 'Failure notification',
};

/**
 * The DS01.3 clause a 2025 requirement id maps to, or `null` when there is none.
 *
 * `null` is the right answer for an advisory id (`adv.*`, which carries no
 * requirement at all) and for any id outside the 27-row matrix, so callers can
 * pass a raw `finding.requirement` through without pre-filtering.
 */
export function forwardClause(req: string): string | null {
  return Object.prototype.hasOwnProperty.call(FORWARD, req) ? (FORWARD[req] ?? null) : null;
}
