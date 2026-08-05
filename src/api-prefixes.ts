/**
 * The path prefixes owned by the backend, in ONE place.
 *
 * Two consumers must agree on this list, and they live in different runtimes:
 *
 *   - `src/app.ts` — the SPA fallback must NEVER serve index.html for these
 *     paths; they get the framework's real 404/405 instead, so e.g.
 *     `GET /api/sessions/<bad-uuid>` reaches the API.
 *   - `vite.config.ts` — `npm run dev:web` serves the UI from Vite and proxies
 *     exactly these prefixes to the API process on :3000. A prefix present in
 *     one list but not the other means dev silently serves the SPA shell for a
 *     backend route (beads 51o).
 *
 * Sharing the LIST is not enough: the two consumers must also agree on how a
 * prefix MATCHES, and by default they do not. Fastify compares path segments,
 * while http-proxy (and therefore Vite) matches a plain string context with
 * `startsWith` — so `/api` swallowed `/api.ts`, the SPA's own API-client module,
 * and the dashboard never mounted (bug 5cb). Both semantics now come from here:
 * {@link isApiPath} for Fastify, {@link apiProxyContext} for Vite.
 *
 * It lives in its own module rather than in `app.ts` so the Vite config can
 * import it without dragging Fastify (and the rest of the server) into the
 * config's import graph. Nothing here may import anything.
 */
export const API_PREFIXES = ['/api', '/i', '/health'];

/**
 * True when `pathname` is owned by a backend route (must not be SPA-fallen-back).
 *
 * Matching is SEGMENT-AWARE: a prefix claims itself and everything below it,
 * never a sibling that merely starts with the same characters. `/api` owns
 * `/api` and `/api/sessions`; it does not own `/api.ts` or `/apiary`, and `/i`
 * does not own `/icons/foo.png`.
 *
 * Takes a pathname — strip any query string before calling.
 */
export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The Vite/http-proxy context that matches exactly what {@link isApiPath} does.
 *
 * Vite treats a context beginning with `^` as a regular expression tested
 * against the raw request URL (`doesProxyContextMatchUrl`), which is the only
 * way to express a boundary — a bare string context is `startsWith`, and that
 * is what made the dev server proxy `/api.ts` (bug 5cb).
 *
 * The URL still carries its query string here, where {@link isApiPath} sees a
 * pathname, so `?` terminates the prefix as well as `/` — otherwise
 * `/health?probe=1` would stop being proxied. (A fragment never reaches the
 * wire, so `#` needs no such treatment.)
 */
export function apiProxyContext(prefix: string): string {
  // Prefixes are literal paths, but escape anyway so a future prefix containing
  // a regex metacharacter cannot quietly widen the match.
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?]|$)`;
}
