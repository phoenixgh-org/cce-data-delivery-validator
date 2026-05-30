/**
 * Stage 0 — session lookup (DESIGN.md §6 row 0: "UUID exists & not expired").
 *
 * Resolves the path-param UUID against the `session` table. A missing session
 * short-circuits with **404** and NO transmission row is persisted (the route
 * only persists once a request reaches the body stages with a valid session).
 *
 * On success we stamp `last_post_at` (DESIGN.md §11: drives the 30-day
 * inactivity sweep) and continue.
 *
 * NOTE on "not expired": the v1 `session` schema (db/initdb/10-session.sql) has
 * NO expiry column — retention is an out-of-band sweep that DELETEs stale rows,
 * so an expired session simply does not exist by the time a POST arrives. Thus
 * "exists == valid" here; there is no in-row expiry check to perform. If an
 * expiry column is ever added, gate the 404 on it in this stage.
 */

import type { Queryable } from '../../db/repository.js';
import { bumpLastPostAt, getSession } from '../../db/repository.js';
import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';

/**
 * Build the stage. `db` is injectable so the route can run stage 0 + the
 * terminal persist on the same checked-out client / transaction if desired;
 * defaults to the shared pool.
 */
export function sessionStage(db?: Queryable): Stage {
  return {
    name: 'session',
    async run(ctx: PipelineContext): Promise<StageOutcome> {
      const session = await getSession(ctx.sessionUuid, db);
      if (!session) {
        // Unknown (or already-purged/expired) session → 404, no row persisted.
        return halt(404);
      }
      // Successful lookup: stamp activity for the retention sweep (§11).
      await bumpLastPostAt(ctx.sessionUuid, db);
      return CONTINUE;
    },
  };
}
