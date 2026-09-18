/**
 * Ingest pipeline framework (DESIGN.md §6).
 *
 * Each `POST /i/{uuid}` runs an ordered list of {@link Stage}s. A stage either
 * **continues** (optionally pushing one or more findings onto `ctx.findings`) or
 * **halts** with an HTTP status (the §6 short-circuit codes). The runner stops
 * at the first halt and reports the final status + accumulated findings.
 *
 * THE SHARED CONTRACT. Subagents B and C fill the per-stage stub bodies under
 * `src/ingest/stages/*.ts` WITHOUT editing this file. {@link PipelineContext} is
 * deliberately over-provisioned so every stage has a slot to read/write and no
 * one needs to widen the type. Treat the shapes below as frozen.
 */

import type { FastifyRequest } from 'fastify';

import type { InsertFindingInput, Severity } from '../db/repository.js';
import { PROFILE_VOCABULARY } from '../profile-vocabulary.js';
import { CONTRACT_PROFILE } from '../schema-registry.js';
import type { Profile, RegistryEntry, SchemaRegistry } from '../schema-registry.js';
import { isAdvisoryId } from './stages/semantic/advisory.js';

/**
 * One finding accumulated as the pipeline runs. Shape matches
 * {@link InsertFindingInput} EXCEPT for `profile`, which is optional here and
 * required there (by1c.50): only the schema stage knows which lineage it graded,
 * so a transport or semantic stage emits a finding with no profile at all.
 *
 * Resolving that absence is the job of exactly one place — {@link stampProfiles},
 * called at the grading/storage boundary in `src/ingest/route.ts` just before
 * `insertFindings`. The storage layer itself carries no default.
 */
export type Finding = Omit<InsertFindingInput, 'profile'> & { profile?: Profile };

export type { Severity };

/**
 * Transmission `meta.*` fields lifted from the parsed body (DESIGN.md §3.1, §8).
 * Populated by the schema/semantic stages once the body parses; every field is
 * nullable because earlier stages (and parse failures) leave them unset.
 */
export interface IngestMeta {
  transferId?: string | null;
  transferSrc?: string | null;
  transferType?: string | null;
  /** Raw `meta.schemaVersion` as sent (pre-normalization). */
  schemaVersion?: string | null;
}

/**
 * Mutable context threaded through every stage. Over-provisioned on purpose:
 * stages read what they need and write their slot; nobody widens this type.
 */
export interface PipelineContext {
  /** The Fastify request (headers, params, protocol, raw body). */
  readonly request: FastifyRequest;
  /** Session UUID from the `/i/:uuid` path param. */
  readonly sessionUuid: string;
  /** Exact wire bytes as sent (DESIGN.md §4.1). Empty Buffer if no body. */
  readonly rawBody: Buffer;
  /** The compiled, content-pinned schema registry (from `app.schemaRegistry`). */
  readonly registry: SchemaRegistry;

  /** Findings accumulate here; the runner never clears them. */
  readonly findings: Finding[];

  /** Parsed JSON payload; set by the parse stage (stage 6). null until then. */
  parsedBody: unknown;
  /** Transmission `meta.*`, filled by the schema/semantic stages. */
  meta: IngestMeta;
  /** Normalized MAJOR.MINOR.PATCH schema version; null until resolved. */
  normalizedSchemaVersion: string | null;
  /**
   * The requirement lineage this transmission is GRADED against — the profile of
   * the registry entry `meta.schemaVersion` resolved to. Set by the schema stage
   * (7); null until then, and still null after it when the version was missing
   * or unsupported, because an unresolved version names no lineage.
   */
  primaryProfile: Profile | null;
  /**
   * The lineage graded in SHADOW alongside it — the current entry of the other
   * lineage, per `registry.shadowFor()`. Its findings are recorded but never
   * affect the response. Null when no shadow ran (see `primaryProfile`, or a
   * registry with only one lineage).
   */
  shadowProfile: Profile | null;

