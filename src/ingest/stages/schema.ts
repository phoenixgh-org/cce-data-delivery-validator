/**
 * Stage 7 — schema validate (DESIGN.md §6 row 7, §3.1/§3.2, §6.1; registry §9).
 *
 * Runs ONLY when the parse stage (6) succeeded. The parsed JSON body is graded
 * TWICE — once under each registered lineage — because a supplier holding the
 * March 2025 contract will be asked to move to DS01.3 and should be able to see
 * the gap before it becomes binding (bd by1c, Concept D):
 *
 *   PRIMARY  the lineage `meta.schemaVersion` resolves to. Drives the HTTP
 *            status exactly as it always has: a failure halts 422.
 *   SHADOW   `registry.shadowFor(primary)` — the current entry of the OTHER
 *            lineage. Its findings are recorded and never affect the status,
 *            never halt, and are recorded even when the primary run halts,
 *            because grading both profiles is the point; only the response code
 *            is primary-only.
 *
 * NUMBERING FOLLOWS THE VALIDATOR'S PROFILE, NOT ITS ROLE. Which lineage
 * produced a finding is what decides the clause it is filed under, so the same
 * validator numbers its findings the same way whether it ran as primary or as
 * shadow. Role decides only the status and the halt.
 *
 *   ATTRIBUTION RULE (also DESIGN.md §6.1)
 *   - a finding from a `cce-interop` (profile `2025`) validator is §3.2;
 *   - a finding from the Annex 4 (profile `ds013`) validator is clause 5.3.2
 *     ("validates against Annex 4"), EXCEPT where its `instancePath` addresses
 *     the transmission metadata block (`/meta` or below), which is clause 5.3.3
 *     (transmission metadata: the `transferredAt` Z pattern, the `transferType`
 *     enum, minLength on the identifiers). This is why the DS01.3 5.3.3 duties
 *     need no semantic branch of their own — the Annex 4 pattern on
 *     `/meta/transferredAt` already rejects a UTC offset.
 *
 * The stage:
 *
 *   1. Lifts `meta.{transferId,transferSrc,transferType,schemaVersion}` onto
 *      `ctx.meta` so the persist step records what the supplier SENT — even when
 *      validation then fails. (Stage 6 owns only `parsedBody`/`parseOk`; this
 *      stage owns `ctx.meta.*`, `ctx.normalizedSchemaVersion`, `ctx.schemaOk`,
 *      and `ctx.primaryProfile`/`ctx.shadowProfile`.)
 *   2. Resolves the version via `ctx.registry.lookup(raw)` (normalize → exact
 *      match, no fuzzy fallback). A missing/non-string `schemaVersion`, or an
 *      unsupported version, is a §3.2 fail that lists the accepted versions and
 *      halts **422** — unchanged, and with NO shadow run: without a resolved
 *      entry there is no primary lineage, so there is no other lineage to be the
 *      shadow of, and both profile slots stay null.
 *   3. On a known version, runs that entry's compiled Ajv validator. Each Ajv
 *      error becomes ONE fail finding carrying the error's JSON Pointer and the
 *      clause the attribution rule gives it; the stage sets `ctx.schemaOk =
 *      false` and halts **422**.
 *   4. A clean validation sets `ctx.schemaOk = true` and records a pass finding
 *      citing the content-pinned sha256 (the §9 provenance surface). An entry
 *      that carries a `draftDate` is named as a DRAFT rather than as official —
 *      "official" is a claim about published bytes, and the Annex 4 entry is an
 *      unpublished proposal.
 *   5. Runs the shadow validator over the same parsed body, recording its errors
 *      (or its own single pass finding) with `profile` set to the shadow
 *      lineage. Two translations apply to the shadow run only, both as exported
 *      pure functions so the primary run can adopt them later (bd bt8o):
 *      container-keyword suppression and null-explanation collapsing.
 *
 * Pointer mapping: Ajv `instancePath` is already an RFC-6901 JSON Pointer, which
 * we surface verbatim as the finding `pointer`. Ajv emits '' (empty) for a
 * root-level failure (e.g. a missing top-level `meta`/`data`); we keep the
 * pointer as null in that case (a JSON Pointer of '' addresses the whole
 * document and reads as "no pointer" in the dashboard) and still spell out
 * "(root)" in the human-readable `detail`.
 *
 * Defensive precondition: if `parseOk !== true` or there is no `parsedBody`, the
 * parse stage already halted 400 — but should this stage somehow run without a
 * parsed body, there is nothing to validate, so it continues without touching
 * `ctx.schemaOk`.
 */

