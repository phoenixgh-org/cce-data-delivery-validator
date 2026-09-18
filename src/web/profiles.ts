/**
 * The profile vocabulary (by1c.11) — the ONE place the dashboard turns a lineage
 * id into words a supplier reads.
 *
 * The shadow-grading handoff makes the wording binding, because a supplier bound
 * to a 2025 LTA must never be told the version their contract requires is stale:
 * the contract lineage is "UNICEF Q1 2025", the shadow lineage is
 * "DS01.3 DRAFT" with the vendored draft's date, and the words "old", "new",
 * "current", "latest", "v1" and "v2" are NEVER used of a lineage. "Outdated"
 * stays available, but only WITHIN a lineage (0.8.0 vs 0.8.1), never across two.
 *
 * One consequence shapes the exports below: nothing here names a lineage from a
 * literal at the call site. Callers pass the profile they read off the session
 * response, and the name comes from {@link PROFILE_NAME}.
 *
 * Pure and browser-safe: no DOM, no JSX, no backend import — which is also what
 * lets profiles.test.ts exercise it on the Node runner without the React shim.
 * The grading lens's surfaces (the header toggle, the lens banner, the verdict
 * columns, the summary cards and the detail headings) import this module rather
 * than restating the words.
 *
 * The words are shared with the server (by1c.32). src/profile-vocabulary.ts is
 * the definition; this module RE-DECLARES it because `tsconfig.web.json` sets
 * `rootDir` to src/web and browser code therefore cannot import anything outside
 * it. profiles.test.ts imports the server module and asserts the two are equal,
 * the same mirror-plus-equality pattern src/web/clauseMap.ts uses for the clause
 * map — so a name changed on one side and not the other fails a test rather than
 * reaching a supplier.
 */
import type { Profile } from './api';

/** How one lineage is named, in the two lengths the surfaces need. */
export interface ProfileWords {
  /** The requirement package, for the lens and column headers: `'DS01.3 DRAFT'`. */
  name: string;
  /** The schema document, for a provenance line: `'DS01.3 Annex 4'`. */
  longName: string;
}

/**
 * The reader-facing name of each lineage, in both lengths. A mirror of
 * `PROFILE_VOCABULARY` in src/profile-vocabulary.ts — held equal to it by
 * profiles.test.ts, not by the type system.
 */
export const PROFILE_VOCABULARY: Record<Profile, ProfileWords> = {
  '2025': { name: 'UNICEF Q1 2025', longName: 'cce-interop' },
  ds013: { name: 'DS01.3 DRAFT', longName: 'DS01.3 Annex 4' },
};

/**
 * The bare reader-facing name of each lineage — no role suffix, no date. The
 * contract marker and the draft date are composed on top of this so one name
 * serves the header toggle, the verdict columns and the tooltips alike.
 *
 * A derived view of {@link PROFILE_VOCABULARY}'s short form rather than a third
 * list of names: the header toggle, the banner, the verdict columns and the
 * detail headings keep reading this, and the words they read come from the one
 * vocabulary.
 */
export const PROFILE_NAME: Record<Profile, string> = Object.fromEntries(
  Object.entries(PROFILE_VOCABULARY).map(([profile, words]) => [profile, words.name]),
) as Record<Profile, string>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A draft date in the compact form a one-line label needs: `'2026-09-08'` →
 * `"Sep 8"`.
 *
 * The YYYY-MM-DD parts are read off the string directly and NOT handed to
 * `new Date(...)`: a date-only string parses as UTC midnight and then renders in
 * the viewer's local zone, which shows the previous day west of Greenwich. The
 * date is provenance, so it must read the same everywhere.
 *
 * Anything that is not a YYYY-MM-DD date comes back unchanged — an unrecognised
 * value is shown as the server sent it rather than guessed at.
 */
export function formatDraftDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (month === undefined || day < 1 || day > 31) return date;
  return `${month} ${day}`;
}

/**
 * A draft date in full, as the lens banner states it: `'2026-09-08'` → `"Sep 8,
 * 2026"`.
 *
 * The same parse as {@link formatDraftDate}, and for the same reason — the date
 * is provenance and must read the same in every time zone. The two lengths are
 * separate because their sentences are: the compact form sets the date beside a
 * version on one cramped line, where the year is noise, while the banner makes it
 * the end of a sentence that dates an unpublished proposal, where a bare
 * "Sep 8" leaves the reader to guess the year.
 *
 * Anything that is not a YYYY-MM-DD date comes back unchanged, as there too.
 */
export function formatDraftDateLong(date: string): string {
  const short = formatDraftDate(date);
  return short === date ? date : `${short}, ${date.slice(0, 4)}`;
}