  /** `Content-Type` request header (as sent), or null if absent. */
  contentType: string | null;
  /** `Content-Encoding` request header (as sent), or null if absent. */
  contentEncoding: string | null;

  /** True once the body parsed as JSON (stage 6). null until parse runs. */
  parseOk: boolean | null;
  /** True once the body validated against its schema (stage 7). null until then. */
  schemaOk: boolean | null;
}

/**
 * The result of running one stage.
 *   - `continue` — proceed to the next stage (findings, if any, already pushed).
 *   - `halt`     — short-circuit the pipeline with `status` as the HTTP code.
 */
export type StageOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'halt'; readonly status: number };

/** A pipeline stage: inspects/mutates `ctx`, returns its outcome. */
export interface Stage {
  /** Stable name for logging/ordering (e.g. 'session', 'method', 'parse'). */
  readonly name: string;
  run(ctx: PipelineContext): Promise<StageOutcome> | StageOutcome;
}

/** Convenience: a stage that continues. */
export const CONTINUE: StageOutcome = { kind: 'continue' };

/** Convenience: build a halt outcome with the given HTTP status. */
export function halt(status: number): StageOutcome {
  return { kind: 'halt', status };
}

/**
 * Push a finding onto the context and continue. Sugar for the common
 * "record a finding, keep going" case so stage bodies stay terse.
 */
export function record(ctx: PipelineContext, finding: Finding): StageOutcome {
  ctx.findings.push(finding);
  return CONTINUE;
}

/**
 * Default success status when no stage halts. DESIGN.md §6 makes `200` the
 * SINGLE success status — `202` is not used.
 */
export const DEFAULT_SUCCESS_STATUS = 200;

/** The outcome of a full pipeline run. */
export interface PipelineResult {
  /** Final HTTP status: the first halt's status, else {@link DEFAULT_SUCCESS_STATUS}. */
  readonly status: number;
  /** All findings accumulated across the stages that ran. */
  readonly findings: readonly Finding[];
  /** Name of the stage that halted, or null if every stage continued. */
  readonly haltedAt: string | null;
}

/**
 * Run `stages` in order against `ctx`, stopping at the first halt. Findings
 * accumulate on `ctx.findings` throughout (even from the halting stage, which
 * may push a teaching finding before short-circuiting). The §6 status-code
 * mapping lives in the stages themselves — they return the code; the runner
 * just surfaces the first one.
 */
export async function runPipeline(
  ctx: PipelineContext,
  stages: readonly Stage[],
): Promise<PipelineResult> {
  for (const stage of stages) {
    const outcome = await stage.run(ctx);
    if (outcome.kind === 'halt') {
      return { status: outcome.status, findings: ctx.findings, haltedAt: stage.name };
    }
  }
  return { status: DEFAULT_SUCCESS_STATUS, findings: ctx.findings, haltedAt: null };
}

/**
 * One finding as echoed in the HTTP response body — the human-readable subset of
 * a {@link Finding} (`requirement`, `severity`, `summary`, `detail`) plus the
 * lineage that graded it. The internal `pointer` is omitted; suppliers read the
 * per-error location from `detail`, and the full finding (with pointer) is
 * persisted for the dashboard.
 */
export interface ResponseFinding {
  requirement: string;
  severity: Severity;
  /**
   * The requirement lineage this finding graded against (bd by1c.27). Until it
   * was carried here, a supplier whose payload conforms to the contract read
   * `severity: 'fail'` on an HTTP 200 with nothing but the clause numbering to
   * tell them the finding came from an unpublished draft. Present on every
   * entry, advisories included, so the body can be filtered without parsing
   * clause ids.
   */
  profile: Profile;
  /**
   * The one-line OBSERVATION, on advisories that carry one (agj.17). Echoed here
   * because this body is a teaching surface (see below): an integrator who never
   * opens the dashboard should read the same one-liner the advisory row shows,
   * with `detail` beneath it as the rationale.
   *
   * OMITTED, not null, wherever there is none — on every graded finding, which
   * carries its explanation in `detail` alone, and on an advisory whose copy has
   * not been split yet. A key that appears only when it says something keeps the
   * body readable for the integrator this echo exists for.
   */
  summary?: string | null;
  /** Human-readable explanation; absent only if a finding carried no detail. */
  detail?: string | null;
}

