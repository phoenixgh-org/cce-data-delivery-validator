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
 * WHAT IT PRINTS is a verdict list, run counts, the advisory copy the instance
 * served, the grading-lens audit, the coverage gaps, and the DASHBOARD URL of the
 * session it just filled. The dashboard is the detailed human-readable report (epic 8qa: "the
 * main human-readable report is the validator UI itself"); this output is a
 * summary, not a second report.
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
import { CONTRACT_PROFILE, PROFILES, type Profile } from '../../schema-registry.js';
import {
  isConcurrentDelivery,
  materializeCase,
  requiresAuthEnabled,
  type ExerciseCase,
} from '../case.js';
import { EXERCISE_CASES } from '../cases.js';
import type { TransportContext, WireRequest } from '../transforms/transport.js';
import {
  auditAdvisoryCopy,
  auditLensRows,
  judgeCase,
  tally,
  type CaseVerdict,
  type CopyAudit,
  type LensAudit,
  type PostOutcome,
} from './assertions.js';
import {
  ExerciseHttpError,
  createExerciseSession,
  enableBearerAuth,
  fetchLensSummary,
  fetchSessionEvidence,
  normalizeBaseUrl,
  playPost,
  type IngestResult,
  type SessionHandle,
} from './client.js';
import { computeCoverage, formatCoverage } from './coverage.js';

const DEFAULT_BASE_URL = 'http://localhost:3000';

const USAGE = `Usage: npm run exercise [-- <base-url>]

Plays the CCE conformance exercise suite against a RUNNING validator instance,
then prints a per-case verdict, run counts, the grading-lens audit, the
requirement-coverage report and the dashboard URL of the session it created (that
dashboard is the detailed report). Sends synthetic data only.

  <base-url>   target origin (default ${DEFAULT_BASE_URL}, or $EXERCISE_BASE_URL)

Exit codes: 0 all cases passed, the advisory copy is clean and the lens agrees ·
1 a case failed, or the advisory-copy or grading-lens audit found a violation ·
2 could not run.`;

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
  /**
   * The run-wide advisory-copy audit (y0w4) — a session-level fact, not a case
   * one. The copy is prose graders may reword, so no case expects a particular
   * summary; what is checked is that every advisory the instance served carries
   * one, carries a rationale, and says neither in defect vocabulary.
   */
  readonly advisoryCopy: CopyAudit;
  /**
   * The GRADING-LENS audit (tfnv.10) — also session-level, and for the same
   * reason: the summary rows are a statement about the whole session, so no case
   * can own them. It checks that the rows the instance serves under the draft
   * package agree with the findings and verdicts it serves beside them.
   */
  readonly lens: LensAudit;
}

/**
 * The package the lens audit reads under: the registered lineage that is not the
 * contract — `ds013` today.
 *
 * Read off the LOCAL registry rather than off the target's `session.shadowProfile`,
 * which would cost a second read before the one being audited. A target that does
 * not know the package answers HTTP 400 and the audit says so as a note, so the
 * two ways of being wrong about it both end in the same honest line rather than
 * in a failed run.
 */
const SHADOW_LENS: Profile | undefined = PROFILES.find((profile) => profile !== CONTRACT_PROFILE);

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

  const evidence = await fetchSessionEvidence(baseUrl, session.uuid);
  const { findings } = evidence;

  // The summary the DRAFT LENS serves, read after the table has been played so
  // the rows cover every transmission the run wrote. `undefined` for a registry
  // with no shadow lineage: there is no second package to read under, which the
  // audit reports the same way it reports a target that does not know the lens.
  const lensRows =
    SHADOW_LENS === undefined ? null : await fetchLensSummary(baseUrl, session.uuid, SHADOW_LENS);

  const verdicts = cases.map((kase) =>
    judgeCase(kase, outcomesByCase.get(kase.id) ?? [], findings),
  );
  // Audited over the SESSION's findings rather than over the verdicts: the copy
  // bar belongs to every advisory the instance served, including ones no case
  // named, and pooling per case would judge a shared advisory twice.
  return {
    session,
    verdicts,
    advisoryCopy: auditAdvisoryCopy(findings),
    lens: auditLensRows(SHADOW_LENS ?? null, lensRows, findings, evidence.verdicts),
  };
}

