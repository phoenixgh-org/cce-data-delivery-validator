/**
 * Display-status and verifiability-class lookup tables for the redesigned
 * dashboard primitives (108.2). These translate the REAL api.ts unions
 * (NOT the prototype's shorthand keys) into presentational metadata.
 *
 * Both maps are `Record<Union, …>` so TS exhaustiveness CATCHES any union
 * member that lacks an entry — there is deliberately no index/`||` fallback
 * that could hide a gap. The intent comes from the redesign README's
 * "Status -> display label" and "Verifiability classes -> labels" tables;
 * the shorthand prototype keys are mapped to the real union members here
 * (e.g. attested -> 'attestation', active -> 'active-only',
 * na/permissive -> 'not-applicable'/'none', info -> 'not-exercised').
 */
import type { ComplianceClass, DisplayStatus } from '../../api';

/**
 * Colour family a StatusPill renders in. `dead` = non-gradeable / dimmed:
 * --text-faint text, transparent bg, 1px --border (no status colour).
 */
export type StatusKind = 'pass' | 'fail' | 'mixed' | 'neutral' | 'dead';

export interface StatusMeta {
  /** Short label rendered inside the pill. */
  label: string;
  /** Drives the pill colour family. */
  kind: StatusKind;
}

/**
 * Real DisplayStatus union -> {label, kind}. Translated from the prototype's
 * shorthand STATUS_META (info/attested/active/na) to the real union members:
 *   not-exercised    <- prototype "info"      (neutral; not driven by traffic)
 *   self-attestation <- prototype "attested"  (dead)
 *   not-applicable   <- prototype "na"        (dead)
 *   (no real key maps to the prototype's "active"/"deferred" — that concept
 *    lives on the ComplianceClass side as 'active-only'.)
 */
export const STATUS_META: Record<DisplayStatus, StatusMeta> = {
  pass: { label: 'pass', kind: 'pass' },
  // 2kx: passed, but against a registered-but-OLDER schema version. It borrows
  // the `mixed` (amber) colour family on purpose — that is the same --mixed
  // tone as the per-transmission OUTDATED SCHEMA tag and the soft/info
  // signature bars, so one amber means one thing across the dashboard. The
  // label stays short enough for the pill column; the row's amber outdated
  // count and the expanded "validated against an outdated schema" line supply
  // the detail.
  'pass-outdated': { label: 'outdated', kind: 'mixed' },
  fail: { label: 'fail', kind: 'fail' },
  mixed: { label: 'mixed', kind: 'mixed' },
  untested: { label: 'untested', kind: 'neutral' },
  enforced: { label: 'enforced', kind: 'neutral' },
  'not-exercised': { label: 'deferred', kind: 'dead' },
  'self-attestation': { label: 'self-attested', kind: 'dead' },
  'not-applicable': { label: 'n/a', kind: 'dead' },
};

/** Foreground / background CSS-var pair for each pill kind. */
export const STATUS_KIND_COLORS: Record<StatusKind, { fg: string; bg: string }> = {
  pass: { fg: 'var(--pass)', bg: 'var(--pass-bg)' },
  fail: { fg: 'var(--fail)', bg: 'var(--fail-bg)' },
  mixed: { fg: 'var(--mixed)', bg: 'var(--mixed-bg)' },
  neutral: { fg: 'var(--neutral)', bg: 'var(--neutral-bg)' },
  dead: { fg: 'var(--text-faint)', bg: 'transparent' },
};

export interface ClassMeta {
  /** Plain-language label that replaces the §7 glyph legend. */
  label: string;
  /** One-line explainer used as the section sub-blurb + tooltip text. */
  blurb: string;
  /** Whether a receiver can actually grade this class from traffic. */
  gradeable: boolean;
}

/**
 * Real ComplianceClass union -> {label, blurb, gradeable}. Labels + blurbs
 * follow the README "Verifiability classes -> labels" table and the
 * ComplianceCard group sub-blurbs. Shorthand mapping:
 *   attestation <- prototype "attested"
 *   active-only <- prototype "active"
 *   none        <- prototype "permissive"
 */
export const CLASS_META: Record<ComplianceClass, ClassMeta> = {
  verified: {
    label: 'Verified',
    blurb: 'Confirmed directly from your traffic.',
    gradeable: true,
  },
  heuristic: {
    label: 'Heuristic',
    blurb: 'Inferred from a partial signal — a hint, not proof.',
    gradeable: true,
  },
  enforced: {
    label: 'Enforced',
    blurb: 'Guaranteed by the ingest endpoint itself.',
    gradeable: false,
  },
  attestation: {
    label: 'Self-attested',
    blurb: 'Only you can confirm these — a receiver cannot prove them.',
    gradeable: false,
  },
  'active-only': {
    label: 'Needs active testing',
    blurb: 'Requires a test mode that probes your client. Coming later.',
    gradeable: false,
  },
  none: {
    label: 'Permissive',
    blurb: 'Allowed — nothing to grade.',
    gradeable: false,
  },
};
