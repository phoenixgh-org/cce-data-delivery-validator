/**
 * Sessions API — `POST /api/sessions` (DESIGN.md §5).
 *
 * Mints a new validator session (auth disabled by default — zero-friction
 * onboarding, §3) and returns the capability paths a supplier needs:
 *
 *   - `ingestUrl`    — where transmissions are POSTed (`/i/{uuid}`, §6).
 *   - `dashboardUrl` — where results are viewed (`/d/{uuid}`; lands in M4).
 *
 * Both are RELATIVE path strings, not absolute URLs (DESIGN.md §5): the public
 * origin is owned by the reverse proxy, so the API does not fabricate a host.
 *
 * This endpoint takes NO request body. The app strips Fastify's body parsers and
 * keeps raw bytes for ingest (§1.4), so this handler must not read/parse a body.
 *
 * `GET /api/sessions/:uuid` reads back everything the dashboard surfaces
 * (DESIGN.md §10): session metadata, the reverse-chron transmission list with
 * each transmission's findings + drill-down bytes, the §7 compliance summary
 * derived from the session's findings, and the registered schema set as
 * {version, sha256} so the dashboard can name the bytes it is graded against
 * without keeping its own copy of the hash (beads 3cq). JSON-only — no HTML/web
 * UI (that's M4).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { computeComplianceSummary } from './compliance-matrix.js';
import { ACCEPTED_LENSES, foldUnderLens, lensMatrix, parseLens } from './lens.js';
import {
  inScope,
  parseSource,
  parseWindow,
  rollup,
  scopeTotals,
  scopeTransmissions,
  windowLowerBound,
} from './scope.js';
import {
  computeSignatures,
  issueSignaturesUnderLens,
  txMatchesSig,
  withRequirementUnderLens,
} from './signatures.js';
import type { SignatureTransmission } from './signatures.js';
import { deriveSourceView, sourceCounts } from './source.js';
import { readiness, verdict } from './verdicts.js';
import type { Verdict, VerdictTransmission } from './verdicts.js';
import { generateCredential } from '../auth/credential.js';
import {
  AUTH_METHODS,
  RETENTION_MS,
  createSession,
  deleteSessionData,
  disableAuth,
  enableAuth,
  getSession,
  isAuthMethod,
  listFindingsForSession,
  listFindingsInWindow,
  listTransmissions,
  listTransmissionsInWindow,
} from '../db/repository.js';
import type { AuthMethod, FindingRow, TransmissionRow } from '../db/repository.js';
import { CONTRACT_PROFILE } from '../schema-registry.js';
import type { Profile, SchemaRegistry } from '../schema-registry.js';

/** Findings as surfaced per-transmission on the dashboard (drill-down detail). */
function toFindingView(f: FindingRow) {
  return {
    requirement: f.requirement,
    severity: f.severity,
    // Advisory prose is two pieces since agj.17: `summary` is the one-line
    // observation shown on the row, `detail` the rationale behind its expander.
    // Null on graded findings and on rows stored before the column existed — the
    // browser falls back to `detail` in both cases.
    summary: f.summary,
    detail: f.detail,
    pointer: f.pointer,
    outdated: f.outdated,
    // Structured signature fields (4h4.1): schema errors carry keyword/
    // instancePath/param; transport/heuristic findings carry a stable code.
    keyword: f.keyword,
    instancePath: f.instance_path,
    param: f.param,
    code: f.code,
    // Which requirement lineage this finding graded against (by1c.5): the
    // contract in force, or the DS01.3 shadow run. Passed through from the row —
    // since by1c.6 a single transmission carries findings of both lineages, and
    // everything downstream that grades (the profile-disjoint signature fold,
    // the verdict engine) reads this field to tell them apart.
    profile: f.profile,
  };
}

/**
 * Everything the response needs to say WHICH LINEAGE graded what: the contract in
 * force, the lineage being shadowed (if any), that lineage's provenance, and the
 * registry the primary lineage of a transmission is resolved through.
 *
 * Built once per request from the registry (never from a literal), so the day
 * `CONTRACT_PROFILE` flips, the shadow half of every response follows without a
 * second decision: `shadowFor()` answers "the other lineage" by construction.
 */
