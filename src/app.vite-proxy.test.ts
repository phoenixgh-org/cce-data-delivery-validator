/**
 * Drift guard for the dev-server proxy (beads 51o).
 *
 * `npm run dev:web` serves the SPA from Vite and proxies the backend-owned
 * prefixes to the API on :3000; `buildApp()` uses the same list to keep its SPA
 * fallback from shadowing backend routes. Both now read {@link API_PREFIXES},
 * but a hand-written literal is easy to reintroduce in vite.config.ts, and the
 * failure it causes is silent — dev serves the SPA shell for a real API route
 * instead of proxying it. So assert the config's actual proxy keys.
 *
 * Needs no DB and starts no server: it imports the Vite config object only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_PREFIXES } from './api-prefixes.js';
import viteConfig from '../vite.config.js';

test('vite dev proxy covers exactly API_PREFIXES', () => {
  const proxy = viteConfig.server?.proxy;
  assert.ok(proxy, 'vite.config.ts declares no server.proxy');
  assert.deepEqual([...Object.keys(proxy)].sort(), [...API_PREFIXES].sort());
});

test('every proxied prefix targets the API dev server', () => {
  const proxy = viteConfig.server?.proxy ?? {};
  for (const [prefix, target] of Object.entries(proxy)) {
    assert.equal(target, 'http://127.0.0.1:3000', `${prefix} proxies somewhere unexpected`);
  }
});
