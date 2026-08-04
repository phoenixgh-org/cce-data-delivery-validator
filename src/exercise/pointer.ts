/**
 * Minimal RFC 6901 JSON Pointer write helpers for the exercise transform
 * vocabulary (8qa.1).
 *
 * Payload mutators address the field they change by pointer (`/data/0/AMID`)
 * so a case reads as its own documentation. Only the two operations the
 * vocabulary needs are implemented — set and delete — and both THROW rather than
 * silently no-op when the path does not resolve. A transform that quietly failed
 * to mutate would turn a fail-direction case into a false pass, which is exactly
 * the defect this suite exists to catch.
 *
 * Findings elsewhere in the codebase already speak RFC 6901 (Ajv `instancePath`,
 * `Finding.pointer`), so cases and findings share one addressing scheme.
 */

/** Split a pointer into unescaped reference tokens (`~1` → `/`, `~0` → `~`). */
export function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`JSON Pointer must be '' or start with '/': ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Escape one reference token for embedding in a pointer (RFC 6901 §3). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

/** Read one child of `node` by reference token, or throw with the full pointer. */
function child(node: unknown, token: string, pointer: string): unknown {
  if (!isContainer(node)) {
    throw new Error(`JSON Pointer ${pointer}: cannot descend into a non-object at "${token}"`);
  }
  if (Array.isArray(node)) {
    const index = arrayIndex(node, token, pointer);
    return node[index];
  }
  return (node as Record<string, unknown>)[token];
}

/** Parse + bounds-check an array index token. */
function arrayIndex(array: unknown[], token: string, pointer: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    throw new Error(`JSON Pointer ${pointer}: "${token}" is not an array index`);
  }
  const index = Number(token);
  if (index >= array.length) {
    throw new Error(`JSON Pointer ${pointer}: index ${index} is past the end of the array`);
  }
  return index;
}

/** Resolve everything but the last token, returning the parent and final key. */
function resolveParent(root: unknown, pointer: string): { parent: Container; key: string } {
  const tokens = pointerTokens(pointer);
  if (tokens.length === 0) {
    throw new Error('JSON Pointer must address a member, not the whole document');
  }
  let node: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    node = child(node, token, pointer);
  }
  if (!isContainer(node)) {
    throw new Error(`JSON Pointer ${pointer}: parent is not an object or array`);
  }
  return { parent: node, key: tokens[tokens.length - 1]! };
}

/**
 * Set the value at `pointer`, creating the member if its parent is an object.
 * Array members must already exist (an exercise never appends by pointer).
 */
export function setAtPointer(root: unknown, pointer: string, value: unknown): void {
  const { parent, key } = resolveParent(root, pointer);
  if (Array.isArray(parent)) {
    parent[arrayIndex(parent, key, pointer)] = value;
    return;
  }
  parent[key] = value;
}

/** Delete the member at `pointer`. Throws if it is not there to delete. */
export function deleteAtPointer(root: unknown, pointer: string): void {
  const { parent, key } = resolveParent(root, pointer);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(parent, key, pointer), 1);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new Error(`JSON Pointer ${pointer}: nothing to delete at "${key}"`);
  }
  delete parent[key];
}
