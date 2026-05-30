/**
 * Postgres connection pool.
 *
 * A single shared `pg.Pool` per process. Configuration is read from the
 * environment that docker-compose already wires (DESIGN.md §13): `DATABASE_URL`
 * is preferred when present; otherwise node-postgres falls back to the standard
 * `PG*` vars (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`). Both
 * are passed through compose today, so either path works without code changes.
 *
 * This module is deliberately thin: it owns connection lifecycle only. All SQL
 * lives in the typed repository wrappers in this directory.
 */

import { Pool, type PoolConfig } from 'pg';

let pool: Pool | undefined;

/** Build the pool config from the environment (`DATABASE_URL` ?? `PG*`). */
function configFromEnv(): PoolConfig {
  const url = process.env.DATABASE_URL;
  // When DATABASE_URL is set we hand it to pg verbatim; otherwise pg reads the
  // PG* vars itself from an empty config.
  return url ? { connectionString: url } : {};
}

/**
 * Get the process-wide pool, lazily creating it on first use. Reused across the
 * app so we don't open a fresh connection per request.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(configFromEnv());
  }
  return pool;
}

/** Close the pool (used by graceful shutdown and tests). Safe to call when unset. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
