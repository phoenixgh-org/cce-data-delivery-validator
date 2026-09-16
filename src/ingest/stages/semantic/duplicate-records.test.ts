/**
 * `adv.duplicate_records` — the advisory for the same record delivered twice
 * inside ONE transmission (agj.8, epic agj).
 *
 * The acceptance sentence from agj.8 is that records within a report sharing an
 * ABST, and separately records that are deep-equal, raise ONE finding per
 * transmission carrying the counts and a pointer to the first repeat; that a
 * conformant baseline stays silent; and that §1.8's verdict is unchanged. All of
 * that is measured here against the REAL machinery rather than asserted — the
 * fixtures are validated by the real `SchemaRegistry`, run through the real §6
 * body stages for their 200 and their zero fail findings, and §1.8 is graded by
 * the real `duplicateCheck` on the very payload that raises this advisory.
 *
 * The §1.8 pin is the load-bearing half. §1.8 compares the sha256 of the RAW BODY
 * and `meta.transferId` against earlier transmissions in the session — both
 * properties of the envelope — so a payload carrying the same record twice is
 * byte-novel and earns its §1.8 PASS. The duplicate-carrying fixture below is
 * graded by the real duplicate check and earns a §1.8 finding INDISTINGUISHABLE
 * from the one the clean fixture earns, which is simultaneously the proof that
 * the blind spot is real and the proof that this module did not disturb it.
 *
 * The other pinned interaction is with `adv.time_not_increasing`: PQS's example
 * (a chunk of records re-appended to the previous file) raises BOTH, and agj.8
 * says explicitly that neither is suppressed for the other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComplianceSummary } from '../../../api/compliance-matrix.js';
import { SchemaRegistry } from '../../../schema-registry.js';
import { runPipeline, type Finding, type PipelineContext, type Stage } from '../../pipeline.js';
import { contentTypeStage } from '../content-type.js';
import { encodingStage } from '../encoding.js';
import { parseStage } from '../parse.js';
import { schemaStage } from '../schema.js';
import { semanticStage, type SemanticDeps } from '../semantic.js';
import { sizeStage } from '../size.js';
import { isAdvisoryId } from './advisory.js';
import { duplicateRecordsCheck } from './duplicate-records.js';
import { duplicateCheck } from './duplicate.js';
import { intervalCheck } from './interval.js';
import { timeOrderCheck } from './time-order.js';

const JSON_UTF8 = 'application/json; charset=utf-8';

/** The real registry — load() is synchronous and DB-free. */
const registry = SchemaRegistry.load();

const deps: SemanticDeps = {
  concurrentAtEntry: 1,
  findPriorTransmissions: async () => [],
};

// ── fixtures ────────────────────────────────────────────────────────────────

/** A compact ABST `offsetSeconds` after 2024-01-15T03:30:00Z. */
function abstAt(offsetSeconds: number): string {
  const total = 3 * 3600 + 30 * 60 + offsetSeconds;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `20240115T${pad(Math.floor(total / 3600))}${pad(Math.floor((total % 3600) / 60))}${pad(
    total % 60,
  )}Z`;
}

/** One conformant EMS record stamped at `abst`, with `tvc` as its reading. */
function emsRecord(abst: unknown, tvc = 4.7): Record<string, unknown> {
  return {
    ABST: abst,
    ALRM: null,
    BEMD: 13.2,
    BLOG: 367,
    CMPR: 320,
    DORV: 0,
    EERR: null,
    LERR: null,
    SVA: 900,
    TAMB: 23.1,
    TVC: tvc,
  };
}

/** A schema-valid EMS transmission whose ONE report carries the given records. */
function emsPayload(records: readonly unknown[]): Record<string, unknown> {
  return emsPayloadReports([records]);
}

/** The same, for several reports — each an independent series. */
function emsPayloadReports(reports: readonly (readonly unknown[])[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'ems',
      transferId: 'T-duplicate-records-ems',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: reports.map((records) => ({
      CID: 'US',
      ADOP: '2020-12-01',
      AMFR: 'Alpha Fridge, Inc',
      AMOD: 'FRIDGE-100',
      APQS: 'E003/998',
      ASER: 'A-SerialNum',
      EDOP: '2021-06-01',
      EMFR: 'EMD_Name',
      EMOD: 'EMD-ModelNo',
      EPQS: 'E006/999',
      ESER: 'EMD-SerialNum',
      EMSV: 'v01.02.123',
      LSV: 'v01.02.008',
      LDOP: '2021-08-15',
      LMFR: 'Logger_Co',
      LMOD: 'Logger_Model',
      LPQS: 'E006/998',
      LSER: 'log4567890asdf',
      CDAT: '2021-06-01',
      CDAT2: '2021-06-02',
      records: [...records],
    })),
  };
}

