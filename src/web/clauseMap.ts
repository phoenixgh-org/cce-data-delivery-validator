/**
 * The 2025 → DS01.3 forward clause map (by1c.14) — browser code, re-declared
 * from `FORWARD` in src/api/clause-map.ts, whose own authority is the prose
 * table in `docs/clause-mapping.md`.
 *
 * WHY a mirror: the docked detail marks a 2025 finding that also fails under
 * DS01.3 with the shadow clause it is re-tagged to ("· also 5.1.3"), and that
 * naming happens in the browser. The server module is pure and dependency-free
 * by design, but it still sits under src/api, which browser code does not import
 * (src/web/api.ts's header states the rule).
 *
 * Only the forward map is mirrored. `TIGHTENED`, `NEW_IN_DS013` and
 * `DS013_TITLE` have no browser consumer yet; copying them here unused would put
 * three more tables on the drift list for nothing. The colocated test asserts
 * deep equality with the server object, so a row added there and not here fails
 * the build.
 */

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