interface Grading {
  /** The lineage in force — what the 27-row matrix and the scorecard grade. */
  contractProfile: Profile;
  /** The lineage previewed beside it, or null when the registry holds only one. */
  shadowProfile: Profile | null;
  /** Provenance of the shadow lineage's current bytes; null with no shadow. */
  shadow: ShadowProvenance | null;
  /** The profile ids a verdict is reported under, contract first. */
  profiles: readonly Profile[];
  /** Resolves a declared `meta.schemaVersion` back to the lineage it belongs to. */
  registry: SchemaRegistry;
}

/**
 * What the dashboard needs to NAME the shadow lineage's bytes: its registry key,
 * the hash computed over the vendored file at boot, and — for an unpublished
 * proposal — the date of the draft it is a copy of.
 *
 * `draftDate` is OPTIONAL and comes off the registry entry, never a literal here
 * (epic by1c item 3): a published shadow schema has no draft date to report, and
 * the legend's "draft <date>" label is licensed by the field's presence alone.
 */
interface ShadowProvenance {
  version: string;
  sha256: string;
  draftDate?: string;
}

/**
 * Derive the request's {@link Grading} from the compiled registry.
 *
 * When `shadowFor()` finds nothing — a registry holding a single lineage — there
 * is no second profile id to report a verdict under, so `profiles` is the
 * contract alone and every shadow surface (readiness, the shadow verdict key,
 * the provenance object) is absent or null. That is the same "nothing was
 * measured" reading a null shadow verdict carries, one level up.
 */
function deriveGrading(registry: SchemaRegistry): Grading {
  const entry = registry.shadowFor(CONTRACT_PROFILE);
  const shadowProfile = entry === null ? null : entry.profile;
  return {
    contractProfile: CONTRACT_PROFILE,
    shadowProfile,
    shadow:
      entry === null
        ? null
        : entry.draftDate === undefined
          ? { version: entry.version, sha256: entry.sha256 }
          : { version: entry.version, sha256: entry.sha256, draftDate: entry.draftDate },
    profiles: shadowProfile === null ? [CONTRACT_PROFILE] : [CONTRACT_PROFILE, shadowProfile],
    registry,
  };
}

/**
 * One transmission's verdict under each registered lineage, KEYED BY PROFILE ID
 * (epic by1c item 8) — `{ '2025': 'pass', 'ds013': 'fail' }` — not by the
 * primary/shadow role, which varies per transmission in a mixed stream while the
 * dashboard's contract column does not.
 *
 * A key is absent only when the registry holds no such lineage; within a key,
 * `null` is narrower than "that lineage never ran": the body reached neither
 * validator under this package AND nothing forward-mapped failed, which in
 * practice leaves only an unresolved `meta.schemaVersion` (see `Verdict`).
 */
type VerdictsByProfile = Partial<Record<Profile, Verdict>>;

/**
 * Grade one transmission under every profile the registry knows.
 *
 * Built by looping the profile ids rather than naming them, so this is the same
 * code whichever lineage is the contract. Note what it does NOT read: the HTTP
 * status. A transmission rejected 422 on its primary lineage can still hold a
 * 'pass' verdict under the other one — status records what the primary validator
 * decided, a verdict records what a lineage decided (src/api/verdicts.ts).
 */
function verdictsFor(tx: VerdictTransmission, grading: Grading): VerdictsByProfile {
  const out: VerdictsByProfile = {};
  for (const profile of grading.profiles) {
    out[profile] = verdict(tx, profile, grading.contractProfile);
  }
  return out;
}

/**
 * Which lineage drove this transmission's status — the one its declared
 * `meta.schemaVersion` resolves to, read back through the same registry lookup
 * the ingest pipeline used. Null when nothing resolved: an unparseable body, an
 * absent version, or a version outside both lineages (a `1.0.0` declaration),
 * where no primary validator ever ran.
 *
 * Derived, never stored: the version is already on the row and the registry is
 * already loaded, so a DB column would be a second copy free to drift from the
 * registry it restates.
 */
function primaryProfileOf(schemaVersion: string | null, registry: SchemaRegistry): Profile | null {
  if (schemaVersion === null || schemaVersion.length === 0) return null;
  const result = registry.lookup(schemaVersion);
  return result.ok ? result.entry.profile : null;
}