import type { ErrorObject } from 'ajv';

import type { Profile, RegistryEntry } from '../../schema-registry.js';
import {
  CONTINUE,
  halt,
  type PipelineContext,
  type Stage,
  type StageOutcome,
} from '../pipeline.js';

/** Normalize an Ajv `instancePath` ('' at root) to a finding pointer. */
function toPointer(instancePath: string): string | null {
  return instancePath === '' ? null : instancePath;
}

/**
 * The clause one validator's finding is filed under — see the ATTRIBUTION RULE
 * in the module header. `instancePath` is an Ajv instance path, so the metadata
 * block is addressed exactly as `/meta` or `/meta/...`; matching on the segment
 * rather than the bare prefix keeps a future sibling property that merely starts
 * with those four characters out of 5.3.3.
 */
export function clauseFor(profile: Profile, instancePath: string): string {
  if (profile !== 'ds013') return '3.2';
  return instancePath === '/meta' || instancePath.startsWith('/meta/') ? '5.3.3' : '5.3.2';
}

/** Build a readable detail string for one Ajv error, filed under `clause`. */
function describeError(err: ErrorObject, clause: string): string {
  const where = err.instancePath === '' ? '(root)' : err.instancePath;
  const message = err.message ?? 'is invalid';
  return `schema violation at ${where}: ${message} (§${clause})`;
}

/**
 * How a clean run names the bytes it validated against. A published entry is
 * "official"; an entry carrying a `draftDate` is an unpublished proposal and is
 * named a DRAFT with that date, because calling a draft official would be a
 * false statement about its standing (bd by1c.21).
 */
function describePass(entry: RegistryEntry, clause: string): string {
  const provenance =
    entry.draftDate === undefined
      ? `official ${entry.version} (sha256 ${entry.sha256})`
      : `DRAFT ${entry.version} (draft ${entry.draftDate}, sha256 ${entry.sha256})`;
  return `validated against ${provenance} (§${clause})`;
}

/**
 * Ajv keywords that COMBINE subschemas rather than assert anything of their own.
 *
 * An error on one of these carries no location a supplier can act on — Ajv
 * reports `if` at the document root with `params.failingKeyword: 'then'`, and
 * `oneOf` at the record that failed it — so surfacing them alongside the leaf
 * errors underneath adds a readiness reason that reads "if at (root)" and names
 * no defect. The leaf errors beneath them are kept and say the actual thing.
 *
 * Exported as a predicate because BOTH runs suppress them: the shadow run
 * adopted it first (bd by1c.6), and bd bt8o extended it to the primary §3.2 /
 * 5.3.2 run, which carried the same noise. A failure consisting only of
 * container errors still reports — see the guard in {@link schemaStage}.
 */
export function isContainerError(err: ErrorObject): boolean {
  return (
    err.keyword === 'if' ||
    err.keyword === 'then' ||
    err.keyword === 'else' ||
    err.keyword === 'oneOf' ||
    err.keyword === 'anyOf' ||
    err.keyword === 'allOf'
  );
}

/** The data objects that can discharge the duty to explain a null reading. */
const EXPLAINER_OBJECTS = new Set(['LERR', 'EERR']);

