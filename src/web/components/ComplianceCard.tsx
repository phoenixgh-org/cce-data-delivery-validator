/**
 * ComplianceCard (108.5) — the redesigned §7 compliance summary that replaces
 * the flat Matrix table (README §Screens 2 → ComplianceCard).
 *
 * RENDER-ONLY: this renders the exact `summary` the API returns. It groups rows
 * by verifiability (`classes[0]`) and derives nothing — no reclassification, no
 * status recompute. The five groups, their order, gradeable flags, and collapse
 * defaults mirror the prototype's engine.js GROUPS.
 *
 * Props match `CompliancePaneProps` in Dashboard.tsx verbatim; the parent owns
 * all the state (filter, open row, collapse map, selected tx) — the grading lens
 * (tfnv.5) included: this card takes the selected package as a prop and reads
 * neither the URL nor a constant of its own. Under a non-contract package the
 * card's border goes plum and the header names the package.
 *
 * THE ROWS UNDER A DRAFT PACKAGE (tfnv.6). The grouping axis does not change: a
 * clause is grouped by its verifiability class exactly as a §7 requirement is,
 * because being NEW or TIGHTENED in the draft is an annotation ON a requirement
 * rather than a class of its own (owner decision, tfnv.14). So the six clauses
 * the draft adds sit in the class groups the server sends — 5.3.5 among the
 * Verified rows, with live counts — and what the draft adds is said on the row
 * instead: the {@link rowTags} pills, and, for an added clause nothing feeds,
 * one line at the head of its drill-down ({@link NOT_FED_NOTE}). The signature
 * block reads the lens too ({@link signaturesForReq}), so clicking an issue
 * cross-filters the transmission list under the selected package exactly as it
 * does by default — the same Signature, and the same `key`, reach the Dashboard.
 */
import type { CSSProperties, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { ComplianceClass, ComplianceRow, Profile, Signature, TransmissionView } from '../api';
import { ADVISORY_PREFIX, CONTRACT_PROFILE } from '../api';
import { PROFILE_NAME } from '../profiles';
import { StatusPill } from './ui/StatusPill';
import { Icon } from './ui/Icon';
import { Tag } from './ui/Tag';
import { inlineCode } from './ui/inlineCode';
import { CLASS_META } from './ui/statusMaps';
import { DS013_REFERENCE, DS013_REFERENCE_SOURCE } from './ds013Reference';
import { getRequirementReference } from './requirementReference';
import { ADVISORY_COPY, advisoryIdFromKey, advisoryLabel } from '../advisories';
// Pane width shared with the summary card above it (src/web/layout.ts, vamh.8).
import { REQUIREMENTS_PANE_FLEX } from '../layout';

/* ------------------------------------------------------------------ *
 * Props — EXACT copy of Dashboard.tsx CompliancePaneProps + CollapsedGroups.
 * ------------------------------------------------------------------ */

/** Per-verifiability-class collapse map for the non-gradeable groups. */
type CollapsedGroups = Partial<Record<ComplianceClass, boolean>>;

export interface CompliancePaneProps {
  summary: ComplianceRow[];
  /**
   * All captured transmissions. Retained for the Dashboard call-site contract;
   * the expanded requirement detail no longer derives per-tx chips from these
   * (the deduped signature rows replaced that). The compliance summary/rollup is
   * never recomputed from these.
   */
  transmissions: TransmissionView[];
  /** Newest tx selected in the right pane. Retained for the call-site contract. */
  selectedTx: string | null;
  /** Pick a transmission. Retained for the call-site contract. */
  onSelectTx: (id: string) => void;
  /** Which requirement row is open (drill-down + finding→req cross-link). */
  expandedReq: string | null;
  /** Toggle the open requirement row. */
  onToggleReq: (req: string | null) => void;
  /** "Show what we can't grade" filter — wired to the header checkbox. */
  showNonGradeable: boolean;
  /** Setter for the filter checkbox. */
  onShowNonGradeableChange: (next: boolean) => void;
  /** Collapse state for the non-gradeable groups. */
  collapsedGroups: CollapsedGroups;
  /** Toggle a non-gradeable group's collapse. */
  onToggleGroup: (cls: ComplianceClass) => void;
  /**
   * Scope-relative deduped issue signatures (4h4.9 plumbs from data.signatures).
   * Rendered as the per-requirement "Distinct issues" rows in the expanded row.
   */
  signatures?: Signature[];
  /**
   * Cross-filter trigger: select a signature to scope the transmission list.
   * Clicking a signature row calls this — cross-filter only, no in-card expand.
   */
  onSelectSignature?: (sig: Signature) => void;
  /** Key of the currently active signature cross-filter (drives active-row styling), or null. */
  activeSignatureKey?: string | null;
  /**
   * The requirement package the served `summary` was computed under (tfnv.4's
   * `lens`). READ-ONLY here, as everything on this card is: it tints the chrome,
   * names the package in the header, and tells a row which signatures belong to
   * it ({@link signaturesForReq}) — it never re-grades or re-groups anything.
   */
  lens?: Profile;
  /** The package in force, as the session serves it. */
  contractProfile?: Profile;
  /**
   * Transmissions in the current scope — the denominator the expanded evidence
   * line states its transmission tallies against (vsy1).
   *
   * IT COMES FROM THE SERVER'S `scoped.scoped`, the same number the summary card
   * above this pane reports, and NOT from `transmissions.length`: that prop is
   * the session's whole capture, while the row counts beside it were folded over
   * the scoped set. Omitting it (as the tests do) drops the "of N transmissions"
   * clause and leaves the tallies bare rather than inventing a denominator.
   */
  scopedTotal?: number;
}

/* ------------------------------------------------------------------ *
 * Group definitions — the 5 prototype GROUPS, in order. Each group owns a set
 * of real ComplianceClass values (matched against row.classes[0]); the group's
 * presentational label/blurb/gradeable flag are pulled from CLASS_META on its
 * representative class so we don't restate copy that already lives in 108.2.
 *
 *   verified      → Verified            (gradeable)
 *   heuristic     → Heuristic           (gradeable)
 *   attestation   → Self-attested       (collapsible, expanded by default)
 *   active-only   → Needs active testing(collapsible, collapsed by default)
 *   none|enforced → Permissive          (collapsible, collapsed by default)
 *
 * `enforced` (and any future enforced-as-primary class) folds into Permissive,
 * per the bite context — the prototype has no separate Enforced group.
 * ------------------------------------------------------------------ */

interface GroupDef {
  /** The class whose CLASS_META supplies this group's label/blurb/gradeable. */
  rep: ComplianceClass;
  /** Real classes (matched on classes[0]) that fall into this group. */
  members: ComplianceClass[];
  /** Default collapsed state for the non-gradeable collapsible groups. */
  defaultCollapsed: boolean;
}

const GROUPS: GroupDef[] = [
  { rep: 'verified', members: ['verified'], defaultCollapsed: false },
  { rep: 'heuristic', members: ['heuristic'], defaultCollapsed: false },
  { rep: 'attestation', members: ['attestation'], defaultCollapsed: false },
  { rep: 'active-only', members: ['active-only'], defaultCollapsed: true },
  { rep: 'none', members: ['none', 'enforced'], defaultCollapsed: true },
];

/** Effective collapse state: the parent's value if set, else the group default. */
function isCollapsed(group: GroupDef, collapsedGroups: CollapsedGroups): boolean {
  const v = collapsedGroups[group.rep];
  return v === undefined ? group.defaultCollapsed : v;
}

/** Find the group whose members include the given row's primary class. */
function groupForRow(row: ComplianceRow): GroupDef | undefined {
  const primary = row.classes[0];
  if (primary === undefined) return undefined;
  return GROUPS.find((g) => g.members.includes(primary));
}

/* ------------------------------------------------------------------ *
 * Row — a single requirement, expandable into its detail panel.
 * ------------------------------------------------------------------ */

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const mono = 'var(--mono)';

/* ------------------------------------------------------------------ *
 * The column grid — ONE source for both kinds of row (693r).
 *
 * A requirement row ({@link ReqRow}) and an advisory row ({@link AdvisoryRow})
 * are deliberately the same shape: synm's acceptance for the advisory row is
 * that it sits "on the ReqRow column grid so titles align". That held only by
 * coincidence while each row typed the geometry out for itself — the grid lived
 * in a const scoped inside ReqRow, so the advisory row could not read it and
 * carried a copy instead. A change to one row's gap, padding or slot width
 * would then have un-aligned the other silently.
 *
 * So the geometry lives here, at module scope, and both rows read it. What is
 * shared is geometry only: colour, opacity and what goes IN each slot stay with
 * the row, because that is where the two legitimately differ.
 * ------------------------------------------------------------------ */

/**
 * The row container: four slots in a line, on the shared gap and padding.
 *
 * `opacity` is optional rather than defaulted, because the two rows differ in
 * kind and not in value: a requirement row dims when its group is not gradeable,
 * and an advisory row has no dead state to dim for — so it passes nothing and
 * renders no `opacity` at all.
 */
function rowGridStyle(opts: { expanded: boolean; opacity?: number }): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'baseline',
    gap: 13,
    padding: '9px 16px',
    cursor: 'pointer',
    ...(opts.opacity === undefined ? {} : { opacity: opts.opacity }),
    borderBottom: '1px solid var(--border)',
    background: opts.expanded ? 'var(--detail)' : 'transparent',
    transition: prefersReducedMotion ? undefined : 'background 120ms ease',
  };
}

