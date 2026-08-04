/**
 * `npm run exercise` — the live-instance runner for the conformance exercise
 * suite (8qa.2; epic 8qa "Runner").
 *
 * NEEDS A RUNNING VALIDATOR. This is deliberately NOT part of `npm test`'s glob:
 * it mints a real session and POSTs real transmissions at a deployed (or local
 * `npm run dev`) instance. What CI checks instead are the pure halves — the case
 * table's directions (../cases.test.ts), the assertion logic (./assertions.test.ts)
 * and the coverage join (./coverage.test.ts) — which share these exact case
 * definitions, so the two cannot drift apart.
 *
 *   npm run exercise                       # http://localhost:3000
 *   npm run exercise -- https://host       # explicit target
 *   EXERCISE_BASE_URL=https://host npm run exercise
 *
 * WHAT IT PRINTS is a verdict list, run counts, the coverage gaps, and the
 * DASHBOARD URL of the session it just filled. The dashboard is the detailed
 * human-readable report (epic 8qa: "the main human-readable report is the
 * validator UI itself"); this output is a summary, not a second report.
 *
 * SYNTHETIC DATA ONLY (DESIGN.md): every byte sent comes from the exercise
 * baseline + transform vocabulary. Nothing here reads real CCE data.
 *
 * ── §1.3 auth setup, and why the order is what it is (ke6) ──────────────────
 * A §1.3 case cannot be expressed as POSTs alone: the SESSION must first opt into
 * auth and hand the runner its show-once credential. Cases say so declaratively
 * (`setup: 'auth-enabled'`, ../case.ts) and {@link runExercise} honors it.
 *
 * Enabling auth is STICKY and session-global — `auth_enabled` lives on the
 * session row, and from then on the ingest pipeline's auth stage 401s every POST
 * that does not carry the credential, before the body/schema/semantic stages run
 * (src/ingest/stages/auth.ts). An ordinary case played after that would collapse
 * to a 401 and miss every finding it expects.
 *
 * So the runner PARTITIONS rather than toggles: every case without a setup is
 * played first, auth is enabled once, then the `auth-enabled` cases are played,
 * and auth is left on when the run ends. Authors are therefore free to put a
 * §1.3 case anywhere in the table (the transport table's natural place is between
 * §1.2 and §1.4), and the disable route — `DELETE /api/sessions/{uuid}/auth`,
 * which exists and works — is deliberately NOT used: one transition per run is
 * fewer moving parts than one per case, and the end state honestly shows the
 * dashboard reader that §1.3 was exercised.
 *
 * ── a known limit, for 8qa.5 ────────────────────────────────────────────────
 * §2.1 serial delivery still cannot be exercised: it needs two POSTs genuinely IN
 * FLIGHT at once, which a sequential player cannot produce. That is a per-CASE
 * concern too ("these POSTs go out concurrently"), and the setup field is the
 * obvious place to grow — but do not add it until the bite that needs it.
 */

import { COMPLIANCE_MATRIX } from '../../api/compliance-matrix.js';
import { materializeCase, requiresAuthEnabled, type ExerciseCase } from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import type { TransportContext } from '../transforms/transport.js';
import {
  judgeCase,
  tally,
  type CaseVerdict,
  type FindingsByTransmission,
  type PostOutcome,
} from './assertions.js';
import {
  ExerciseHttpError,
  createExerciseSession,
  enableBearerAuth,
  fetchFindingsByTransmission,
  normalizeBaseUrl,
  playPost,
  type SessionHandle,
} from './client.js';
import { computeCoverage, formatCoverage } from './coverage.js';

const DEFAULT_BASE_URL = 'http://localhost:3000';

const USAGE = `Usage: npm run exercise [-- <base-url>]

Plays the CCE conformance exercise suite against a RUNNING validator instance,
then prints a per-case verdict, run counts, the requirement-coverage report and
the dashboard URL of the session it created (that dashboard is the detailed
report). Sends synthetic data only.

  <base-url>   target origin (default ${DEFAULT_BASE_URL}, or $EXERCISE_BASE_URL)

Exit codes: 0 all cases passed · 1 a case failed · 2 could not run.`;

/** Resolve the target origin: CLI argument, then env, then localhost. */
export function resolveBaseUrl(argv: readonly string[], env: Record<string, string | undefined>) {
  const positional = argv.find((arg) => !arg.startsWith('-'));
  return normalizeBaseUrl(positional ?? env.EXERCISE_BASE_URL ?? DEFAULT_BASE_URL);
}

/**
 * Play every POST of one case, in declaration order, against the session. The
 * POSTs of a case are sequential and so are the cases: order is load-bearing for
 * the sequence heuristics (§1.8 sees the earlier transmission of the same
 * session), and the §2.1 concurrency case that would want otherwise is not
 * expressible here yet (see the module header).
 */
