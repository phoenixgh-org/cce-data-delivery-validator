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
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Directories never scanned: build output, deps, tracker state, local-only docs. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.beads', '.git', 'coverage']);
const SKIP_PATHS = new Set(['docs/internal']);

const EXTENSIONS = ['.md', '.ts', '.tsx'];

/**
 * TEMPORARY EXEMPTION. The root CLAUDE.md is the agent-orientation file and
 * still carries the sibling map; its cleanup is in flight on a separate branch
 * (chore/claude-md-no-sibling-refs). Delete this entry once that lands — the
 * guard is meant to cover CLAUDE.md too.
 */
const EXEMPT_FILES = new Set(['CLAUDE.md']);

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
    } else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
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
  `no sibling-repo references (checked ${EXTENSIONS.join(', ')} outside ${[...SKIP_DIRS].join(', ')})`,
);
