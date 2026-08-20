import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSignatures,
  generalizePath,
  isAdvisoryFinding,
  isIssue,
  isSignable,
  issueSignatures,
  sigKey,
  sigTitle,
  signaturesForReq,
  txMatchesSig,
} from './signatures.js';
import type { SignatureFinding, SignatureTransmission } from './signatures.js';

/** Build a SignatureFinding with sensible defaults; override what a test needs. */
function finding(over: Partial<SignatureFinding>): SignatureFinding {
  return {
    requirement: '3.2',
    severity: 'fail',
    detail: null,
    pointer: null,
    outdated: false,
    keyword: null,
    instancePath: null,
    param: null,
    code: null,
    ...over,
  };
}

/** Build a transmission with the given findings. */
function tx(
  id: string,
  received_at: string,
  source: string,
  findings: SignatureFinding[],
): SignatureTransmission {
  return { id, received_at, source, findings };
}

test('generalizePath strips array indices to /*', () => {
  assert.equal(generalizePath('/data/0/ABST'), '/data/*/ABST');
  assert.equal(generalizePath('/data/7/ABST'), '/data/*/ABST');
  assert.equal(generalizePath(null), '');
  assert.equal(generalizePath(''), '');
});

test('isIssue: fail is an issue; plain info/pass are not; outdated info IS', () => {
  assert.equal(isIssue(finding({ severity: 'fail' })), true);
  assert.equal(isIssue(finding({ severity: 'info', outdated: false })), false);
  assert.equal(isIssue(finding({ severity: 'pass' })), false);
  assert.equal(isIssue(finding({ severity: 'info', outdated: true })), true);
});

test('sigKey generalizes the path and never includes the offending value', () => {
  const f = finding({
    requirement: '3.2',
    keyword: 'format',
    instancePath: '/data/0/ABST',
    param: 'date-time',
    detail: 'Schema validation failed: "data/0/ABST" must match format "date-time".',
  });
  assert.equal(sigKey(f), '3.2|format|/data/*/ABST|date-time');
  // The offending instance value / index must not leak into the key.
  assert.ok(!sigKey(f).includes('/0/'));
});

test('sigKey: check-code findings key off req|code', () => {
  assert.equal(
    sigKey(finding({ requirement: '1.2', code: 'tx.missing_charset' })),
    '1.2|tx.missing_charset',
  );
});

test('sigKey: last-resort fallback uses req|detail when no keyword or code', () => {
  assert.equal(sigKey(finding({ requirement: '1.3', detail: 'auth failed' })), '1.3|auth failed');
});

test('sigTitle: schema keywords get templated titles', () => {
  assert.equal(
    sigTitle(finding({ keyword: 'required', param: 'EERR' })),
    'Missing required property EERR',
  );
  assert.equal(
    sigTitle(finding({ keyword: 'format', instancePath: '/data/0/ABST', param: 'date-time' })),
    'ABST must match format “date-time”',
  );
});

test('sigTitle: extended CODE_TITLE covers the non-prototype codes', () => {
  assert.equal(
    sigTitle(finding({ requirement: '2.1', code: 'tx.concurrent_delivery' })),
    'Concurrent delivery (expected serial)',
  );
  assert.equal(
    sigTitle(finding({ requirement: '3.4', code: 'tx.irregular_interval' })),
    'ABST reading cadence looks irregular',
  );
});

test('sigTitle: an uncoded finding falls back to detail then requirement', () => {
  assert.equal(
    sigTitle(finding({ requirement: '1.3', detail: 'auth failed', code: null })),
    'auth failed',
  );
  assert.equal(sigTitle(finding({ requirement: '1.3', detail: null, code: null })), '1.3');
});

test('computeSignatures: schema-keyword case aggregates count/txCount/sources/timestamps', () => {
  const f = (ip: string) => finding({ keyword: 'format', instancePath: ip, param: 'date-time' });
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [f('/data/0/ABST')]),
    tx('t2', '2026-06-17T14:05:00.000Z', 'kano', [f('/data/0/ABST')]),
  ]);
  assert.equal(sigs.length, 1);
  const s = sigs[0]!;
  assert.equal(s.kind, 'schema');
  assert.equal(s.req, '3.2');
  assert.equal(s.count, 2);
  assert.equal(s.txCount, 2);
  assert.equal(s.sourceCount, 2);
  assert.equal(s.first, '2026-06-17T14:00:00.000Z');
  assert.equal(s.last, '2026-06-17T14:05:00.000Z');
});

test('computeSignatures: check-code case groups by code', () => {
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [
      finding({ requirement: '1.2', code: 'tx.missing_charset', detail: 'no charset' }),
    ]),
  ]);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.kind, 'check');
  assert.equal(sigs[0]!.key, '1.2|tx.missing_charset');
  assert.equal(sigs[0]!.title, 'Content-Type missing “charset=utf-8”');
});