/** Last segment of a JSON Pointer, or null for the root pointer. */
function lastSegment(pointer: string): string | null {
  if (pointer === '') return null;
  const at = pointer.lastIndexOf('/');
  return at === -1 ? null : pointer.slice(at + 1);
}

/**
 * Does `instancePath` address `record` itself, or something inside it?
 *
 * Matched on the segment boundary rather than as a bare string prefix, the same
 * treatment clauseFor() gives `/meta`: without it `/data/0/records/10/LERR`
 * counts as being inside `/data/0/records/1`, and a tenth record's explainer
 * would stand as evidence about the second one (bd by1c.24).
 */
function withinRecord(record: string, instancePath: string): boolean {
  return instancePath === record || instancePath.startsWith(`${record}/`);
}

/**
 * One record's unexplained null reading, recovered from the Ajv errors of a
 * failed record-level `oneOf`. Carries the errors it stands for so the caller
 * can drop them rather than report the same fact three times.
 */
export interface NullExplanation {
  /** JSON Pointer to the RECORD, e.g. `/data/0/records/1`. */
  readonly pointer: string;
  /** The data object that arrived null, e.g. `TVC`. */
  readonly object: string;
  /** Human-readable explanation, with no clause suffix — the caller adds one. */
  readonly detail: string;
  /** The Ajv errors this explanation replaces. */
  readonly replaces: readonly ErrorObject[];
}

/**
 * Collapse the leaf errors of a failed null-explanation `oneOf` into ONE
 * readable statement per record.
 *
 * Both registered lineages encode "a null sensed value must be explained" as a
 * record-level `oneOf` — a normal branch requiring the object to be a number,
 * and an abnormal branch requiring it to be null WITH a populated `LERR` (bd
 * memory ems-record-conditionals-allof; the same shape is in vendored 0.8.1, so
 * the primary run can adopt this translation later). Ajv reports a violation as
 * three or four errors saying nothing a supplier would recognize: "TVC must be
 * number", "LERR must be string", and the `oneOf` container itself. What
 * happened is one thing: a null reading arrived with nothing to explain it.
 *
 * PURE, and deliberately over an error list alone — no second read of the
 * payload — so the same call serves the primary run, a replay, or a test.
 *
 * The shape is recognized, never assumed. A `oneOf` is translated only when its
 * own leaf errors show BOTH halves of that rule failing together:
 *
 *   - explainer evidence: a leaf on `<record>/LERR` or `<record>/EERR`, or a
 *     `required` error naming one of them as missing;
 *   - a sensed object whose ONLY leaf errors are `type` errors that do not admit
 *     null — which is what Ajv emits when the value IS null and the normal
 *     branch wanted a number. A value of the wrong non-null type (a string where
 *     a number belongs) also trips the abnormal branch's `must be null`, so it
 *     carries a null-admitting type error and is left alone.
 *
 * The mains/solar `oneOf` in the same record does not match: its leaves sit AT
 * the record pointer (`required SVA`/`required DCSV`), not under it, so it keeps
 * reporting as the ordinary required-property failures it is.
 *
 * A container's leaves are scoped by BOTH the schema position and the instance
 * position. Ajv's `schemaPath` says where in the SCHEMA a rule sits, so every
 * item of the same array shares it: scoping on `schemaPath` alone gathers the
 * leaves of every record that failed the same `oneOf`, and collapsing them into
 * one record's statement silently drops the others' real defects (bd by1c.24).
 */