/** One conformant RTMD record — the other record branch. */
function rtmdRecord(abst: unknown, tvc = 3.2): Record<string, unknown> {
  return { ABST: abst, ALRM: 'HEAT', BEMD: 14.3, EERR: 'none', TVC: tvc };
}

/** A schema-valid RTMD transmission carrying the given records. */
function rtmdPayload(records: readonly unknown[]): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: '0.8.1',
      transferType: 'rtm',
      transferId: 'T-duplicate-records-rtm',
      transferSrc: 'com.example',
      transferredAt: '2024-01-15T04:05:54Z',
    },
    data: [
      {
        AMID: 'appliance-1',
        CID: 'US',
        EDOP: '2021-06-01',
        EMFR: 'EMD_Name',
        EMOD: 'EMD-ModelNo',
        EPQS: 'E006/999',
        ESER: 'EMD-SerialNum',
        EMSV: 'v01.02.123',
        DLST: { TVC: { SID: 'sensor-1', SMFR: 'SensMfr', SMOD: 'SensMod' } },
        records: [...records],
      },
    ],
  };
}

/**
 * A conformant series: 20 distinct readings at the 900 s period, each with its
 * own TVC. Twenty rather than three so that ONE re-appended record leaves §3.4's
 * cadence pass intact — a repeat contributes an interval of ZERO to the sorted
 * series, and a short series has too little spread to absorb it. That keeps the
 * fixture what an advisory fixture has to be: a payload that breaks no rule.
 */
const CLEAN = Array.from({ length: 20 }, (_, i) => emsRecord(abstAt(i * 900), 4.5 + i / 10));

/**
 * PQS's shape: a record from earlier in the file re-appended at its end, so the
 * same record arrives twice AND the series steps backwards at the join. Both
 * observations are owed on this payload, and neither is suppressed for the other.
 */
const RE_APPENDED = [...CLEAN, CLEAN[10]!];

// ── harnesses ───────────────────────────────────────────────────────────────

function makeCtx(payload: unknown, transferType = 'ems'): PipelineContext {
  return {
    request: {} as PipelineContext['request'],
    sessionUuid: 'duplicate-records-session',
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    registry,
    findings: [],
    parsedBody: null,
    meta: { transferType, transferId: 'T-duplicate-records' },
    normalizedSchemaVersion: null,
    primaryProfile: null,
    shadowProfile: null,
    contentType: JSON_UTF8,
    contentEncoding: null,
    parseOk: null,
    schemaOk: null,
  };
}

/** The §6 body stages in route order (mirrors sample-gap.test.ts's harness). */
function bodyStages(): Stage[] {
  return [
    sizeStage(),
    contentTypeStage(),
    encodingStage(),
    parseStage(),
    schemaStage(),
    semanticStage(deps),
  ];
}

/** Drive the check alone against an already-parsed body (unit cases). */
function checkOnly(payload: unknown, transferType = 'ems'): Finding[] {
  const ctx = makeCtx(payload, transferType);
  ctx.parsedBody = payload;
  ctx.parseOk = true;
  ctx.schemaOk = true;
  return duplicateRecordsCheck(ctx);
}

function advisories(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => f.requirement === 'adv.duplicate_records');
}

/** The one finding, or a failed assertion naming the payload that stayed silent. */
function only(payload: unknown, transferType = 'ems'): Finding {
  const raised = advisories(checkOnly(payload, transferType));
  assert.equal(raised.length, 1, 'exactly one finding per transmission');
  return raised[0]!;
}

/** Tally findings into the `countsByRequirement` shape the §7 join consumes. */
function countsOf(
  findings: readonly Finding[],
): Record<string, { pass: number; fail: number; info: number }> {
  const counts: Record<string, { pass: number; fail: number; info: number }> = {};
  for (const f of findings) {
    counts[f.requirement] ??= { pass: 0, fail: 0, info: 0 };
    counts[f.requirement]![f.severity] += 1;
  }
  return counts;
}

