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
 * ── §2.1 concurrent delivery (8qa.5) ────────────────────────────────────────
 * The limit this header used to record — that §2.1 needs two POSTs genuinely IN
 * FLIGHT at once, which a sequential player cannot produce — is lifted. A case
 * declares `delivery: 'concurrent'` (../case.ts) and {@link playCase} fires its
 * POSTs with `Promise.all` instead of awaiting each one; sequential stays the
 * default and every other case is byte-for-byte unchanged.
 *
 * The two capabilities compose without interacting: `delivery` decides how ONE
 * case's POSTs go out, `setup` decides what the session needs first, and
 * {@link planPlayOrder} still partitions on `setup` alone. Concurrency never spans
 * cases — a case is played to completion before the next starts — so the §2.1 pass
 * cases cannot be poisoned by the fail case's overlap.
 */

import { COMPLIANCE_MATRIX } from '../../api/compliance-matrix.js';
import {
  isConcurrentDelivery,
  materializeCase,
  requiresAuthEnabled,
  type ExerciseCase,
} from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import type { TransportContext, WireRequest } from '../transforms/transport.js';
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
  type IngestResult,
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
 * How a POST is put on the wire. Injected so ./run.test.ts can watch {@link
 * playCase} honor `delivery` without opening a socket; the runner always passes
 * the real {@link playPost}.
 */
export type PostPlayer = (
  baseUrl: string,
  ingestUrl: string,
  request: WireRequest,
) => Promise<IngestResult>;

/**
 * Play every POST of one case against the session, and return one outcome per
 * POST in DECLARATION order (both branches below preserve it — `Promise.all`
 * resolves positionally — because the status assertions are per POST).
 *
 * SEQUENTIAL by default: each POST completes before the next goes out. Order is
 * load-bearing for §1.8, whose duplicate lookup only sees rows that have already
 * persisted, so a replay case must not race itself.
 *
 * CONCURRENT when the case says so: the POSTs are fired together and overlap in
 * flight, which is the only thing that can drive the §2.1 grader's snapshot above
 * 1 (see the `Delivery` doc in ../case.ts for what that grader observes). The cases
 * themselves stay sequential relative to each other either way.
 */
export async function playCase(
  baseUrl: string,
  session: SessionHandle,
  kase: ExerciseCase,
  transport: TransportContext,
  play: PostPlayer = playPost,
): Promise<PostOutcome[]> {
  const posts = materializeCase(kase, { transport });
  const record = (post: (typeof posts)[number], result: IngestResult): PostOutcome => ({
    label: post.label,
    expectedStatus: post.expectedStatus,
    status: result.status,
    transmissionId: result.transmissionId,
  });

  if (isConcurrentDelivery(kase)) {
    const results = await Promise.all(
      posts.map((post) => play(baseUrl, session.ingestUrl, post.request)),
    );
    return posts.map((post, i) => record(post, results[i]!));
  }

  const outcomes: PostOutcome[] = [];
  for (const post of posts) {
    outcomes.push(record(post, await play(baseUrl, session.ingestUrl, post.request)));
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
