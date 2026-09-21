/**
 * ADVISORY — `adv.identifier_collision`: an appliance-side identifier that arrived
 * in this session beside a DIFFERENT companion identifier than an earlier accepted
 * delivery carried it beside (owning issue: 0rfk, decided 2026-09-18).
 *
 * The motivating case comes out of `./short-identifier.ts`, which is a LENGTH
 * heuristic: it observes that an identifier is too narrow to carry enough distinct
 * values for a national fleet, and deliberately concludes nothing about whether the
 * values actually collide. An identifier that demonstrably arrives under two
 * different companions inside one session is a FACT about the data rather than an
 * argument about the value space, and it is the signal that issue deferred. The
 * shape on the wire: one delivery reports `ASER "S-1"` with `AMID "fridge-a"`, a
 * later one reports `ASER "S-1"` with `AMID "fridge-b"`, and the receiving country
 * is holding two deliveries it cannot attribute to one appliance.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace via
 * {@link advisory}, so it provably cannot move any §7 requirement's pass or fail
 * status (advisory.ts's header explains how that is enforced).
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is NOT a §1.8 repeat-delivery verdict. §1.8 grades an exact content replay and
 * a re-used `transferId` (./duplicate.ts); both are excluded in SQL by
 * {@link findPriorUnitIdentities}, which drops any prior sharing this
 * transmission's content hash or its transfer id, and a delivery the service
 * rejected leaves no identity row to be compared against at all.
 *
 * It is NOT an identity resolution, and the copy says so. An identifier corrected
 * between two deliveries and two appliances that genuinely share one identifier
 * look IDENTICAL from the receiving side: both produce one value arriving beside
 * two companions. Deciding which happened needs the supplier, so the observation
 * states what arrived and names what the receiving side therefore cannot do. This
 * bound is the 2026-09-18 decision's own, and it is what keeps the advisory from
 * claiming two appliances exist.
 *
 * ── WHAT COLLIDES ───────────────────────────────────────────────────────────
 * Two accepted deliveries collide when they share one appliance-side identifier
 * VALUE and disagree on another that BOTH carry. The appliance-side identifiers
 * are exactly three — `ASER` (the manufacturer's serial), `AMID` (the supplier
 * platform's handle, an `rtmd-report` property only) and `AID` (the employer's
 * asset id, optional on both branches) — so the pairs compared are (ASER, AMID),
 * (ASER, AID) and (AMID, AID), each in both directions ({@link COMPARISONS}).
 *
 *   - A value ABSENT, null or blank on either side is not compared: `identifier`
 *     (src/identity/unit-key.ts) yields `null` for it, and one side carrying no
 *     asset id says nothing about the other side's.
 *   - Values are TRIMMED, never case-folded, for the reason that function gives:
 *     `"ab"` and `"AB"` are different serials and we have no warrant to merge them.
 *   - `LSER`, `ESER`, `LID` and `EID` are NOT compared. They name the logger and
 *     the monitoring device rather than the appliance, and `unitKey`'s docblock is
 *     the reasoning: one appliance re-instrumented, or one logger moved to another
 *     appliance, is ordinary operation. Remarking on it would grade maintenance.
 *
 * ── WHAT IT READS, AND FROM WHERE ───────────────────────────────────────────
 * The second check in the catalogue with a read path, after
 * ./abst-window-overlap.ts, and built the same way. The two halves:
 *
 *   - THIS BODY'S IDENTITIES come from {@link computeUnitIdentities}
 *     (src/identity/unit-key.ts): one `{unitKey, aser, amid, aid}` per identified
 *     report. A body naming no appliance yields none and the check returns
 *     immediately, paying for no lookup.
 *   - THE PRIORS come from `deps.findPriorUnitIdentities`, newest first, out of the
 *     `transmission_unit_identity` rows earlier POSTs in the SAME session left
 *     behind (db/initdb/96-transmission-unit-identity.sql). It runs BEFORE this
 *     transmission is persisted (route.ts writes the rows after
 *     `insertTransmission`), so a transmission can never collide with itself.
 *
 * ── ONE ADVISORY PER UNIT, NAMING THE MOST RECENT COLLIDING PRIOR ───────────
 * PINNED, and the test pins it. A body whose appliance collides with six earlier
 * deliveries raises ONE advisory, not six, and the prior it names is the most
 * recently received of them — `findPriorUnitIdentities` orders by `received_at
 * DESC`, so the first matching row is that one. The alternative (one advisory per
 * colliding pair) would measure how long the session has been running rather than
 * anything about this delivery. A multi-report body still raises one advisory PER
 * APPLIANCE.
 *
 * When one prior collides on more than one pair, the FIRST match in
 * {@link COMPARISONS} order is the one named: the serial is the appliance's own
 * name and leads, the platform handle follows, and the employer's asset id comes
 * last. Naming every pair would lengthen the line without changing what the
 * supplier has to go and look at.
 *
 * TIMESTAMPS RENDER ISO 8601 UTC TO THE SECOND (`2026-09-18T09:14:07Z`), as they do
 * in ./abst-window-overlap.ts: the prior's `received_at` carries milliseconds and
 * nothing in this copy is read beside them.
 *
 * ── THE VALUES ARE IN THE OBSERVATION, THE REASON IS STATIC ─────────────────
 * The identifiers and the receipt time are all in `summary` (synm), which is the
 * half of the copy that carries this transmission's own values. `detail` is one
 * static text per advisory id, because the compliance column shows a single
 * expandable row with no payload in front of it; see
 * {@link IDENTIFIER_COLLISION_RATIONALE}.
 *
 * THE SUMMARY RUNS PAST THE ROUGHLY-90-CHARACTER GUIDANCE on `AdvisoryInput`
 * (./advisory-finding.ts), which it may: this id cites a prior delivery and is
 * listed in `ADVISORY_IDS_CITING_A_PRIOR` (./advisory.ts), where the exception
 * and its reason are stated once (yjni). The four values on the line are the
 * identifier that repeated, the companion THIS report carried, the companion the
 * EARLIER report carried, and when that earlier report arrived.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * The copy OBSERVES and never concludes. It says which identifier repeated, which
 * companions travelled with it, and what the receiving side cannot do — it does NOT
 * say that two appliances exist, that either value is the right one, or that
 * anything went wrong. "Collision" is the id's word and stays out of the prose,
 * which quotes the values instead.
 */