/**
 * Slot 1, the id: wide enough for a six-character DS01.3 clause id ('5.1.10').
 * A §7 id is shorter and simply sits in the same column, so the two packages
 * align on one width rather than reflowing at the toggle; an advisory has no id
 * to print and renders the slot empty, which is what keeps its title in line
 * with the titles above it.
 */
const ROW_SLOT_ID: CSSProperties = { width: 42, flexShrink: 0 };

/** Slot 2, the title: takes the remaining width. */
const ROW_SLOT_TITLE: CSSProperties = { flex: 1, fontSize: 13 };

/** Slot 3, the count: faint by default; the advisory row overrides the colour. */
const ROW_SLOT_COUNT: CSSProperties = {
  fontFamily: mono,
  fontSize: 11,
  color: 'var(--text-faint)',
  width: 58,
  textAlign: 'right',
  flexShrink: 0,
};

/** Slot 4, the verdict: a status pill on a requirement, a neutral tag on an advisory. */
const ROW_SLOT_VERDICT: CSSProperties = { width: 88, textAlign: 'right', flexShrink: 0 };

/**
 * The drill-down panel's left indent — MEASURED, not derived (3q17).
 *
 * The indent exists to start the panel's text under the row's title rather than
 * under its id, so in principle it is the grid above: the row's 16px left
 * padding, plus {@link ROW_SLOT_ID}'s width, plus the 13px gap. It no longer
 * equals that sum. The title column begins at 71px and this indent is 60, an
 * 11px difference a reader sees as the panel sitting slightly left of the title
 * it belongs to.
 *
 * The 60 was correct when it was written, against a 30px id slot (16 + 30 + 13
 * = 59). Widening that slot to 42 for a six-character DS01.3 clause id moved the
 * title column and left the indent behind — which is the drift this constant is
 * named to prevent, already realised once.
 *
 * It is left at what it renders today on purpose: closing the gap is a visual
 * decision rather than a mechanical one, and this lift is a refactor that must
 * change nothing on screen (c117 carries the decision). So the coupling is
 * written down here instead of expressed in code — a change to ROW_SLOT_ID's
 * width, or to the row's horizontal padding, is a change to where this panel
 * ought to start.
 */
const DETAIL_PANEL_INDENT = 60;

/**
 * The drill-down panel: ONE source for both kinds of row (3q17).
 *
 * Expanding either row opens this panel beneath it, and a supplier reads the two
 * as one surface — same ground, same rule below, same indent. It lives at module
 * scope for the reason the grid does: each row used to type the panel out for
 * itself, so a change to one would have left the other behind with nothing
 * failing.
 *
 * Chrome only, as with the grid. What goes IN the panel is the row's own: a
 * requirement prints clause text, its evidence line and its distinct issues; an
 * advisory prints a rationale and its matching transmissions.
 */
const DETAIL_PANEL_STYLE: CSSProperties = {
  background: 'var(--detail)',
  borderBottom: '1px solid var(--border)',
  padding: `12px 16px 15px ${DETAIL_PANEL_INDENT}px`,
};