export function translateNullExplanations(errors: readonly ErrorObject[]): {
  readonly explanations: readonly NullExplanation[];
  readonly remaining: readonly ErrorObject[];
} {
  const explanations: NullExplanation[] = [];
  const replaced = new Set<ErrorObject>();

  for (const container of errors) {
    if (container.keyword !== 'oneOf') continue;
    const record = container.instancePath;
    if (record === '') continue;

    // The branch failures of THIS oneOf, in THIS record: Ajv nests their
    // schemaPath under the container's, but that is a position in the schema and
    // every record in the array shares it, so the record's own pointer is what
    // separates one record's leaves from its siblings' (by1c.24).
    const prefix = `${container.schemaPath}/`;
    const leaves = errors.filter(
      (e) =>
        e !== container && e.schemaPath.startsWith(prefix) && withinRecord(record, e.instancePath),
    );
    if (leaves.length === 0) continue;

    // Half one: something was offered to explain the null, or should have been.
    const explained = leaves.some((e) => {
      const segment = lastSegment(e.instancePath);
      if (
        segment !== null &&
        EXPLAINER_OBJECTS.has(segment) &&
        withinRecord(record, e.instancePath)
      ) {
        return true;
      }
      const missing = (e.params as { missingProperty?: unknown }).missingProperty;
      return (
        e.keyword === 'required' &&
        e.instancePath === record &&
        typeof missing === 'string' &&
        EXPLAINER_OBJECTS.has(missing)
      );
    });
    if (!explained) continue;

    // Half two: exactly one sensed object under the record, and every complaint
    // about it is a type error that refuses null.
    const sensed = new Set<string>();
    for (const e of leaves) {
      if (!e.instancePath.startsWith(`${record}/`)) continue;
      const segment = lastSegment(e.instancePath);
      if (segment === null || EXPLAINER_OBJECTS.has(segment)) continue;
      sensed.add(segment);
    }
    if (sensed.size !== 1) continue;
    const object = [...sensed][0]!;

    const objectLeaves = leaves.filter((e) => e.instancePath === `${record}/${object}`);
    const isNull = objectLeaves.every((e) => {
      if (e.keyword !== 'type') return false;
      const type = (e.params as { type?: unknown }).type;
      const types = Array.isArray(type) ? type.map(String) : [String(type)];
      return !types.includes('null');
    });
    if (!isNull) continue;

    explanations.push({
      pointer: record,
      object,
      detail: `null ${object} without an explaining LERR/EERR`,
      replaces: leaves,
    });
    for (const leaf of leaves) replaced.add(leaf);
  }

  return { explanations, remaining: errors.filter((e) => !replaced.has(e)) };
}

/**
 * The IDENTIFYING param for a signature (4h4.1) — the param that names WHICH
 * defect of this keyword class occurred, NOT the offending value. Pulled from
 * Ajv's structured `err.params` per keyword:
 *   required             → missingProperty
 *   format               → format
 *   additionalProperties → additionalProperty
 *   enum                 → allowedValues (joined)
 *   minimum / maximum    → limit
 *   minLength / maxLength → limit
 *   pattern              → pattern
 *   type                 → type
 * Any other keyword has no stable identifying param → null.
 *
 * `pattern` and `minLength`/`maxLength` were added for the Annex 4 lineage,
 * which applies both widely (a pattern on every date object and on
 * `transferredAt`, minLength on the identifiers). Without them every pattern
 * failure in a transmission signs identically and the dashboard collapses five
 * distinct defects into one row. They apply to the primary run too — the param
 * is a signature-structure field rather than a grade, so nothing changes about
 * what passes or fails.
 */