/**
 * The small JSON body returned on success/short-circuit (DESIGN.md §6).
 *
 * This body is a TEACHING SURFACE: a supplier should understand the outcome from
 * the HTTP response alone, without opening the dashboard (§6). So beyond the
 * persisted `transmissionId` and HTTP `status`, it carries:
 *   - `message` — a one-line human summary ("Accepted: …" / "Rejected (NNN): …")
 *     including a fail/info breakdown so the headline result is self-explanatory.
 *   - `findings` — the COUNT of findings that GRADE this transmission (kept from
 *     the original shape).
 *   - `findingDetails` — the per-finding `{requirement, severity, detail}` echo,
 *     so every recorded observation is readable straight from the response.
 *   - `advisories` — the same echo for the `adv.*` findings, in a field of their
 *     own (see below).
 *   - `notice` — the standing synthetic-data-only warning (§2/§12).
 *
 * ADVISORIES ARE SEPARATE, NOT COUNTED (7rv; DESIGN §7.1). An advisory never
 * changes a requirement's status, so it must not appear in the one number a
 * supplier reads as the outcome either: `findings`, `findingDetails` and the
 * `message` tally are GRADED findings only — exactly what the dashboard's
 * verdict cell does (`findingsCell`, src/web/components/TransmissionsCard.tsx),
 * for the same reason: letting one inflate "N findings, none failed" hands a
 * 100 %-conformant transmission a number to explain. They are carried rather
 * than dropped because this body is the teaching surface for an integrator who
 * never opens the dashboard — the browser puts them in their own Advisories
 * block, and this puts them in their own field.
 *
 * THE SHADOW LINEAGE IS LISTED, NOT COUNTED (by1c.8). Since bd by1c.6 every
 * transmission is graded a second time against the DS01.3 Annex 4 draft. Those
 * findings never move the HTTP status, so they must not move the one number a
 * supplier reads as the outcome either: `findings` and the `message` tally are
 * CONTRACT-lineage findings only, on the same reasoning that excludes advisories.
 * They ARE echoed in `findingDetails`, because a preview of the next revision is
 * exactly the kind of thing the teaching surface exists to deliver — which is why
 * `findingDetails` can be longer than `findings` counts.
 *
 * AND THE LINEAGE IS NAMED (by1c.27). Listing a draft's failures under an HTTP
 * 200 without saying so left the clause numbering (`3.2` is cce-interop, `5.3.x`
 * is Annex 4) as the only discriminator, which a supplier holding the March 2025
 * document cannot read. Two additions close that: every echoed finding carries
 * its `profile`, and `message` gains a trailing sentence naming the shadow
 * lineage — by its draft date and content hash, read off the registry entry —
 * whenever a shadow run happened, in both directions (findings echoed, or a
 * clean pass). Nothing is appended when no shadow ran at all.
 */
export interface IngestResponseBody {
  /** Persisted transmission id, or null when no row was written (404/405). */
  transmissionId: string | null;
  status: number;
  /** One-line human summary of the outcome (teaching surface, §6). */
  message: string;
  /**
   * Count of the findings that GRADE this transmission — advisories excluded
   * (§7.1) and shadow-lineage findings excluded (by1c.8). May be smaller than
   * `findingDetails.length`; see the shadow note above.
   */
  findings: number;
  /**
   * Per-finding human-readable echo of the graded findings (no advisories),
   * BOTH lineages — the contract findings that produced the status and the
   * shadow findings that preview DS01.3. Each entry names its own `profile`, so
   * the two are separable without reading clause numbers.
   */
  findingDetails: ResponseFinding[];
  /**
   * The advisories raised on this transmission, same echo shape. Never counted
   * in `findings` and never listed in `findingDetails`; empty on the vast
   * majority of transmissions and on every pre-body halt.
   */
  advisories: ResponseFinding[];
  /**
   * Standing sandbox warning (dkz.1). Receiving real production data is an
   * explicit non-goal (DESIGN §2) and the capability-URL design is only safe
   * under that constraint (DESIGN §12) — so the teaching surface says so on
   * every response, not just in the UI the integrator may never open.
   */
  notice: string;
}