/* ------------------------------------------------------------------ *
 * Row annotations — what the draft package adds to a row, orthogonal to the
 * verifiability class that groups it (tfnv.14).
 * ------------------------------------------------------------------ */

/**
 * Whether the selected package ADDS this clause: `members` is the 2025
 * requirement ids the clause merges, and empty is what "new in the draft" means.
 *
 * It is `members`, not `graded`, that answers this. The server sends both on
 * every draft row and they part company on 5.3.5, which no 2025 requirement maps
 * onto and which is still fed — by the §3.1 custom-object check, whose findings
 * fold onto it (src/api/lens.ts). Reading `graded` here would drop the NEW tag
 * from the one added clause that has numbers behind it. Absent under the contract
 * lens, where the package has no notion of an added clause, so this is false.
 */
export function isNewInDraft(row: ComplianceRow): boolean {
  return row.members !== undefined && row.members.length === 0;
}

/** A row annotation the draft package adds: the pill's word and its tooltip. */
export interface RowTag {
  /** `data-tag` value — the annotation, for the DOM and for the tests. */
  id: 'tightened' | 'new';
  /** The pill's word. */
  label: string;
  /** The `title` tooltip: one sentence saying what the annotation means. */
  title: string;
}

/**
 * The annotations a row carries, in render order — TIGHTENED before NEW.
 *
 * Both are pills rather than groups: a reader scanning the column wants the
 * verifiability class first (what we can prove about this row), and the draft's
 * relationship to the contract second. No row carries both today — a clause with
 * no 2025 member cannot have tightened — but the order is stated rather than left
 * to chance.
 *
 * The contract package's name comes from the vocabulary (`PROFILE_NAME`), never
 * from a literal here: the day the contract in force moves, the tooltip follows
 * it. "DS01.3" in these sentences names the DOCUMENT, which is not a lineage
 * name and does not move.
 */
export function rowTags(row: ComplianceRow, contractProfile: Profile = CONTRACT_PROFILE): RowTag[] {
  const tags: RowTag[] = [];
  if (row.tightened === true) {
    tags.push({
      id: 'tightened',
      label: 'TIGHTENED',
      title: 'DS01.3 changes what conformance means here.',
    });
  }
  if (isNewInDraft(row)) {
    tags.push({
      id: 'new',
      label: 'NEW',
      title:
        `Added by the DS01.3 draft; nothing in the ${PROFILE_NAME[contractProfile]} ` +
        'contract obliges this.',
    });
  }
  return tags;
}

/**
 * The line an ADDED clause that nothing feeds opens its drill-down with.
 *
 * Such a row shows no counts, and without this it would read like a row we
 * simply have not seen traffic for — the same blank a conformant-but-silent
 * requirement shows. The sentence says the blank is structural: no 2025 delivery
 * is measured against this clause, so no volume of traffic will ever fill it.
 * An added clause that IS fed (5.3.5) shows live counts and a status like any
 * other row of its class, and gets no such line.
 */
export const NOT_FED_NOTE =
  'New in DS01.3: no 2025 requirement maps here, so no delivery is counted on this row.';

/** One annotation pill, rendered inline after the row's summary. */
function RowTagPill({ tag }: { tag: RowTag }): ReactElement {
  return (
    <span
      data-tag={tag.id}
      title={tag.title}
      style={{
        marginLeft: 6,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        color: 'var(--draft)',
        background: 'var(--draft-bg)',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      }}
    >
      {tag.label}
    </span>
  );
}

/**
 * The deduped signatures that belong to a requirement — `Signature.req` keyed,
 * matching the prototype's `E.signaturesForReq`. Server already scoped these to
 * the active window/source, so this is a pure filter (no recompute).
 *
 * NEVER returns an advisory (agj.19) — an exact mirror of the server-side
 * `signaturesForReq` in src/api/signatures.ts, guard included. Requirement
 * grouping is a verdict surface and an advisory has no verdict, so admitting one
 * here would file it among the requirement's "distinct issues". The `req` sentinel
 * ('' for an advisory) already excludes them today; the explicit `kind` guard is
 * what keeps that true if a future advisory is ever given a requirement to group
 * under. Advisories reach the column through {@link advisorySignatures} instead.
 *
 * UNDER THE CONTRACT LENS, CONTRACT ONLY (by1c.7) — the mirror's third guard:
 * the §7 matrix grades the obligations in force, so a 'ds013' shadow signature is
 * excluded even if a DS01.3 clause id ever collides with a §7 id. That branch is
 * unchanged, and the default view with it.
 *
 * UNDER ANOTHER LENS (tfnv.6) a row collects two kinds of signature, which is the
 * fold the server performs in `withRequirementUnderLens` (src/api/signatures.ts):
 * a signature of the SELECTED package keeps its own `req`, because it was numbered
 * in that package when it was written, and a CONTRACT signature lands on the row
 * the server stamped onto it as `requirementUnderLens`.
 *
 * Both halves read SERVED FIELDS ONLY. The stamp is why this needs no browser copy
 * of the clause map, and why a contract signature the selected package files
 * nowhere — a §3.2 result the draft re-runs for itself — carries no stamp and so
 * joins no row. ComplianceCard.test.ts holds this selection equal to the server's
 * own fold on a fixture, rather than to a transcription of the rule.
 */
export function signaturesForReq(
  signatures: readonly Signature[],
  requirement: string,
  lens: Profile = CONTRACT_PROFILE,
  contractProfile: Profile = CONTRACT_PROFILE,
): Signature[] {
  if (lens === contractProfile) {
    return signatures.filter(
      (s) => s.kind !== 'advisory' && s.profile === contractProfile && s.req === requirement,
    );
  }
  return signatures.filter(
    (s) =>
      s.kind !== 'advisory' &&
      ((s.profile === lens && s.req === requirement) ||
        (s.profile === contractProfile && s.requirementUnderLens === requirement)),
  );
}

/**
 * The advisory half of the same set — the ONLY way advisories enter this card
 * (agj.16). Server-rolled (`kind: 'advisory'`, keyed `adv|<adv.id>`) and already
 * scoped, so this too is a pure filter.
 *
 * ORDER IS RESTATED, not inherited. `computeSignatures` returns count DESC, but
 * ties fall back to Map insertion order, which follows whichever transmission
 * happened to arrive first — that would reshuffle the section between polls. The
 * `key` tie-break makes the order total and therefore stable.
 */