export function identifyingParam(err: ErrorObject): string | null {
  const p = err.params as Record<string, unknown>;
  let value: unknown;
  switch (err.keyword) {
    case 'required':
      value = p.missingProperty;
      break;
    case 'format':
      value = p.format;
      break;
    case 'additionalProperties':
      value = p.additionalProperty;
      break;
    case 'enum':
      value = p.allowedValues;
      break;
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'minLength':
    case 'maxLength':
      value = p.limit;
      break;
    case 'pattern':
      value = p.pattern;
      break;
    case 'type':
      value = p.type;
      break;
    default:
      return null;
  }
  if (value == null) return null;
  return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * Grade `ctx.parsedBody` against the shadow entry and record what it says.
 *
 * Never halts and never touches `ctx.schemaOk`: the shadow lineage is not the
 * contract, so nothing it finds may change the response. A clean run records ONE
 * pass finding so "also passes the other profile" is a recorded fact rather than
 * an absence the dashboard would have to infer.
 *
 * There is no shadow equivalent of the primary run's outdated-but-valid check.
 * "Outdated" is intra-lineage, and the shadow entry is by construction the
 * CURRENT entry of its lineage, so the notion only acquires meaning once a
 * second `ds013` revision is registered — at which point a transmission could
 * shadow-validate against an older one. Not built until then.
 */
function recordShadowFindings(ctx: PipelineContext, entry: RegistryEntry): void {
  const ok = entry.validate(ctx.parsedBody);
  // Ajv `.errors` is only valid immediately after the call — capture it now.
  const errors = [...(entry.validate.errors ?? [])];

  if (ok) {
    ctx.findings.push({
      requirement: clauseFor(entry.profile, ''),
      severity: 'pass',
      profile: entry.profile,
      detail: describePass(entry, clauseFor(entry.profile, '')),
    });
    return;
  }

  const { explanations, remaining } = translateNullExplanations(errors);

  for (const explanation of explanations) {
    const clause = clauseFor(entry.profile, explanation.pointer);
    ctx.findings.push({
      requirement: clause,
      severity: 'fail',
      profile: entry.profile,
      detail: `${explanation.detail} (§${clause})`,
      pointer: explanation.pointer,
      param: explanation.object,
      code: 'tx.null_unexplained',
    });
  }

  for (const err of remaining) {
    if (isContainerError(err)) continue;
    const clause = clauseFor(entry.profile, err.instancePath);
    ctx.findings.push({
      requirement: clause,
      severity: 'fail',
      profile: entry.profile,
      detail: describeError(err, clause),
      pointer: toPointer(err.instancePath),
      keyword: err.keyword,
      instancePath: err.instancePath,
      param: identifyingParam(err),
    });
  }
}

export function schemaStage(): Stage {
  return {
    name: 'schema',
    run(ctx: PipelineContext): StageOutcome {
      // Precondition: only validate a body the parse stage actually produced.
      if (ctx.parseOk !== true || ctx.parsedBody == null) {
        return CONTINUE;
      }

      const body = ctx.parsedBody as { meta?: Record<string, unknown> };
      const meta = (body?.meta ?? {}) as Record<string, unknown>;

      // Record what the supplier SENT regardless of whether validation passes, so
      // the persisted row carries the transfer identifiers + raw schema version.
      ctx.meta.transferId = typeof meta.transferId === 'string' ? meta.transferId : null;
      ctx.meta.transferSrc = typeof meta.transferSrc === 'string' ? meta.transferSrc : null;
      ctx.meta.transferType = typeof meta.transferType === 'string' ? meta.transferType : null;
      ctx.meta.schemaVersion = typeof meta.schemaVersion === 'string' ? meta.schemaVersion : null;

      const raw = meta.schemaVersion;

      // Missing / non-string schemaVersion: a §3.2 schema-version failure. We
      // can't resolve a validator, so list what we DO accept and halt 422. No
      // primary lineage means no shadow to run: both profile slots stay null.
      if (typeof raw !== 'string') {
        ctx.normalizedSchemaVersion = null;
        ctx.schemaOk = false;
        ctx.findings.push({
          requirement: '3.2',
          severity: 'fail',
          detail: `meta.schemaVersion is absent or not a string; supported: ${ctx.registry
            .acceptedVersions()
            .join(', ')} (§3.2)`,
          pointer: '/meta/schemaVersion',
          code: 'tx.missing_schema_version',
        });
        return halt(422);
      }

      const res = ctx.registry.lookup(raw);

      // Unknown version: ONE §3.2 fail listing the accepted versions, then 422.
      if (!res.ok) {
        ctx.normalizedSchemaVersion = res.requested || null;
        ctx.schemaOk = false;
        ctx.findings.push({
          requirement: '3.2',
          severity: 'fail',
          detail: `unsupported schemaVersion "${raw}"; supported: ${res.supported.join(', ')} (§3.2)`,
          pointer: '/meta/schemaVersion',
          code: 'tx.unsupported_schema_version',
        });
        return halt(422);
      }

      ctx.normalizedSchemaVersion = res.entry.version;

      // The lineage the payload declared is the PRIMARY; the current entry of
      // the other lineage is the SHADOW. Neither is named as a literal here —
      // the registry answers both, so the day CONTRACT_PROFILE flips this stage
      // needs no edit.
      const primary = res.entry.profile;
      const shadowEntry = ctx.registry.shadowFor(primary);
      ctx.primaryProfile = primary;
      ctx.shadowProfile = shadowEntry?.profile ?? null;

      const ok = res.entry.validate(ctx.parsedBody);
      // Ajv `.errors` is only valid immediately after the call — capture it now.
      const errors = [...(res.entry.validate.errors ?? [])];

      if (!ok) {
        ctx.schemaOk = false;
        // ONE finding per Ajv error, each carrying its JSON Pointer — except the
        // combining keywords, which carry no location a supplier can act on and
        // are suppressed on this run as they are on the shadow (bd bt8o).
        let emitted = 0;
        for (const err of errors) {
          if (isContainerError(err)) continue;
          emitted += 1;
          const clause = clauseFor(primary, err.instancePath);
          ctx.findings.push({
            requirement: clause,
            severity: 'fail',
            profile: primary,
            detail: describeError(err, clause),
            pointer: toPointer(err.instancePath),
            // Structured signature fields (4h4.1): sign on Ajv's closed keyword
            // vocabulary + path + identifying param, never the message string.
            keyword: err.keyword,
            instancePath: err.instancePath,
            param: identifyingParam(err),
          });
        }
        // Guard: never let a 422 go out with zero findings — whether because Ajv
        // populated no errors at all, or because every error it did populate was
        // a suppressed container (bd bt8o).
        if (emitted === 0) {
          ctx.findings.push({
            requirement: clauseFor(primary, ''),
            severity: 'fail',
            profile: primary,
            detail: `body failed validation against schema ${res.entry.version} (§${clauseFor(primary, '')})`,
            code: 'tx.schema_invalid',
          });
        }
        // The shadow lineage is graded even on a rejection: the supplier's
        // standing under the other profile is a fact about this transmission,
        // and withholding it because the contract run failed would report half
        // the answer. Only the status is primary-only.
        if (shadowEntry) recordShadowFindings(ctx, shadowEntry);
        return halt(422);
      }

      ctx.schemaOk = true;

      // Outdated-but-valid (DESIGN.md §7): the body validates, but against an
      // OLDER registered version than the current one. The transmission is still
      // accepted — we record an info finding (not a pass, not a fail) carrying
      // the `outdated` flag so the dashboard can surface the OUTDATED SCHEMA tag
      // and nudge an upgrade. A current-version validation records a pass.
      // Currency is judged WITHIN the lineage the resolved entry belongs to, so a
      // contract-profile transmission is never called outdated because a newer
      // revision of the shadow lineage exists (registry header: current/outdated
      // is intra-profile only).
      const current = ctx.registry.currentVersion(primary);
      const clause = clauseFor(primary, '');
      if (current !== null && res.entry.version !== current) {
        ctx.findings.push({
          requirement: clause,
          severity: 'info',
          profile: primary,
          outdated: true,
          detail: `accepted, but validated against an OUTDATED schema: you declared ${res.entry.version}; the current registered version is ${current}. Upgrade your transmitter to ${current}. (§${clause})`,
          code: 'tx.outdated_schema',
        });
      } else {
        ctx.findings.push({
          requirement: clause,
          severity: 'pass',
          profile: primary,
          detail: describePass(res.entry, clause),
        });
      }

      if (shadowEntry) recordShadowFindings(ctx, shadowEntry);
      return CONTINUE;
    },
  };
}