// ── the gap this advisory exists for ────────────────────────────────────────

test('THE GAP: a record delivered twice is schema-valid on both record branches', () => {
  // The premise, measured rather than assumed: each record is validated against
  // `ems-record`/`rtmd-record` on its own and the schema has no vocabulary for a
  // record's relationship to its siblings, so a repeat validates cleanly.
  const entry = registry.get('0.8.1');
  assert.ok(entry, '0.8.1 is registered');
  const payloads = [
    emsPayload(RE_APPENDED),
    rtmdPayload([rtmdRecord(abstAt(0)), rtmdRecord(abstAt(0))]),
  ];
  for (const payload of payloads) {
    assert.equal(
      entry.validate(payload),
      true,
      `Ajv has nothing to say about a repeated record: ${JSON.stringify(entry.validate.errors)}`,
    );
  }
});

test('THE GAP: §1.8 grades the envelope, so the duplicate-carrying payload passes it', async () => {
  // duplicate.ts hashes the RAW BODY and compares transferIds against earlier
  // transmissions in the session. A payload that repeats a record inside itself
  // has bytes nobody has sent and an id nobody has used, so §1.8 can only pass —
  // which is exactly the blind spot agj.8 covers.
  const ctx = makeCtx(emsPayload(RE_APPENDED));
  ctx.parsedBody = emsPayload(RE_APPENDED);
  const [duplicate] = await duplicateCheck(ctx, deps);
  assert.equal(duplicate?.requirement, '1.8');
  assert.equal(duplicate?.severity, 'pass', 'the transmission itself is novel');
});

// ── acceptance: it fires on a fully conformant payload ──────────────────────

test('it fires through the real §6 body stages on a 200 with zero fail findings', async () => {
  const ctx = makeCtx(emsPayload(RE_APPENDED));
  const result = await runPipeline(ctx, bodyStages());

  assert.equal(result.status, 200);
  assert.equal(
    result.findings.filter((f) => f.severity === 'fail').length,
    0,
    `expected no fail findings, got ${JSON.stringify(result.findings.filter((f) => f.severity === 'fail'))}`,
  );

  const raised = advisories(result.findings);
  assert.equal(raised.length, 1, 'one finding per transmission');
  assert.equal(raised[0]?.severity, 'info');
  assert.equal(raised[0]?.code, 'adv.duplicate_records', 'the adv.* id rides in code too');
  assert.ok(!raised[0]?.outdated, 'never outdated — that would file it as a defect');
});

test('a report of distinct records stays silent, on both branches', () => {
  assert.deepEqual(advisories(checkOnly(emsPayload(CLEAN))), []);
  assert.deepEqual(
    advisories(
      checkOnly(rtmdPayload([rtmdRecord(abstAt(0), 3.2), rtmdRecord(abstAt(900), 3.3)]), 'rtm'),
    ),
    [],
  );
  assert.deepEqual(advisories(checkOnly(emsPayload([emsRecord(abstAt(0))]))), [], 'a lone record');
});

test('a repeat is observed on the RTMD branch too', () => {
  // rtmd-report carries a different record shape, but "a reading delivered
  // twice" is a statement about the series rather than about a device class.
  const finding = only(
    rtmdPayload([rtmdRecord(abstAt(0)), rtmdRecord(abstAt(900)), rtmdRecord(abstAt(0))]),
    'rtm',
  );
  assert.equal(finding.pointer, '/data/0/records/2');
});

// ── what the finding has to carry ───────────────────────────────────────────

test('it carries BOTH counts and points at the first repeat', () => {
  // Six records: /2 repeats /0's ABST with a different reading (same-ABST only),
  // /4 is /1 all over again (both signals), /5 repeats /0's ABST as well.
  const finding = only(
    emsPayload([
      emsRecord(abstAt(0), 4.7),
      emsRecord(abstAt(900), 4.8),
      emsRecord(abstAt(0), 5.1),
      emsRecord(abstAt(1800), 4.9),
      emsRecord(abstAt(900), 4.8),
      emsRecord(abstAt(0), 5.4),
    ]),
  );
  // The two counts do NOT sum: the record that is identical in full is also one
  // of the three that repeat an ABST.
  assert.equal(
    finding.summary,
    '3 records repeat an earlier record in the same report — 3 by ABST, 1 identical in full.',
  );
  assert.equal(finding.pointer, '/data/0/records/2', 'and the pointer is the first repeat');
});

