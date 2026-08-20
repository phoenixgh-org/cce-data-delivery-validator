/**
 * The compliance column's ADVISORIES section (agj.16) — and the two-sided
 * exclusion that lets it exist.
 *
 * Advisories moved INTO the verdict column, which is the one place the category
 * has always been kept out of. That is safe only because the split is explicit
 * on both sides of the same signature set, and the claims below are exactly the
 * ones a reader cannot get from the types:
 *
 *   1. THE SECTION IS THE ONLY DOOR. `advisorySignatures` selects them and
 *      `signaturesForReq` refuses them, so an advisory can reach the column only
 *      as its own section — never as a requirement's "distinct issue", and never
 *      in the count beside a §7 row. The `kind` guard is asserted against a
 *      hostile advisory carrying a real requirement id (agj.19): `req` is '' in
 *      production and the equality alone would pass today, which is precisely
 *      why the guard needs a test that does not rely on the sentinel.
 *   2. PICKING ONE CROSS-FILTERS AND NOTHING ELSE. The rows are the same
 *      {@link SigRow} as a requirement's, so `onPick` hands the advisory
 *      Signature to `onSelectSignature` unchanged — the Dashboard then sets the
 *      list filter alone. It must not imply failures-only: an advisory-only
 *      transmission has zero failures and would vanish from its own cross-filter
 *      (pinned server-side in src/api/sessions.test.ts).
 *   3. NO STATUS COLOUR. An advisory carries `sev: 'info'`, which without a
 *      `kind` branch falls through to the `--mixed` amber that means
 *      *warning / outdated* everywhere else on this dashboard — "a lesser
 *      defect" on the one surface that must not say defect (DESIGN §7.1).
 *   4. EMPTY MEANS ABSENT. No advisories → the section returns null, header and
 *      all, so a conformant session's column looks exactly as it did before.
 *
 * Like Setup.test.ts / TransmissionsCard.test.ts this reaches pure functions
 * only — the repo has no component-test harness. {@link AdvisorySection} is
 * hook-free by design (its collapse state is the parent's), so it can be CALLED
 * as a plain function and its returned element tree walked for the rows; nothing
 * here mounts or renders. The global React binding plus the dynamic import are
 * the same shim Setup.test.ts explains: src/web has no jsx tsconfig, so esbuild
 * uses the classic `React.createElement` transform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';

import type { Signature } from '../api';

(globalThis as unknown as { React: typeof React }).React = React;

const { AdvisorySection, SigRow, advisorySignatures, signaturesForReq, sigTone } =
  await import('./ComplianceCard.js');

/** A signature as the server rolls one; `over` states only what a test varies. */
function sig(over: Partial<Signature> = {}): Signature {
  return {
    key: '3.2|required|/data|CID',
    req: '3.2',
    title: 'Missing required property CID',
    kind: 'check',
    sev: 'fail',
    count: 3,
    txCount: 2,
    sourceCount: 1,
    first: '2026-08-19T12:00:00Z',
    last: '2026-08-20T12:00:00Z',
    examplePointer: null,
    ...over,
  };
}

/** An advisory signature: `kind: 'advisory'`, `adv|<id>` key, '' req, info sev. */
function adv(id: string, over: Partial<Signature> = {}): Signature {
  return sig({ key: `adv|${id}`, req: '', title: id, kind: 'advisory', sev: 'info', ...over });
}

/** Every SigRow element in a returned tree, in render order. */
function sigRows(node: unknown): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!React.isValidElement(n)) return;
    if (n.type === SigRow) found.push(n);
    walk((n.props as { children?: unknown }).children);
  };
  walk(node);
  return found;
}

/** The section's props, defaulted so each test states only what it varies. */
function section(
  signatures: Signature[],
  over: Partial<Parameters<typeof AdvisorySection>[0]> = {},
): ReturnType<typeof AdvisorySection> {
  return AdvisorySection({
    signatures,
    collapsed: false,
    onToggle: () => {},
    activeSignatureKey: null,
    ...over,
  });
}

