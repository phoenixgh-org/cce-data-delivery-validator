/**
 * §1.3 opt-in credential generation + verification (DESIGN.md §3, §12).
 *
 * The SINGLE source of truth for both STORING and VERIFYING the opt-in auth
 * secret. ct4.2's ingest auth stage imports {@link verifyCredential} and ct4.3's
 * dashboard toggle drives {@link generateCredential} via the sessions API — neither
 * re-implements hashing, so the column mapping below lives here and nowhere else.
 *
 * Hashing: there is NO password-hashing dependency in this repo (sha256 — the only
 * existing hash, src/schema-registry.ts — is a content fingerprint, NOT appropriate
 * for a credential). We use node:crypto `scryptSync` with a per-secret random salt
 * and a `timingSafeEqual` comparison; no new dependency.
 *
 * Column mapping (reuses the existing `session` columns, no schema change):
 *   - `header` method: `auth_header_name` = the configurable header name (e.g.
 *     `X-CCE-Token`); `auth_secret_hash` = KDF(generated token). Verify reads the
 *     named header and checks KDF(value) matches.
 *   - `basic`  method: `auth_header_name` = the Basic username; `auth_secret_hash`
 *     = KDF(generated password). Verify decodes `Authorization: Basic
 *     base64(user:pass)`, requires `user === auth_header_name` AND KDF(pass) match.
 *   - `bearer` method (DS01.3 clause 5.1.5 / RFC 6750, 5bs.4): `auth_header_name`
 *     = the literal `Authorization` (the header is fixed by the scheme — there is
 *     nothing to configure, but the column stays populated so the ingest stage can
 *     name the expected header uniformly); `auth_secret_hash` = KDF(generated
 *     token). Verify requires `Authorization: Bearer <token>` and KDF(token) match.
 *
 * `basic` and `bearer` SHARE the `Authorization` header, so both verifies dispatch
 * on the SCHEME token — matched case-insensitively per RFC 9110 §11.1 — and never
 * on mere header presence. A Basic credential presented to a bearer-configured
 * session (or vice versa) fails as surely as a wrong secret.
 *
 * Stored form of `auth_secret_hash` is `salt:hash` (both hex). The plaintext token
 * or password is returned by {@link generateCredential} exactly once (§12) and is
 * never persisted in the clear.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { AuthMethod } from '../db/repository.js';

/** scrypt output length (bytes) — 32 is a standard derived-key size. */
const KEY_LEN = 32;
/** Per-secret random salt length (bytes). */
const SALT_LEN = 16;
/** Default header name when the caller does not pick one (configurable per §1.3). */
const DEFAULT_HEADER_NAME = 'X-CCE-Token';
/** Generated-secret length (bytes); 24 random bytes → 48 hex chars of entropy. */
const SECRET_LEN = 24;
/** Generated Basic-auth username when the caller does not supply one. */
const DEFAULT_BASIC_USER = 'cce';
/**
 * The header a `bearer` credential always rides in (RFC 6750 §2.1). Unlike the
 * `header` method's configurable name, this one is fixed by the scheme; it is
 * stored in `auth_header_name` so every method populates the column.
 */
const BEARER_HEADER_NAME = 'Authorization';

/** Options for {@link generateCredential}, by method. */
export interface GenerateOptions {
  /** `header`: the header name to carry the token (default `X-CCE-Token`). */
  headerName?: string;
  /** `basic`: the username half of the Basic credential (default `cce`). */
  username?: string;
}

/**
 * The auth columns to persist on the session. Mirrors the `auth_*` fields of
 * `SessionRow` minus the boolean toggle (the repository helper flips
 * `auth_enabled` separately). NEVER returned to clients — `auth_secret_hash` is
 * a stored hash, not the plaintext.
 */
export interface StoredAuth {
  auth_method: AuthMethod;
  auth_header_name: string;
  auth_secret_hash: string;
}

/**
 * Result of generating a credential: the {@link StoredAuth} to persist, plus the
 * plaintext secret (token, or Basic password) to show the supplier EXACTLY ONCE
 * (§12). The plaintext is never stored and never returned again.
 */
export interface GeneratedCredential {
  store: StoredAuth;
  /**
   * Show-once plaintext. For `header` and `bearer`, the token; for `basic`, the
   * password.
   */
  plaintext: string;
  /** For `basic`, the username half (it is not secret — also stored as the header name). */
  username?: string;
}

/** The stored auth fields a verify reads — the relevant subset of `SessionRow`. */
export interface StoredSessionAuth {
  auth_enabled: boolean;
  auth_method: AuthMethod | null;
  auth_header_name: string | null;
  auth_secret_hash: string | null;
}

/**
 * The request-side material a verify checks. `headerValue` is the value of the
 * configured header (`header` method) — typically read case-insensitively by the
 * caller; `authorization` is the raw `Authorization` request header (`basic` and
 * `bearer` methods, told apart by their scheme token). Either may be undefined
 * when the client sent nothing.
 */
export interface PresentedCredential {
  headerValue?: string;
  authorization?: string;
}