test('same ABST with different content is counted, and named as the weaker signal', () => {
  const finding = only(emsPayload([emsRecord(abstAt(0), 4.7), emsRecord(abstAt(0), 5.5)]));
  // An absent signal is written as 0 rather than as "none", so the line keeps
  // one shape whichever comparison fired.
  assert.equal(
    finding.summary,
    '1 record repeats an earlier record in the same report — 1 by ABST, 0 identical in full.',
  );
});

test('an identical record is named as identical in full', () => {
  const finding = only(emsPayload(RE_APPENDED));
  assert.equal(
    finding.summary,
    '1 record repeats an earlier record in the same report — 1 by ABST, 1 identical in full.',
  );
  assert.equal(finding.pointer, '/data/0/records/20');
});

test('a record sent three times yields two repeats, both measured against the first copy', () => {
  const finding = only(
    emsPayload([emsRecord(abstAt(0)), emsRecord(abstAt(0)), emsRecord(abstAt(0))]),
  );
  assert.equal(
    finding.summary,
    '2 records repeat an earlier record in the same report — 2 by ABST, 2 identical in full.',
  );
  assert.equal(finding.pointer, '/data/0/records/1');
});

// ── how the two comparisons are computed ────────────────────────────────────

test('identical-in-full ignores property ORDER, which JSON does not give meaning', () => {
  // Same properties, same values, written in a different order: one record sent
  // twice, and a serialization that respected arrival order would miss it for a
  // cosmetic reason. Key order is sorted away before the comparison.
  const forward = emsRecord(abstAt(0));
  const reversed = Object.fromEntries(Object.entries(forward).reverse());
  const finding = only(emsPayload([forward, reversed]));
  assert.match(finding.summary ?? '', /1 identical in full\.$/);
});

test('identical-in-full reads nested values, and a differing one is not a match', () => {
  const nested = (sid: string) => ({
    ...rtmdRecord(abstAt(0)),
    DLST: { TVC: { SID: sid, SMFR: 'SensMfr', SMOD: 'SensMod' } },
  });
  const twin = only(rtmdPayload([nested('sensor-1'), nested('sensor-1')]), 'rtm');
  assert.match(twin.summary ?? '', /1 identical in full\.$/);

  const differing = only(rtmdPayload([nested('sensor-1'), nested('sensor-2')]), 'rtm');
  assert.match(
    differing.summary ?? '',
    /0 identical in full\.$/,
    'one nested value apart is not the same record',
  );
});

test('an ABST that is not a string joins no ABST match, and still joins an identity match', () => {
  // A timestamp that did not arrive is not one two records can share — and a
  // report of null ABSTs is null-padding's subject, not a report of duplicates.
  // The identity comparison needs no timestamp to mean what it says.
  assert.deepEqual(
    advisories(checkOnly(emsPayload([emsRecord(null, 4.7), emsRecord(null, 4.8)]))),
    [],
    'two null-stamped records with different readings share nothing',
  );
  const finding = only(emsPayload([emsRecord(null, 4.7), emsRecord(null, 4.7)]));
  assert.equal(
    finding.summary,
    '1 record repeats an earlier record in the same report — 0 by ABST, 1 identical in full.',
    'a null ABST joins no ABST match, so that count is 0 while the identity count is 1',
  );
});

test('the ABST comparison is on the value as SENT, not on the instant it names', () => {
  // `…T033000Z` and `…T033000.000Z` are one instant written two ways. This check
  // compares characters — the conservative reading, which can only under-report —
  // and ./time-order.ts, which parses, is what notices the pair.
  const payload = emsPayload([emsRecord('20240115T033000Z'), emsRecord('20240115T033000.000Z')]);
  assert.deepEqual(advisories(checkOnly(payload)), []);

  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  assert.equal(timeOrderCheck(ctx).length, 1, 'and the module that parses says its piece');
});

// ── reports are independent series ──────────────────────────────────────────

test('the scan never crosses a report boundary', () => {
  // Two devices legitimately stamp readings at the same instant, and a record
  // matched across reports would be two appliances, not one reading twice.
  assert.deepEqual(
    advisories(
      checkOnly(
        emsPayloadReports([
          [emsRecord(abstAt(0)), emsRecord(abstAt(900))],
          [emsRecord(abstAt(0)), emsRecord(abstAt(900))],
        ]),
      ),
    ),
    [],
  );
});

