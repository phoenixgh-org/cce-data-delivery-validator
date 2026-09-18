/**
 * Lint guard: no sibling-workspace repo references in published sources.
 *
 * This repo is public, but it is developed inside a workspace of sibling
 * checkouts (the simulator, the spec repo, the downstream store, …). A path
 * like `../WHO_PQS_E006_EMS_specifications/...` dangles for every reader
 * outside that workspace, and several of those siblings are private. Comments
 * and docs must therefore cite something a stranger can resolve — a published
 * URL, or a description of the artifact — never a sibling path or repo name.
 * Cross-project orientation belongs in the workspace-level CLAUDE.md
 * (cce-data-delivery-validator-gvlh).
 *
 * The check anchors on the known sibling repo NAMES rather than a bare `../`,
 * because ordinary TypeScript relative imports (`../pipeline.js`) match that
 * and are perfectly legitimate.
 *
 * Reach: every tracked file whose name ends in an `EXTENSIONS` entry or appears
 * in the `EXTENSIONLESS` set below, anywhere under the repo root outside
 * `SKIP_DIRS` and `SKIP_PATHS`. Both lists are needed because a file with no
 * extension (`Dockerfile`) carries comments just as a `.sh` or `.js` file does,
 * and a sibling path in any of them would otherwise pass lint.
 *
 * Three kinds of tracked text file sit deliberately outside that reach. Every
 * `.json` file is out so the vendored `src/schemas/*.json` can never be edited
 * to satisfy a guard (see `EXTENSIONS` below). The dot-ignore files
 * (`.gitignore`, `.dockerignore`, `.prettierignore`) are out because they list
 * tool paths rather than prose and are not published pages, so a sibling
 * reference has no reason to appear in one. And this file itself is out, by
 * path, via `EXEMPT_FILES` below — it has to spell the sibling names out to
 * match them.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Directories never scanned: build output, deps, tracker state, local-only docs. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.beads', '.git', 'coverage']);
const SKIP_PATHS = new Set(['docs/internal']);

/**
 * Scanned file types. `.json` is deliberately absent: `src/schemas/*.json` are
 * vendored upstream bytes that must stay byte-identical to the published
 * artifact, so they must never be edited to satisfy a guard. That exclusion is
 * why this stays an allowlist rather than a denylist of binary types — a
 * denylist would sweep the vendored schemas back in.
 *
 * Entries are matched with `endsWith`, not a parsed extension, so `.example`
 * reaches `.env.example` (cce-data-delivery-validator-47le).
 */
const EXTENSIONS = [
  '.md',
  '.ts',
  '.tsx',
  '.sql',
  '.yml',
  '.yaml',
  '.mjs',
  '.cjs',
  '.js',
  '.sh',
  '.html',
  '.css',
  '.example',
];

/**
 * Tracked files an extension allowlist cannot reach, matched by exact name.
 * They are published text like any other source, and a `../sibling` path in one
 * of them would otherwise pass the guard silently
 * (cce-data-delivery-validator-mpza).
 */
const EXTENSIONLESS = new Set(['Caddyfile', 'Dockerfile', 'LICENSE']);

/**
 * The guard exempts itself by path: the PATTERNS table below has to spell the
 * sibling names out to match them, so scanning this file would report every
 * entry as a violation. The exemption is on the path, not on the pattern list,
 * so that moving the list elsewhere later stays an open decision.
 */
const EXEMPT_FILES = new Set(['scripts/check-sibling-refs.mjs']);

/**
 * Sibling repos in this workspace. `ems-data-simulator` is public and may be
 * cited by its GitHub URL, so only the `../` path form is rejected for it.
 */
const PATTERNS = [
  { name: 'tremble', re: /tremble/gi },
  { name: '../ems-data-simulator', re: /\.\.\/ems-data-simulator/gi },
  { name: 'WHO_PQS_E006_EMS_specifications', re: /WHO_PQS_E006_EMS_specifications/gi },
  { name: 'ColdchainDB', re: /ColdchainDB/gi },
  { name: 'cce-mdm', re: /cce-mdm/gi },
  { name: 'docs-2to8-cc', re: /docs-2to8-cc/gi },
  { name: 'lccdx', re: /lccdx/gi },
  { name: 'pogodv', re: /pogodv/gi },
  { name: 'varo-app', re: /varo-app/gi },
  { name: 'dx-load-testing', re: /dx-load-testing/gi },
  { name: 'openfmr', re: /openfmr/gi },
];

/** Every scannable file under `dir`, as repo-relative paths. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_PATHS.has(rel)) continue;
      yield* walk(abs);
    } else if (
      entry.isFile() &&
      (EXTENSIONS.some((ext) => entry.name.endsWith(ext)) || EXTENSIONLESS.has(entry.name))
    ) {
      if (!EXEMPT_FILES.has(rel)) yield rel;
    }
  }
}

const violations = [];

for await (const rel of walk(root)) {
  const lines = (await readFile(join(root, rel), 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) violations.push({ rel, line: i + 1, name, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(
    'sibling-repo references found (this repo is public — cite a published URL instead):\n',
  );
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}: ${v.name}`);
    console.error(`    ${v.text}`);
  }
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  `no sibling-repo references (checked files ending in ${EXTENSIONS.join(', ')} plus ${[
    ...EXTENSIONLESS,
  ].join(', ')}, outside ${[...SKIP_DIRS, ...SKIP_PATHS].join(', ')}; .json and the dot-ignore ` +
    `files are excluded by design)`,
);
