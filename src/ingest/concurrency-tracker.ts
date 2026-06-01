/**
 * In-flight request tracking per session (DESIGN.md §8, requirement §2.1).
 *
 * §2.1 expects "serial delivery by default": a supplier should not have more
 * than one `POST /i/{uuid}` in flight at a time for a given session. We OBSERVE
 * concurrency rather than enforce it — the data is still accepted (2xx) and the
 * observed in-flight count becomes a teaching finding (see stages/semantic/concurrency.ts).
 *
 * This is single-instance, in-memory only ("Concurrency observation is in-flight
 * request tracking per session, not a stored artifact"). The module-level Map is
 * keyed by sessionUuid → number of requests currently in flight for that session.
 * Behind a load balancer with multiple instances this undercounts; that is an
 * accepted limitation of the observation (not enforcement) design.
 *
 * Pure and fully unit-testable: {@link enterSession} / {@link leaveSession} are
 * the only mutators and {@link inFlight} is a read-only probe for tests.
 */

/** sessionUuid → number of `POST /i/{uuid}` requests currently in flight. */
const inFlightBySession = new Map<string, number>();

/**
 * Mark a request as entering the session: increment the in-flight count and
 * return the NEW count as the snapshot. The snapshot INCLUDES the current
 * request, so a snapshot of 1 means this request was the only one in flight
 * (serial); ≥2 means at least one OTHER request overlapped it (concurrent).
 *
 * Every successful {@link enterSession} MUST be paired with exactly one
 * {@link leaveSession} (call it from a `finally`) or the count leaks.
 */
export function enterSession(sessionUuid: string): number {
  const next = (inFlightBySession.get(sessionUuid) ?? 0) + 1;
  inFlightBySession.set(sessionUuid, next);
  return next;
}

/**
 * Mark a request as leaving the session: decrement the in-flight count. The key
 * is DELETED when the count reaches 0 so the Map does not leak an entry per
 * session that ever received a request. A spurious leave (count already 0/absent)
 * is a no-op.
 */
export function leaveSession(sessionUuid: string): void {
  const current = inFlightBySession.get(sessionUuid);
  if (current === undefined) return;
  const next = current - 1;
  if (next <= 0) {
    inFlightBySession.delete(sessionUuid);
  } else {
    inFlightBySession.set(sessionUuid, next);
  }
}

/** Read the current in-flight count for a session (0 when absent). Test probe. */
export function inFlight(sessionUuid: string): number {
  return inFlightBySession.get(sessionUuid) ?? 0;
}
