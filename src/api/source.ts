/**
 * The SOURCE dimension (4h4.2) — a stable presentation pair derived from a
 * transmission's raw source key (`transmission.transfer_src`, populated from
 * meta.transferSrc).
 *
 * Volume comes from "one or multiple CCEs", so every transmission carries a
 * source/device identifier the dashboard scopes by. This module is a small PURE
 * helper (no DB, no HTTP) so BOTH the per-transmission list rows AND the filter
 * `<select>` options derive `sourceCode`/`sourceLabel` IDENTICALLY — a single
 * source of truth keeps the row chip and the option in lock-step.
 */

/**
 * Stable bucket for a null/empty/blank `transfer_src`. A single bucket collapses
 * every source-less transmission together; the code/label/key are constants so
 * the bucket renders consistently everywhere.
 *
 *   - `key`   — the empty string; the canonical raw key for "no source".
 *   - `code`  — three em-dash-free dashes; a visually distinct, stable 3-char code.
 *   - `label` — a human "Unknown source" label.
 */
export const UNKNOWN_SOURCE_KEY = '';
export const UNKNOWN_SOURCE_CODE = '---';
export const UNKNOWN_SOURCE_LABEL = 'Unknown source';

/** The presentation pair derived from a raw source key. */
export interface SourceView {
  /** Raw source key (the trimmed `transfer_src`, or the empty string when absent). */
  source: string;
  /** Stable 3-char UPPERCASE code (e.g. KAN). Deterministic from {@link source}. */
  sourceCode: string;
  /** Human label — the raw key (or the "unknown" label for the null bucket). */
  sourceLabel: string;
}

/** Split a key into significant tokens on any run of non-alphanumeric chars. */
function tokenize(key: string): string[] {
  return key.split(/[^a-zA-Z0-9]+/).filter((t) => t.length > 0);
}

/** Leading reverse-DNS namespace tokens we skip so the code keys off the name. */
const NAMESPACE_TOKENS = new Set(['org', 'com', 'net', 'io', 'gov', 'edu']);

/**
 * Derive the stable 3-letter UPPERCASE code from a raw source key.
 *
 * RULE (deterministic — the same key always yields the same code):
 *   1. Split the key into significant tokens on any non-alphanumeric run
 *      (".", "-", "_", whitespace, …), dropping a single leading reverse-DNS
 *      namespace token ("org"/"com"/"net"/"io"/"gov"/"edu") when more tokens
 *      remain, so "org.kano-depot" keys off "kano" rather than "org".
 *   2. Take the FIRST three alphanumeric characters of the first remaining
 *      significant token — so "org.kano-depot" → "KAN", "kano" → "KAN".
 *   3. If that token is shorter than 3 chars, append the next tokens' leading
 *      letters; right-pad with 'X' if still short. Then uppercase.
 *
 * Examples: "org.kano-depot" → "KAN"; "kano" → "KAN"; "ab" → "ABX";
 * "x.y.z" → "XYZ"; "" → "---" (the unknown bucket).
 */
export function deriveSourceCode(rawKey: string): string {
  const trimmed = (rawKey ?? '').trim();
  if (trimmed.length === 0) return UNKNOWN_SOURCE_CODE;

  let tokens = tokenize(trimmed);
  if (tokens.length > 1 && NAMESPACE_TOKENS.has(tokens[0]!.toLowerCase())) {
    tokens = tokens.slice(1);
  }

  // Build from the first token's leading alnum chars, drawing on later tokens'
  // leading letters only when the first token is shorter than 3 chars.
  let code = tokens[0] ?? trimmed.replace(/[^a-zA-Z0-9]/g, '');
  for (let i = 1; code.length < 3 && i < tokens.length; i += 1) {
    code += tokens[i]![0]!;
  }

  // Pad to exactly 3 chars (short keys like "ab") and uppercase.
  return (code.slice(0, 3) + 'XXX').slice(0, 3).toUpperCase();
}

/**
 * Derive the full {@link SourceView} presentation pair from a raw `transfer_src`.
 * A null/undefined/blank key collapses to the single stable "unknown" bucket.
 */
export function deriveSourceView(rawKey: string | null | undefined): SourceView {
  const trimmed = (rawKey ?? '').trim();
  if (trimmed.length === 0) {
    return {
      source: UNKNOWN_SOURCE_KEY,
      sourceCode: UNKNOWN_SOURCE_CODE,
      sourceLabel: UNKNOWN_SOURCE_LABEL,
    };
  }
  return {
    source: trimmed,
    sourceCode: deriveSourceCode(trimmed),
    sourceLabel: trimmed,
  };
}

/** One filter `<select>` option: a source view plus its in-scope count. */
export interface SourceCount extends SourceView {
  /** How many transmissions in the scoped set carry this source. */
  count: number;
}

/** The minimal shape {@link sourceCounts} reads off a scoped transmission. */
export interface HasTransferSrc {
  transfer_src: string | null;
}

/**
 * Window-aware per-source counts (4h4.2 #4): fold a SCOPED transmission set into
 * `[{ source, sourceCode, sourceLabel, count }]` for the filter `<select>`
 * options. Sources are keyed by raw key (null/blank → the single unknown
 * bucket), so the counts and the row chips agree. Sorted by count descending,
 * then by source key ascending for a stable order on ties.
 *
 * The caller passes the ALREADY-scoped set (the window/source filtering endpoint
 * is a separate issue); this helper just counts whatever it is handed.
 */
export function sourceCounts(transmissions: readonly HasTransferSrc[]): SourceCount[] {
  const byKey = new Map<string, SourceCount>();
  for (const t of transmissions) {
    const view = deriveSourceView(t.transfer_src);
    const existing = byKey.get(view.source);
    if (existing) existing.count += 1;
    else byKey.set(view.source, { ...view, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}
