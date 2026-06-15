/**
 * CCE data delivery validator — listen/bootstrap entrypoint.
 *
 * The configurable, port-free app lives in `app.ts` (`buildApp`). This module
 * binds it to a port and wires the boot-only side effects (retention sweep).
 *
 * The retention worker (DESIGN.md §11) is started HERE, not in `buildApp`, so
 * `buildApp` stays side-effect-free and `app.inject(...)` tests never spawn a
 * background timer.
 */

import type { FastifyBaseLogger } from 'fastify';

import { buildApp } from './app.js';
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

export async function main(): Promise<void> {
  const app = buildApp();
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
