/**
 * Whether a read names its requirement package (tfnv.17).
 *
 * The dashboard holds a lens and the two reads accept one, but the contract
 * package is deliberately NOT sent: `?lens=2025` and no lens at all mean the
 * same thing to the server, so omitting it keeps the default view's request URL
 * the one every prior bite pinned. That rule lived inline at the two call sites
 * in Dashboard.tsx, which put it out of reach of a test; it lives here so both
 * halves of the property — serialized only when supplied, supplied only when the
 * lens is not the contract package — are pinned rather than asserted in a commit
 * message.
 *
 * Pure and browser-safe: no DOM, no JSX, no backend import, which is what lets
 * lensQuery.test.ts exercise it on the Node runner (the pattern scopeCopy.ts and
 * profiles.ts follow).
 */
import type { Profile } from './api.js';

/**
 * The `lens` half of a read's options: `{}` under the contract package, and
 * `{ lens }` under any other one. Spread into the options object of
 * {@link getSession} / {@link listTransmissions}, both of which serialize only
 * the keys they are given.
 *
 * `contractProfile` is a parameter rather than the module constant for the reason
 * profiles.ts gives: the contract in force is one flip point, and a caller passes
 * the value it already read rather than this module naming a lineage.
 */
export function lensOpt(lens: Profile, contractProfile: Profile): { lens?: Profile } {
  return lens === contractProfile ? {} : { lens };
}