test('repeats are pooled across reports and the first in document order wins the pointer', () => {
  const finding = only(
    emsPayloadReports([
      [emsRecord(abstAt(0)), emsRecord(abstAt(900)), emsRecord(abstAt(900))],
      [emsRecord(abstAt(0)), emsRecord(abstAt(0))],
    ]),
  );
  assert.match(finding.summary ?? '', /^2 records repeat an earlier record/);
  assert.equal(finding.pointer, '/data/0/records/2');
});

// ── intra-payload only, deliberately (agj.14 owns the rest) ─────────────────

test('a payload whose records repeat a PRIOR transmission is silent here', () => {
  // agj.8's boundary: this compares records against records in the SAME
  // transmission and never against anything stored from an earlier one. Whether
  // cross-transmission overlap is in scope for v1 is agj.14's question, and this
  // silence is the decision agj.8 made rather than an oversight.
  const first = emsPayload(CLEAN);
  const second = emsPayload(CLEAN);
  assert.deepEqual(advisories(checkOnly(first)), []);
  assert.deepEqual(advisories(checkOnly(second)), [], 'the second delivery observes nothing here');
});

// ── the overlap with adv.time_not_increasing is the point ──────────────────

test('PQS’s shape raises BOTH observations, and neither is suppressed', async () => {
  // "A chunk of records were placed at the end of the previous data file... time
  // would go backwards to the first record of the subsequent file." agj.8 is
  // explicit that the two findings together reconstruct the assembly, so both
  // ride on the same transmission.
  const result = await runPipeline(makeCtx(emsPayload(RE_APPENDED)), bodyStages());
  const ids = result.findings.filter((f) => isAdvisoryId(f.requirement)).map((f) => f.requirement);

  assert.ok(ids.includes('adv.duplicate_records'), 'the record arrived twice');
  assert.ok(ids.includes('adv.time_not_increasing'), 'and the series stopped stepping forward');
  assert.equal(
    result.findings.filter((f) => f.severity === 'fail').length,
    0,
    'and both are advisories, so nothing is graded down',
  );
});

// ── what it deliberately does not say ───────────────────────────────────────

test('a malformed body raises nothing at all', () => {
  assert.deepEqual(advisories(checkOnly({})), []);
  assert.deepEqual(advisories(checkOnly({ data: [] })), []);
  assert.deepEqual(advisories(checkOnly({ data: ['not a report'] })), []);
  assert.deepEqual(advisories(checkOnly({ data: [{ records: 'not an array' }] })), []);
  assert.deepEqual(
    advisories(checkOnly({ data: [{ records: ['not a record', 'not a record', 7, 7] }] })),
    [],
    'records that are not objects are skipped — the schema owns record shape',
  );
});

// ── the governing constraint: it moves no requirement's status ──────────────

test('PIN: the §7 summary is identical with and without this advisory', async () => {
  const ctx = makeCtx(emsPayload(RE_APPENDED));
  const result = await runPipeline(ctx, bodyStages());
  assert.equal(advisories(result.findings).length, 1, 'the advisory really is present');

  const withAdvisory = computeComplianceSummary(countsOf(result.findings));
  const without = computeComplianceSummary(
    countsOf(result.findings.filter((f) => !isAdvisoryId(f.requirement))),
  );

  assert.deepEqual(withAdvisory, without, 'the advisory moved a §7 row');
  assert.equal(
    withAdvisory.filter((r) => r.status === 'fail' || r.status === 'mixed').length,
    0,
    'and the supplier is still carrying no failed requirement',
  );
});

test('PIN: §1.8 grades the duplicate-carrying payload exactly as it grades the clean one', async () => {
  // agj.8's explicit constraint: §1.8 owns re-delivery of a TRANSMISSION and its
  // verdict must not move. Both payloads are novel envelopes, so their §1.8
  // findings have to be indistinguishable — this module asks a different question
  // in its own namespace and leaves the §1.8 grade where it was.
  const repeated = await runPipeline(makeCtx(emsPayload(RE_APPENDED)), bodyStages());
  const clean = await runPipeline(makeCtx(emsPayload(CLEAN)), bodyStages());
  const only18 = (findings: readonly Finding[]) => findings.filter((f) => f.requirement === '1.8');

  assert.deepEqual(only18(repeated.findings), only18(clean.findings));
  assert.equal(only18(repeated.findings)[0]?.severity, 'pass', 'and it is still a pass');
  assert.equal(advisories(clean.findings).length, 0, 'while the clean payload is silent');
});

