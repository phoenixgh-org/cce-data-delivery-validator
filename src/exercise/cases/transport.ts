/**
 * TRANSPORT-domain exercise cases — the §1.x requirements graded from HOW a
 * transmission is delivered: method, content type, credential, size, encoding.
 *
 * OWNERSHIP: this file is the transport table (8qa.3). Payload cases live in
 * ./payload.ts and the sequence heuristics in ./sequence.ts; ../cases.ts is the
 * index that concatenates the three into `EXERCISE_CASES`. Keeping the domains in
 * separate files is what lets the per-requirement tables grow in parallel without
 * three bites editing one array.
 *
 * A §1.3 case must declare `setup: 'auth-enabled'` — the session has to opt into
 * auth before the credential wrappers mean anything, and the runner plays those
 * cases last for the reason documented on {@link ExerciseCase.setup}. The
 * table-wide invariant in ../cases.test.ts enforces the declaration.
 *
 * ── where the expected statuses and findings come from ──────────────────────
 * Every expectation below is READ OFF THE PIPELINE, not off the requirement
 * prose (src/ingest/route.ts orders the stages; each stage owns its status):
 *
 *   §1.1  method stage halts 405 pre-persistence (no row, no finding — the
 *         status IS the grade); parse stage records a §1.1 pass on a clean
 *         UTF-8 JSON body and a §1.1 fail + 400 otherwise.
 *   §1.2  content-type stage NEVER halts (415 is optional per §6): it records a
 *         §1.2 pass on exactly `application/json; charset=utf-8` — matched
 *         case-insensitively — and a §1.2 fail on anything else, then continues
 *         to the schema stage, so a §1.2 fail still lands on a 200.
 *   §1.3  auth stage is a no-op INFO note while the session has not opted in;
 *         once enabled it records a §1.3 pass on a good credential, or a §1.3
 *         fail + 401 on a missing/wrong/misschemed one. That 401 is the one
 *         pre-body halt that still PERSISTS a row (route.ts special-cases
 *         `haltedAt === 'auth'`), which is why the fail cases below can expect a
 *         finding rather than a bare status.
 *   §1.4  size stage measures the exact WIRE bytes: ≤1MB records a §1.4 pass and
 *         continues, over it records a §1.4 fail and halts 413.
 *   §1.6  encoding stage records a §1.6 pass for one clean gzip layer, and a
 *         §1.6 fail + 400 for an undecodable body, a gzip-of-gzip, or any
 *         non-gzip `Content-Encoding` token.
 *
 * NOT COVERED HERE, deliberately: §1.5 (📝 self-attestation) and §1.7 (nothing
 * to grade — `customHeader()` exists to demonstrate the permissive path, but a
 * case targeting §1.7 could never show a finding to back the claim).
 */

import type { ExerciseCase } from '../case.js';
import {
  badAuth,
  bearerCredential,
  contentType,
  doubleGzip,
  gzip,
  method,
  noAuth,
  oversize,
  unparseableBody,
  unsupportedEncoding,
} from '../transforms/transport.js';

