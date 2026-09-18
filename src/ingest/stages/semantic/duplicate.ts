/**
 * Semantic check — §1.8 duplicate detection (owning issue: 8ji.1).
 *
 * §1.8 asks us to NOTICE when a supplier re-sends a transmission within a
 * session. We OBSERVE rather than reject — the data is accepted (2xx) and the
 * observation becomes a teaching finding. There are two flavours of repeat, and
 * a single POST can trip BOTH at once:
 *
 *   - EXACT CONTENT REPLAY — a prior row in this session whose `content_hash`
 *     equals this transmission's sha256 (identical wire bytes), compared with
 *     `Buffer.equals`.
 *   - REPEATED transferId — a prior row whose `transfer_id` equals this
 *     transmission's `transferId` (only meaningful when transferId is non-null;
 *     the bytes may or may not have changed).
 *
 * The check computes its OWN sha256 of `ctx.rawBody` (route.ts computes a
 * separate copy at persist; we do NOT share it — see issue notes) and asks
 * `deps.findPriorTransmissions` for earlier rows in the SAME session. Because
 * that lookup runs BEFORE the current transmission persists, every returned row
 * is strictly earlier — exactly the priors a repeat is graded against.
 *
 * The §1.8 honesty caveat: a repeat is not automatically wrong. A supplier MAY
 * have an allowed condition or a justified exception, and we cannot judge that
 * from here. So the fail detail RECORDS the observed repeat and names the
 * caveat rather than asserting a hard violation. We NEVER collapse or drop —
 * we always emit exactly one §1.8 finding (pass when both are novel, fail when
 * any repeat is observed).
 *
 * UNDER DS01.3 (by1c.10, decision D2 of by1c.2). Clause 5.1.9 restates §1.8 as
 * a "shall not" rather than a "should not" — the strongest form of the tightening
 * the shadow profile exists to preview. It changes nothing here. This check
 * already grades an observed repeat as a FAIL under the 2025 contract, which is
 * as severe as the shadow could make it, so 5.1.9 is a pure RE-TAG through
 * `FORWARD` in src/api/clause-map.ts: the same single finding is attributed to
 * §1.8 on the contract surface and to 5.1.9 on the DS01.3 one, and the verdict
 * engine (src/api/verdicts.ts) carries the contract failure forward so a
 * duplicate fails both profiles. The consequence worth stating: a duplicate can
 * never appear as a DS01.3 readiness reason, because readiness is folded over
 * traffic that PASSES the contract and this traffic does not. No DS01.3 branch,
 * no second finding, no severity change.
 *
 * Returns exactly one finding. The orchestrator pushes it onto `ctx.findings`.
 */

import { createHash } from 'node:crypto';

import type { Finding } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';

const REPEAT_CAVEAT =
  'we observe the repeat but cannot judge whether an allowed condition or ' +
  'justified exception applies, so the data is accepted and recorded';

export const duplicateCheck: SemanticCheck = async (ctx, deps): Promise<Finding[]> => {
  // Compute this transmission's content hash independently of the persist path.
  const contentHash = createHash('sha256').update(ctx.rawBody).digest();
  const transferId = ctx.meta.transferId ?? null;

  const priors = await deps.findPriorTransmissions(ctx.sessionUuid, { transferId, contentHash });

  // Exact content replay: a prior row with byte-identical content.
  const exactReplay = priors.some(
    (p) => p.content_hash != null && p.content_hash.equals(contentHash),
  );
  // Repeated transferId: a prior row re-using this (non-null) transferId.
  const repeatedTransferId =
    transferId !== null && priors.some((p) => p.transfer_id === transferId);

  // Both novel → pass.
  if (!exactReplay && !repeatedTransferId) {
    const idNote =
      transferId !== null
        ? `transferId "${transferId}" is novel in this session`
        : `no transferId was sent`;
    return [
      {
        requirement: '1.8',
        severity: 'pass',
        detail: `no prior occurrence in this session: ${idNote} and the content is novel (§1.8).`,
      },
    ];
  }

  // A repeat was observed → fail, naming which kind(s) tripped.
  const kinds: string[] = [];
  if (exactReplay) kinds.push('exact content replay (byte-identical to an earlier transmission)');
  if (repeatedTransferId)
    kinds.push(`same transferId "${transferId}" re-used from an earlier transmission`);

  return [
    {
      requirement: '1.8',
      severity: 'fail',
      detail: `duplicate observed in this session — ${kinds.join('; ')}. §1.8: ${REPEAT_CAVEAT}.`,
      code: 'tx.duplicate_transfer',
    },
  ];
};
