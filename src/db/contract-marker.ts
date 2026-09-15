/**
 * The contract-profile marker: which requirement lineage this database was last
 * written under, and the boot check that refuses to start over data written
 * under a different one (by1c.52).
 *
 * Findings are stored by lineage (`finding.profile`), not by role, so the day
 * {@link CONTRACT_PROFILE} moves from '2025' to 'ds013' every stored row changes
 * meaning: a transport rejection recorded as '2025' was a contract finding when
 * it was written and would read as a shadow finding after the flip, silently
 * dropping out of the supplier's grade. The decision is a clean cut — on flip day
 * ALL stored data is discarded, never migrated — and this guard is what enforces
 * it, because operators other than us run the service and a silent mislabelling
 * is exactly the failure nobody notices.
 *
 * Inference from existing rows cannot do this job: an unstamped finding written
 * under the old column default is indistinguishable from a deliberately stamped
 * one. The profile is therefore recorded explicitly in `service_marker`
 * (db/initdb/80-contract-profile-marker.sql), a table holding at most one row.
 *
 * LIMIT: this guard compares the DATABASE against the server's
 * {@link CONTRACT_PROFILE}. It cannot see the mirror literal in `src/web/api.ts`,
 * so a flip remains a two-edit change (server + web) and a server/web mismatch
 * stays undetected here.
 *
 * Cost: one indexed SELECT of at most one row, once, before `app.listen()`. The
 * guard is dormant until flip day and adds no measurable boot latency.
 *
 * A database whose volume predates db/initdb/80-contract-profile-marker.sql has
 * no `service_marker` table at all. That read fails with SQLSTATE 42P01, and it
 * is reported as its own outcome (`missing-table`) rather than as an unreadable
 * marker, because it is permanent and operator-fixable — see
 * {@link isMissingMarkerTable} (by1c.54).
 */

import { CONTRACT_PROFILE, type Profile } from '../schema-registry.js';
import { getPool } from './pool.js';
import type { Queryable } from './repository.js';

/** Row shape of the one-row `service_marker` table. */
interface ServiceMarkerRow {
  contract_profile: Profile;
}

/**
 * Read the contract profile this database was last written under, or null when
 * the marker has never been stamped (a fresh database).
 */
export async function readContractMarker(db: Queryable = getPool()): Promise<Profile | null> {
  const { rows } = await db.query<ServiceMarkerRow>(
    `SELECT contract_profile FROM service_marker WHERE singleton = true`,
  );
  return rows[0]?.contract_profile ?? null;
}

/**
 * Stamp the database with `profile`. Upserts the single row, so re-stamping the
 * same value is harmless and refreshes `written_at`.
 */
export async function writeContractMarker(
  profile: Profile,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO service_marker (singleton, contract_profile, written_at)
     VALUES (true, $1, now())
     ON CONFLICT (singleton)
     DO UPDATE SET contract_profile = EXCLUDED.contract_profile,
                   written_at = EXCLUDED.written_at`,
    [profile],
  );
}

/** What the boot check found. */
export interface ContractProfileCheck {
  /**
   * `fresh` — no marker; this call stamped {@link expected}.
   * `match` — the stored profile is the one this build runs.
   * `mismatch` — the database holds data written under a different profile.
   * `missing-table` — `service_marker` does not exist, so the guard cannot run:
   * a database volume created before db/initdb/80-contract-profile-marker.sql
   * was added (by1c.54).
   */
  outcome: 'fresh' | 'match' | 'mismatch' | 'missing-table';
  /** The profile read from the database; null on a fresh database. */
  stored: Profile | null;
  /** The profile this build runs ({@link CONTRACT_PROFILE}). */
  expected: Profile;
}

/** Postgres SQLSTATE `undefined_table` — the relation in the query does not exist. */
const UNDEFINED_TABLE = '42P01';

/**
 * True when `err` is Postgres reporting that the queried relation does not
 * exist. Classifying by SQLSTATE is what separates the two failures that used to
 * look identical to the boot guard: a missing `service_marker` table is a
 * permanent, operator-fixable state of THIS database, whereas a refused
 * connection, a timeout or an auth failure is transient and says nothing about
 * what the database holds. Only the first justifies refusing to start (by1c.54).
 *
 * The shape is duck-typed rather than `instanceof DatabaseError`, because the
 * error crosses a `Queryable` boundary that may be a pool, a client, or a test
 * double.
 */
export function isMissingMarkerTable(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNDEFINED_TABLE
  );
}

/**
 * The operator-facing refusal when the marker table is absent. db/initdb/*.sql is
 * replayed only on the first boot of a fresh volume, so a database created before
 * the marker file was added never got it — and until it is applied by hand the
 * flip-day guard cannot see what the stored rows were written under. Naming the
 * file and the deployment section keeps the fix to one command.
 */
export function missingMarkerTableMessage(): string {
  return (
    `contract profile marker table is missing; apply ` +
    `db/initdb/80-contract-profile-marker.sql to this database and start again ` +
    `(docs/deployment.md, "Upgrading an existing database volume"). ` +
    `Until it is applied the flip-day guard cannot check what this database was ` +
    `written under, so the service refuses to start rather than risk relabelling ` +
    `stored findings.`
  );
}

/**
 * The operator-facing refusal. Names both profiles and the only supported
 * action, because there is no migration: adopting a new contract profile
 * discards everything already stored.
 */
export function contractProfileMismatchMessage(stored: Profile, expected: Profile): string {
  return (
    `database was last written under contract profile ${stored}; ` +
    `this build runs contract profile ${expected}. ` +
    `Adopting a new contract profile discards all stored data: stop the service, ` +
    `discard the database volume (docker compose down -v), and start again. ` +
    `There is no migration.`
  );
}

/**
 * Run the boot check: read the marker, stamping it when absent. Returns what it
 * found rather than exiting, so it is testable without booting Fastify; the
 * caller (src/index.ts) is what refuses to start on `mismatch`.
 */
export async function assertContractProfile(
  db: Queryable = getPool(),
): Promise<ContractProfileCheck> {
  const expected = CONTRACT_PROFILE;

  let stored: Profile | null;
  try {
    stored = await readContractMarker(db);
  } catch (err) {
    // A missing marker table is a verdict, not an outage: this database predates
    // db/initdb/80 and the guard cannot run over it. Report it as an outcome so
    // the caller refuses to start. Every other failure — connection refused,
    // timeout, auth — is transient and still propagates to the caller's
    // fail-open branch.
    if (isMissingMarkerTable(err)) {
      return { outcome: 'missing-table', stored: null, expected };
    }
    throw err;
  }

  if (stored === null) {
    await writeContractMarker(expected, db);
    return { outcome: 'fresh', stored: null, expected };
  }
  return { outcome: stored === expected ? 'match' : 'mismatch', stored, expected };
}
