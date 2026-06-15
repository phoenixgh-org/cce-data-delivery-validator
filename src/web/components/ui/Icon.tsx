/**
 * Inline outline icon set for the redesigned dashboard (108.2). Each icon is a
 * 24x24 SVG drawn at 1.6px stroke in `currentColor` — no icon font, no emoji.
 * Colour follows the surrounding text colour; size defaults to 14px.
 */
import type { CSSProperties, ReactElement } from 'react';

export type IconName =
  | 'chevron'
  | 'chevronDown'
  | 'info'
  | 'copy'
  | 'lock'
  | 'trash'
  | 'filter'
  | 'alert'
  | 'check'
  | 'refresh';

export interface IconProps {
  name: IconName;
  /** Square px size (width = height). Defaults to 14. */
  size?: number;
  style?: CSSProperties;
}

const PATHS: Record<IconName, ReactElement> = {
  chevron: <polyline points="9 6 15 12 9 18" />,
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.4" fill="currentColor" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </>
  ),
  filter: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  alert: (
    <>
      <path d="M12 3l9 16H3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <circle cx="12" cy="17" r="0.4" fill="currentColor" />
    </>
  ),
  check: <polyline points="5 12 10 17 19 7" />,
  refresh: (
    <>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
      <path d="M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
      <path d="M4 20v-4h4" />
    </>
  ),
};

export function Icon({ name, size = 14, style }: IconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