test('PIN: §3.4 is untouched — a repeat contributes no cadence spread to grade', async () => {
  // Two readings at one instant leave a single interval, and §3.4 treats a single
  // interval as having no spread to fault. The point of the pin is the direction:
  // this module reads a question §3.4 cannot see rather than second-guessing a
  // verdict §3.4 already owns.
  const payload = emsPayload([emsRecord(abstAt(0)), emsRecord(abstAt(0))]);
  const ctx = makeCtx(payload);
  ctx.parsedBody = payload;
  const [interval] = await intervalCheck(ctx, deps);
  assert.equal(interval?.requirement, '3.4');
  assert.equal(interval?.severity, 'pass');
  assert.equal(advisories(checkOnly(payload)).length, 1, 'while the repeat is still observed');
});

// ── wording is acceptance, not polish ───────────────────────────────────────

test('it names what arrived, then why a repeat inside one transmission is different', () => {
  const finding = only(emsPayload(RE_APPENDED));

  assert.equal(
    finding.summary,
    '1 record repeats an earlier record in the same report — 1 by ABST, 1 identical in full.',
  );
  assert.equal(finding.pointer, '/data/0/records/20', 'where');
  assert.equal(
    finding.detail,
    'Two records that share the same timestamp force the country to perform the ' +
      'de-duplication or to risk duplicate records landing twice in every average, total ' +
      'and alarm tally. Countries should anticipate occasional duplicate transmissions, ' +
      'which requirements clause 1.8 allows after a delivery failure or on request, but ' +
      'duplicate records within a single transmission cannot be explained by ' +
      "retransmission and are worth checking in the supplier's assembly step.",
  );
});

test('the copy carries no defect vocabulary and no synonym for the category', () => {
  // Same bar the Advisories copy is held to (src/web/advisories.test.ts): the
  // payload broke no rule — §1.8 grades the envelope and the schema grades each
  // record alone — so any of these would be a false statement about the supplier
  // rather than a harsh tone.
  //
  // ONE PHRASE IS EXEMPT: "a delivery failure" in the approved rationale
  // (agj.17, 2026-09-15) names the circumstance requirements clause 1.8 allows a
  // retransmission after. It is a statement about that clause, not a verdict on
  // this payload, so it is removed before the bar is applied rather than the bar
  // being loosened.
  const defectWords =
    /\b(warn|warning|issue|issues|defect|defects|error|errors|fail|fails|failed|failing|failure|invalid|violation|violates|problem|wrong|incorrect|bad|non-?compliant|must)\b/i;
  const finding = only(emsPayload(RE_APPENDED));

  assert.match(
    finding.detail ?? '',
    /clause 1\.8 allows after a delivery failure/,
    'the exemption',
  );
  for (const copy of [
    finding.summary ?? '',
    (finding.detail ?? '').replace('a delivery failure', ''),
  ]) {
    assert.doesNotMatch(copy, defectWords, `copy reads as a defect: ${copy}`);
    assert.doesNotMatch(copy, /data quality|practice note|observation/i, 'no renaming');
  }
});

test('the copy never concludes how the record came to arrive twice', () => {
  // A re-appended chunk, a record re-sent without being re-stamped and a logger
  // that genuinely reported twice are indistinguishable from the receiving side,
  // so the rationale says where to look and never picks one. It also never names
  // one copy as the spurious one — the two are interchangeable from here.
  const finding = only(emsPayload(RE_APPENDED));
  const copy = `${finding.summary ?? ''} ${finding.detail ?? ''}`;
  assert.doesNotMatch(copy, /clearly|evidently|should have been|remove the second/i);
});

test('the observation stands alone per transmission', () => {
  // The dashboard folds recurring advisories and shows only the most recent
  // occurrence, so the observation has to be readable without its siblings.
  const summary = only(emsPayload(RE_APPENDED)).summary ?? '';
  assert.match(summary, /^1 record repeats an earlier record in the same report/);
  assert.doesNotMatch(summary, /this session|every transmission/i);
});