test('computeSignatures: outdated-info finding is grouped as a soft issue', () => {
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'kano', [
      finding({
        requirement: '3.2',
        severity: 'info',
        outdated: true,
        code: 'tx.outdated_schema',
        detail: 'validated against an outdated schema',
      }),
    ]),
  ]);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.sev, 'info');
  assert.equal(sigs[0]!.kind, 'check');
  assert.equal(sigs[0]!.title, 'Validated against an outdated schema');
});

test('computeSignatures: index-collapse — /data/0 and /data/7 fold into ONE signature', () => {
  const f = (ip: string) => finding({ keyword: 'format', instancePath: ip, param: 'date-time' });
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [f('/data/0/ABST'), f('/data/7/ABST')]),
  ]);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0]!.count, 2);
  // Same key for both indices — and the index never appears in the key.
  assert.equal(sigs[0]!.key, '3.2|format|/data/*/ABST|date-time');
  assert.ok(!sigs[0]!.key.includes('/0/') && !sigs[0]!.key.includes('/7/'));
});

test('computeSignatures: distinct signatures sorted by count DESC', () => {
  const fmt = finding({ keyword: 'format', instancePath: '/data/0/ABST', param: 'date-time' });
  const req = (rp: string) => finding({ keyword: 'required', instancePath: rp, param: 'EERR' });
  // 'format' appears 3x (across 2 tx), 'required' appears 1x.
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [fmt, fmt, req('/data/0')]),
    tx('t2', '2026-06-17T14:01:00.000Z', 'nairobi', [fmt]),
  ]);
  assert.equal(sigs.length, 2);
  assert.equal(sigs[0]!.count, 3);
  assert.equal(sigs[1]!.count, 1);
  // The higher-count signature comes first.
  assert.ok(sigs[0]!.count >= sigs[1]!.count);
});

test('computeSignatures: empty-string source counts as one stable unknown bucket', () => {
  const f = finding({ requirement: '1.2', code: 'tx.missing_charset' });
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', '', [f]),
    tx('t2', '2026-06-17T14:01:00.000Z', '', [f]),
  ]);
  assert.equal(sigs[0]!.sourceCount, 1);
});

test('signaturesForReq filters to a single requirement', () => {
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [
      finding({ requirement: '1.2', code: 'tx.missing_charset' }),
      finding({ requirement: '3.2', keyword: 'required', instancePath: '/data/0', param: 'EERR' }),
    ]),
  ]);
  assert.equal(signaturesForReq(sigs, '3.2').length, 1);
  assert.equal(signaturesForReq(sigs, '3.2')[0]!.req, '3.2');
  assert.equal(signaturesForReq(sigs, '9.9').length, 0);
});

test('txMatchesSig: true only when a tx carries an issue with the given key', () => {
  const t = tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [
    finding({ requirement: '1.2', code: 'tx.missing_charset' }),
    // A plain info finding is NOT an issue and must not match.
    finding({ requirement: '1.8', severity: 'info', outdated: false, detail: 'repeat candidate' }),
  ]);
  assert.equal(txMatchesSig(t, '1.2|tx.missing_charset'), true);
  assert.equal(txMatchesSig(t, '3.2|format|/data/*/ABST|date-time'), false);
  // The non-issue info finding's key must not match either.
  assert.equal(txMatchesSig(t, '1.8|repeat candidate'), false);
});

/* ── ADVISORY SIGNATURES (agj.15) ─────────────────────────────────────────────
 *
 * Advisories fold into the SAME signature set so the one ?signatureKey= list
 * cross-filter serves them, while staying out of everything that counts defects.
 * The fixtures below build advisories in the production shape: severity 'info',
 * outdated false, and the adv.* id in BOTH `requirement` and `code`. */

/** An advisory finding as src/ingest/stages/semantic/advisory.ts emits one. */
function adv(id: string, over: Partial<SignatureFinding> = {}): SignatureFinding {
  return finding({ requirement: id, code: id, severity: 'info', outdated: false, ...over });
}

test('isAdvisoryFinding: adv.* in requirement or code; §7 findings are not advisories', () => {
  assert.equal(isAdvisoryFinding(adv('adv.null_padding')), true);
  assert.equal(isAdvisoryFinding(finding({ requirement: 'adv.sample_gap', code: null })), true);
  assert.equal(isAdvisoryFinding(finding({ requirement: '3.2', code: 'adv.sample_gap' })), true);
  assert.equal(
    isAdvisoryFinding(finding({ requirement: '1.2', code: 'tx.missing_charset' })),
    false,
  );
  assert.equal(isAdvisoryFinding(finding({ requirement: '3.2', keyword: 'required' })), false);
});

