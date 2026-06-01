import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite build for the M4 React SPA (DESIGN §13, frontend stack LOCKED to
 * React SPA + Vite + @fastify/static). The app source lives under `src/web`;
 * the build emits to `dist/web`, which `buildApp()` in src/app.ts serves as
 * static files with an SPA fallback so `/d/:uuid` deep-links resolve.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