/**
 * The synthetic-data-only warning echoed on every ingest response. Wording is
 * kept in step with the web UI notice (`src/web/components/ui/SyntheticDataNotice.tsx`).
 */
export const SYNTHETIC_DATA_NOTICE =
  'Synthetic test data only: this is a sandbox endpoint. Never send real CCE data or PII — ' +
  'the endpoint URL is a bearer capability that anyone holding it can read.';

/**
 * Whether a finding is an advisory rather than a graded §7 observation. Keyed
 * off the `adv.*` namespace via {@link isAdvisoryId} — the one definition of
 * what an advisory is — checking `requirement` first because that is the field
 * the §7 matrix and the dashboard both key off; `code` is checked too so a
 * hand-built advisory that only set one of them can never slip into the tally.
 */
function isAdvisoryFinding(f: Finding): boolean {
  return isAdvisoryId(f.requirement) || isAdvisoryId(f.code);
}

/** True for the HTTP 2xx status range (success — the data was accepted). */
function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The lineage a finding grades against, as the response reports it. A finding
 * from a transport stage carries no profile at all — only the schema stage
 * stamps one — so "absent" has to resolve to something, and it resolves to the
 * CONTRACT lineage: a §1.x transport obligation or a §3.3 semantic check grades
 * against the contract in force, whichever lineage that is.
 *
 * Written as `CONTRACT_PROFILE` rather than as the literal `'2025'` so the flip
 * stays one constant change. With the literal, the day the contract moves to
 * `'ds013'` every unstamped finding would be echoed under the SHADOW lineage and
 * dropped from {@link isContractFinding}'s count — the number a supplier reads
 * as the outcome (bd by1c.31).
 */
export function profileOf(f: Finding): Profile {
  return f.profile ?? CONTRACT_PROFILE;
}

/**
 * Stamp an explicit profile onto every finding on the way into storage — THE one
 * default in the system (by1c.50). The repository requires `profile` and applies
 * no fallback, so this is where an unstamped transport or semantic finding
 * acquires the contract lineage, on exactly the reasoning {@link profileOf} gives.
 *
 * Keeping the stamp here rather than in the repository means the wire (the
 * response body) and the stored row resolve absence through the same function,
 * so the day `CONTRACT_PROFILE` flips they cannot disagree (bd by1c.31).
 */
export function stampProfiles(findings: readonly Finding[]): InsertFindingInput[] {
  return findings.map((f) => ({ ...f, profile: profileOf(f) }));
}

/**
 * Whether a finding graded against the CONTRACT lineage — the obligations in
 * force.
 */
function isContractFinding(f: Finding): boolean {
  return profileOf(f) === CONTRACT_PROFILE;
}