/**
 * The advisory block: the copy a supplier would actually read, then whatever the
 * audit has to say about it (y0w4).
 *
 * The summary lines are the point. The dashboard is the detailed report, but a
 * run that never shows the prose leaves the operator no way to notice that a
 * well-graded advisory says something wrong — so one line per distinct
 * `(id, summary)` is printed. Distinct, not per occurrence: the same advisory
 * fires on many transmissions of a run with identical wording, and fourteen
 * copies of one sentence would bury the rest of the output.
 *
 * Violations and warnings are separated because they cost different things: a
 * violation fails the run ({@link main}), a warning is a long summary and counts
 * grow with the payload. A note is a fact about the target instance.
 */
function formatAdvisoryCopy(audit: CopyAudit): string[] {
  if (audit.observed === 0) return [];

  const lines: string[] = [];
  lines.push(`advisories — ${audit.observed} finding(s), ${audit.lines.length} distinct`);
  const width = Math.max(...audit.lines.map((line) => line.requirement.length));
  for (const line of audit.lines) {
    lines.push(`  ${line.requirement.padEnd(width)}  ${line.summary ?? '(no summary served)'}`);
  }

  if (audit.violations.length + audit.warnings.length + audit.notes.length > 0) {
    lines.push('');
    lines.push('advisory copy');
    for (const violation of audit.violations) lines.push(`  FAIL  ${violation}`);
    for (const warning of audit.warnings) lines.push(`  warn  ${warning}`);
    for (const note of audit.notes) lines.push(`  note  ${note}`);
  }
  return lines;
}

/**
 * The grading-lens block (tfnv.10): how many rows the draft package served, the
 * rows carrying a failure, and whatever the audit has to say about them.
 *
 * The failing rows are printed with BOTH numbers — the count the summary served
 * and the count the run's own findings fold onto the row — because the two
 * agreeing is the whole claim. A reader who sees `5.1.6  2 fail (folded 2)` can
 * check the page against the run without opening the dashboard, and a
 * disagreement reads as the mismatch it is rather than as one unexplained number.
 */
function formatLensAudit(audit: LensAudit): string[] {
  if (audit.lens === null && audit.notes.length === 0) return [];

  const lines: string[] = [];
  lines.push(
    `grading lens — ${audit.lens ?? 'none'}: ${audit.rows} row(s) served, ` +
      `${audit.failing.length} carrying a failure`,
  );
  const width = Math.max(1, ...audit.failing.map((row) => row.requirement.length));
  for (const row of audit.failing) {
    lines.push(
      `  ${row.requirement.padEnd(width)}  ${row.served} fail (folded ${row.folded}) ` +
        `from ${new Set(row.transmissions).size} transmission(s)`,
    );
  }
  for (const violation of audit.violations) lines.push(`  FAIL  ${violation}`);
  for (const note of audit.notes) lines.push(`  note  ${note}`);
  return lines;
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
  const advisoryLines = formatAdvisoryCopy(result.advisoryCopy);
  if (advisoryLines.length > 0) {
    lines.push('');
    lines.push(...advisoryLines);
  }
  const lensLines = formatLensAudit(result.lens);
  if (lensLines.length > 0) {
    lines.push('');
    lines.push(...lensLines);
  }
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
  // An advisory-copy violation fails the run on its own, even with every case
  // green (y0w4). The copy is part of what the service delivers, and a run that
  // exited 0 while printing an advisory with no summary would be reporting the
  // gap to nobody. A lens disagreement fails it for the same reason (tfnv.10):
  // the numbers a supplier reads under the draft package are part of what is
  // delivered, and every case can pass while the page adds them up wrongly.
  const ok =
    result.verdicts.every((verdict) => verdict.ok) &&
    result.advisoryCopy.violations.length === 0 &&
    result.lens.violations.length === 0;
  return ok ? 0 : 1;
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