/**
 * Order findings ascending by §-number for the per-tx drill-down. Requirements are
 * dotted ids ("1.2", "1.10", "3.2"), so a plain string sort would mis-rank "1.10"
 * before "1.2"; `numeric: true` compares each numeric run by VALUE, giving true
 * section order. Sort is stable, so multiple findings under one requirement keep
 * their insertion (pipeline) order.
 */
function byRequirement(a: FindingRow, b: FindingRow): number {
  return a.requirement.localeCompare(b.requirement, undefined, { numeric: true });
}

/**
 * Build the per-transmission view (list row + drill-down detail) from a
 * transmission row and its pre-grouped findings. Shared by the summary read
 * (`GET /api/sessions/:uuid`) and the paginated list (`…/transmissions`) so the
 * row shape — source dimension (4h4.2) + inlined findings + the per-profile
 * verdicts (by1c.9) — is IDENTICAL on both. The list rows carry the verdicts for
 * the same reason they carry the findings: the virtualized list renders its
 * verdict dots off the page it already fetched, with no second read.
 */
function toTransmissionView(t: TransmissionRow, findings: readonly FindingRow[], grading: Grading) {
  // SOURCE dimension (4h4.2): derive the presentation pair from the raw
  // transfer_src so list rows + the filter <select> agree (src/api/source.ts).
  const { source: src, sourceCode, sourceLabel } = deriveSourceView(t.transfer_src);
  // One pass over the findings: the drill-down list and the verdicts read the
  // same camelCase views, so the sort + map happens once.
  const findingViews = findings.slice().sort(byRequirement).map(toFindingView);
  return {
    id: t.id,
    received_at: t.received_at,
    http_status: t.http_status,
    content_type: t.content_type,
    content_encoding: t.content_encoding,
    // wire_bytes is a bigint → pg returns a string; pass it through as-is.
    wire_bytes: t.wire_bytes,
    schema_version: t.schema_version,
    transfer_id: t.transfer_id,
    // Keep the raw transfer_src for the window-aware source counts.
    transfer_src: t.transfer_src,
    // Raw source key + derived 3-letter code + human label (4h4.2).
    source: src,
    sourceCode,
    sourceLabel,
    parse_ok: t.parse_ok,
    schema_ok: t.schema_ok,
    body: t.body,
    raw_body: t.raw_body,
    findings: findingViews,
    // Per-lineage verdicts + which lineage drove the status (by1c.9). Both are
    // derived from data already on the row, so they cost no extra read.
    verdicts: verdictsFor({ findings: findingViews }, grading),
    primaryProfile: primaryProfileOf(t.schema_version, grading.registry),
  };
}

type TransmissionView = ReturnType<typeof toTransmissionView>;

/** Group findings by transmission_id (preserves per-tx insertion order). */
function groupFindingsByTx(findings: readonly FindingRow[]): Map<string, FindingRow[]> {
  const byTx = new Map<string, FindingRow[]>();
  for (const f of findings) {
    const bucket = byTx.get(f.transmission_id);
    if (bucket) bucket.push(f);
    else byTx.set(f.transmission_id, [f]);
  }
  return byTx;
}

/**
 * Adapt a built view to the SignatureTransmission shape txMatchesSig/sigKey
 * consume — `received_at` as an ISO string, raw source key, camelCase findings.
 * Reusing the same projection the summary feeds computeSignatures keeps the
 * list's signatureKey cross-filter membership EQUAL to the signature engine.
 */
function asSignatureTx(t: TransmissionView): SignatureTransmission {
  return {
    id: t.id,
    received_at: new Date(t.received_at).toISOString(),
    source: t.source,
    findings: t.findings,
  };
}

/** The opaque list cursor: the (received_at, id) of the last row of a page. */
interface ListCursor {
  receivedAt: number;
  id: string;
}

