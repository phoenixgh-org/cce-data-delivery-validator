/**
 * Schema registry (content-hash pinned).
 *
 * Hosts the *vendored* transmission JSON Schemas (draft-07), seeded with 0.8.0.
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

import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

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
  { version: '0.8.0', file: './schemas/cce-interop-0.8.0.json' },
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

function buildAjv(): Ajv {
  // draft-07 is the dialect declared by the vendored schema's $schema.
  // Ajv's default export validates draft-07.
  return new Ajv({ allErrors: true, strict: false });
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
    const ajv = buildAjv();

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
    return [...this.byVersion.keys()].sort();
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