/**
 * How the trailing sentence names the bytes the shadow run used.
 *
 * Every fact comes from the registry entry, on the same reasoning as the §3.2
 * pass detail (`describePass`, src/ingest/stages/schema.ts): a draft date or a
 * hash restated as a literal here is a second copy that can drift from the bytes
 * actually loaded. Draft-ness is likewise read off the entry — the presence of
 * `draftDate` — because an unpublished proposal and a published schema are not
 * described the same way, and the shadow lineage is whichever one is not the
 * contract today.
 *
 * The lineage is named from the shared vocabulary (bd by1c.32), and both branches
 * take the `longName` — the schema DOCUMENT the bytes come from, which is what
 * this sentence is about: it ends in the sha256 of the file that ran. "The
 * cce-interop 0.8.1 schema" names the artifact family the published filename and
 * `$id` use, and "the DS01.3 Annex 4 draft of 2026-09-08" names the document the
 * proposal lives in. The `name` is the requirement PACKAGE a reader chooses
 * between on the dashboard ("UNICEF Q1 2025", "DS01.3 DRAFT"); it was right here
 * while the short name was "DS01.3", but since tfnv.1 it would put a shouted
 * "DRAFT" next to this sentence's own "draft of". What still differs per branch
 * is what follows the name — a version and "schema" for a published entry, a
 * date for a draft (bd by1c.49). Draft-ness is read off the ENTRY, and so is the
 * profile, never written as a literal — which lineage is the shadow flips with
 * `CONTRACT_PROFILE`.
 */
function describeShadowLineage(entry: RegistryEntry): string {
  const words = PROFILE_VOCABULARY[entry.profile];
  return entry.draftDate === undefined
    ? `the ${words.longName} ${entry.version} schema (sha256 ${entry.sha256})`
    : `the ${words.longName} draft of ${entry.draftDate} (sha256 ${entry.sha256})`;
}

/**
 * Where the shadow lineage's facts are read from: the pipeline context, narrowed
 * to the two fields this needs. {@link PipelineContext} satisfies it structurally,
 * so the route passes `ctx` straight through.
 */
export interface ShadowLineageSource {
  readonly registry: SchemaRegistry;
  readonly shadowProfile: Profile | null;
}

/**
 * The registry entry the shadow run graded against, or null when no shadow ran.
 *
 * `ctx.shadowProfile` is the schema stage's own record of which lineage it
 * shadowed, and it stays null when the version never resolved, when the body
 * never parsed, and on every pre-body transport halt — the three cases where the
 * response must say nothing about a second lineage. The entry itself is the
 * CURRENT one of that profile, which is exactly what `shadowFor()` handed the
 * stage.
 */
function shadowEntryOf(source: ShadowLineageSource | null | undefined): RegistryEntry | null {
  const profile = source?.shadowProfile ?? null;
  if (profile === null) return null;
  const version = source!.registry.currentVersion(profile);
  return version === null ? null : (source!.registry.get(version) ?? null);
}

/**
 * The trailing sentence naming the shadow lineage, or null when there is nothing
 * to say (by1c.27).
 *
 * Both directions are reported. Failures echoed in `findingDetails` get the
 * count plus "did not affect this status", which is the fact a conformant
 * supplier needs to read `severity: 'fail'` on an HTTP 200 without alarm; a
 * clean shadow run — recorded as a single `pass` finding — gets "Also passes",
 * because being ready for the next revision is worth telling someone.
 *
 * The shadow set is matched on the finding's EXPLICIT profile, not on
 * `profileOf`'s default: a transport finding carries no profile, and defaulting
 * it would enrol every one of them in the shadow tally on the day the contract
 * flips and `'2025'` becomes the shadow lineage.
 */
function shadowSentence(entry: RegistryEntry | null, graded: readonly Finding[]): string | null {
  if (entry === null) return null;
  const shadow = graded.filter((f) => f.profile === entry.profile);
  if (shadow.length === 0) return null;

  const lineage = describeShadowLineage(entry);
  if (shadow.every((f) => f.severity === 'pass')) return `Also passes ${lineage}.`;
  const n = shadow.length;
  return `${n} further ${n === 1 ? 'finding' : 'findings'} under ${lineage} did not affect this status.`;
}

