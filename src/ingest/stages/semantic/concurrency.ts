/**
 * Semantic check — §2.1 concurrency observation (owning issue: 8ji.3).
 *
 * §2.1 calls for "serial delivery by default": a supplier should normally have
 * at most one `POST /i/{uuid}` in flight per session. We OBSERVE rather than
 * enforce — the data is accepted (2xx) and the observed concurrency becomes a
 * teaching finding.
 *
 * The snapshot is `deps.concurrentAtEntry`, the in-flight count captured at
 * handler entry by the concurrency tracker. It INCLUDES this request:
 *   - snapshot ≤ 1 → this was the only request in flight → PASS (serial).
 *   - snapshot ≥ 2 → ≥1 OTHER request overlapped this one → FAIL (concurrent).
 *
 * The §2.1 caveat: we cannot judge whether a justified exception applies (a
 * supplier MAY have a legitimate reason to overlap), so the detail records the
 * observation and names that caveat rather than asserting a hard violation.
 *
 * Returns exactly one finding. Independent of the body, so no parse/schema guard.
 */

import type { Finding } from '../../pipeline.js';
import type { SemanticCheck } from '../semantic.js';

export const concurrencyCheck: SemanticCheck = (_ctx, deps): Finding[] => {
  const observed = deps.concurrentAtEntry;
  const serial = observed <= 1;

  if (serial) {
    return [
      {
        requirement: '2.1',
        severity: 'pass',
        detail:
          `serial delivery observed: this was the only POST in flight for the session ` +
          `(${observed} in flight, incl. self). §2.1 expects serial delivery by default; ` +
          `we observe concurrency and cannot judge whether a justified exception applies.`,
      },
    ];
  }

  const others = observed - 1;
  return [
    {
      requirement: '2.1',
      severity: 'fail',
      code: 'tx.concurrent_delivery',
      detail:
        `concurrent delivery observed: ${others} other POST${others === 1 ? ' was' : 's were'} ` +
        `in flight for the session alongside this one (${observed} total, incl. self). ` +
        `§2.1 expects serial delivery by default; we observe concurrency and cannot judge ` +
        `whether a justified exception applies.`,
    },
  ];
};