/** Derive `salt:hash` (hex) from a plaintext secret with a fresh random salt. */
function hashSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(plaintext, salt, KEY_LEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Constant-time check that `plaintext` reproduces the stored `salt:hash`. Returns
 * false on any malformed stored value rather than throwing.
 */
function verifySecret(plaintext: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const saltHex = stored.slice(0, sep);
  const hashHex = stored.slice(sep + 1);
  if (saltHex.length === 0 || hashHex.length === 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = scryptSync(plaintext, salt, expected.length);
  // Lengths are equal by construction (derived to expected.length), so
  // timingSafeEqual will not throw — but guard anyway for malformed input.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Generate a fresh §1.3 credential for `method`. Returns the columns to persist
 * (only the salted hash, never plaintext) plus the show-once plaintext.
 */
export function generateCredential(
  method: AuthMethod,
  opts: GenerateOptions = {},
): GeneratedCredential {
  const plaintext = randomBytes(SECRET_LEN).toString('hex');

  if (method === 'header') {
    const headerName = opts.headerName?.trim() || DEFAULT_HEADER_NAME;
    return {
      store: {
        auth_method: 'header',
        auth_header_name: headerName,
        auth_secret_hash: hashSecret(plaintext),
      },
      plaintext,
    };
  }

  if (method === 'bearer') {
    // bearer: nothing is configurable — the token rides in `Authorization: Bearer
    // <token>` (RFC 6750 §2.1), so auth_header_name records that fixed header.
    return {
      store: {
        auth_method: 'bearer',
        auth_header_name: BEARER_HEADER_NAME,
        auth_secret_hash: hashSecret(plaintext),
      },
      plaintext,
    };
  }

  // basic: the username is stored in auth_header_name (it is not secret), the
  // password is the show-once plaintext whose hash we persist.
  const username = opts.username?.trim() || DEFAULT_BASIC_USER;
  return {
    store: {
      auth_method: 'basic',
      auth_header_name: username,
      auth_secret_hash: hashSecret(plaintext),
    },
    plaintext,
    username,
  };
}

/**
 * Split an `Authorization` header into its scheme token and the remainder
 * (RFC 9110 §11.6.2 `credentials = auth-scheme [ 1*SP token68 … ]`). The scheme
 * is returned LOWERCASED — it is matched case-insensitively per RFC 9110 §11.1,
 * so `Bearer`, `bearer` and `BEARER` are the same scheme. Returns null for an
 * absent header or one with no scheme + parameter pair.
 */
function parseAuthorization(
  authorization: string | undefined,
): { scheme: string; params: string } | null {
  if (typeof authorization !== 'string') return null;
  // tchar set for the scheme token, then at least one space, then the rest
  // (trailing whitespace trimmed).
  const m = /^[ \t]*([A-Za-z0-9!#$%&'*+\-.^_`|~]+)[ \t]+(.*?)[ \t]*$/.exec(authorization);
  if (!m || !m[2]) return null;
  return { scheme: m[1]!.toLowerCase(), params: m[2] };
}

/**
 * The lowercased scheme token of an `Authorization` header (`basic`, `bearer`, …),
 * or null when absent/unparseable. Exported so the ingest stage can EXPLAIN a
 * scheme mismatch without re-parsing the header itself — `basic` and `bearer`
 * share the header, so "something was presented" is not the same question as
 * "the right scheme was presented".
 */
export function authorizationScheme(authorization: string | undefined): string | null {
  return parseAuthorization(authorization)?.scheme ?? null;
}

/** Decode an `Authorization: Basic base64(user:pass)` header → {user, pass} or null. */
function decodeBasic(authorization: string | undefined): { user: string; pass: string } | null {
  const parsed = parseAuthorization(authorization);
  if (!parsed || parsed.scheme !== 'basic') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(parsed.params, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header (RFC 6750 §2.1),
 * or null when the header is absent, carries another scheme, or is malformed. The
 * token68 grammar admits no internal whitespace, so `Bearer a b` is rejected rather
 * than silently taken as `a b`.
 */
function decodeBearer(authorization: string | undefined): string | null {
  const parsed = parseAuthorization(authorization);
  if (!parsed || parsed.scheme !== 'bearer') return null;
  if (/\s/.test(parsed.params)) return null;
  return parsed.params;
}

/**
 * Verify a presented credential against a session's stored auth fields.
 * Timing-safe. Returns false (never throws) for missing/malformed presented
 * material or an incompletely-configured session.
 *
 * NOTE: this only decides credential correctness. The CALLER decides whether to
 * verify at all — when `auth_enabled` is false the ingest stage continues without
 * calling this (§3 zero-friction default). Here, a disabled/unconfigured session
 * yields false.
 */
export function verifyCredential(
  presented: PresentedCredential,
  session: StoredSessionAuth,
): boolean {
  if (!session.auth_enabled) return false;
  if (!session.auth_secret_hash || !session.auth_header_name) return false;

  if (session.auth_method === 'header') {
    const value = presented.headerValue;
    if (typeof value !== 'string' || value.length === 0) return false;
    return verifySecret(value, session.auth_secret_hash);
  }

  if (session.auth_method === 'bearer') {
    // Dispatch on the SCHEME, not on header presence: a `Basic …` value here is a
    // miss, not a candidate (decodeBearer returns null for any other scheme).
    const token = decodeBearer(presented.authorization);
    if (token === null || token.length === 0) return false;
    return verifySecret(token, session.auth_secret_hash);
  }

  if (session.auth_method === 'basic') {
    const creds = decodeBasic(presented.authorization);
    if (!creds) return false;
    // Username must match (case-sensitive) AND the password hash must match.
    // Check the password hash unconditionally so a wrong username does not
    // short-circuit into a faster path (keeps the cost roughly uniform).
    const passOk = verifySecret(creds.pass, session.auth_secret_hash);
    const userOk =
      creds.user.length === session.auth_header_name.length &&
      timingSafeEqual(Buffer.from(creds.user), Buffer.from(session.auth_header_name));
    return passOk && userOk;
  }

  return false;
}
