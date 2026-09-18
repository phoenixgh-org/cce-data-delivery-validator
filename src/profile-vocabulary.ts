/**
 * The profile vocabulary (bd by1c.32) — the one server-side place a requirement
 * lineage turns into words a supplier reads.
 *
 * Two surfaces name a lineage in prose: the ingest response sentence
 * (src/ingest/pipeline.ts) and the dashboard's "also loaded, not graded against"
 * provenance line (src/web/components/Setup.tsx). Each used to carry its own
 * map, and the two had already drifted apart on the DS01.3 label, so the same
 * bytes were described differently on the wire and on the dashboard. The names
 * live here instead, as two fields of ONE vocabulary rather than two maps:
 *
 *  - `name` is the requirement PACKAGE a reader chooses between — the words on
 *    the lens toggle, a column header, a chip prefix: "UNICEF Q1 2025",
 *    "DS01.3 DRAFT".
 *  - `longName` is the schema DOCUMENT the bytes come from, for a provenance
 *    line that says which artifact was loaded — "cce-interop", "DS01.3 Annex 4".
 *
 * The two are different nouns, which is why the lens rename (bd tfnv.1) moved
 * only `name`. A provenance sentence built from the package name would read "the
 * UNICEF Q1 2025 0.8.1 schema", which names a requirement package at the one
 * point the reader is being told which FILE the bytes were checked against. Both
 * forms are kept because both are right in their own place; what is removed is
 * the divergence, not the shorter wording.
 *
 * Every caller reads the name off a lineage id it got from a registry entry or a
 * finding, never from a literal at the call site. Which lineage is the contract
 * and which is the shadow flips with `CONTRACT_PROFILE` (src/schema-registry.ts,
 * the single flip point), so a surface that wrote "DS01.3" outright would
 * describe the `cce-interop` entries that way on the day the contract moves.
 *
 * Browser code cannot import this module — `tsconfig.web.json` sets `rootDir` to
 * src/web — so src/web/profiles.ts re-declares the same vocabulary and
 * src/web/profiles.test.ts asserts the two are equal, the mirror-plus-equality
 * pattern src/web/clauseMap.ts already uses for the clause map.
 */

// `Profile` is declared in both src/db/repository.ts (findings) and
// src/schema-registry.ts (vendored entries). The repository copy is taken here
// because schema-registry re-exports PROFILES from this module, and importing
// back from it would make the two modules a cycle. The import is type-only, so
// nothing of the repository (and no `pg` pool) is pulled in at runtime.
import type { Profile } from './db/repository.js';

/**
 * Every profile, in the order the registry reports them — contract lineage
 * first. Only used to give cross-lineage listings a stable order; nothing infers
 * a profile from position.
 */
export const PROFILES: readonly Profile[] = ['2025', 'ds013'];

/** How one lineage is named, in the two lengths the surfaces need. */
export interface ProfileWords {
  /** The requirement package, for the lens and column headers: `'DS01.3 DRAFT'`. */
  name: string;
  /** The schema document, for a provenance line: `'DS01.3 Annex 4'`. */
  longName: string;
}

/**
 * The reader-facing name of each lineage. `'2025'` is the `cce-interop` family
 * the service grades against today; `'ds013'` is the DS01.3 Annex 4 delivery
 * schema proposal it grades against in shadow.
 *
 * The words themselves are binding (the shadow-grading handoff): a lineage is
 * never called "old", "new", "current", "latest", "v1" or "v2", because a
 * supplier bound to a 2025 long-term agreement must not be told the version
 * their contract requires is stale. "DRAFT" names what the DS01.3 bytes ARE —
 * an unpublished proposal — and is not a claim that they supersede anything.
 */
export const PROFILE_VOCABULARY: Record<Profile, ProfileWords> = {
  '2025': { name: 'UNICEF Q1 2025', longName: 'cce-interop' },
  ds013: { name: 'DS01.3 DRAFT', longName: 'DS01.3 Annex 4' },
};