async function playCase(
  baseUrl: string,
  session: SessionHandle,
  kase: ExerciseCase,
  transport: TransportContext,
): Promise<PostOutcome[]> {
  const outcomes: PostOutcome[] = [];
  for (const post of materializeCase(kase, { transport })) {
    const result = await playPost(baseUrl, session.ingestUrl, post.request);
    outcomes.push({
      label: post.label,
      expectedStatus: post.expectedStatus,
      status: result.status,
      transmissionId: result.transmissionId,
    });
  }
  return outcomes;
}

/** A table split into the order it must be PLAYED in. */
export interface PlayOrder {
  /** Cases needing nothing but a minted session, in table order. */
  readonly plain: readonly ExerciseCase[];
  /** Cases needing §1.3 auth enabled, in table order — played after `plain`. */
  readonly authed: readonly ExerciseCase[];
}

/**
 * Split the table so the §1.3 cases go last. Pure and exported for its test: the
 * ordering is load-bearing (see the module header — enabling auth is sticky, so a
 * plain case played afterwards would 401), and it must hold however the case
 * files happen to be concatenated.
 */
export function planPlayOrder(cases: readonly ExerciseCase[]): PlayOrder {
  return {
    plain: cases.filter((kase) => !requiresAuthEnabled(kase)),
    authed: cases.filter(requiresAuthEnabled),
  };
}

/** Everything one run produced. */
export interface RunResult {
  readonly session: SessionHandle;
  readonly verdicts: readonly CaseVerdict[];
}

/**
 * Create a session, play the table, then read the findings back ONCE and judge
 * every case against them. The read happens after the whole table has been
 * played rather than per case: findings are attributed by transmission id, so a
 * single read is both cheaper and immune to any ordering surprise.
 *
 * Auth-requiring cases are played LAST, after a single opt-in — see the module
 * header for why enabling §1.3 auth cannot be undone case by case here. A table
 * with no such case never calls the auth route at all, so the zero-friction
 * default run is unchanged.
 */
export async function runExercise(
  baseUrl: string,
  cases: readonly ExerciseCase[] = EXERCISE_CASES,
): Promise<RunResult> {
  const session = await createExerciseSession(baseUrl);
  const { plain, authed } = planPlayOrder(cases);

  const outcomesByCase = new Map<string, PostOutcome[]>();

  // Phase 1: auth is off, so every POST reaches the pipeline uncredentialed.
  for (const kase of plain) {
    outcomesByCase.set(kase.id, await playCase(baseUrl, session, kase, {}));
  }

  // Phase 2: opt the session in ONCE, then play the §1.3 cases with the
  // show-once credential in the transport context (`bearerCredential()` reads it;
  // `noAuth()`/`badAuth()` deliberately do not).
  if (authed.length > 0) {
    const transport: TransportContext = {
      credential: await enableBearerAuth(baseUrl, session.uuid),
    };
    for (const kase of authed) {
      outcomesByCase.set(kase.id, await playCase(baseUrl, session, kase, transport));
    }
  }

  const findings: FindingsByTransmission = await fetchFindingsByTransmission(baseUrl, session.uuid);

  const verdicts = cases.map((kase) =>
    judgeCase(kase, outcomesByCase.get(kase.id) ?? [], findings),
  );
  return { session, verdicts };
}

/** Render the run as printable lines. Pure, so the shape is easy to eyeball. */
export function formatRun(
  baseUrl: string,
  result: RunResult,
  cases: readonly ExerciseCase[],
): string[] {
  const totals = tally(result.verdicts);
  const lines: string[] = [];

  for (const verdict of result.verdicts) {
    lines.push(`${verdict.ok ? 'ok  ' : 'FAIL'} ${verdict.caseId}`);
    for (const failure of verdict.failures) lines.push(`       ${failure}`);
  }

  lines.push('');
  lines.push(
    `${totals.cases} case(s) · ${totals.casesPassed} passed · ${totals.casesFailed} failed`,
  );
  lines.push(
    `${totals.posts} POST(s) · ${totals.accepted} accepted (2xx) · ${totals.rejected} rejected`,
  );
  lines.push('');
  lines.push(...formatCoverage(computeCoverage(cases, COMPLIANCE_MATRIX)));
  lines.push('');
  lines.push(`report: ${baseUrl}${result.session.dashboardUrl}`);
  return lines;
}

/** CLI entry: resolve the target, run, print, and set the exit code. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl(argv, env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 2;
  }

  console.log(`exercising ${baseUrl} — ${EXERCISE_CASES.length} case(s), synthetic data only`);

  let result: RunResult;
  try {
    result = await runExercise(baseUrl);
  } catch (err) {
    // A target that is down/wrong is an OPERATOR problem, not a suite failure:
    // say what to fix, and never let it read as "the validator failed a case".
    if (err instanceof ExerciseHttpError) {
      console.error(`\ncould not run the exercise suite.\n${err.message}`);
      return 2;
    }
    throw err;
  }

  for (const line of formatRun(baseUrl, result, EXERCISE_CASES)) console.log(line);
  return result.verdicts.every((verdict) => verdict.ok) ? 0 : 1;
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 2;
    });
}
