import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { API_PREFIXES } from './src/api-prefixes.js';

/**
 * Vite build for the M4 React SPA (DESIGN §13, frontend stack LOCKED to
 * React SPA + Vite + @fastify/static). The app source lives under `src/web`;
 * the build emits to `dist/web`, which `buildApp()` in src/app.ts serves as
 * static files with an SPA fallback so `/d/:uuid` deep-links resolve.
 *
 * `server` below is the DEV story (beads 4z2) and affects `npm run dev:web`
 * only, never `vite build`: the Node process cannot serve the dashboard in dev
 * (it would be serving this untransformed source), so the UI is served here with
 * HMR and the backend-owned prefixes are proxied to `npm run dev` on :3000.
 * Client routes (`/`, `/d/:uuid`) are NOT proxied — Vite's SPA fallback serves
 * them, exactly as @fastify/static does in production.
 */
const DEV_API_TARGET = 'http://127.0.0.1:3000';

/**
 * Proxy map DERIVED from the single API_PREFIXES list src/app.ts uses for its
 * SPA fallback, so the two cannot drift (beads 51o); src/app.vite-proxy.test.ts
 * asserts the equality a future hand-written literal here would break.
 */
const devProxy = Object.fromEntries(API_PREFIXES.map((prefix) => [prefix, DEV_API_TARGET]));

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: devProxy,
  },
});