export function advisorySignatures(signatures: readonly Signature[]): Signature[] {
  return signatures
    .filter((s) => s.kind === 'advisory')
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key)));
}

/**
 * The bar/count colour for a signature row.
 *
 * `--fail` for a hard fail, `--mixed` for a soft/info verdict signature — and
 * `--accent-text` for an ADVISORY, which is NOT a lesser defect. The advisory
 * surface takes accent and neutrals and never a status colour, `--mixed` least
 * of all: that amber already means *warning / outdated*
 * everywhere on this dashboard (the `pass-outdated` pill, the OUTDATED SCHEMA
 * tag, flagged payload lines), so an advisory row falling through to it would
 * say "a lesser defect" in the one place that must not say defect at all. An
 * advisory carries `sev: 'info'`, so without this branch it would.
 */
export function sigTone(sig: Pick<Signature, 'kind' | 'sev'>): string {
  if (sig.kind === 'advisory') return 'var(--accent-text)';
  return sig.sev === 'fail' ? 'var(--fail)' : 'var(--mixed)';
}

/**
 * A single deduped issue (signature) row in an expanded requirement. A button
 * that cross-filters the transmission list — it does NOT expand or navigate in
 * the card. The thin proportion bar's width ∝ this signature's share of the
 * requirement's issue volume (its `count` over the requirement's max). `--fail`
 * for a hard fail; `--mixed` for a soft/info signature (e.g. an outdated-schema
 * §3.2 finding, which carries `sev:'info'`). The active row (key ===
 * `activeSignatureKey`) takes an `--accent` border + `--accent-weak` fill.
 *
 * Advisories no longer render through this row — they have {@link AdvisoryRow}
 * since synm — but they still share {@link sigTone}, which is what keeps a status
 * colour off the advisory surface.
 */
export function SigRow({
  sig,
  max,
  active,
  onPick,
}: {
  sig: Signature;
  max: number;
  active: boolean;
  onPick: (sig: Signature) => void;
}): ReactElement {
  const pct = max > 0 ? Math.max(6, Math.round((sig.count / max) * 100)) : 0;
  const tone = sigTone(sig);
  return (
    <button
      onClick={() => onPick(sig)}
      title="View these transmissions"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 56px auto 16px',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        textAlign: 'left',
        padding: '7px 9px',
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent-weak)' : 'var(--surface)',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {sig.title}
        </span>
        <span
          style={{
            display: 'block',
            position: 'relative',
            height: 3,
            marginTop: 4,
            background: 'var(--border)',
            borderRadius: 2,
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              height: 3,
              width: `${pct}%`,
              background: tone,
              borderRadius: 2,
            }}
          />
        </span>
      </span>
      <span
        style={{
          fontFamily: mono,
          fontSize: 11.5,
          color: tone,
          textAlign: 'right',
        }}
      >
        {sig.txCount} tx
      </span>
      <span
        style={{
          fontFamily: mono,
          fontSize: 10.5,
          color: 'var(--text-faint)',
          whiteSpace: 'nowrap',
        }}
      >
        {sig.sourceCount} src
      </span>
      <Icon
        name="arrowRight"
        size={13}
        style={{ color: active ? 'var(--accent-text)' : 'var(--text-faint)' }}
      />
    </button>
  );
}

/**
 * The long-form evidence line under an expanded requirement: one coloured
 * segment per non-zero tally, joined with " · " by the caller. `outdated` (2kx)
 * is its own segment in the --mixed amber, NOT folded into passing: an outdated
 * finding is recorded severity=info with no pass finding, so a row can be
 * `pass-outdated` with zero passes and zero fails — which used to render as the
 * "no transmissions in this window" empty state despite every payload having
 * been validated. Empty array = genuinely nothing in scope.
 *
 * EVERY SEGMENT COUNTS TRANSMISSIONS (vsy1), because `row.counts` does since the
 * server stopped counting findings. The noun and the denominator ride on the
 * FIRST segment only — "60 of 80 transmissions failing · 13 passing" — so the
 * line says once what it is counting and against what, rather than repeating the
 * word on every clause or leaving the reader to guess the unit from the
 * scorecard.
 *
 * `scopedTotal` is the scope's transmission count, straight from the same
 * `scoped.scoped` the summary cards report. Undefined (a caller that has no
 * scope, as the tests do) drops the "of N transmissions" and leaves the bare
 * tallies.
 *
 * THE NOT-REACHED SEGMENT IS A THIRD STATE, NOT A SUBTRACTION. `pass` and `fail`
 * are not disjoint — one transmission can pass one member of a collapsed DS01.3
 * clause and fail another — so `scopedTotal − pass − fail` is not the remainder
 * and would go negative on exactly the rows the collapse affects. It is rendered
 * from `row.notReached`, which the server computed against the scope it knows,
 * and in the faint neutral: never reaching a check is not a verdict either way.
 *
 * It is suppressed on a row the server says nothing feeds (`graded === false`,
 * a clause DS01.3 adds with no check behind it). There the remainder is the whole
 * scope by construction, and "80 not reached" would read as a measurement when
 * {@link NOT_FED_NOTE} above it has just said there is no check to reach.
 */
function countSegments(row: ComplianceRow, scopedTotal?: number): ReactElement[] {
  const segments: ReactElement[] = [];
  // Applied to whichever segment lands first, then spent.
  let scope = scopedTotal === undefined ? '' : ` of ${scopedTotal} transmissions`;
  const take = (): string => {
    const s = scope;
    scope = '';
    return s;
  };
  if (row.counts.fail > 0) {
    segments.push(
      <span key="fail" style={{ color: 'var(--fail)' }}>
        {row.counts.fail}
        {take()} failing
      </span>,
    );
  }
  if (row.counts.pass > 0) {
    segments.push(
      <span key="pass" style={{ color: 'var(--pass)' }}>
        {row.counts.pass}
        {take()} passing
      </span>,
    );
  }
  if (row.outdated > 0) {
    segments.push(
      <span key="outdated" style={{ color: 'var(--mixed)' }}>
        {row.outdated}
        {take()} validated against an outdated schema
      </span>,
    );
  }
  if (row.notReached > 0 && row.graded !== false) {
    segments.push(
      <span key="not-reached" style={{ color: 'var(--text-faint)' }}>
        {row.notReached}
        {take()} not reached
      </span>,
    );
  }
  return segments;
}

