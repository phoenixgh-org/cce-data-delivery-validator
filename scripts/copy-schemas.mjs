/**
 * Copy vendored schema bytes into the build output.
 *
 * `tsc` does not emit non-TS assets, so the byte-identical vendored schemas in
 * `src/schemas/` must be copied to `dist/schemas/` for the built app to load
 * them at runtime (the registry resolves them relative to its own module URL).
 */

import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = new URL('../src/schemas/', import.meta.url);
const dest = new URL('../dist/schemas/', import.meta.url);

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

console.log(`copied schemas: ${src.pathname} -> ${dest.pathname} (root ${root})`);
