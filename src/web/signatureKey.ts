/**
 * The signature key, rebuilt in the browser (by1c.14) — browser code,
 * re-declared from `generalizePath` / `sigKey` in src/api/signatures.ts.
 *
 * WHY a mirror rather than a wire field: the session read ships signatures
 * pre-rolled, but a per-transmission finding carries no signature key, and the
 * docked detail's shadow rows need one — a row is a button on the same
 * `?signatureKey=` cross-filter the compliance signatures use, so it has to name
 * the signature its finding folded into. Every field `sigKey` consumes
 * (`profile`, `requirement`, `keyword`, `instancePath`, `param`, `code`,
 * `detail`) is already on {@link FindingView}, so the key is derivable here and
 * no server change is needed.
 *
 * This file is browser code and imports no backend module (the rule stated in
 * src/web/api.ts's header). The colocated test closes the loop the type system
 * cannot: it imports the SERVER functions and asserts the two agree over a
 * fixture set, so a change to the fold on either side fails the build rather
 * than quietly producing keys that match nothing.
 */
import { ADVISORY_PREFIX, type FindingView } from './api';

/**
 * Key namespace for advisory signatures (`adv|adv.null_padding`) — mirror
 * `ADVISORY_KEY_PREFIX` in src/api/signatures.ts. The left half sits where a
 * profile would, which is unambiguous because the profile vocabulary is closed.
 */
export const ADVISORY_KEY_PREFIX = 'adv|';

/**
 * The fields the key is built from — every one of them on {@link FindingView},
 * so a caller passes its finding through unchanged.
 */
export type KeyableFinding = Pick<
  FindingView,
  'requirement' | 'detail' | 'keyword' | 'instancePath' | 'param' | 'code' | 'profile'
>;

/**
 * Strip array indices so per-element failures collapse: `/data/0/ABST` and
 * `/data/7/ABST` both become `/data/*\/ABST`.
 */
export function generalizePath(p: string | null | undefined): string {
  return (p || '').replace(/\/\d+/g, '/*');
}

/** Whether an id belongs to the `adv.*` namespace rather than the §7 ids. */
function isAdvisoryId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(ADVISORY_PREFIX);
}

/** The `adv.*` id an advisory finding carries (`code` first, `requirement` after). */
function advisoryIdOf(f: KeyableFinding): string {
  return isAdvisoryId(f.code) ? (f.code as string) : f.requirement;
}

/**
 * The signature key a finding folds into:
 *   - advisory:      `adv|<adv.id>`
 *   - schema error:  `profile|req|keyword|generalizedInstancePath|param`
 *   - check code:    `profile|req|code`
 *   - last resort:   `profile|req|detail`
 *
 * The profile prefix is what keeps the two lineages disjoint (by1c.7): the same
 * Ajv keyword failing at the same path under 2025 and under DS01.3 is two
 * defects against two clauses, never one row.
 */
export function findingSignatureKey(f: KeyableFinding): string {
  if (isAdvisoryId(f.requirement) || isAdvisoryId(f.code)) {
    return ADVISORY_KEY_PREFIX + advisoryIdOf(f);
  }
  const head = f.profile + '|' + f.requirement;
  if (f.keyword) {
    return head + '|' + f.keyword + '|' + generalizePath(f.instancePath) + '|' + (f.param || '');
  }
  if (f.code) return head + '|' + f.code;
  return head + '|' + (f.detail || '');
}