/**
 * How many FINDINGS sit behind an expanded row's issue rows (vsy1) — the number
 * the eyebrow line carries now that the tally beside it counts transmissions.
 *
 * This is the one thing the transmission tally deliberately hides. The schema
 * stage writes one fail per Ajv error, so an `ems-report` missing five
 * logger-identity properties is ONE failing transmission and FIVE findings, and a
 * supplier reading "60 failing" is entitled to know how much evidence that is
 * before deciding how much work it represents.
 *
 * FAILS ONLY, for two reasons. It heads the issue rows, and a pass raises no
 * issue to head — its finding count would answer a question the block is not
 * asking, and on a collapsed DS01.3 clause it is inflated anyway (5.1.3 folds
 * 150 pass findings from 77 transmissions, one per member clause). And an `info`
 * finding is either an observation with no issue row at all or the
 * outdated-schema case, which the evidence line above already reports in
 * transmissions — a row whose only findings are outdated infos therefore shows no
 * finding count, which loses nothing: the schema stage writes at most one of
 * those per transmission, so the two numbers would be the same.
 */
function findingTotal(row: ComplianceRow): number {
  return row.findings.fail;
}

/**
 * The "Distinct issues" summary block in an expanded (gradeable) requirement:
 * the evidence line, an eyebrow + the finding count, then a column of deduped
 * signature rows (max 540px wide). Past 4 signatures it offers a
 * "+ N more issues" / "Show fewer" toggle (local state). A requirement with no
 * in-scope signatures shows the empty-state copy; low-cardinality requirements
 * simply render their single signature. The proportion bar's `max` is the
 * requirement's largest signature `count`, so widths read as a share of this
 * requirement's issue volume.
 *
 * TWO LINES, TWO UNITS, EACH NAMED (vsy1). The evidence line comes first and is
 * stated in transmissions against the scope — "60 of 80 transmissions failing ·
 * 13 passing · 7 not reached" — because that is the noun the scorecard above the
 * card counts, and the two numbers are meant to be read against each other. The
 * finding count then sits beside the eyebrow, where the per-severity tally used
 * to, and says the word: "Distinct issues  251 findings". Nothing on either line
 * is left to be inferred from the other.
 */
