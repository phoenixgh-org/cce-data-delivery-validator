/**
 * SEQUENCE-domain exercise cases — the heuristics graded from how transmissions
 * relate to EACH OTHER rather than from any single POST: §1.8 duplicate
 * detection, §3.4 reading cadence, and (8qa.5) §2.1 serial delivery.
 *
 * OWNERSHIP: this file is the sequence-heuristics table (8qa.5). Transport cases
 * live in ./transport.ts and payload cases in ./payload.ts; ../cases.ts is the
 * index that concatenates the three into `EXERCISE_CASES`.
 *
 * Grouping is by REQUIREMENT DOMAIN, not by `fault.layer` — the §3.4 cases below
 * carry a payload-layer fault (the readings themselves are mutated) but grade a
 * sequence heuristic, so they belong here and not in ./payload.ts.
 *
 * A case here that repeats a transferId on purpose is exempted from the
 * table-wide uniqueness invariant WITHIN itself only; its pinned id must still
 * not collide with any other case's (../cases.test.ts, hn5).
 *
 * TRANSFER IDS ARE PINNED, both ways. The §1.8 cases name every transferId they
 * send — the duplicate ones so they really repeat, and the distinct ones so they
 * really differ — rather than trusting the baseline generator to vary them. The
 * generator is a swappable seam whose contract promises only a schema-valid,
 * freshly owned payload (../baseline.ts), so a §1.8 case that leaned on it would
 * decay silently the day it is swapped (bd b8r).
 *
 * THE ONE ADVISORY IN THIS FILE. Advisory cases live in ./payload.ts, because an
 * advisory reads the body. `adv.abst_window_overlap` (agj.24) is the exception
 * and belongs here: it is the only advisory graded from how two transmissions
 * relate — one delivery's ABST window against the windows earlier deliveries in
 * the session recorded for the same appliance — so it is a sequence heuristic
 * that happens to be an advisory, and it needs the multi-POST shape this file
 * owns. Both of its cases PIN the appliance identity with
 * `setApplianceMonitoringId`, so what each asserts is a fact about its own two
 * POSTs rather than about every other rtm case the runner played into the same
 * session.
 *
 * §3.4 IS GRADED WITHIN ONE PAYLOAD, so its two cases are single-POST despite
 * living in the sequence table: the interval check reads `records[].ABST` of the
 * transmission in front of it and never looks at earlier ones
 * (src/ingest/stages/semantic/interval.ts). Cadence ACROSS transmissions is not
 * something the validator grades today; do not add a multi-POST §3.4 case to
 * exercise a heuristic that does not exist.
 */

import { ABST_WINDOW_OVERLAP_ID } from '../../ingest/stages/semantic/abst-window-overlap.js';
import type { ExerciseCase } from '../case.js';
import {
  irregularCadence,
  readingWindow,
  regularCadence,
  setApplianceMonitoringId,
  setTransferId,
} from '../transforms/payload.js';

