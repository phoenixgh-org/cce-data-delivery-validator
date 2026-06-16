/**
 * Delete-confirm modal (108.8). A typed-confirmation gate over the danger-zone
 * "Delete all captured data" flow (README §Modal — Delete confirm). The scrim
 * covers the dashboard; the centered card requires the user to type `DELETE`
 * (case-insensitive, trimmed) before the red "Delete everything" button arms.
 *
 * This component is render-only: it owns nothing but the local input value (via
 * the lifted `value`/`onChange` props the Dashboard plumbs into `deleteConfirm`)
 * and emits `onCancel`/`onConfirm`. The actual `deleteSessionData` call + refetch
 * live in the Dashboard so the modal stays presentational.
 *
 * Motion: fade only, gated on `prefers-reduced-motion` per the existing
 * ComplianceCard convention (no keyframes; a mount flag drives an opacity
 * transition).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { Icon } from './ui/Icon';

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Shared neutral button (mirrors the prototype `uBtn`). */
const btn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontFamily: 'var(--sans)',
  color: 'var(--text-muted)',
  background: 'var(--surface)',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export interface DeleteModalProps {
  /** Whether the modal is shown. */
  open: boolean;
  /** Current transmission count ({N} in the body copy). */
  count: number;
  /** Lifted confirm-input value (Dashboard's `deleteConfirm`). */
  value: string;
  /** Update the lifted confirm-input value. */
  onChange: (value: string) => void;
  /** Dismiss without deleting (scrim click, Cancel, Escape). */
  onCancel: () => void;
  /** Run the delete (only reachable once armed). */
  onConfirm: () => void;
}

export function DeleteModal({
  open,
  count,
  value,
  onChange,
  onCancel,
  onConfirm,
}: DeleteModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Mount flag drives the fade-in; reset whenever the modal re-opens. Also focus
  // the confirm input on open (autofocus without the JSX attribute).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    inputRef.current?.focus();
    if (prefersReducedMotion) {
      setShown(true);
      return;
    }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Escape closes (cancels) the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const armed = value.trim().toUpperCase() === 'DELETE';

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,26,24,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        opacity: shown ? 1 : 0,
        transition: prefersReducedMotion ? undefined : 'opacity 140ms ease',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          boxSizing: 'border-box',
          background: 'var(--surface)',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          boxShadow: '0 20px 50px rgba(0,0,0,.25)',
          padding: '22px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Icon name="alert" size={18} style={{ color: 'var(--fail)' }} />
          <span id="delete-modal-title" style={{ fontSize: 15, fontWeight: 700 }}>
            Delete all captured data?
          </span>
        </div>
        <p
          style={{
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--text-muted)',
            margin: '0 0 14px',
          }}
        >
          This permanently removes{' '}
          <strong style={{ color: 'var(--text)' }}>
            {count} transmission{count === 1 ? '' : 's'}
          </strong>{' '}
          and all their findings. The endpoint and ingest URL keep working, so you can start a fresh
          test protocol. This cannot be undone.
        </p>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
          Type{' '}
          <code style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)' }}>
            DELETE
          </code>{' '}
          to confirm.
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'var(--mono)',
            fontSize: 13,
            padding: '8px 11px',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            background: 'var(--surface-2)',
            color: 'var(--text)',
            marginBottom: 16,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
          <button type="button" style={btn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!armed}
            onClick={onConfirm}
            style={{
              ...btn,
              color: '#fff',
              background: 'var(--fail)',
              border: 'none',
              opacity: armed ? 1 : 0.4,
              cursor: armed ? 'pointer' : 'not-allowed',
            }}
          >
            <Icon name="trash" size={12} /> Delete everything
          </button>
        </div>
      </div>
    </div>
  );
}
