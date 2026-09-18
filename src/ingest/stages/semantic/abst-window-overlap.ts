/**
 * ADVISORY — `adv.abst_window_overlap`: two transmissions in one session, for
 * the same CCE unit, whose `ABST` windows intersect while their bodies differ
 * (owning issue: agj.24, decided on agj.14).
 *
 * The motivating case is PQS's own description of a common EMS data issue: "a
 * chunk of records were placed at the end of the previous data file". Across the
 * delivery interface that is cross-TRANSMISSION record overlap — each delivery
 * shows a gap where the chunk should be, time steps backward at the boundary,
 * and the same period arrives twice. From the receiving side the visible trace
 * is two deliveries for one appliance whose covered time spans intersect.
 *
 * An ADVISORY, never a verdict: `severity: 'info'` under the `adv.*` namespace
 * via {@link advisory}, so it provably cannot move any §7 requirement's pass or
 * fail status (advisory.ts's header explains how that is enforced).
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is not a repeat-delivery verdict. §1.8 already grades an exact content
 * replay and a re-used `transferId` (./duplicate.ts), and requirements §5
 * REQUIRES a supplier to re-send after a delivery the receiving side did not
 * accept. Both of those are excluded in SQL by
 * {@link findPriorUnitWindows} — the lookup drops any prior sharing this
 * transmission's content hash or its `transferId` — so this check never sees a
 * repeat §1.8 has already spoken about, and the copy says so.
 *
 * ── WHAT IT READS, AND FROM WHERE ───────────────────────────────────────────
 * The only advisory with a read path. Every other check in the catalogue is a
 * pure function of one parsed body; this one compares the body in hand against
 * `transmission_unit_window` rows earlier POSTs in the SAME session left behind
 * (db/initdb/95-transmission-unit-window.sql). The two halves:
 *
 *   - THIS BODY'S WINDOWS come from {@link computeUnitWindows}
 *     (src/identity/unit-key.ts): one `{unitKey, abstMin, abstMax}` per
 *     identified report, over the records whose `ABST` `parseAbst` can read. A
 *     body naming no appliance, or carrying no readable timestamp, yields none
 *     and the check returns immediately.
 *   - THE PRIORS come from `deps.findPriorUnitWindows`, newest first. It runs
 *     BEFORE this transmission is persisted (route.ts writes the rows after
 *     `insertTransmission`), so a transmission can never overlap itself.
 *
 * INTERSECTION is the ordinary closed-interval test — `prior.abst_min <=
 * this.abstMax AND this.abstMin <= prior.abst_max` — so two deliveries that
 * merely touch at a shared instant intersect. That is deliberate: a record
 * delivered in both halves of a boundary is exactly the shape PQS describes.
 *
 * ── ONE ADVISORY PER UNIT, NAMING THE MOST RECENT OVERLAPPING PRIOR ─────────
 * PINNED, and the test pins it. A body that overlaps six earlier deliveries of
 * one appliance raises ONE advisory, not six, and the prior it names is the
 * most recently received of them — `findPriorUnitWindows` orders by
 * `received_at DESC`, so the first matching row is that one. The alternative
 * (one advisory per overlapping pair) was rejected because the count would
 * measure how long the session has been running rather than anything about this
 * delivery, and because the supplier's question is "did I send this period
 * twice?", which one row answers. A multi-report body still raises one advisory
 * PER APPLIANCE, since each is a separate delivery question.
 *
 * TIMESTAMPS ARE RENDERED ISO 8601 UTC TO THE SECOND (`2020-01-15T04:05:54Z`),
 * whatever form they arrived in. Also pinned. The compact `ABST` form the wire
 * uses (`20200115T040554Z`) is hard to read beside a `received_at` that never
 * had it, and the two timestamps in this copy are compared by eye.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * The copy OBSERVES and never concludes (approved 2026-09-18). Overlapping
 * windows have an innocent reading — a clock or a boundary off by a little
 * between two deliveries that legitimately adjoin — and the receiving side
 * cannot tell that from a chunk re-sent, so the rationale names both and
 * chooses neither.
 */

import { createHash } from 'node:crypto';

import { computeUnitWindows, unitKey, type UnitWindow } from '../../../identity/unit-key.js';
import type { Finding, PipelineContext } from '../../pipeline.js';
import type { PriorUnitWindow, SemanticCheck, SemanticDeps } from '../semantic.js';
import { advisory } from './advisory-finding.js';