test('the section renders one row per advisory, most-observed first', () => {
  const rows = sigRows(
    section([
      sig(),
      adv('adv.null_padding', { count: 2 }),
      adv('adv.date_format', { count: 9 }),
      sig({ key: '1.5|tx.missing_charset', req: '1.5' }),
    ]),
  );

  assert.deepEqual(
    rows.map((r) => (r.props as { sig: Signature }).sig.key),
    ['adv|adv.date_format', 'adv|adv.null_padding'],
  );
});

test('ties order by key, so the section does not reshuffle between polls', () => {
  // computeSignatures sorts on count alone; ties keep Map insertion order, which
  // follows whichever transmission happened to arrive first.
  const ordered = advisorySignatures([
    adv('adv.zebra', { count: 4 }),
    adv('adv.alpha', { count: 4 }),
  ]).map((s) => s.key);

  assert.deepEqual(ordered, ['adv|adv.alpha', 'adv|adv.zebra']);
  // Same set, opposite arrival order — same rendering.
  assert.deepEqual(
    advisorySignatures([adv('adv.alpha', { count: 4 }), adv('adv.zebra', { count: 4 })]).map(
      (s) => s.key,
    ),
    ordered,
  );
});

test('picking an advisory row hands the signature straight to onSelectSignature', () => {
  const picked: Signature[] = [];
  const advisory = adv('adv.null_identity');
  const rows = sigRows(
    section([sig(), advisory], { onSelectSignature: (s: Signature) => picked.push(s) }),
  );

  const row = rows[0];
  assert.ok(row);
  const props = row.props as { sig: Signature; onPick: (s: Signature) => void };
  props.onPick(props.sig);

  // The whole Signature, unchanged — the Dashboard sets ?signatureKey= from its
  // `key` and touches nothing else. In particular no failuresOnly: an
  // advisory-only transmission has zero failures and would disappear from the
  // very filter this click just set.
  assert.deepEqual(picked, [advisory]);
});

test('the active row is the one whose key matches the cross-filter', () => {
  const rows = sigRows(
    section([adv('adv.null_padding', { count: 2 }), adv('adv.date_format', { count: 9 })], {
      activeSignatureKey: 'adv|adv.null_padding',
    }),
  );

  assert.deepEqual(
    rows.map((r) => (r.props as { active: boolean }).active),
    [false, true],
  );
});

test('a requirement never groups an advisory, sentinel or not', () => {
  // agj.19: `req` is '' in production, so the equality alone excludes advisories
  // today and this hostile case cannot arise — the point of the `kind` guard is
  // that it stays excluded if one is ever given a requirement to group under.
  const hostile = adv('adv.null_padding', { req: '3.2' });
  const real = sig();

  assert.deepEqual(signaturesForReq([real, hostile], '3.2'), [real]);
  assert.deepEqual(signaturesForReq([adv('adv.null_padding')], ''), []);
  // And the section takes only the other half.
  assert.deepEqual(advisorySignatures([real, hostile]), [hostile]);
});

test('an advisory row takes the accent, never a status colour', () => {
  // sev is 'info' on every advisory, which is the --mixed amber for a verdict
  // signature (an outdated-schema §3.2 finding). Advisories must not borrow it.
  assert.equal(sigTone(adv('adv.null_padding')), 'var(--accent-text)');
  assert.equal(sigTone(sig({ sev: 'fail' })), 'var(--fail)');
  assert.equal(sigTone(sig({ sev: 'info' })), 'var(--mixed)');
});

test('no advisories renders no section at all — not an empty one', () => {
  assert.equal(section([]), null);
  assert.equal(section([sig(), sig({ key: '1.5|tx.missing_charset', req: '1.5' })]), null);
  // Collapsed is a different thing from absent: the header still renders.
  assert.notEqual(section([adv('adv.null_padding')], { collapsed: true }), null);
  assert.deepEqual(sigRows(section([adv('adv.null_padding')], { collapsed: true })), []);
});
