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
 * It lives in its own module rather than in `app.ts` so the Vite config can
 * import it without dragging Fastify (and the rest of the server) into the
 * config's import graph. Nothing here may import anything.
 */
export const API_PREFIXES = ['/api', '/i', '/health'];
