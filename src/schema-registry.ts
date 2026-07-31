/**
 * Schema registry (content-hash pinned).
 *
 * Hosts the *vendored* transmission JSON Schemas, currently 0.8.1 only.
 *
 * DIALECT: 0.8.1 as published declares JSON Schema **2020-12**, so the registry
 * compiles with Ajv's 2020 build (`ajv/dist/2020`), NOT the draft-07 default
 * export. The pre-release 0.8.0 was draft-07 and is deliberately no longer
 * registered (see VENDORED) — nothing outside this machine ever used it, and
 * carrying it would mean selecting an Ajv build per entry for no benefit. If a
 * future version ever reintroduces a second dialect, that per-entry selection
 * is the seam to add: each version already compiles in its own Ajv instance.
 *
 * Design constraints (DESIGN.md §9):
 *   - Never fetched at runtime: `meta.schemaVersion` is an opaque lookup key.
 *   - Normalized matching: accept a bare semver (`0.8.0`) OR a full `$id`-style
 *     URL, extract MAJOR.MINOR.PATCH, then *exact-match* — no fuzzy fallback.
 *   - Content-hash provenance: each version is pinned by the SHA-256 of its
 *     canonical (byte-identical-to-published) bytes.
 *   - Ajv compiles each schema once at startup; the compiled validator is reused.
 *     The process fails loudly at boot if the blessed bytes don't compile.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AnySchema, ValidateFunction } from 'ajv';
// The 2020-12 build, not the draft-07 default export — see the dialect note
// above. Named import (not default) so it resolves under NodeNext ESM: the
// default export of this CJS build types as a namespace, not a constructor.
import { Ajv2020 } from 'ajv/dist/2020.js';

/** A schema version vendored into the registry. */
interface VendoredSchema {
  /** Canonical MAJOR.MINOR.PATCH key. */
  version: string;
  /** Path to the byte-identical published bytes, relative to this module. */
  file: string;
}

/**
 * The blessed set of vendored schemas. The file is loaded as raw bytes so the
 * SHA-256 is taken over exactly the published artifact (not a re-serialization).
 */
const VENDORED: readonly VendoredSchema[] = [
  { version: '0.8.1', file: './schemas/cce-interop-0.8.1.json' },
];

/** A compiled, ready-to-use registry entry. */
export interface RegistryEntry {
  readonly version: string;
  /** Lowercase hex SHA-256 of the canonical bytes. */
  readonly sha256: string;
  readonly validate: ValidateFunction;
}

/** Result of a registry lookup. */
export type LookupResult =
  | { readonly ok: true; readonly entry: RegistryEntry }
  | {
      readonly ok: false;
      readonly reason: 'unsupported';
      readonly requested: string;
      readonly supported: readonly string[];
    };

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

/**
 * Normalize a raw `schemaVersion` value to a canonical MAJOR.MINOR.PATCH key.
 *
 * Accepts a bare semver (`0.8.0`) or a full `$id`-style URL
 * (`https://schemas.2to8.cc/schemas/cce-interop-0.8.0.json`). Returns null if no
 * MAJOR.MINOR.PATCH triple can be extracted.
 */
export function normalizeVersion(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const m = SEMVER_RE.exec(raw);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Order two canonical MAJOR.MINOR.PATCH keys by numeric value so `0.8.10` sorts
 * AFTER `0.8.9` (a plain string sort would mis-rank them). Both inputs are
 * already-canonical registry keys, so the triple always parses.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function buildAjv(): Ajv2020 {
  // 2020-12 is the dialect declared by the vendored schema's $schema. Ajv's
  // DEFAULT export validates draft-07 and rejects a 2020-12 schema outright
  // ("no schema with key or ref .../draft/2020-12/schema"), which took the whole
  // process down at boot when 0.8.1 was republished — SchemaRegistry.load() runs
  // inside buildApp(). Use the 2020 build.
  //
  // `strict: false` is kept from the draft-07 configuration: the published bytes
  // are not ours to adjust, so schema-authoring warnings must never fail a boot.
  return new Ajv2020({ allErrors: true, strict: false });
}

export class SchemaRegistry {
  private readonly byVersion = new Map<string, RegistryEntry>();

  private constructor() {}

  /**
   * Load + compile every vendored schema. Throws if any blessed bytes are
   * missing or fail to compile, so the process fails loudly at boot.
   */
  static load(): SchemaRegistry {
    const registry = new SchemaRegistry();

    for (const { version, file } of VENDORED) {
      const path = fileURLToPath(new URL(file, import.meta.url));
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (err) {
        throw new Error(
          `schema registry: failed to read vendored ${version} at ${path}: ${String(err)}`,
        );
      }

      const sha256 = sha256Hex(bytes);

      let validate: ValidateFunction;
      try {
        // Each schema compiles in its OWN Ajv instance.
        //
        // This was originally justified by the vendored versions sharing one
        // `$id`. That was never true of the *published* schemas — every release
        // carries a version-specific `$id` — it was true only of our vendored
        // 0.8.1, which was a copy of 0.8.0's bytes with the `$id` left stale
        // (fixed 2026-07-25). Isolation is kept deliberately: it means a future
        // vendored file with a duplicate or malformed `$id` degrades to "that
        // one version fails to compile" rather than poisoning the whole
        // registry at boot.
        const ajv = buildAjv();
        const schema = JSON.parse(bytes.toString('utf8')) as AnySchema;
        validate = ajv.compile(schema);
      } catch (err) {
        throw new Error(
          `schema registry: failed to compile ${version} (sha256 ${sha256}): ${String(err)}`,
        );
      }

      registry.byVersion.set(version, { version, sha256, validate });
    }

    return registry;
  }

  /** Sorted list of canonical versions this registry can validate against. */
  supportedVersions(): readonly string[] {
    return [...this.byVersion.keys()].sort(compareVersions);
  }

  /**
   * The CURRENT (newest) registered version — the highest MAJOR.MINOR.PATCH the
   * registry knows. A transmission that validates against an older registered
   * version is "outdated but valid": still accepted, but flagged so the supplier
   * can upgrade (DESIGN.md §7; the dashboard's OUTDATED SCHEMA signal). Returns
   * null only for an empty registry (never in practice — load() seeds it).
   */
  currentVersion(): string | null {
    const versions = this.supportedVersions();
    return versions.length === 0 ? null : versions[versions.length - 1]!;
  }

  /** Direct entry access for an already-canonical version key. */
  get(version: string): RegistryEntry | undefined {
    return this.byVersion.get(version);
  }

  /**
   * Normalize `raw` (bare semver or `$id` URL), then exact-match. Unknown or
   * unparseable versions return `{ ok: false, supported: [...] }`. No fuzzy
   * fallback to a "close" version.
   */
  lookup(raw: string): LookupResult {
    const requested = normalizeVersion(raw) ?? raw;
    const entry = this.byVersion.get(requested);
    if (entry) return { ok: true, entry };
    return {
      ok: false,
      reason: 'unsupported',
      requested,
      supported: this.supportedVersions(),
    };
  }
}