import { createHash } from 'node:crypto';

import { computeUnitIdentities, unitKey, type UnitIdentity } from '../../../identity/unit-key.js';
import type { Finding, PipelineContext } from '../../pipeline.js';
import type { PriorUnitIdentity, SemanticCheck, SemanticDeps } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/** The advisory id, exported for `ADVISORY_IDS` (see ./advisory.ts). */
export const IDENTIFIER_COLLISION_ID = 'adv.identifier_collision' as const;

/**
 * THE RATIONALE, static per advisory id. This module is its single owner:
 * ./advisory.ts collects it into `ADVISORY_RATIONALES`, the API serves it on the
 * advisory signature, and the browser holds no copy of its own.
 *
 * It names no identifier and no timestamp — those are in the summary, which is the
 * half of the copy that speaks about one delivery — and it names no cause, because
 * a corrected identifier and two appliances sharing one are indistinguishable from
 * the receiving side.
 */
export const IDENTIFIER_COLLISION_RATIONALE =
  'An appliance identifier that arrives beside a different companion identifier than an ' +
  'earlier delivery carried leaves the receiving country holding two deliveries it cannot ' +
  'attribute to one appliance. From the receiving side an identifier that was corrected ' +
  'between deliveries and two appliances that share one identifier look the same, so this ' +
  'observation names neither: only the supplier can say which reading applies, and until it ' +
  'does the country cannot place either delivery against a single unit in its inventory. ' +
  'Exact retransmissions are excluded from this observation and are graded under §1.8.';

/** The appliance-side identifier fields, the only three this check compares. */
type IdentifierField = 'aser' | 'amid' | 'aid';

/**
 * How each field reads in the copy: the namespace spelled out, the way
 * `applianceName` spells out a unit key in ./abst-window-overlap.ts. The wire key
 * is quoted beside the prose name so a supplier can go straight to the property.
 */
const FIELD_NOUN: Readonly<Record<IdentifierField, string>> = {
  aser: 'appliance serial ASER',
  amid: 'appliance id AMID',
  aid: 'asset id AID',
};