/** The advisory id, exported for `ADVISORY_IDS` (see ./advisory.ts). */
export const ABST_WINDOW_OVERLAP_ID = 'adv.abst_window_overlap' as const;

/** Whether a value is a plain (non-array) object we can read keys off. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A timestamp as ISO 8601 UTC to the second — the ONE rendering this copy uses,
 * for both the window bounds (which arrived as compact `ABST` strings) and the
 * prior's `received_at` (which never did). Sub-second precision is dropped: the
 * windows are compared at millisecond resolution but read at second resolution.
 */
function isoSeconds(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * The appliance a unit key names, in prose — the key's value with its namespace
 * spelled out rather than shown as the `aser:`/`amid:` prefix it carries
 * internally. The two namespaces never reconcile (see `unitKey`'s docblock), so
 * the copy says WHICH kind of name it is quoting.
 */
function applianceName(key: string): string {
  if (key.startsWith('aser:')) return `appliance serial ASER ${key.slice('aser:'.length)}`;
  if (key.startsWith('amid:')) return `appliance id AMID ${key.slice('amid:'.length)}`;
  // Unreachable while `unitKey` produces those two prefixes and nothing else;
  // quoting the raw key is better than asserting a namespace we did not read.
  return key;
}

/**
 * JSON Pointer to the FIRST report of this body that named `key`, for the
 * raw-payload drill-down. Recomputed here rather than carried on
 * {@link UnitWindow}: the window is the merge of every report for one appliance
 * (a body may carry several), and the pointer only has to land the reader on
 * the delivery in question.
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

/** The most recent prior window for `window`'s unit that intersects it. */
function mostRecentOverlap(
  priors: readonly PriorUnitWindow[],
  window: UnitWindow,
): PriorUnitWindow | undefined {
  // `findPriorUnitWindows` orders newest first, so the first match is the most
  // recently received one.
  return priors.find(
    (prior) =>
      prior.unit_key === window.unitKey &&
      prior.abst_min.getTime() <= window.abstMax &&
      window.abstMin <= prior.abst_max.getTime(),
  );
}

/** The `adv.abst_window_overlap` check, registered in `ADVISORY_CHECKS`. */
export const abstWindowOverlapCheck: SemanticCheck = async (
  ctx: PipelineContext,
  deps: SemanticDeps,
): Promise<Finding[]> => {
  const windows = computeUnitWindows(ctx.parsedBody);
  // No appliance named, or no readable timestamp — nothing a later delivery
  // could be compared against, so there is no lookup to pay for either.
  if (windows.length === 0) return [];

  // Computed here rather than shared with the persist path, exactly as
  // ./duplicate.ts computes its own: the two are independent readers of the
  // same bytes.
  const contentHash = createHash('sha256').update(ctx.rawBody).digest();

  const priors = await deps.findPriorUnitWindows(
    ctx.sessionUuid,
    windows.map((window) => window.unitKey),
    { excludeContentHash: contentHash, excludeTransferId: ctx.meta.transferId ?? null },
  );
  if (priors.length === 0) return [];

  const findings: Finding[] = [];
  for (const window of windows) {
    const prior = mostRecentOverlap(priors, window);
    if (prior === undefined) continue;

    const unit = applianceName(window.unitKey);
    findings.push(
      advisory({
        id: ABST_WINDOW_OVERLAP_ID,
        pointer: pointerForUnit(ctx.parsedBody, window.unitKey),
        summary:
          'The timestamps in this report overlap a report received earlier in this session ' +
          'for the same appliance.',
        detail:
          `Records for ${unit} span ${isoSeconds(window.abstMin)} to ` +
          `${isoSeconds(window.abstMax)}. A report received at ${isoSeconds(prior.received_at)} ` +
          `for the same appliance spans ${isoSeconds(prior.abst_min)} to ` +
          `${isoSeconds(prior.abst_max)}, and the two bodies differ. Overlapping windows are ` +
          'what a record chunk appended to the previous delivery looks like from the receiving ' +
          'side; they are also what two deliveries that legitimately cover adjoining periods ' +
          'look like when a clock or a boundary is off by a little. Exact retransmissions are ' +
          'excluded from this observation and are graded under §1.8.',
      }),
    );
  }

  return findings;
};
