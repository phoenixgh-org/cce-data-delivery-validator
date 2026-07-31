/**
 * Synthetic-data-only warning (dkz.1).
 *
 * This service is a test/sandbox: receiving real production data is an explicit
 * non-goal (DESIGN §2), and the entire capability-URL design is justified ONLY
 * by that constraint — the UUID is a bearer secret in the path, and URLs leak
 * via logs, proxies, and browser history (DESIGN §12). So the warning has to be
 * visible both BEFORE the endpoint is created (Landing) and at the moment of
 * integration (Setup), with identical wording. One component, two call sites.
 *
 * Styled with the `--mixed` (warning) tokens + the `alert` icon, matching the
 * existing show-once-credential callout in Setup; `--fail` is reserved for the
 * Danger zone.
 */
import { Icon } from './Icon';

export interface SyntheticDataNoticeProps {
  /** Denser type/padding for the in-dashboard Setup panel. */
  compact?: boolean;
}

export function SyntheticDataNotice({ compact }: SyntheticDataNoticeProps) {
  return (
    <div
      role="note"
      style={{
        display: 'flex',
        gap: compact ? 8 : 10,
        alignItems: 'flex-start',
        border: '1px solid var(--mixed)',
        background: 'var(--mixed-bg)',
        borderRadius: 6,
        padding: compact ? '9px 11px' : '12px 14px',
        marginBottom: compact ? 14 : 20,
      }}
    >
      <Icon
        name="alert"
        size={compact ? 13 : 15}
        style={{ color: 'var(--mixed)', flexShrink: 0, marginTop: 1 }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 12 : 13,
            fontWeight: 700,
            color: 'var(--text)',
            marginBottom: 3,
          }}
        >
          Synthetic test data only
        </div>
        <div
          style={{
            fontSize: compact ? 11.5 : 12.5,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
          }}
        >
          Send synthetic or test payloads only. Never point a live CCE fleet at this endpoint, and
          never send real facility, device, or personal data. The endpoint URL is a bearer
          capability — anyone holding it can read everything you send, and URLs leak through logs,
          proxies, and browser history.
        </div>
      </div>
    </div>
  );
}