/** Encode a cursor as a URL-safe base64 token (received_at epoch ms + id). */
function encodeCursor(c: ListCursor): string {
  return Buffer.from(`${c.receivedAt}:${c.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a list cursor token, or `null` for an absent/malformed value (the page
 * just starts from the top — the list, like scope parsing, never 400s on a bad
 * query param).
 */
function decodeCursor(raw: unknown): ListCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = text.indexOf(':');
    if (sep <= 0) return null;
    const receivedAt = Number(text.slice(0, sep));
    const id = text.slice(sep + 1);
    if (!Number.isFinite(receivedAt) || id.length === 0) return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
}

/** Default and hard-cap page sizes for the transmission list. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Parse a `limit` query value, clamped to [1, MAX_PAGE_SIZE], default otherwise. */
function parsePageSize(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n)));
}

/**
 * Strict reverse-chron compare for the cursor: a row comes AFTER the cursor when
 * its (received_at DESC, id DESC) sort key is strictly past the cursor's — i.e.
 * older received_at, or same received_at with a smaller id. Matches the SQL
 * `ORDER BY received_at DESC, id DESC` total order exactly.
 */
function afterCursor(receivedAt: number, id: string, cursor: ListCursor): boolean {
  if (receivedAt < cursor.receivedAt) return true;
  if (receivedAt > cursor.receivedAt) return false;
  return id < cursor.id;
}

/** Register the sessions API on `app`. */
export function registerSessionsApi(app: FastifyInstance): void {
  app.post('/api/sessions', async (_request: FastifyRequest, reply: FastifyReply) => {
    // No arguments → mints with auth disabled by default; DB defaults the uuid.
    const session = await createSession();
    return reply.code(201).send({
      uuid: session.uuid,
      ingestUrl: `/i/${session.uuid}`,
      dashboardUrl: `/d/${session.uuid}`,
    });
  });

  // §1.3 opt-in auth toggle (DESIGN.md §3, §10, §12). The dashboard generates the
  // credential; the service stores ONLY its salted hash and echoes the plaintext
  // exactly ONCE here. Enabling is idempotent in effect — re-POSTing rotates the
  // credential (a fresh secret is minted each time).
  //
  // The app keeps raw bytes for ingest (§1.4) and registers no JSON parser, so the
  // body arrives as a Buffer; parse it here.
  //
  // REQUEST BODY (all fields optional; an absent/empty body is valid):
  //
  //   {
  //     "method":     "header" | "basic" | "bearer",   // default "header"
  //     "headerName": string,   // `header` method only — default X-CCE-Token
  //     "username":   string    // `basic`  method only — default cce
  //   }
  //
  // `method` DEFAULTS to `header` when omitted (back-compat: the pre-5bs.4 caller
  // sent `{}`), but an unrecognised value is REJECTED with 400 `invalid_method`
  // rather than silently falling back — a supplier who asks for a method we do not
  // implement must not be told auth is configured the way they asked.
  //
  // 201 RESPONSE, by method (the show-once plaintext, §12):
  //
  //   header → { uuid, auth_enabled, auth_method:'header', auth_header_name, token }
  //   basic  → { uuid, auth_enabled, auth_method:'basic',  username, password }
  //   bearer → { uuid, auth_enabled, auth_method:'bearer', auth_header_name, token }
  //
  // For `bearer` (RFC 6750) `auth_header_name` is always the literal
  // `Authorization` and the credential is sent as `Authorization: Bearer <token>`;
  // nothing about it is configurable, so `headerName`/`username` are ignored.
  app.post(
    '/api/sessions/:uuid/auth',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;

      let body: { method?: unknown; headerName?: unknown; username?: unknown } = {};
      if (Buffer.isBuffer(request.body) && request.body.length > 0) {
        try {
          const parsed = JSON.parse(request.body.toString('utf8'));
          if (parsed && typeof parsed === 'object') body = parsed as typeof body;
        } catch {
          return reply.code(400).send({ error: 'invalid_json' });
        }
      }

      // Omitted → `header` (back-compat default); present-but-unknown → 400.
      let method: AuthMethod = 'header';
      if (body.method !== undefined) {
        if (!isAuthMethod(body.method)) {
          return reply.code(400).send({ error: 'invalid_method', allowed: AUTH_METHODS });
        }
        method = body.method;
      }
      const headerName = typeof body.headerName === 'string' ? body.headerName : undefined;
      const username = typeof body.username === 'string' ? body.username : undefined;

      const credential = generateCredential(method, { headerName, username });
      const view = await enableAuth(uuid, {
        authMethod: credential.store.auth_method,
        authHeaderName: credential.store.auth_header_name,
        authSecretHash: credential.store.auth_secret_hash,
      });
      if (!view) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      // Echo the plaintext credential EXACTLY ONCE (§12) plus the config it
      // implies. The salted hash is never returned. `header`/`bearer` → token +
      // the header it rides in; `basic` → username + password.
      if (method === 'header' || method === 'bearer') {
        return reply.code(201).send({
          uuid: view.uuid,
          auth_enabled: view.auth_enabled,
          auth_method: view.auth_method,
          auth_header_name: view.auth_header_name,
          token: credential.plaintext,
        });
      }
      return reply.code(201).send({
        uuid: view.uuid,
        auth_enabled: view.auth_enabled,
        auth_method: view.auth_method,
        username: view.auth_header_name,
        password: credential.plaintext,
      });
    },
  );

  // Disable §1.3 auth: clears the stored credential and flips auth_enabled off.
  app.delete(
    '/api/sessions/:uuid/auth',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;
      const view = await disableAuth(uuid);
      if (!view) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }
      return reply.send({
        uuid: view.uuid,
        auth_enabled: view.auth_enabled,
        auth_method: view.auth_method,
      });
    },
  );

  // Delete all CAPTURED DATA for a session (DESIGN.md §8 user-triggered purge):
  // wipes its transmissions + findings but KEEPS the session row + ingest URL
  // alive, so the supplier can start a fresh test protocol against the same
  // endpoint. Drives the dashboard's "Delete all captured data" danger zone.
  // 404 when the session is unknown/expired; otherwise reports how many
  // transmissions were removed (0 is a valid no-op for an already-empty session).
  app.delete(
    '/api/sessions/:uuid/data',
    async (request: FastifyRequest<{ Params: { uuid: string } }>, reply: FastifyReply) => {
      const { uuid } = request.params;

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const deletedTransmissions = await deleteSessionData(uuid);
      return reply.send({ uuid, deleted: { transmissions: deletedTransmissions } });
    },
  );

  // SCOPE-AWARE session read (4h4.4). Accepts a time `window` (15m|1h|6h|all,
  // default all) + `source` (a raw source key | all, default all) and returns,
  // over the SCOPED transmission set, a pre-aggregated payload so the browser
  // never holds every raw finding to render the compliance and signature
  // surfaces: { session, summary, rollup, signatures, sources, scoped }.
  // Unknown/invalid window/source values FALL BACK to defaults (no 400) to keep
  // the dashboard resilient. 404/meta/expiresAt and the per-tx findings drill-down
  // are preserved.
  //
  // LIST/SUMMARY SPLIT (DECISION): the full `transmissions` list STILL ships in
  // this response for now — the docked detail pane reads it. The paginated/
  // filterable LIST endpoint (4h4.5) supersedes this list path later; this
  // handler is the summary half of that split.
  app.get(
    '/api/sessions/:uuid',
    async (
      request: FastifyRequest<{
        Params: { uuid: string };
        Querystring: { window?: string; source?: string; lens?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { uuid } = request.params;

      // The lens is validated BEFORE the session lookup: it is the one query
      // parameter that can 400, the answer does not depend on the session, and
      // failing early keeps the response from depending on whether the uuid
      // exists. Window and source stay resilient — they fall back (4h4.4).
      const lens = parseLens(request.query.lens);
      if (lens === null) {
        return reply.code(400).send({ error: 'unknown_lens', accepted: ACCEPTED_LENSES });
      }

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const window = parseWindow(request.query.window);
      const source = parseSource(request.query.source);

      const [transmissions, findings] = await Promise.all([
        listTransmissions(uuid),
        listFindingsForSession(uuid),
      ]);

      // Group findings by transmission_id once for the per-tx drill-down; the
      // scope-relative summary counts are recomputed over the SCOPED set below.
      const findingsByTx = groupFindingsByTx(findings);

      // Build the full per-transmission views (list + drill-down). `source` is the
      // raw key the scope predicate filters on; the camelCase finding fields feed
      // computeSignatures unchanged.
      const grading = deriveGrading(app.schemaRegistry);
      const transmissionViews = transmissions.map((t) =>
        toTransmissionView(t, findingsByTx.get(t.id) ?? [], grading),
      );

      const now = Date.now();

      // Window-only set (NOT narrowed by the selected source) — the filter
      // <select> must show every source's in-window count, regardless of which
      // source is currently selected.
      const windowViews = scopeTransmissions(transmissionViews, window, 'all', now);
      const sources = sourceCounts(windowViews);

      // The fully SCOPED set drives every scope-relative aggregate.
      const scopedViews = scopeTransmissions(transmissionViews, window, source, now);

      // "Does this transmission fail?" answered under the SELECTED package, which
      // is the contract verdict `txFailing` asks for whenever that package is the
      // contract. Both reads use this one predicate so the summary's
      // `withFailures` and the list's `failuresOnly` can never disagree.
      const failsUnderLens = (tx: VerdictTransmission): boolean =>
        verdict(tx, lens, grading.contractProfile) === 'fail';

      // Scope-relative summary: fold the scoped set's findings onto the rows of
      // the SELECTED requirement package, then join them with that package's
      // matrix. `outdated` is tallied in its own map: it is a per-finding
      // MODIFIER, not a severity (2kx keeps the outdated-but-valid schema finding
      // at info), and it is what lifts a session that only ever used an older
      // registered version off 'untested' onto 'pass-outdated'.
      //
      // Under the contract lens the fold is the CONTRACT-lineage-only count this
      // read has always done (by1c.8): the §7 matrix grades the obligations in
      // force, so a DS01.3 finding has no row to land in. Under the DS01.3 lens
      // it is the clause map that decides the row, and §3.2 — the one requirement
      // the draft re-runs rather than re-tags — is excluded from the carry-forward
      // (src/api/lens.ts states both rules).
      const scopedFindings = scopedViews.flatMap((t) => t.findings);
      const { counts: scopedCounts, outdated: scopedOutdated } = foldUnderLens(
        scopedFindings,
        lens,
        grading.contractProfile,
      );
      const summary = computeComplianceSummary(
        scopedCounts,
        scopedOutdated,
        lensMatrix(lens, grading.contractProfile),
      );

      // computeSignatures consumes the scoped views via the shared signature-tx
      // projection (same one the list endpoint's cross-filter uses). The set now
      // also carries kind:'advisory' entries (agj.15) so the dashboard can drive
      // the ?signatureKey= cross-filter from an advisory — they ride the wire but
      // are EXCLUDED from `distinctIssues` below, which counts defects only.
      //
      // Under a non-contract lens each non-advisory signature also gains the row
      // it belongs to in that package (`requirementUnderLens`), so the browser
      // groups signatures without a second copy of the clause map.
      const scopedSignatureTxs = scopedViews.map(asSignatureTx);
      const signatures = withRequirementUnderLens(
        computeSignatures(scopedSignatureTxs),
        lens,
        grading.contractProfile,
      );

      // DS01.3 READINESS (by1c.9) over the SAME scoped set — window + source only.
      // `failuresOnly` and `signatureKey` are list filters and are deliberately
      // not applied: readiness is a statement about the whole scope, and a set
      // narrowed to failing transmissions would report readiness over the traffic
      // least able to demonstrate it (src/api/verdicts.ts states the rule).
      // Null when the registry holds no shadow lineage — there is nothing to be
      // ready for, and the dashboard hides the strip off that null.
      const readinessView =
        grading.shadowProfile === null
          ? null
          : readiness(scopedSignatureTxs, {
              contractProfile: grading.contractProfile,
              shadowProfile: grading.shadowProfile,
            });

      const base = session.last_post_at ?? session.created_at;
      const expiresAt = new Date(base.getTime() + RETENTION_MS).toISOString();

      // Expose only auth_enabled/auth_method — never leak auth_secret_hash.
      return reply.send({
        session: {
          uuid: session.uuid,
          created_at: session.created_at,
          last_post_at: session.last_post_at,
          auth_enabled: session.auth_enabled,
          auth_method: session.auth_method,
          // Which lineage the dashboard's verdict surfaces mean (by1c.9). Both
          // come off the registry: `contractProfile` is the obligations in force,
          // `shadowProfile` the lineage previewed beside them — null when the
          // registry holds one lineage, which is what hides both shadow surfaces
          // (the second verdict column on the transmissions list and the grading
          // lens toggle) without either of them testing for a version by name.
          contractProfile: grading.contractProfile,
          shadowProfile: grading.shadowProfile,
        },
        // The requirement package every aggregate below was computed under
        // (tfnv.4) — echoed so a reader (and a cached response) can never be in
        // doubt which package the numbers grade, whether the caller asked for one
        // or took the default.
        lens,
        // Full list still ships here for the docked detail pane (see split note).
        transmissions: transmissionViews,
        summary,
        rollup: rollup(summary),
        signatures,
        sources,
        // Counted UNDER THE LENS (tfnv.4): `distinctIssues` counts the defects the
        // selected package names, and `withFailures` the transmissions that fail
        // its verdict. Under the contract lens both are what they were before the
        // lens existed (by1c.7) — the headline counts defects against the
        // obligations in force, and a DS01.3 signature never inflates it.
        // The distinct-CCE-unit pair (p98) is folded here too, off the `body` the
        // scoped views already carry — profile-independent and verdict-independent,
        // so it needs no second read and no grading input.
        scoped: scopeTotals(
          scopedViews,
          issueSignaturesUnderLens(signatures, lens, grading.contractProfile).length,
          failsUnderLens,
        ),
        expiresAt,
        // The shadow lineage's current bytes — version, the hash computed over
        // the vendored file at boot, and the draft date when the entry is an
        // unpublished proposal. Service-global like `schemas` (the shadow entry
        // is in that list too), surfaced separately so the legend can name the
        // shadow without re-deriving "the newest entry that is not the contract".
        // Null whenever `session.shadowProfile` is.
        shadow: grading.shadow,
        // How much of the contract-conformant traffic in scope would also pass
        // the shadow lineage, and what stands in the way (by1c.9). Null when
        // there is no shadow lineage registered.
        readiness: readinessView,
        // Which schema bytes this endpoint grades against (beads 3cq). Service-
        // global, not session-scoped, but it rides on the response the dashboard
        // ALREADY fetches rather than costing a second endpoint + round trip —
        // the panel that displays it renders from this payload. Straight off the
        // registry, so the hash the supplier reads is the hash of the bytes in
        // force; the dashboard previously carried it as a literal and drifted.
        schemas: app.schemaRegistry.provenance(),
      });
    },
  );

  // PAGINATED, FILTERABLE transmission list (4h4.5). Backs the dashboard's list
  // region "Transmissions · showing {visible} of {scoped}" at thousands of rows,
  // where shipping the whole list (the summary read above) does not scale.
  //
  // Query params (all resilient — unknown values fall back, never 400):
  //   - window   15m|1h|6h|all (default all) — same scope semantics as the summary.
  //   - source   a raw source key | all (default all) — TRIMMED transfer_src, the
  //              null/blank bucket is the empty-string key (deriveSourceView).
  //   - failuresOnly  true|1 → keep only tx with ≥1 fail finding.
  //   - signatureKey  keep only tx exhibiting that signature (txMatchesSig) — the
  //              cross-filter from a clicked signature row.
  //   - cursor   opaque (received_at,id) token from a prior page's nextCursor.
  //   - limit    page size, clamped to [1, MAX_PAGE_SIZE], default DEFAULT_PAGE_SIZE.
  //
  // APPROACH (the 4h4.5 trade-off, app-filter side): push only the window
  // time-bound + reverse-chron ORDER into SQL (reuse the (session_uuid,
  // received_at DESC) index via listTransmissionsInWindow), fetch the windowed
  // candidates + their findings, then apply source / failuresOnly / signatureKey
  // / cursor pagination IN APP. Per-session volume is bounded by the 7-day
  // retention window, so the bounded scan is cheap — and source-normalization
  // (source.ts) + signatureKey membership (signatures.ts txMatchesSig) stay
  // single-sourced instead of being re-implemented in SQL (which would drift).
  //
  // Response: { transmissions: [page of rows], scoped, nextCursor, hasMore }.
  //   - each row is the SAME view as the summary (TransmissionView + source/
  //     sourceCode/sourceLabel) with its findings INLINED — the docked detail pane
  //     renders StatusPill/§links/OUTDATED tag/pointer/inventory straight off the
  //     row, no second fetch (volume is page-bounded, so inlining is cheap).
  //   - `scoped` is the count AFTER all four filters — the "of {scoped}"
  //     denominator the header means (visible = transmissions.length ≤ scoped).
  app.get(
    '/api/sessions/:uuid/transmissions',
    async (
      request: FastifyRequest<{
        Params: { uuid: string };
        Querystring: {
          window?: string;
          source?: string;
          failuresOnly?: string;
          signatureKey?: string;
          cursor?: string;
          limit?: string;
          lens?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { uuid } = request.params;

      // Validated before the session lookup, for the reason the summary read
      // gives: the lens is the one parameter here that can 400.
      const lens = parseLens(request.query.lens);
      if (lens === null) {
        return reply.code(400).send({ error: 'unknown_lens', accepted: ACCEPTED_LENSES });
      }

      const session = await getSession(uuid);
      if (!session) {
        return reply.code(404).send({ error: 'not_found', uuid });
      }

      const window = parseWindow(request.query.window);
      const source = parseSource(request.query.source);
      const failuresOnly =
        request.query.failuresOnly === 'true' || request.query.failuresOnly === '1';
      const signatureKey =
        typeof request.query.signatureKey === 'string' && request.query.signatureKey.length > 0
          ? request.query.signatureKey
          : null;
      const cursor = decodeCursor(request.query.cursor);
      const limit = parsePageSize(request.query.limit);

      const now = Date.now();
      const lo = windowLowerBound(window, now);

      // SQL does the window slice + reverse-chron order; the app does the rest.
      const [transmissions, findings] = await Promise.all([
        listTransmissionsInWindow(uuid, lo),
        listFindingsInWindow(uuid, lo),
      ]);

      const findingsByTx = groupFindingsByTx(findings);
      const grading = deriveGrading(app.schemaRegistry);
      const views = transmissions.map((t) =>
        toTransmissionView(t, findingsByTx.get(t.id) ?? [], grading),
      );

      // Apply scope (source + the window's [lo, now] bound) + failuresOnly +
      // signatureKey app-side, single-sourced from scope.ts (inScope — the SAME
      // predicate the summary endpoint scopes with, so the shared "showing
      // {visible} of {scoped}" header agrees, incl. the received_at <= now upper
      // bound) and signatures.ts (txMatchesSig). The SQL already pushed the lo
      // bound; inScope re-applies it harmlessly and adds the now upper bound.
      const filtered = views.filter((t) => {
        if (!inScope(t, window, source, now)) return false;
        // The SELECTED package's verdict (tfnv.4), not "any fail finding": under
        // the contract lens this is the contract verdict it has always been
        // (by1c.8), so a transmission that conforms today and would only fail
        // under DS01.3 is not listed as a failure the supplier must act on now;
        // under the DS01.3 lens the same filter means "fails the draft".
        if (failuresOnly && verdict(t, lens, grading.contractProfile) !== 'fail') return false;
        if (signatureKey !== null && !txMatchesSig(asSignatureTx(t), signatureKey)) return false;
        return true;
      });

      // `scoped` = the post-filter denominator the header reads "of {scoped}".
      const scoped = filtered.length;

      // Cursor pagination over the (already reverse-chron) filtered set: drop rows
      // up to and including the cursor, take `limit`, expose hasMore + nextCursor.
      const afterCursorViews =
        cursor === null
          ? filtered
          : filtered.filter((t) => afterCursor(new Date(t.received_at).getTime(), t.id, cursor));
      const page = afterCursorViews.slice(0, limit);
      const hasMore = afterCursorViews.length > page.length;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({ receivedAt: new Date(last.received_at).getTime(), id: last.id })
          : null;

      return reply.send({
        transmissions: page,
        scoped,
        nextCursor,
        hasMore,
        // The package `failuresOnly` filtered under, echoed as on the summary read.
        lens,
      });
    },
  );
}