test('isIssue STILL excludes advisories — they are not defects', () => {
  assert.equal(isIssue(adv('adv.null_padding')), false);
  assert.equal(isIssue(adv('adv.date_format')), false);
  // isSignable is the wider gate: issues OR advisories.
  assert.equal(isSignable(adv('adv.null_padding')), true);
  assert.equal(isSignable(finding({ severity: 'fail' })), true);
  assert.equal(isSignable(finding({ severity: 'info', outdated: false })), false);
});

test('sigKey: an advisory keys as adv|<adv.id>, never off a requirement', () => {
  assert.equal(sigKey(adv('adv.null_padding')), 'adv|adv.null_padding');
  // The pointer/detail of an instance never enters the key.
  assert.equal(
    sigKey(adv('adv.null_padding', { pointer: '/data/0/records/7/TCON', detail: 'TCON was null' })),
    'adv|adv.null_padding',
  );
  // Two different advisories are two different keys.
  assert.notEqual(sigKey(adv('adv.sample_gap')), sigKey(adv('adv.date_format')));
});

test('sigTitle: an advisory id derives a human label', () => {
  assert.equal(sigTitle(adv('adv.null_padding')), 'Null padding');
  assert.equal(sigTitle(adv('adv.time_not_increasing')), 'Time not increasing');
  // Derivation, not a table: an id nobody has seen yet still renders as words.
  assert.equal(sigTitle(adv('adv.brand_new_check')), 'Brand new check');
});

test('computeSignatures: advisories fold with kind advisory, sev info, req ""', () => {
  const a = adv('adv.null_padding', { pointer: '/data/0/records/0/TCON' });
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [a]),
    tx('t2', '2026-06-17T14:05:00.000Z', 'mombasa', [a]),
  ]);
  assert.equal(sigs.length, 1);
  const sig = sigs[0]!;
  assert.equal(sig.key, 'adv|adv.null_padding');
  assert.equal(sig.kind, 'advisory');
  assert.equal(sig.sev, 'info');
  assert.equal(sig.req, '', 'an advisory belongs to no §7 requirement');
  assert.equal(sig.title, 'Null padding');
  assert.equal(sig.count, 2);
  assert.equal(sig.txCount, 2);
  assert.equal(sig.sourceCount, 2);
  assert.equal(sig.first, '2026-06-17T14:00:00.000Z');
  assert.equal(sig.last, '2026-06-17T14:05:00.000Z');
  assert.equal(sig.examplePointer, '/data/0/records/0/TCON');
});

test('computeSignatures: advisories never displace or merge with issue signatures', () => {
  const fail = finding({ requirement: '1.2', code: 'tx.missing_charset' });
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [fail, adv('adv.sample_gap')]),
  ]);
  assert.equal(sigs.length, 2);
  assert.deepEqual(
    sigs.map((s) => s.kind).sort(),
    ['advisory', 'check'],
    'one issue signature and one advisory signature, side by side',
  );
  // The defect half is what any grading count reads.
  assert.deepEqual(
    issueSignatures(sigs).map((s) => s.key),
    ['1.2|tx.missing_charset'],
    'issueSignatures drops advisories',
  );
});

test('signaturesForReq NEVER returns an advisory signature', () => {
  const sigs = computeSignatures([
    tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [
      finding({ requirement: '3.2', keyword: 'required', instancePath: '/data/0', param: 'EERR' }),
      adv('adv.null_padding'),
    ]),
  ]);
  assert.equal(signaturesForReq(sigs, '3.2').length, 1);
  assert.equal(signaturesForReq(sigs, '3.2')[0]!.kind, 'schema');
  // Not under the empty-string sentinel either — advisories are not a requirement.
  assert.equal(signaturesForReq(sigs, '').length, 0, 'the "" sentinel is not a requirement');
  assert.equal(signaturesForReq(sigs, 'adv.null_padding').length, 0);
});

test('txMatchesSig: an advisory key matches a tx with ZERO failures', () => {
  // A fully conformant transmission that merely carries an observation.
  const clean = tx('t1', '2026-06-17T14:00:00.000Z', 'nairobi', [
    finding({ requirement: '3.2', severity: 'pass' }),
    adv('adv.null_padding'),
  ]);
  assert.equal(txMatchesSig(clean, 'adv|adv.null_padding'), true);
  assert.equal(txMatchesSig(clean, 'adv|adv.sample_gap'), false);
  // A failing tx without that advisory does not match it.
  const failing = tx('t2', '2026-06-17T14:01:00.000Z', 'nairobi', [
    finding({ requirement: '1.2', code: 'tx.missing_charset' }),
  ]);
  assert.equal(txMatchesSig(failing, 'adv|adv.null_padding'), false);
  assert.equal(txMatchesSig(failing, '1.2|tx.missing_charset'), true);
});
