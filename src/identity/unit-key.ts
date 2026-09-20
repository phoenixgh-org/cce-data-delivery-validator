/**
 * CCE identity — the one place the service decides WHICH APPLIANCE a report is
 * about, and the ABST window that report covered.
 *
 * {@link unitKey} and {@link identifier} were lifted here from
 * `src/api/scope.ts` (agj.24) with their reasoning intact: the dashboard's
 * distinct-unit count and the ingest-side ABST-window observation must agree on
 * identity, and two copies of a key rule drift. The docblock on `unitKey` is the
 * record of the 2026-08-04 decision (bd p98) and travels with the function.
 *
 * Nothing here touches the database or the pipeline context: these are pure
 * functions over an already-parsed body, so both the API and the ingest stage can
 * call them freely.
 */

import { parseAbst } from '../ingest/stages/semantic/interval.js';

/** Whether a value is a plain (non-array) object we can read keys off. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A string identifier with surrounding whitespace removed, or `null` when the
 * value is not a usable identifier (absent, JSON `null`, a non-string, or blank).
 * Trimmed but NOT case-folded: `"ab"` and `"AB"` are different serials, and we
 * have no warrant to merge them.
 */
export function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The identity key for one report object, or `null` when the report names no
 * appliance. Lineage-agnostic — it needs no `meta.transferType` branch, because
 * the two branches of `src/schemas/cce-interop-0.8.1.json` carry disjoint
 * appliance identifiers:
 *
 *   - `$defs/rtmd-report` REQUIRES `AMID` (`["string"]`, "the ID of the appliance
 *     object in the RTMD supplier’s cloud platform … a stable reference to the
 *     appliance"); `ASER` is optional there.
 *   - `$defs/ems-report` has NO `AMID` property at all; it REQUIRES `ASER`
 *     (`["string","null"]`, appliance manufacturer serial number) alongside
 *     `AMFR`/`AMOD`/`APQS`.
 *   - `AID` (programme asset id) is optional on both and is the EMPLOYER’S
 *     handle, not the supplier’s, so it is not the key.
 *   - `LSER` and `ESER` name the logger and the monitoring device — the thing
 *     doing the watching, not the equipment being watched. Counting those would
 *     be a different number (one CCE can be re-instrumented, one logger moved).
 *
 * DECIDED 2026-08-04 (Benson, bd p98) — CCE IDENTITY IS THE EQUIPMENT ID. So
 * `ASER`, the manufacturer’s serial for the appliance itself, is PREFERRED, and
 * `AMID`, the supplier platform’s own handle on it, is the FALLBACK for the RTMD
 * reports that carried no serial. Every EMS report keys on `ASER`; an RTMD report
 * keys on `ASER` when the supplier sent one and on `AMID` otherwise.
 *
 * `AMFR` plays no part in the key. The serial identifies the equipment on its
 * own here — this is a count of identifier values as they arrived, not an
 * attempt to make them globally unique.
 *
 * NOTE the two namespaces never reconcile: a manufacturer serial and a
 * supplier-internal id are different kinds of name, so the same physical
 * refrigerator reported under each counts as TWO units. That is inherent to a
 * passive receiver — resolving identity is out of scope (see p98’s notes) — and
 * it is disclosed in the readout’s tooltip rather than fixed here.
 */
export function unitKey(report: Record<string, unknown>): string | null {
  const aser = identifier(report['ASER']);
  if (aser !== null) return `aser:${aser}`;
  const amid = identifier(report['AMID']);
  if (amid !== null) return `amid:${amid}`;
  return null;
}

/**
 * The ABST span one report covered, keyed by the appliance it reported on —
 * the unit of `transmission_unit_window` (db/initdb/95-transmission-unit-window.sql).
 */
export interface UnitWindow {
  /** The appliance identity ({@link unitKey}), prefix included. */
  unitKey: string;
  /** Earliest parseable `ABST` in the report's records, epoch ms (UTC). */
  abstMin: number;
  /** Latest parseable `ABST` in the report's records, epoch ms (UTC). */
  abstMax: number;
  /** How many records contributed — those whose `ABST` parsed. */
  recordCount: number;
}

/**
 * The ABST window each identified report in a parsed body covered, one entry per
 * report (agj.24). PURE: it reads `body.data[]` exactly the way `unitTotals` in
 * `src/api/scope.ts` does, and knows nothing about transmissions or storage.
 *
 * What is skipped, and why each omission is a window that cannot be compared
 * rather than a window of zero width:
 *
 *   - a body that is not an object with an array `data` (including an unparsed
 *     body) contributes nothing;
 *   - an entry of `data[]` that is not an object is not a report;
 *   - a report whose {@link unitKey} is `null` named no appliance, so there is
 *     nothing to match it against a later delivery;
 *   - records whose `ABST` is absent, `null` or unparseable are skipped and do
 *     NOT widen the window — {@link parseAbst} is the same reader §3.4 uses, so
 *     a string this service cannot read here is one it could not read there;
 *   - a report in which no record's `ABST` parses yields no entry at all.
 *
 * A report carrying a single parseable record yields a degenerate window with
 * `abstMin === abstMax`. That is deliberate: a one-record delivery still lands
 * inside or outside a previous delivery's span, which is the whole question.
 *
 * Millisecond resolution is enough here — these are windows to intersect, not an
 * ordering to grade.
 *
 * Two reports for the SAME appliance inside one body collapse to one entry
 * spanning both, because the table holds one window per unit per transmission.
 */
export function computeUnitWindows(body: unknown): UnitWindow[] {
  if (!isPlainObject(body)) return [];
  const data = body['data'];
  if (!Array.isArray(data)) return [];

  // Insertion-ordered, so the returned array follows the payload's report order.
  const windows = new Map<string, UnitWindow>();

  for (const report of data) {
    if (!isPlainObject(report)) continue;
    const key = unitKey(report);
    if (key === null) continue;

    const records = report['records'];
    if (!Array.isArray(records)) continue;

    let min: number | null = null;
    let max: number | null = null;
    let recordCount = 0;
    for (const record of records) {
      if (!isPlainObject(record)) continue;
      const ts = parseAbst(record['ABST']);
      if (ts === null) continue;
      recordCount += 1;
      if (min === null || ts < min) min = ts;
      if (max === null || ts > max) max = ts;
    }

    // No record's ABST parsed → no window to compare.
    if (min === null || max === null) continue;

    const existing = windows.get(key);
    if (existing === undefined) {
      windows.set(key, { unitKey: key, abstMin: min, abstMax: max, recordCount });
    } else {
      existing.abstMin = Math.min(existing.abstMin, min);
      existing.abstMax = Math.max(existing.abstMax, max);
      existing.recordCount += recordCount;
    }
  }

  return [...windows.values()];
}

/**
 * The appliance-side identifiers one report carried, keyed by the appliance it
 * reported on — the unit of `transmission_unit_identity`
 * (db/initdb/96-transmission-unit-identity.sql).
 *
 * THE THREE FIELDS ARE THE APPLIANCE'S OWN NAMES, and the list is closed (0rfk):
 *
 *   - `ASER`, the manufacturer's serial for the equipment;
 *   - `AMID`, the supplier platform's handle on it (an `rtmd-report` property
 *     only — `ems-report` declares no such property);
 *   - `AID`, the employer's asset id, optional on both branches.
 *
 * `LSER`, `ESER`, `LID` and `EID` are deliberately NOT here. They name the logger
 * and the monitoring device rather than the appliance, and the docblock on
 * {@link unitKey} says why that distinction matters: one appliance can be
 * re-instrumented and one logger can be moved, both ordinary operations. A check
 * comparing those across deliveries would remark on routine maintenance.
 */
export interface UnitIdentity {
  /** The appliance identity ({@link unitKey}), prefix included. */
  unitKey: string;
  /** `ASER` as reported, trimmed, or `null` when the report carried no usable value. */
  aser: string | null;
  /** `AMID` as reported, trimmed, or `null`. */
  amid: string | null;
  /** `AID` as reported, trimmed, or `null`. */
  aid: string | null;
}

/**
 * The appliance-side identifiers each identified report in a parsed body carried,
 * one entry per report (0rfk). PURE, exactly as {@link computeUnitWindows} is: it
 * reads `body.data[]` and knows nothing about transmissions or storage.
 *
 * What is skipped, and why:
 *
 *   - a body that is not an object with an array `data` (including an unparsed
 *     body) contributes nothing;
 *   - an entry of `data[]` that is not an object is not a report;
 *   - a report whose {@link unitKey} is `null` named no appliance, so there is
 *     nothing to match it against a later delivery.
 *
 * Unlike {@link computeUnitWindows} it does NOT depend on the records: a report
 * whose timestamps this service cannot read still names its appliance, and the
 * identity is exactly as comparable for it.
 *
 * TWO REPORTS FOR ONE APPLIANCE IN ONE BODY: the FIRST wins, and the second is
 * dropped whole rather than merged. Merging would invent an identity no single
 * report declared — a row carrying the first report's `ASER` beside the second's
 * `AID` — and intra-body disagreement is a different observation from the
 * cross-delivery one this feeds (out of scope on 0rfk).
 */
export function computeUnitIdentities(body: unknown): UnitIdentity[] {
  if (!isPlainObject(body)) return [];
  const data = body['data'];
  if (!Array.isArray(data)) return [];

  // Insertion-ordered, so the returned array follows the payload's report order.
  const identities = new Map<string, UnitIdentity>();

  for (const report of data) {
    if (!isPlainObject(report)) continue;
    const key = unitKey(report);
    if (key === null) continue;
    if (identities.has(key)) continue;

    identities.set(key, {
      unitKey: key,
      aser: identifier(report['ASER']),
      amid: identifier(report['AMID']),
      aid: identifier(report['AID']),
    });
  }

  return [...identities.values()];
}