/**
 * Compose the one-line teaching summary. Accepted runs lead with "Accepted",
 * short-circuits with "Rejected (NNN)"; both append the finding tally (with a
 * fail/info breakdown when present) so the headline conveys the result alone.
 *
 * `graded` excludes advisories, so the tally reads exactly as it would had none
 * been raised (7rv). Advisories get their own trailing sentence when there are
 * any — never a term inside the tally — echoing the dashboard's own wording
 * ("not graded, and not counted in the findings above", `ADVISORY_COPY`).
 *
 * It excludes SHADOW-lineage findings for the same reason (by1c.8). Since bd
 * by1c.6 a transmission whose declared `schemaVersion` resolves to a registered
 * lineage is also graded against the DS01.3 Annex 4 draft, and those findings
 * never touch the HTTP status; letting them into the one number a supplier reads
 * as the outcome would tell a conformant integrator they had five failures
 * against obligations that do not yet exist. They stay in `findingDetails`, each
 * naming its own profile.
 *
 * `shadow` is that lineage's own trailing sentence, appended LAST (by1c.27) —
 * after the advisory sentence, so both of the "this is outside the tally" notes
 * follow the tally they qualify rather than interrupting it. Null when no shadow
 * run happened.
 */
function summarize(
  status: number,
  graded: readonly Finding[],
  advisories: readonly Finding[],
  shadow: string | null,
): string {
  const contract = graded.filter(isContractFinding);
  const total = contract.length;
  const fails = contract.filter((f) => f.severity === 'fail').length;
  const infos = contract.filter((f) => f.severity === 'info').length;

  const plural = (n: number) => (n === 1 ? 'finding' : 'findings');
  let tally = `${total} ${plural(total)}`;
  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} fail`);
  if (infos > 0) parts.push(`${infos} info`);
  if (parts.length > 0) tally += ` (${parts.join(', ')})`;

  const headline = isAccepted(status)
    ? `Accepted (${status}): data recorded; ${tally}.`
    : `Rejected (${status}): ${tally}.`;

  const sentences = [headline];
  if (advisories.length > 0) {
    const n = advisories.length;
    sentences.push(
      `${n} ${n === 1 ? 'advisory' : 'advisories'}, not graded and not counted above.`,
    );
  }
  if (shadow !== null) sentences.push(shadow);
  return sentences.join(' ');
}

/**
 * Build the small summary body returned to the supplier (DESIGN.md §6 teaching
 * surface). See {@link IngestResponseBody} for the field contract — in
 * particular, advisories are partitioned out of `findings`/`findingDetails` and
 * carried in `advisories` (7rv).
 *
 * `lineages` is the pipeline context (or anything carrying the registry and the
 * shadow profile the run recorded). It is what the trailing shadow sentence is
 * built from; omit it only where no shadow run could have happened, and the body
 * simply says nothing about a second lineage.
 */
export function buildResponseBody(
  status: number,
  findings: readonly Finding[],
  transmissionId: string | null,
  lineages?: ShadowLineageSource | null,
): IngestResponseBody {
  const echo = (f: Finding): ResponseFinding => ({
    requirement: f.requirement,
    severity: f.severity,
    profile: profileOf(f),
    // Spread rather than assigned: `summary` is carried only by an advisory that
    // has one, and an explicit `summary: null` on every graded finding would be
    // noise in a body a supplier reads by eye (agj.17).
    ...(f.summary == null ? {} : { summary: f.summary }),
    detail: f.detail,
  });
  // Partitioned on the id namespace, not on position: findings arrive in stage
  // order, which puts stage-8 advisories at the tail today, but nothing may rely
  // on that (the dashboard's `splitFindings` makes the same point).
  const graded = findings.filter((f) => !isAdvisoryFinding(f));
  const advisories = findings.filter((f) => isAdvisoryFinding(f));

  return {
    transmissionId,
    status,
    message: summarize(status, graded, advisories, shadowSentence(shadowEntryOf(lineages), graded)),
    // Contract lineage only — the count and the message tally agree, and both
    // say what this transmission was graded on (by1c.8).
    findings: graded.filter(isContractFinding).length,
    findingDetails: graded.map(echo),
    advisories: advisories.map(echo),
    notice: SYNTHETIC_DATA_NOTICE,
  };
}
