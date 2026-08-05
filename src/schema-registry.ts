/**
 * Schema registry (content-hash pinned).
 *
 * Hosts the *vendored* transmission JSON Schemas: 0.8.0 and 0.8.1, with 0.8.1
 * the CURRENT (newest) version and 0.8.0 registered as outdated-but-valid.
 *
 * DIALECT IS PER ENTRY. The two registered versions do not share a dialect:
 * 0.8.1 as published declares JSON Schema **2020-12** (Ajv's `ajv/dist/2020`
 * build), while 0.8.0 declares **draft-07** (Ajv's default export). Neither
 * build validates the other's `$schema`, so each entry names its dialect and
 * {@link buildAjv} selects the build — the seam this header used to describe as
 * hypothetical, made real by the decision below. Each version already compiled
 * in its own Ajv instance, which is what made the seam cheap.
 *
 * WHY 0.8.0 IS BACK. Registering it was decided on 2026-08-04 (bd 8qa.4),
 * amending bd fvw's 2026-08-02 stance that nothing further would register until
 * instructed ("this decision creates no outdated cohort"). The instruction came:
 * an outdated cohort is wanted deliberately, because with a single registered
 * version the outdated-but-valid branch of the schema stage
 * (src/ingest/stages/schema.ts) is unreachable by construction and so is the
 * dashboard's OUTDATED SCHEMA signal — neither could be exercised end to end.
 * 0.8.0 is the version a supplier is most likely to still be sending, which
 * makes it the honest choice of cohort. The decision was narrowed: 0.7.x and
 * earlier stay out entirely, and 0.8.2/0.8.3 (present upstream in the authoring
 * folder) stay out for now, so CURRENT remains 0.8.1.
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
// BOTH builds, one per dialect — see the dialect note above. Named imports (not
// defaults) so they resolve under NodeNext ESM: the default export of these CJS
// builds types as a namespace, not a constructor.
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * The JSON Schema dialect a vendored file declares in its `$schema`, and hence
 * the Ajv build that can compile it. Not inferred from the bytes: which build a
 * blessed file compiles under is part of what "blessed" means, so it is stated
 * here and would have to be changed deliberately.
 */
export type SchemaDialect = 'draft-07' | '2020-12';

/** A schema version vendored into the registry. */
interface VendoredSchema {
  /** Canonical MAJOR.MINOR.PATCH key. */
  version: string;
  /** Path to the byte-identical published bytes, relative to this module. */
  file: string;
  /** The dialect its `$schema` declares — selects the Ajv build. */
  dialect: SchemaDialect;
}

/**
 * The blessed set of vendored schemas. The file is loaded as raw bytes so the
 * SHA-256 is taken over exactly the published artifact (not a re-serialization).
 *
 * Order does not matter — every consumer sorts by {@link compareVersions} — but
 * oldest-first matches how the set is read aloud, and the LAST entry by version
 * (not by position) is what `currentVersion()` reports.
 */
const VENDORED: readonly VendoredSchema[] = [
  { version: '0.8.0', file: './schemas/cce-interop-0.8.0.json', dialect: 'draft-07' },
  { version: '0.8.1', file: './schemas/cce-interop-0.8.1.json', dialect: '2020-12' },
];

/** A compiled, ready-to-use registry entry. */
export interface RegistryEntry {
  readonly version: string;
  /** Lowercase hex SHA-256 of the canonical bytes. */
  readonly sha256: string;
  readonly validate: ValidateFunction;
}

/**
 * The publishable half of a {@link RegistryEntry}: what a registered schema IS,
 * with no compiled validator attached — the shape safe to serialize to clients.
 *
 * `sha256` is always the hash computed over the vendored bytes at load(), which
 * is the entire point of surfacing it: the dashboard used to state the schema
 * provenance as a hardcoded literal and once shipped a fabricated hash (beads
 * 3cq). A hash that travels from the bytes is a hash that cannot drift.
 */
export interface SchemaProvenance {
  readonly version: string;
  /** Lowercase hex SHA-256 of the vendored bytes, computed at load(). */
  readonly sha256: string;
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

function buildAjv(dialect: SchemaDialect): Ajv | Ajv2020 {
  // The build MUST match the dialect the file declares. Ajv's DEFAULT export
  // validates draft-07 and rejects a 2020-12 schema outright ("no schema with
  // key or ref .../draft/2020-12/schema") — which took the whole process down at
  // boot when 0.8.1 was republished, since SchemaRegistry.load() runs inside
  // buildApp(). The 2020 build refuses draft-07's `$schema` for the mirror-image
  // reason. Neither is a superset of the other, so this is a switch, not a
  // default with an exception.
  //
  // `allErrors` so a §3.2 rejection can list every violation at once, and
  // `strict: false` because the published bytes are not ours to adjust —
  // schema-authoring warnings must never fail a boot. Both apply to both builds.
  const options = { allErrors: true, strict: false };
  return dialect === '2020-12' ? new Ajv2020(options) : new Ajv(options);
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

    for (const { version, file, dialect } of VENDORED) {
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
        // (fixed 2026-07-25). Isolation is kept deliberately, and now earns its
        // keep twice over: the instances are no longer even the same CLASS
        // (draft-07 vs 2020-12 builds), and a future vendored file with a
        // duplicate or malformed `$id` still degrades to "that one version fails
        // to compile" rather than poisoning the whole registry at boot.
        const ajv = buildAjv(dialect);
        const schema = JSON.parse(bytes.toString('utf8')) as AnySchema;
        validate = ajv.compile(schema);
      } catch (err) {
        throw new Error(
          `schema registry: failed to compile ${version} as ${dialect} (sha256 ${sha256}): ${String(err)}`,
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

  /**
   * Every registered schema as {@link SchemaProvenance}, oldest first — what the
   * API serves so the dashboard can state which bytes it grades against.
   *
   * Derived from the SAME entries `lookup()` validates with, so the reported
   * hash is by construction the hash of the bytes actually in force; there is no
   * second copy of the value to fall out of step. Reports the registered set
   * exactly as it is (0.8.0 and 0.8.1 today) — it never asserts how many versions
   * there ought to be, which is why the dashboard survived the set growing from
   * one entry to two without a code change.
   */
  provenance(): readonly SchemaProvenance[] {
    return [...this.byVersion.values()]
      .map(({ version, sha256 }) => ({ version, sha256 }))
      .sort((a, b) => compareVersions(a.version, b.version));
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
