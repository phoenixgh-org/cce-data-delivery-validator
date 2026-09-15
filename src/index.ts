/**
 * CCE data delivery validator — listen/bootstrap entrypoint.
 *
 * The configurable, port-free app lives in `app.ts` (`buildApp`). This module
 * binds it to a port and wires the boot-only side effects (retention sweep).
 *
 * The retention worker (DESIGN.md §11) is started HERE, not in `buildApp`, so
 * `buildApp` stays side-effect-free and `app.inject(...)` tests never spawn a
 * background timer. The contract-profile guard (by1c.52) runs here for the same
 * reason, and BEFORE `listen()`: a service that would mislabel stored findings
 * must never accept a transmission first.
 */

import type { FastifyBaseLogger } from 'fastify';

import { buildApp } from './app.js';
import {
  assertContractProfile,
  contractProfileMismatchMessage,
  missingMarkerTableMessage,
} from './db/contract-marker.js';
import { purgeExpiredSessions } from './db/repository.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Default retention sweep interval (ms): once per hour. The sweep itself only
 * deletes rows already past the 7-day window (DESIGN.md §11), so cadence only
 * affects how promptly expired sessions are reaped, not WHAT is reaped.
 */
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;

/** A minimal logger shape — Fastify's logger satisfies this. */
type SweepLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

/** Run one retention sweep, logging the purged count (or any failure). */
async function runSweep(log: SweepLogger): Promise<void> {
  try {
    const purged = await purgeExpiredSessions();
    log.info(`retention: purged ${purged} expired session(s)`);
  } catch (err) {
    // A failed sweep must never crash the process; the next tick retries.
    log.error(err);
  }
}

/**
 * Start the periodic retention worker (DESIGN.md §11): runs one sweep shortly
 * after boot, then every `RETENTION_SWEEP_MS` (default hourly). The interval is
 * `.unref()`'d so it never keeps the process alive on its own. Returns the
 * timer so callers/tests can clear it.
 */
export function startRetentionSweep(log: SweepLogger): NodeJS.Timeout {
  const intervalMs = Number(process.env.RETENTION_SWEEP_MS ?? DEFAULT_SWEEP_MS);

  // Kick one sweep shortly after boot so a long-down service reaps promptly,
  // without blocking the listen() path.
  setTimeout(() => void runSweep(log), 0).unref();

  const timer = setInterval(() => void runSweep(log), intervalMs);
  timer.unref();
  return timer;
}

/**
 * The flip-day guard (by1c.52, by1c.54). Reads the database's contract-profile
 * marker and returns false when the service must refuse to start, because
 * adopting a new contract profile discards all stored data rather than migrating
 * it (see src/db/contract-marker.ts). Four outcomes:
 *
 * - `fresh` / `match` — the marker was stamped, or already names the profile this
 *   build runs. Logged at info; boot continues.
 * - `mismatch` — the database holds data written under a different profile.
 *   Logged at error with the operator action; boot is refused.
 * - `missing-table` — `service_marker` does not exist (SQLSTATE 42P01), so this
 *   database volume predates db/initdb/80-contract-profile-marker.sql and the
 *   guard cannot run over it. Logged at error with the file to apply; boot is
 *   refused. Failing open here would leave the guard permanently inert on exactly
 *   the deployments it was written for — an existing one, carrying pre-flip rows.
 * - any other read failure (connection refused, timeout, auth) — inconclusive
 *   rather than fatal, matching this module's stance that DB trouble never
 *   crashes the process ({@link runSweep}). It says nothing about what the
 *   database holds, it clears by itself, and the guard runs again on the next
 *   boot.
 */
async function contractProfileOk(log: SweepLogger): Promise<boolean> {
  try {
    const check = await assertContractProfile();
    if (check.outcome === 'mismatch') {
      log.error(contractProfileMismatchMessage(check.stored!, check.expected));
      return false;
    }
    if (check.outcome === 'missing-table') {
      log.error(missingMarkerTableMessage());
      return false;
    }
    log.info(
      `contract profile: ${check.expected} (${check.outcome === 'fresh' ? 'marker stamped on a fresh database' : 'matches the stored marker'})`,
    );
    return true;
  } catch (err) {
    log.error(err);
    log.error('contract profile: marker unreadable, guard not run; starting anyway');
    return true;
  }
}

export async function main(): Promise<void> {
  const app = buildApp();
  // Guard first: never listen over data written under a different contract profile.
  if (!(await contractProfileOk(app.log))) {
    process.exit(1);
  }
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  // Boot-only side effect: start the §11 retention worker after we're listening.
  startRetentionSweep(app.log);
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