function SignatureSummary({
  row,
  signatures,
  activeSignatureKey,
  onSelectSignature,
  lens,
  contractProfile,
  scopedTotal,
}: {
  row: ComplianceRow;
  signatures: Signature[];
  activeSignatureKey: string | null;
  onSelectSignature?: (sig: Signature) => void;
  /** The selected requirement package — which signatures belong to this row. */
  lens: Profile;
  /** The package in force, as the session serves it. */
  contractProfile: Profile;
  /** Transmissions in the scope — the evidence line's denominator. */
  scopedTotal?: number;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const segments = countSegments(row, scopedTotal);
  const findings = findingTotal(row);
  const sigs = signaturesForReq(signatures, row.requirement, lens, contractProfile);
  const hasSigs = sigs.length > 0;
  const max = hasSigs ? Math.max(...sigs.map((s) => s.count)) : 0;
  const visible = showAll ? sigs : sigs.slice(0, 4);
  const extra = sigs.length - 4;

  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontFamily: mono,
          fontSize: 11,
          color: 'var(--text-muted)',
          marginBottom: 7,
        }}
      >
        {segments.flatMap((seg, i) =>
          i === 0 ? [seg] : [<span key={`sep-${i}`}>{' · '}</span>, seg],
        )}
        {segments.length === 0 && 'no transmissions in this window'}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 7 }}>
        <span
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            color: 'var(--text-faint)',
          }}
        >
          {hasSigs ? 'Distinct issues' : 'Status'}
        </span>
        {findings > 0 && (
          <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-muted)' }}>
            {findings} finding{findings === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {hasSigs ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 540 }}>
          {visible.map((s) => (
            <SigRow
              key={s.key}
              sig={s}
              max={max}
              active={s.key === activeSignatureKey}
              onPick={(sig) => onSelectSignature?.(sig)}
            />
          ))}
          {sigs.length > 4 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                alignSelf: 'flex-start',
                fontSize: 11,
                color: 'var(--accent-text)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 0',
              }}
            >
              {showAll ? 'Show fewer' : `+ ${extra} more issue${extra === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {row.counts.fail === 0 && row.counts.pass > 0
            ? 'No issues — every transmission in this window passed.'
            : 'Nothing to surface for this window.'}
        </div>
      )}
    </div>
  );
}

function ReqRow({
  row,
  dead,
  expanded,
  onToggle,
  signatures,
  activeSignatureKey,
  onSelectSignature,
  lens,
  contractProfile,
  scopedTotal,
}: {
  row: ComplianceRow;
  dead: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** All in-scope signatures; filtered to this requirement by the summary block. */
  signatures: Signature[];
  activeSignatureKey: string | null;
  onSelectSignature?: (sig: Signature) => void;
  /** The selected requirement package — the row's tags and signatures read it. */
  lens: Profile;
  /** The package in force, as the session serves it. */
  contractProfile: Profile;
  /** Transmissions in the scope — the expanded evidence line's denominator. */
  scopedTotal?: number;
}): ReactElement {
  const ref = getRequirementReference(row.requirement);
  const text = ref?.text ?? row.summary;
  const guidance = ref?.guidance;
  // tfnv.9: the DS01.3 text is quoted from an unpublished draft, so it carries
  // its provenance wherever it is shown. The test is the table it came out of,
  // not the id's shape: the two key spaces are disjoint, so membership is exact.
  const fromDraft = ref !== undefined && row.requirement in DS013_REFERENCE;
  const tags = rowTags(row, contractProfile);
  // An added clause nothing feeds: `graded` false is the server saying no live
  // count lands here, which is a different statement from "no traffic yet".
  const notFed = isNewInDraft(row) && row.graded === false;

  const rowStyle = rowGridStyle({ expanded, opacity: dead ? 0.5 : 1 });

  return (
    <div data-req={row.requirement}>
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={rowStyle}
      >
        <span
          style={{
            fontFamily: mono,
            fontSize: 11.5,
            color: 'var(--text-faint)',
            ...ROW_SLOT_ID,
          }}
        >
          {row.requirement}
        </span>
        <span style={ROW_SLOT_TITLE}>
          {row.summary}
          <Icon
            name="info"
            size={11}
            style={{ color: 'var(--text-faint)', marginLeft: 6, verticalAlign: 'middle' }}
          />
          {tags.map((tag) => (
            <RowTagPill key={tag.id} tag={tag} />
          ))}
        </span>
        {!dead && (
          <span style={ROW_SLOT_COUNT}>
            {row.counts.fail > 0 && (
              <span style={{ color: 'var(--fail)' }}>{row.counts.fail}f </span>
            )}
            {row.counts.pass > 0 && (
              <span style={{ color: 'var(--pass)' }}>{row.counts.pass}p</span>
            )}
            {/* 2kx: outdated-but-valid validations have no pass finding, so
                without their own tally a `pass-outdated` row would read "—". */}
            {row.outdated > 0 && (
              <span style={{ color: 'var(--mixed)' }}>
                {row.counts.pass > 0 ? ' ' : ''}
                {row.outdated}o
              </span>
            )}
            {row.counts.pass + row.counts.fail + row.outdated === 0 && '—'}
          </span>
        )}
        <span style={ROW_SLOT_VERDICT}>
          {dead ? <StatusPill status={row.status} /> : <StatusPill status={row.status} dot />}
        </span>
      </div>
      {expanded && (
        <div style={DETAIL_PANEL_STYLE}>
          {notFed && (
            <div
              style={{
                marginBottom: 8,
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--text-faint)',
                maxWidth: 640,
              }}
            >
              {NOT_FED_NOTE}
            </div>
          )}
          <div style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: 640 }}>{text}</div>
          {fromDraft && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)', maxWidth: 640 }}>
              {`Quoted from the DS01.3 preview draft, revision ${DS013_REFERENCE_SOURCE.revision} — not yet published.`}
            </div>
          )}
          {guidance && (
            <div
              style={{
                marginTop: 10,
                fontSize: 11.5,
                lineHeight: 1.65,
                color: 'var(--text-muted)',
                maxWidth: 640,
                paddingLeft: 12,
                borderLeft: '2px solid var(--detail-accent)',
              }}
            >
              <strong style={{ fontWeight: 600, color: 'var(--text)' }}>How we check it. </strong>
              {guidance}
            </div>
          )}
          {!dead && (
            <SignatureSummary
              row={row}
              signatures={signatures}
              activeSignatureKey={activeSignatureKey}
              onSelectSignature={onSelectSignature}
              lens={lens}
              contractProfile={contractProfile}
              scopedTotal={scopedTotal}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Advisories — the bottom section of the column (agj.16, synm).
 * ------------------------------------------------------------------ */

/**
 * ONE ADVISORY, as an expandable row in the shape of a {@link ReqRow} (synm).
 *
 * WHY THE SAME SHAPE. An advisory used to render as a bare {@link SigRow} — a
 * cross-filter button with no way into what the observation is about — while a
 * requirement a few pixels above it collapsed and expanded. That difference was
 * an accident of how the two arrived in the column, and it left the rationale
 * reachable only from a transmission that happened to carry the advisory. So the
 * row sits on the same column grid: the 42px id slot (empty — an advisory is not
 * a clause of anything and has no id to print there), the title, the count slot,
 * the verdict slot.
 *
 * WHAT THE SHAPE DOES NOT BRING WITH IT. No StatusPill, no pass/fail tally and
 * no status colour: an advisory is raised against a payload that broke no rule
 * (DESIGN §7.1), so there is no verdict to render and `sigTone`'s accent rule
 * governs every coloured thing here. The verdict slot carries a neutral
 * "advisory" tag in the accent rather than a pill, which says what the row is
 * without saying how it did. The count is transmissions observed, and it feeds
 * nothing — not the conformance rollup, not the scorecard, not the
 * distinct-issues headline.
 *
 * THE EXPANDED BLOCK is the rationale, then ONE control. "Matching
 * transmissions", never "Distinct issues": the label on a requirement's block
 * names defects to fix, and an advisory has none. The control is the cross-filter
 * the retired SigRow was — it hands the whole Signature to `onSelectSignature`
 * and sets nothing else, `failuresOnly` least of all, because an advisory-only
 * transmission has zero failures and would vanish from the filter this click
 * just set.
 *
 * The rationale is the SERVED one (`Signature.rationale`) and the browser holds
 * no copy of it; {@link inlineCode} renders its backticked identifiers, which is
 * a rendering concern rather than a reason to reword the copy.
 */
export function AdvisoryRow({
  sig,
  expanded,
  onToggle,
  active,
  onSelectSignature,
}: {
  sig: Signature;
  expanded: boolean;
  onToggle: () => void;
  /** True when this advisory's key is the active cross-filter. */
  active: boolean;
  onSelectSignature?: (sig: Signature) => void;
}): ReactElement {
  const id = advisoryIdFromKey(sig.key);
  const tone = sigTone(sig);

  return (
    <div data-req={id}>
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={rowGridStyle({ expanded })}
      >
        {/* The id slot, empty and the same width, so advisory titles line up with
            requirement titles rather than starting 42px to their left. */}
        <span style={ROW_SLOT_ID} />
        <span style={ROW_SLOT_TITLE}>{advisoryLabel(id)}</span>
        <span style={{ ...ROW_SLOT_COUNT, color: tone }}>{sig.txCount} tx</span>
        <span style={ROW_SLOT_VERDICT}>
          <Tag label="advisory" color={tone} background="var(--accent-weak)" />
        </span>
      </div>
      {expanded && (
        <div style={DETAIL_PANEL_STYLE}>
          {sig.rationale !== undefined && sig.rationale !== '' && (
            <div style={{ fontSize: 12.5, lineHeight: 1.65, maxWidth: 640 }}>
              {inlineCode(sig.rationale)}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: 'var(--text-faint)',
                marginBottom: 7,
              }}
            >
              Matching transmissions
            </div>
            <button
              onClick={() => onSelectSignature?.(sig)}
              title="View these transmissions"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                textAlign: 'left',
                padding: '7px 11px',
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-weak)' : 'var(--surface)',
              }}
            >
              <span style={{ fontFamily: mono, fontSize: 11.5, color: tone }}>
                {sig.txCount} tx
              </span>
              <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text-faint)' }}>
                {sig.sourceCount} src
              </span>
              <Icon
                name="arrowRight"
                size={13}
                style={{ color: active ? 'var(--accent-text)' : 'var(--text-faint)' }}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Advisories section: the last thing in the compliance column, BELOW
 * Permissive, rendered from the server's advisory signatures.
 *
 * NOT A §7 CLASS, deliberately. It is not in `GROUPS`, has no `CLASS_META`
 * entry, and no `ComplianceClass` — inventing a sixth "class" would have put
 * advisories inside the verifiability matrix, which grades the 27 requirements
 * and is exactly what an advisory has no place in. It is a sibling section that
 * happens to sit in the same scroll column, and it borrows only the group
 * header's SHAPE (chevron · label · count · one faint line) so the column reads
 * as one thing.
 *
 * WHY IT LIVES IN THE COLUMN AT ALL. Its rows read as requirement rows do: an
 * {@link AdvisoryRow} collapses and expands on the same column grid, and what it
 * expands to is the served rationale and one "Matching transmissions" control.
 * That control is the cross-filter the rows themselves used to be, before synm
 * gave each advisory a row of its own — so picking it still hands the whole
 * Signature to `onSelectSignature` and sets NOTHING else. `failuresOnly` is a
 * separate control the Dashboard never touches from here, which matters because
 * an advisory-only transmission has zero failures and would vanish from the
 * cross-filter the click just set.
 *
 * WHAT IT DOES NOT DO: no StatusPill, no `§` cross-link (an advisory belongs to
 * no requirement), no pass/fail tally, and no status colour — see
 * {@link sigTone}. Its count is the number of distinct advisories and feeds
 * nothing: the conformance rollup, the scorecard and the distinct-issues
 * headline all read server numbers that exclude advisories by construction.
 *
 * Renders NOTHING when the scope holds no advisories (returns null, header and
 * all). A permanent "no advisories" line would be noise at the foot of every
 * conformant session, and it was the retired AdvisoriesCard's behaviour too.
 *
 * Hook-free on purpose: the collapse state is the parent's, which keeps this a
 * plain function of its props that ComplianceCard.test.ts can call directly (the
 * repo has no component-test harness — see Setup.test.ts).
 */
export function AdvisorySection({
  signatures,
  collapsed,
  onToggle,
  activeSignatureKey,
  onSelectSignature,
  expandedReq = null,
  onToggleReq,
}: {
  /** ALL in-scope signatures; the advisory half is selected here. */
  signatures: readonly Signature[];
  collapsed: boolean;
  onToggle: () => void;
  activeSignatureKey: string | null;
  onSelectSignature?: (sig: Signature) => void;
  /**
   * Which row is open, shared with the requirement rows (synm). An advisory row
   * is keyed by its `adv.*` id, which cannot collide with a clause id, so the
   * transmission detail's cross-link opens one through the same `onSelectReq`
   * plumbing a finding's § id uses.
   */
  expandedReq?: string | null;
  /** Toggle the open row — the parent's `onToggleReq`. */
  onToggleReq?: (req: string | null) => void;
}): ReactElement | null {
  const sigs = advisorySignatures(signatures);
  if (sigs.length === 0) return null;

  return (
    <div
      data-advisories=""
      style={{
        // The one strong colour on the section, and it is the accent — never a
        // status tone. Carried over from the retired AdvisoriesCard.
        borderLeft: '3px solid var(--accent)',
      }}
    >
      <div
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '10px 16px 8px',
          background: 'var(--surface-3)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          cursor: 'pointer',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <Icon
          name={collapsed ? 'chevron' : 'chevronDown'}
          size={12}
          style={{ color: 'var(--text-faint)' }}
        />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>
          {ADVISORY_COPY.title}
        </span>
        <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-faint)' }}>
          {sigs.length}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 11.5,
            color: 'var(--text-faint)',
            textAlign: 'right',
          }}
        >
          {ADVISORY_COPY.columnSubhead}
        </span>
      </div>
      {!collapsed && (
        <>
          <p
            style={{
              margin: 0,
              padding: '11px 16px 12px',
              fontSize: 11.5,
              lineHeight: 1.55,
              color: 'var(--text-muted)',
              maxWidth: 640,
            }}
          >
            {ADVISORY_COPY.blurb}
          </p>
          {sigs.map((s) => {
            const id = advisoryIdFromKey(s.key);
            return (
              <AdvisoryRow
                key={s.key}
                sig={s}
                expanded={expandedReq === id}
                onToggle={() => onToggleReq?.(expandedReq === id ? null : id)}
                active={s.key === activeSignatureKey}
                onSelectSignature={onSelectSignature}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card.
 * ------------------------------------------------------------------ */

export function ComplianceCard({
  summary,
  expandedReq,
  onToggleReq,
  showNonGradeable,
  onShowNonGradeableChange,
  collapsedGroups,
  onToggleGroup,
  signatures = [],
  onSelectSignature,
  activeSignatureKey = null,
  lens = CONTRACT_PROFILE,
  contractProfile = CONTRACT_PROFILE,
  scopedTotal,
}: CompliancePaneProps): ReactElement {
  // A non-contract package is selected (tfnv.5) — what tints the card's chrome
  // and names the package in the header. The rows read `lens` and
  // `contractProfile` themselves (tfnv.6); this flag is chrome only.
  const draftLens = lens !== contractProfile;
  /*
   * Collapse state for the Advisories section, LOCAL rather than in the parent's
   * `collapsedGroups` — that map is keyed by `ComplianceClass` and advisories are
   * not one (see {@link AdvisorySection}). Default EXPANDED: the section renders
   * nothing at all when empty, so it is only ever on screen when there is
   * something in it, and a collapsed-by-default section that appears out of
   * nowhere would read as one more thing to go looking for.
   */
  const [advisoriesCollapsed, setAdvisoriesCollapsed] = useState(false);

  /*
   * Cross-link reveal (gfx): when a finding §req sets `expandedReq` to a row in a
   * group that's collapsed or filtered out, the row never renders and the click
   * dead-ends. Here we make the target row's group visible: enable the filter if
   * the group is non-gradeable and hidden, and un-collapse it if collapsed.
   *
   * Deps are deliberately ONLY `expandedReq` + `summary`: we read the current
   * `collapsedGroups`/`showNonGradeable` to decide whether a toggle is needed,
   * but we don't want the effect to re-fire when those change (the toggles below
   * would otherwise risk a loop / fight a user re-collapsing the group). The
   * guards ensure each setter fires at most once per cross-link.
   */
  useEffect(() => {
    if (expandedReq === null) return;
    const row = summary.find((r) => r.requirement === expandedReq);
    if (row === undefined) return;
    const group = groupForRow(row);
    if (group === undefined) return;

    const gradeable = CLASS_META[group.rep].gradeable;
    if (gradeable) return; // gradeable groups are always visible — nothing to do

    if (!showNonGradeable) onShowNonGradeableChange(true);
    if (isCollapsed(group, collapsedGroups)) onToggleGroup(group.rep);
  }, [expandedReq, summary]);

  /*
   * The same reveal for an ADVISORY target (synm). The effect above looks the id
   * up in `summary`, which holds requirements only, so an `adv.*` id falls
   * straight through it — and the Advisories section keeps its collapse state
   * here rather than in `collapsedGroups`. Without this, a cross-link from the
   * transmission detail into a collapsed section would dead-end exactly as a
   * cross-link into a collapsed group used to.
   */
  useEffect(() => {
    if (expandedReq === null || !expandedReq.startsWith(ADVISORY_PREFIX)) return;
    if (advisoriesCollapsed) setAdvisoriesCollapsed(false);
  }, [expandedReq]);

  /*
   * Scroll the target row into view — SEPARATE from the reveal effect above so it
   * runs AFTER the un-collapse/un-filter setters have re-rendered the row into the
   * DOM. Keyed on `expandedReq` plus the current `showNonGradeable`/`collapsedGroups`
   * so that when a collapsed/filtered cross-link target becomes visible, this fires
   * again with the row now present (the reveal effect deliberately omits those deps
   * to avoid re-firing the toggles, so the scroll cannot live there). A rAF defers
   * past layout to guarantee the row is mounted; it's cancelled on cleanup.
   */
  useEffect(() => {
    if (expandedReq === null) return;
    if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;

    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-req="${CSS.escape(expandedReq)}"]`);
      el?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
    });

    return () => cancelAnimationFrame(raf);
    // `advisoriesCollapsed` is in the deps for the same reason the group state is
    // (synm): an advisory row only mounts once the section is open, so the scroll
    // has to fire again after the reveal above un-collapses it.
  }, [expandedReq, showNonGradeable, collapsedGroups, advisoriesCollapsed]);

  return (
    <div
      style={{
        flex: REQUIREMENTS_PANE_FLEX,
        background: 'var(--surface)',
        border: `1px solid var(${draftLens ? '--draft-border' : '--border-strong'})`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: 'var(--shadow)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 700 }}>Compliance summary</span>
        {/* Which package these rows ARE (tfnv.5). The name is the vocabulary's,
            and the plum is the page's one signal that a draft is being read. */}
        {draftLens && (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--draft)' }}>
            {`· ${PROFILE_NAME[lens]}`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showNonGradeable}
            onChange={(e) => onShowNonGradeableChange(e.target.checked)}
          />
          Show what we can&apos;t grade
        </label>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {GROUPS.map((group) => {
          const meta = CLASS_META[group.rep];
          const gradeable = meta.gradeable;
          // Filter off → groups 3-5 (the non-gradeable ones) are removed entirely.
          if (!gradeable && !showNonGradeable) return null;

          const rows = summary.filter((r) => {
            const primary = r.classes[0];
            return primary !== undefined && group.members.includes(primary);
          });
          if (rows.length === 0) return null;

          const collapsed = !gradeable && isCollapsed(group, collapsedGroups);

          return (
            <div key={group.rep}>
              <div
                onClick={gradeable ? undefined : () => onToggleGroup(group.rep)}
                role={gradeable ? undefined : 'button'}
                tabIndex={gradeable ? undefined : 0}
                aria-expanded={gradeable ? undefined : !collapsed}
                onKeyDown={
                  gradeable
                    ? undefined
                    : (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onToggleGroup(group.rep);
                        }
                      }
                }
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '10px 16px 8px',
                  background: gradeable ? 'transparent' : 'var(--surface-3)',
                  borderTop: '1px solid var(--border)',
                  borderBottom: gradeable ? '2px solid var(--text)' : '1px solid var(--border)',
                  cursor: gradeable ? 'default' : 'pointer',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                }}
              >
                {!gradeable && (
                  <Icon
                    name={collapsed ? 'chevron' : 'chevronDown'}
                    size={12}
                    style={{ color: 'var(--text-faint)' }}
                  />
                )}
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: gradeable ? 'var(--text)' : 'var(--text-muted)',
                  }}
                >
                  {meta.label}
                </span>
                <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-faint)' }}>
                  {rows.length}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 11.5,
                    color: 'var(--text-faint)',
                    textAlign: 'right',
                  }}
                >
                  {meta.blurb}
                </span>
              </div>
              {!collapsed &&
                rows.map((row) => (
                  <ReqRow
                    key={row.requirement}
                    row={row}
                    dead={!gradeable}
                    expanded={expandedReq === row.requirement}
                    onToggle={() =>
                      onToggleReq(expandedReq === row.requirement ? null : row.requirement)
                    }
                    signatures={signatures}
                    activeSignatureKey={activeSignatureKey}
                    onSelectSignature={onSelectSignature}
                    lens={lens}
                    contractProfile={contractProfile}
                    scopedTotal={scopedTotal}
                  />
                ))}
            </div>
          );
        })}
        {/* Advisories LAST, below Permissive — outside the GROUPS map because it
            is not a §7 verifiability class and must never be graded as one. */}
        <AdvisorySection
          signatures={signatures}
          collapsed={advisoriesCollapsed}
          onToggle={() => setAdvisoriesCollapsed((v) => !v)}
          activeSignatureKey={activeSignatureKey}
          onSelectSignature={onSelectSignature}
          expandedReq={expandedReq}
          onToggleReq={onToggleReq}
        />
      </div>
    </div>
  );
}
