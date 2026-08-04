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
 */

import type { ExerciseCase } from '../case.js';
import {
  contentType,
  doubleGzip,
  gzip,
  method,
  oversize,
  unparseableBody,
} from '../transforms/transport.js';

export const TRANSPORT_CASES: readonly ExerciseCase[] = [
  // ── §1.1 method + parseability ────────────────────────────────────────────
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

  // ── §1.4 size ─────────────────────────────────────────────────────────────
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
];