export const TRANSPORT_CASES: readonly ExerciseCase[] = [
  // ── §1.1 method + parseability ────────────────────────────────────────────
  {
    id: '1.1-pass-post-utf8-json',
    title: 'The canonical POST of a UTF-8 JSON body parses cleanly and passes §1.1',
    requirements: ['1.1'],
    direction: 'pass',
    // No transforms: the untouched baseline IS the §1.1 happy path — POST, JSON
    // body, no encoding. (HTTPS, §1.1's other half, is 🔒 enforced at the edge
    // and is not a test of the supplier — see COMPLIANCE_MATRIX row 1.1.)
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.1', severity: 'pass' }],
  },
  {
    id: '1.1-fail-wrong-method',
    title: 'A PUT to the ingest path is refused 405 with no transmission recorded',
    requirements: ['1.1'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'PUT instead of POST' },
    posts: [{ transforms: [method('PUT')], expectedStatus: 405 }],
    // Graded by STATUS alone: a 405 halts before persistence, so no finding is
    // written. A case may legitimately expect no findings at all.
    expectedFindings: [],
  },
  {
    id: '1.1-fail-unparseable-body',
    title: 'A body that is not JSON is rejected 400 with a §1.1 fail',
    requirements: ['1.1'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'body bytes truncated to malformed JSON' },
    posts: [{ transforms: [unparseableBody()], expectedStatus: 400 }],
    expectedFindings: [{ requirement: '1.1', severity: 'fail' }],
  },

  // ── §1.2 content type ─────────────────────────────────────────────────────
  {
    id: '1.2-pass-json-utf8',
    title: 'application/json; charset=utf-8 passes §1.2 regardless of header casing',
    requirements: ['1.2'],
    direction: 'pass',
    // Sent upper-cased on purpose: RFC 7231 media types and parameter values are
    // case-insensitive and the content-type stage lower-cases both before
    // comparing, so this is a genuine pass rather than a restatement of the
    // baseline header — and it pins that leniency against a future regression.
    posts: [{ transforms: [contentType('APPLICATION/JSON; CHARSET=UTF-8')], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.2', severity: 'pass' }],
  },
  {
    id: '1.2-fail-content-type',
    title: 'text/plain earns a §1.2 fail without short-circuiting the pipeline',
    requirements: ['1.2'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'Content-Type: text/plain instead of application/json' },
    // 415 is optional per §6, so the run continues and still reaches 200.
    posts: [{ transforms: [contentType('text/plain')], expectedStatus: 200 }],
    expectedFindings: [
      { requirement: '1.2', severity: 'fail' },
      { requirement: '3.2', severity: 'pass' },
    ],
  },

  // ── §1.3 authorization (opt-in) ───────────────────────────────────────────
  // All three declare `setup: 'auth-enabled'`: the auth stage only grades on a
  // session that opted in, and the runner plays these last because the opt-in is
  // sticky and session-global (../case.ts, ../runner/run.ts). The FAIL pair needs
  // the declaration as much as the pass does — with auth off, a credential-less
  // POST is a plain 200 carrying a §1.3 INFO note, not the 401 they assert.
  {
    id: '1.3-pass-bearer-credential',
    title: 'The configured Bearer credential authorizes the POST and passes §1.3',
    requirements: ['1.3'],
    direction: 'pass',
    setup: 'auth-enabled',
    // `bearerCredential()` throws unless the runner supplied the session's
    // show-once token, so this case cannot even materialize without the setup.
    posts: [{ transforms: [bearerCredential()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.3', severity: 'pass' }],
  },
  {
    id: '1.3-fail-missing-credential',
    title: 'No Authorization header on an auth-enabled session is a §1.3 fail + 401',
    requirements: ['1.3'],
    direction: 'fail',
    setup: 'auth-enabled',
    fault: {
      layer: 'transport',
      note: 'Authorization header omitted from an auth-enabled session',
    },
    // 401 is the ONE pre-body halt that still writes a transmission row, so the
    // §1.3 fail finding really is readable back from the dashboard (route.ts).
    posts: [{ transforms: [noAuth()], expectedStatus: 401 }],
    expectedFindings: [{ requirement: '1.3', severity: 'fail' }],
  },
  {
    id: '1.3-fail-wrong-credential',
    title: 'A Bearer token that is not the configured one is a §1.3 fail + 401',
    requirements: ['1.3'],
    direction: 'fail',
    setup: 'auth-enabled',
    fault: { layer: 'transport', note: 'Bearer scheme carrying an incorrect token' },
    // Distinct from the missing-credential case on purpose: the stage reports
    // "incorrect token" vs "no header detected", and a supplier debugging §1.3
    // needs both halves of that distinction to be exercised.
    posts: [{ transforms: [badAuth()], expectedStatus: 401 }],
    expectedFindings: [{ requirement: '1.3', severity: 'fail' }],
  },

  // ── §1.4 size ─────────────────────────────────────────────────────────────
  {
    id: '1.4-pass-within-cap',
    title: 'An ordinary body is measured against the 1MB wire cap and passes §1.4',
    requirements: ['1.4'],
    direction: 'pass',
    // The baseline is a few hundred bytes, so this is a comfortable pass rather
    // than an at-the-boundary one. A true at-cap case (exactly 1MB of wire bytes,
    // still schema-valid) would need a padding wrapper the vocabulary does not
    // have yet; the boundary itself is already pinned by the size stage's own
    // unit tests (src/ingest/stages/body-stages.test.ts).
    posts: [{ expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.4', severity: 'pass' }],
  },
  {
    id: '1.4-fail-oversize-body',
    title: 'A body one byte over the 1MB cap is rejected 413',
    requirements: ['1.4'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'body padded to 1MB + 1 byte' },
    posts: [{ transforms: [oversize()], expectedStatus: 413 }],
    expectedFindings: [{ requirement: '1.4', severity: 'fail' }],
  },

  // ── §1.6 content encoding ─────────────────────────────────────────────────
  {
    id: '1.6-pass-gzip',
    title: 'A single gzip layer declared via Content-Encoding decodes cleanly',
    requirements: ['1.6'],
    direction: 'pass',
    posts: [{ transforms: [gzip()], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '1.6', severity: 'pass' }],
  },
  {
    id: '1.6-fail-double-gzip',
    title: 'A gzip member that decompresses to another gzip member is rejected 400',
    requirements: ['1.6'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'gzip-of-gzip under a single Content-Encoding: gzip' },
    posts: [{ transforms: [doubleGzip()], expectedStatus: 400 }],
    expectedFindings: [{ requirement: '1.6', severity: 'fail' }],
  },
  {
    id: '1.6-fail-unsupported-encoding',
    title: 'A Content-Encoding we cannot decode (br) is rejected 400 before any parse',
    requirements: ['1.6'],
    direction: 'fail',
    fault: { layer: 'transport', note: 'Content-Encoding: br declared over an unencoded body' },
    // The stage rejects on the TOKEN alone — only gzip (and the no-op identity)
    // is decodable — so the body deliberately stays plain JSON: what is graded is
    // the declared encoding, not whether the bytes are really brotli.
    posts: [{ transforms: [unsupportedEncoding('br')], expectedStatus: 400 }],
    expectedFindings: [{ requirement: '1.6', severity: 'fail' }],
  },
];
