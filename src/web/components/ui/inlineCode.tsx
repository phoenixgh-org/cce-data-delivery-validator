/**
 * Backticked identifiers, rendered as inline code (synm).
 *
 * Advisory prose is written in the house style, where an identifier is wrapped
 * in backticks — `ems-report`, `TVC`, `ASER`. The server serves those strings
 * verbatim, because the check that owns the wording is the single owner of it
 * and the browser holds no copy. So the backticks arrive in the browser, and the
 * fix belongs here rather than in the copy: stripping them server-side would
 * lose the distinction between an identifier and a word, and re-authoring the
 * copy without them would put a rendering concern in the prose.
 *
 * One helper, used everywhere the dashboard shows advisory prose — the rationale
 * on a compliance-column advisory row, and the observation line in the
 * transmission detail, including its pre-summary fallback, which renders the
 * rationale itself.
 *
 * Unpaired backticks are left alone: a lone tick is text, not an unterminated
 * span, so prose that happens to contain one renders as written rather than
 * swallowing the rest of the sentence.
 */
import type { ReactNode } from 'react';

/** Monospace ink for an identifier inside a sentence. */
const codeStyle = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  padding: '0 3px',
  borderRadius: 3,
  background: 'var(--surface-3)',
  color: 'var(--text)',
} as const;

/**
 * Split prose on paired backticks: even indices are plain text, odd indices are
 * the identifier inside a pair. Exported for the test, which pins the split
 * itself — the element tree around it is styling.
 */
export function splitInlineCode(text: string): string[] {
  return text.split(/`([^`]+)`/g);
}

/**
 * The prose with each backticked span rendered as `<code>`. Returns the string
 * unchanged when it carries no pair, so a caller can use it on every line
 * without paying for a wrapper that says nothing.
 */
export function inlineCode(text: string): ReactNode {
  const parts = splitInlineCode(text);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} style={codeStyle}>
        {part}
      </code>
    ) : (
      part
    ),
  );
}