export const SEQUENCE_CASES: readonly ExerciseCase[] = [
  // ── §3.4 reading cadence ──────────────────────────────────────────────────
  {
    id: '3.4-pass-regular-cadence',
    title: 'An evenly spaced reading series passes the §3.4 regularity heuristic',
    requirements: ['3.4'],
    direction: 'pass',
    posts: [{ transforms: [regularCadence(4, 15)], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'pass' }],
  },
  {
    id: '3.4-fail-irregular-cadence',
    title: 'A wildly uneven reading series fails the §3.4 regularity heuristic (still 200)',
    requirements: ['3.4'],
    direction: 'fail',
    fault: {
      layer: 'payload',
      note: 'readings at 0/5/6/120 minutes — an interval CV far past the 25% tolerance',
    },
    posts: [{ transforms: [irregularCadence([0, 5, 6, 120])], expectedStatus: 200 }],
    expectedFindings: [{ requirement: '3.4', severity: 'fail' }],
  },

  // ── §1.8 duplicate detection (the multi-POST shape) ───────────────────────
  {
    id: '1.8-fail-repeated-transfer-id',
    title: 'A second POST re-using the first POST’s transferId is observed as a §1.8 duplicate',
    requirements: ['1.8'],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'the second POST re-uses the first POST’s transferId within the same session',
    },
    posts: [
      {
        label: 'novel',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
      {
        label: 'replay',
        transforms: [setTransferId('exercise-1.8-replay')],
        expectedStatus: 200,
      },
    ],
    // The session shows BOTH: the first POST is novel, the second is the repeat.
    expectedFindings: [
      { requirement: '1.8', severity: 'pass' },
      { requirement: '1.8', severity: 'fail' },
    ],
  },
  {
    id: '1.8-pass-distinct-transfer-ids',
    title: 'Two transmissions with distinct transferIds are both novel to §1.8',
    requirements: ['1.8'],
    direction: 'pass',
    // The counterpart of the replay case, and a multi-POST case ON PURPOSE: a
    // single POST is novel trivially, whereas §1.8 is about what a SECOND
    // transmission looks like beside a stored first one. Both flavours of repeat
    // are cleared here — the ids differ, and because the id lives in the body the
    // serialized bytes differ too, so neither the transferId nor the content-hash
    // branch of the duplicate check trips (src/ingest/stages/semantic/duplicate.ts).
    //
    // Not exempt from the table's transferId-uniqueness invariant, and must never
    // become so: this case is the one that would break if the exemption predicate
    // (a case expecting a §1.8 fail) ever widened.
    posts: [
      {
        label: 'first',
        transforms: [setTransferId('exercise-1.8-distinct-a')],
        expectedStatus: 200,
      },
      {
        label: 'second',
        transforms: [setTransferId('exercise-1.8-distinct-b')],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [{ requirement: '1.8', severity: 'pass' }],
  },

  // ── adv.abst_window_overlap (the cross-transmission window shape) ─────────
  {
    id: 'adv.abst_window_overlap-fail-second-delivery-reoverlaps-the-first',
    title:
      'A second delivery for the same appliance covering an overlapping ABST window is observed',
    // Empty by the advisory-case rule: an advisory is not a COMPLIANCE_MATRIX
    // row, so the claim is the expectation below (../cases.test.ts, by1c.42).
    requirements: [],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'the second POST re-sends the last two readings of the first under a new transferId',
    },
    // The PQS shape, at transmission granularity: the first delivery covers
    // +0…+45 minutes and the second covers +30…+75, so the two share the
    // readings at +30 and +45. Neither §1.8 flavour applies — the transferIds
    // differ and the bytes differ with them — which is precisely the gap this
    // advisory exists to speak into (agj.14).
    posts: [
      {
        label: 'first',
        transforms: [
          setApplianceMonitoringId('exercise-overlap-appliance'),
          readingWindow(0, 4),
          setTransferId('exercise-adv-overlap-a'),
        ],
        expectedStatus: 200,
      },
      {
        label: 'second',
        transforms: [
          setApplianceMonitoringId('exercise-overlap-appliance'),
          readingWindow(30, 4),
          setTransferId('exercise-adv-overlap-b'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [{ requirement: ABST_WINDOW_OVERLAP_ID, severity: 'info' }],
  },
  {
    id: '1.8-fail-exact-retransmission-of-one-appliance',
    title: 'A byte-identical retransmission is a §1.8 duplicate and draws no window observation',
    requirements: ['1.8'],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'the second POST is byte-identical to the first, transferId included',
    },
    // The OTHER half of the advisory's contract, and the reason it is worth a
    // case of its own beside `1.8-fail-repeated-transfer-id`: requirements §5
    // REQUIRES a supplier to re-send after a delivery that was not accepted, so
    // the identical window a retransmission produces must draw no observation.
    // The exclusion is made in SQL (`findPriorUnitWindows` drops priors sharing
    // this transmission's content hash or transferId), and this case is what
    // measures it against a live instance rather than against the query text.
    //
    // A deliberate replay: both POSTs pin the same transferId, and everything
    // else is deterministic, so the two bodies are byte-identical. Exempt from
    // the table's transferId-uniqueness invariant WITHIN itself only, on the
    // strength of the §1.8 fail it expects (../cases.test.ts).
    posts: [
      {
        label: 'first',
        transforms: [
          setApplianceMonitoringId('exercise-retransmit-appliance'),
          readingWindow(0, 4),
          setTransferId('exercise-1.8-retransmit'),
        ],
        expectedStatus: 200,
      },
      {
        label: 'retransmission',
        transforms: [
          setApplianceMonitoringId('exercise-retransmit-appliance'),
          readingWindow(0, 4),
          setTransferId('exercise-1.8-retransmit'),
        ],
        expectedStatus: 200,
      },
    ],
    expectedFindings: [
      { requirement: '1.8', severity: 'pass' },
      { requirement: '1.8', severity: 'fail' },
    ],
    absentFindings: [{ requirement: ABST_WINDOW_OVERLAP_ID }],
  },

  // ── §2.1 serial delivery (the concurrent-delivery shape) ──────────────────
  {
    id: '2.1-pass-serial-delivery',
    title: 'Two transmissions delivered one after the other are observed as serial',
    requirements: ['2.1'],
    direction: 'pass',
    // Explicit, though `sequential` is the default: this case exists to be the
    // deliberate opposite of the concurrent one below, and reading them side by
    // side should not require knowing what the omitted field defaults to.
    delivery: 'sequential',
    // Deterministic: the runner awaits each POST before sending the next, so the
    // in-flight count at the grader's snapshot is exactly 1 both times (§2.1
    // pass). No other case is in flight — cases never overlap each other.
    posts: [
      { label: 'first', expectedStatus: 200 },
      { label: 'second', expectedStatus: 200 },
    ],
    expectedFindings: [{ requirement: '2.1', severity: 'pass' }],
  },
  {
    id: '2.1-fail-concurrent-delivery',
    title: 'Three simultaneous POSTs are observed as concurrent delivery (still 200)',
    requirements: ['2.1'],
    direction: 'fail',
    fault: {
      layer: 'sequence',
      note: 'three POSTs are fired at once, so more than one is in flight for the session',
    },
    // The only case that needs `delivery: 'concurrent'` — and the only way to
    // reach the §2.1 fail branch at all: the grader reads the in-flight count
    // captured at handler entry, which nothing but a genuinely overlapping request
    // can push above 1 (src/ingest/concurrency-tracker.ts + stages/semantic/
    // concurrency.ts). See `Delivery` in ../case.ts.
    //
    // ── what is deterministic here, and what is not ──────────────────────────
    // The §2.1 PASS below is guaranteed: the first request to enter the session
    // always sees a count of 1 (itself), whatever the other two do.
    //
    // The §2.1 FAIL is a TIMING FACT, not a guarantee, and is stated as one. It
    // holds when a second request enters before the first leaves; the window is
    // the whole body → schema → semantic → persist path, database round trips
    // included, so against a local or normally-loaded instance three sockets
    // opened in the same tick overlap comfortably.
    //
    // MEASURED LIVE (8qa.5, local instance + compose Postgres, 9 consecutive
    // runs): the burst produced a §2.1 fail every time. The usual shape is all
    // three overlapping — one pass, then fails naming 1 and 2 other requests in
    // flight — and the thinnest run observed still overlapped one pair. Three
    // POSTs rather than two deliberately: it takes only one of the two later
    // requests to land inside the window.
    //
    // If this case ever fails — a pathologically slow client, or a server that
    // answers faster than the client opens the next socket — the right response is
    // to SAY SO, not to widen the expectation until it cannot fail: dropping the
    // fail leaves §2.1 with no fail-direction exercise at all.
    delivery: 'concurrent',
    posts: [
      { label: 'burst-1', expectedStatus: 200 },
      { label: 'burst-2', expectedStatus: 200 },
      { label: 'burst-3', expectedStatus: 200 },
    ],
    expectedFindings: [
      { requirement: '2.1', severity: 'pass' },
      { requirement: '2.1', severity: 'fail' },
    ],
  },
];
