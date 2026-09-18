/**
 * The profile vocabulary (by1c.11) — the ONE place the dashboard turns a lineage
 * id into words a supplier reads.
 *
 * The shadow-grading handoff makes the wording binding, because a supplier bound
 * to a 2025 LTA must never be told the version their contract requires is stale:
 * the contract lineage is "UNICEF Q1 2025 (contract)", the shadow lineage is
 * "DS01.3 DRAFT" with the vendored draft's date, and the words "old", "new",
 * "current", "latest", "v1" and "v2" are NEVER used of a lineage. "Outdated"
 * stays available, but only WITHIN a lineage (0.8.0 vs 0.8.1), never across two.
 *
 * Two consequences shape the exports below:
 *
 *  1. "(contract)" belongs to whichever profile is `CONTRACT_PROFILE` — the
 *     registry's single flip point — so {@link profileLabel} derives the suffix
 *     from that constant rather than hanging it on the '2025' key. The day the
 *     contract moves, every surface follows without an edit here.
 *  2. Nothing here names a lineage from a literal at the call site. Callers pass
 *     the profile they read off the session response, and the name comes from
 *     {@link PROFILE_NAME}.
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
import { CONTRACT_PROFILE, type Profile, type ShadowProvenance } from './api';

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

/**
 * A lineage's name with its role: "UNICEF Q1 2025 (contract)" for whichever
 * profile is the contract in force, the bare name for every other one.
 */
export function profileLabel(profile: Profile): string {
  return profile === CONTRACT_PROFILE
    ? `${PROFILE_NAME[profile]} (contract)`
    : PROFILE_NAME[profile];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A draft date as a shadow label shows it: `'2026-09-08'` → `"Sep 8"`.
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
 * separate because their sentences are: a shadow label sets the date beside a
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

/**
 * The shadow half of a legend, split so a surface can set the provenance detail
 * in the mono stack while the name stays in the body face.
 */
export interface ShadowLegendParts {
  /** The lineage, marked as a draft when the entry is one: `"DS01.3 DRAFT"`. */
  name: string;
  /** `"Sep 8"` for a draft, the version string for a published entry — mono. */
  detail: string;
}

/**
 * The shadow lineage's label, in parts — `{ name: 'DS01.3 DRAFT', detail: 'Sep 8' }`.
 *
 * `draftDate` present is what licenses calling the entry a draft (api.ts,
 * `ShadowProvenance`); a published shadow entry is named by version alone, the
 * same split Setup.tsx's provenance line makes. Null when there is no shadow
 * lineage — `session.shadowProfile === null` is the hide signal for every shadow
 * surface, and `shadow === null` is the same condition.
 *
 * The draft marker is appended only when the lineage's own name does not already
 * carry it (tfnv.1): the vocabulary now names this lineage "DS01.3 DRAFT", and a
 * label reading "DS01.3 DRAFT draft Sep 8" says the word twice. A lineage whose
 * name says nothing about draft-ness still gets the marker, because the fact
 * comes from the entry rather than from the name.
 */
export function shadowLegendParts(
  shadow: ShadowProvenance | null,
  profile: Profile | null,
): ShadowLegendParts | null {
  if (shadow === null || profile === null) return null;
  const name = PROFILE_NAME[profile];
  if (shadow.draftDate === undefined) return { name, detail: shadow.version };
  const marked = /draft/i.test(name) ? name : `${name} draft`;
  return { name: marked, detail: formatDraftDate(shadow.draftDate) };
}

/**
 * The shadow label as one string — `"DS01.3 DRAFT Sep 8"` for a draft, the name
 * and version for a published entry. Null when no shadow lineage is registered.
 *
 * The profile is a parameter rather than a literal for the reason the module
 * header gives: no caller names a lineage by hand.
 */
export function shadowLegend(
  shadow: ShadowProvenance | null,
  profile: Profile | null,
): string | null {
  const parts = shadowLegendParts(shadow, profile);
  return parts === null ? null : `${parts.name} ${parts.detail}`;
}