/**
 * The directed comparisons, in the order a collision is reported. Three pairs —
 * (ASER, AMID), (ASER, AID), (AMID, AID) — each read both ways round, because a
 * shared serial under two platform handles and a shared platform handle under two
 * serials are the same fact seen from either end and either may be the one this
 * body presents.
 *
 * ORDER IS THE REPORTING PRIORITY, not an implementation detail: the appliance's
 * own serial is the name a country recognises, so a collision involving it is named
 * ahead of one between the supplier's handle and the employer's asset id.
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

/**
 * A timestamp as ISO 8601 UTC to the second — the one rendering this copy uses, as
 * in ./abst-window-overlap.ts. Sub-second precision is dropped: `received_at` is
 * read as "when the earlier delivery arrived", not compared at millisecond width.
 */
function isoSeconds(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * JSON Pointer to the FIRST report of this body that named `key`, for the
 * raw-payload drill-down — the same recomputation ./abst-window-overlap.ts makes,
 * and for the same reason: the identity is one entry per appliance and the pointer
 * only has to land the reader on the delivery in question.
 */
function pointerForUnit(body: unknown, key: string): string | null {
  if (!isPlainObject(body)) return null;
  const data = body['data'];
  if (!Array.isArray(data)) return null;
  for (const [index, report] of data.entries()) {
    if (!isPlainObject(report)) continue;
    if (unitKey(report) === key) return `/data/${index}`;
  }
  return null;
}

/** One prior that collides with this body's identity, and on which pair. */
interface Collision {
  prior: PriorUnitIdentity;
  shared: IdentifierField;
  companion: IdentifierField;
}

/**
 * The most recent prior colliding with `identity`, and the pair it collides on.
 *
 * `findPriorUnitIdentities` orders newest first, so the first prior that collides
 * at all is the most recently received one; within it, {@link COMPARISONS} order
 * decides which pair is named. A prior sharing a value and agreeing on every
 * companion it carries is NOT a collision — that is the ordinary case of one
 * appliance delivering twice.
 */
function mostRecentCollision(
  priors: readonly PriorUnitIdentity[],
  identity: UnitIdentity,
): Collision | undefined {
  for (const prior of priors) {
    for (const [shared, companion] of COMPARISONS) {
      const sharedHere = identity[shared];
      const companionHere = identity[companion];
      // A value absent on either side is not compared: it is not evidence of
      // agreement and it is not evidence of disagreement.
      if (sharedHere === null || prior[shared] !== sharedHere) continue;
      if (companionHere === null || prior[companion] === null) continue;
      if (prior[companion] === companionHere) continue;
      return { prior, shared, companion };
    }
  }
  return undefined;
}

/** The `adv.identifier_collision` check, registered in `ADVISORY_CHECKS`. */
export const identifierCollisionCheck: SemanticCheck = async (
  ctx: PipelineContext,
  deps: SemanticDeps,
): Promise<Finding[]> => {
  const identities = computeUnitIdentities(ctx.parsedBody);
  // No appliance named — nothing a later delivery could be compared against, so
  // there is no lookup to pay for either.
  if (identities.length === 0) return [];

  // Computed here rather than shared with the persist path, exactly as
  // ./duplicate.ts and ./abst-window-overlap.ts compute their own: each is an
  // independent reader of the same bytes.
  const contentHash = createHash('sha256').update(ctx.rawBody).digest();

  const priors = await deps.findPriorUnitIdentities(ctx.sessionUuid, identities, {
    excludeContentHash: contentHash,
    excludeTransferId: ctx.meta.transferId ?? null,
  });
  if (priors.length === 0) return [];

  const findings: Finding[] = [];
  for (const identity of identities) {
    const collision = mostRecentCollision(priors, identity);
    if (collision === undefined) continue;

    const { prior, shared, companion } = collision;
    findings.push(
      advisory({
        id: IDENTIFIER_COLLISION_ID,
        pointer: pointerForUnit(ctx.parsedBody, identity.unitKey),
        summary:
          `This report carries ${FIELD_NOUN[shared]} ${identity[shared]} beside ` +
          `${FIELD_NOUN[companion]} ${identity[companion]}. A report received at ` +
          `${isoSeconds(prior.received_at)} carried the same ${FIELD_NOUN[shared]} beside ` +
          `${FIELD_NOUN[companion]} ${prior[companion]}.`,
        detail: IDENTIFIER_COLLISION_RATIONALE,
      }),
    );
  }

  return findings;
};
