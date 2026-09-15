/**
 * Schema registry (content-hash pinned).
 *
 * Hosts the *vendored* transmission JSON Schemas. There are now TWO LINEAGES
 * registered side by side, and almost every rule below is stated per lineage:
 *
 *   - profile `'2025'` — the contract in force: the `cce-interop` versions the
 *     service actually grades against. 0.8.1 is CURRENT, 0.8.0 is registered as
 *     the deliberate outdated cohort.
 *   - profile `'ds013'` — the SHADOW lineage: the WHO PQS DS01.3 Annex 4
 *     delivery-schema change proposal, revision `1`, draft dated 2026-09-08.
 *     Registered so transmissions can be graded a second time against where the
 *     standard is heading, never as the contract.
 *
 * {@link CONTRACT_PROFILE} names which lineage is the contract. It is the single
 * flip point: when DS01.3 is published and adopted, that constant moves and the
 * two lineages swap roles without any caller re-deciding for itself.
 *
 * CURRENT / OUTDATED IS INTRA-PROFILE ONLY. `currentVersion(profile)` reports the
 * newest key WITHIN that lineage, and a transmission is "outdated but valid"
 * only against a newer version of ITS OWN lineage. 0.8.1 is not outdated because
 * revision `1` of the Annex 4 draft exists — the two keys are not comparable at
 * all, and {@link compareVersions} refuses to compare across them rather than
 * inventing an order. Profile is declared per entry in {@link VENDORED}, never
 * inferred from the shape of the key at lookup time.
 *
 * KEY SHAPES DIFFER PER LINEAGE. `cce-interop` keys are a MAJOR.MINOR.PATCH
 * triple. Annex 4 dropped semver deliberately — PQS will not maintain a semver
 * contract, and each annex versions independently — so its `meta.schemaVersion`
 * is the STRING `"1"`, an integer revision counter. {@link normalizeVersion}
 * therefore accepts both shapes, plus each lineage's `$id` form (the
 * `https://schemas.2to8.cc/...` URL and the `urn:who:pqs:e006:ds01:annex4:1`
 * URN). Matching stays EXACT after normalization; there is no fuzzy fallback.
 *
 * DIALECT IS PER ENTRY. The registered versions do not share a dialect: 0.8.1 as
 * published and the Annex 4 draft both declare JSON Schema **2020-12** (Ajv's
 * `ajv/dist/2020` build), while 0.8.0 declares **draft-07** (Ajv's default
 * export). Neither build validates the other's `$schema`, so each entry names its
 * dialect and {@link buildAjv} selects the build.
 *
 * WHY 0.8.0 IS REGISTERED. Decided on 2026-08-04 (bd 8qa.4), amending bd fvw's
 * 2026-08-02 stance that nothing further would register until instructed. An
 * outdated cohort is wanted deliberately: with a single registered version the
 * outdated-but-valid branch of the schema stage (src/ingest/stages/schema.ts) is
 * unreachable by construction and so is the dashboard's OUTDATED SCHEMA signal.
 * 0.8.0 is the version a supplier is most likely to still be sending. The
 * decision was narrowed: 0.7.x and earlier stay out entirely, and 0.8.2/0.8.3
 * stay out for now, so CURRENT for the contract profile remains 0.8.1.
 *
 * THE ANNEX 4 FILE MAY BE RE-PINNED IN PLACE — and it is the ONLY file in
 * `src/schemas/` that may (decided 2026-09-14, bd by1c.1). The published
 * `cce-interop` bytes are immutable: a new version means a new file, never an
 * edit. The Annex 4 bytes are an unpublished draft, so there is no published
 * artifact for a hash to protect; when the proposal is revised, replace the
 * vendored bytes, update `draftDate` and the hash asserted in the test, and keep
 * the key. The dashboard labels the entry a draft and shows its hash, so nobody
 * can mistake it for a published schema.
 *
 * Design constraints (DESIGN.md §9):
 *   - Never fetched at runtime: `meta.schemaVersion` is an opaque lookup key.
 *   - Normalized matching, then *exact-match* — no fuzzy fallback.
 *   - Content-hash provenance: each version is pinned by the SHA-256 of its
 *     canonical bytes (byte-identical to what was published, or — for the draft
 *     — to the proposal document as received).
 *   - Ajv compiles each schema once at startup; the compiled validator is reused.
 *     The process fails loudly at boot if the blessed bytes don't compile.
 *   - ONE ENTRY PER KEY across both lineages: entries are held in a single map
 *     keyed by the canonical version alone, so `load()` throws on a repeat rather
 *     than letting the later entry replace the earlier one unseen (bd by1c.23).
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

import { PROFILES } from './profile-vocabulary.js';

/**
 * The JSON Schema dialect a vendored file declares in its `$schema`, and hence
 * the Ajv build that can compile it. Not inferred from the bytes: which build a
 * blessed file compiles under is part of what "blessed" means, so it is stated
 * here and would have to be changed deliberately.
 */
export type SchemaDialect = 'draft-07' | '2020-12';

/**
 * The requirement lineage a vendored schema belongs to: `'2025'` is the
 * `cce-interop` family the service grades against today, `'ds013'` the DS01.3
 * Annex 4 draft it grades against in shadow. Mirrored by `Profile` in
 * src/db/repository.ts (findings) and src/web/api.ts (browser code).
 */
export type Profile = '2025' | 'ds013';

/**
 * Every profile, in the order the registry reports them — contract lineage
 * first. Defined with the rest of the profile vocabulary
 * (src/profile-vocabulary.ts, bd by1c.32) and re-exported here so callers that
 * think of the profile set as a registry fact still read it off the registry.
 */
export { PROFILES };

/**
 * Which lineage is the contract in force. THE single flip point: when DS01.3 is
 * published and adopted this becomes `'ds013'`, and `currentVersion()`,
 * `supportedVersions()`, the copy-paste sample and the dashboard header all
 * follow without a second decision being made anywhere else.
 */
export const CONTRACT_PROFILE: Profile = '2025';

/**
 * A schema version vendored into the registry.
 *
 * Exported only so {@link SchemaRegistry.loadFrom} can be given a synthetic set
 * in tests; the blessed set is {@link VENDORED} and nothing else constructs one.
 */
export interface VendoredSchema {
  /** Canonical key: a MAJOR.MINOR.PATCH triple, or an integer revision. */
  version: string;
  /** Path to the byte-identical published bytes, relative to this module. */
  file: string;
  /** The dialect its `$schema` declares — selects the Ajv build. */
  dialect: SchemaDialect;
  /** Which lineage the version belongs to. Declared, never inferred (see header). */
  profile: Profile;
  /**
   * ISO date of the DRAFT this file is a copy of, for an unpublished proposal.
   * Absent for a published schema — published bytes are identified by their
   * version and hash, and have no draft date to report.
   */
  draftDate?: string;
}

/**
 * The blessed set of vendored schemas. The file is loaded as raw bytes so the
 * SHA-256 is taken over exactly the published artifact (not a re-serialization).
 *
 * Order does not matter — every consumer sorts by {@link compareVersions} within
 * a profile — but oldest-first matches how the set is read aloud, and the LAST
 * entry by version WITHIN ITS PROFILE (not by position) is what
 * `currentVersion(profile)` reports.
 */
const VENDORED: readonly VendoredSchema[] = [
  {
    version: '0.8.0',
    file: './schemas/cce-interop-0.8.0.json',
    dialect: 'draft-07',
    profile: '2025',
  },
  {
    version: '0.8.1',
    file: './schemas/cce-interop-0.8.1.json',
    dialect: '2020-12',
    profile: '2025',
  },
  // The DS01.3 Annex 4 delivery-schema change proposal, revision 1 — an
  // UNPUBLISHED draft dated 2026-09-08, pinned by hash like everything else and
  // registered as the shadow lineage. See the header for the re-pin rule: this
  // is the one file here that may be replaced in place when the draft moves.
  {
    version: '1',
    file: './schemas/pqs-e006-ds01-annex4-1.json',
    dialect: '2020-12',
    profile: 'ds013',
    draftDate: '2026-09-08',
  },
];

/** A compiled, ready-to-use registry entry. */
export interface RegistryEntry {
  readonly version: string;
  /** Lowercase hex SHA-256 of the canonical bytes. */
  readonly sha256: string;
  /** The lineage this version belongs to — see {@link Profile}. */
  readonly profile: Profile;
  /** ISO date of the draft these bytes are a copy of; absent when published. */
  readonly draftDate?: string;
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
  /**
   * Which lineage the version belongs to. The dashboard reads THIS to decide
   * what to name in the copy-paste sample and the header label: every surface
   * that used to treat "registered" as "contract-grade" now selects on it.
   */
  readonly profile: Profile;
  /**
   * ISO date of the draft these bytes are a copy of, when the entry is an
   * unpublished proposal. Its presence is what licenses the dashboard to label
   * the entry a draft rather than a published schema.
   */
  readonly draftDate?: string;
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

/** A bare integer revision key, the Annex 4 lineage's key shape. */
const INTEGER_RE = /^\d+$/;

/**
 * A URN whose LAST colon-separated segment is an integer revision, e.g.
 * `urn:who:pqs:e006:ds01:annex4:1` — the `$id` form of the Annex 4 lineage, the
 * counterpart of the `https://schemas.2to8.cc/...` URL for `cce-interop`.
 */
const URN_REVISION_RE = /^urn:[^\s]*:(\d+)$/i;

/**
 * Normalize a raw `schemaVersion` value to a canonical registry key.
 *
 * Two key shapes, one per lineage (see the header):
 *   - MAJOR.MINOR.PATCH, from a bare semver (`0.8.0`) or a full `$id`-style URL
 *     (`https://schemas.2to8.cc/schemas/cce-interop-0.8.0.json`);
 *   - an integer revision, from a bare integer string (`1`) or a URN whose last
 *     segment is one (`urn:who:pqs:e006:ds01:annex4:1`).
 *
 * Returns null when neither shape is present. Semver is tried first, so a value
 * that carries a triple keeps normalizing exactly as it always did; `1.0.0`
 * therefore stays the semver key `1.0.0` (unregistered, hence unsupported) and
 * never collapses onto the Annex 4 key `1`.
 *
 * Normalization is deliberately shallow — it recognizes a shape, it does not
 * repair one. `01` normalizes to `01` and then misses, because exact match after
 * normalization is the whole discipline here.
 */
export function normalizeVersion(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const semver = SEMVER_RE.exec(raw);
  if (semver) return `${semver[1]}.${semver[2]}.${semver[3]}`;
  if (INTEGER_RE.test(raw)) return raw;
  const urn = URN_REVISION_RE.exec(raw);
  if (urn) return urn[1]!;
  return null;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Order two canonical keys of the SAME lineage by numeric value, so `0.8.10`
 * sorts after `0.8.9` and revision `10` after revision `9` (a plain string sort
 * would mis-rank both). Both inputs are already-canonical registry keys.
 *
 * Throws on a mixed pair. `0.8.1` and `1` are not two points on one scale — they
 * are counters from two different standards — so there is no answer to give, and
 * silently returning one would be how a 0.8.1 transmission ends up graded
 * "outdated" against an Annex 4 draft. Every caller sorts within a profile.
 */
function compareVersions(a: string, b: string): number {
  const aInt = INTEGER_RE.test(a);
  const bInt = INTEGER_RE.test(b);
  if (aInt !== bInt) {
    throw new Error(
      `schema registry: refusing to order "${a}" against "${b}" — different lineages are not comparable`,
    );
  }
  if (aInt) return Number(a) - Number(b);
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
    return SchemaRegistry.loadFrom(VENDORED);
  }

  /**
   * {@link load} over an arbitrary entry list. Separate only so the duplicate-key
   * guard below can be exercised without vendoring a real duplicate file; the
   * service always loads {@link VENDORED}.
   */
  static loadFrom(entries: readonly VendoredSchema[]): SchemaRegistry {
    const registry = new SchemaRegistry();

    for (const { version, file, dialect, profile, draftDate } of entries) {
      // `byVersion` is keyed by the canonical version ALONE, and the two lineages
      // share that key space, so a repeat would silently replace the earlier
      // entry and the registry would boot clean — invisible to every consumer,
      // all of which read back from the deduped map. Fail loudly instead, the
      // same way bytes that will not compile do (bd by1c.23).
      const clash = registry.byVersion.get(version);
      if (clash !== undefined) {
        throw new Error(
          `schema registry: duplicate version key ${version} (profiles ${clash.profile} and ${profile}); ` +
            `each vendored entry must normalize to its own key`,
        );
      }

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

      registry.byVersion.set(version, { version, sha256, profile, draftDate, validate });
    }

    return registry;
  }

  /**
   * Sorted list of the canonical versions of ONE lineage, oldest first. Defaults
   * to the contract profile, which is what every pre-shadow caller meant by
   * "supported": the versions a supplier is expected to be sending today.
   */
  supportedVersions(profile: Profile = CONTRACT_PROFILE): readonly string[] {
    return [...this.byVersion.values()]
      .filter((e) => e.profile === profile)
      .map((e) => e.version)
      .sort(compareVersions);
  }

  /**
   * Every key the registry will accept, contract lineage first, each lineage
   * sorted within itself (never across — see {@link compareVersions}).
   *
   * This is what a rejection lists back to the supplier: the honest answer to
   * "what would you have accepted?" is everything `lookup()` resolves, shadow
   * revisions included, not just the contract cohort.
   */
  acceptedVersions(): readonly string[] {
    return PROFILES.flatMap((profile) => this.supportedVersions(profile));
  }

  /**
   * The CURRENT (newest) registered version OF ONE LINEAGE — the highest key
   * within `profile`, defaulting to the contract profile. A transmission that
   * validates against an older registered version OF ITS OWN lineage is
   * "outdated but valid": still accepted, but flagged so the supplier can upgrade
   * (DESIGN.md §7; the dashboard's OUTDATED SCHEMA signal). Nothing is outdated
   * relative to another lineage — that comparison does not exist. Returns null
   * only when `profile` has nothing registered.
   */
  currentVersion(profile: Profile = CONTRACT_PROFILE): string | null {
    const versions = this.supportedVersions(profile);
    return versions.length === 0 ? null : versions[versions.length - 1]!;
  }

  /**
   * The current entry of the OTHER lineage — the shadow counterpart of
   * `profile` — or null when that lineage has nothing registered.
   *
   * Exists so the shadow run names no profile of its own: it asks the registry
   * what the non-contract lineage currently is, and the day CONTRACT_PROFILE
   * flips, the same call starts returning the 2025 entry with no further edit.
   */
  shadowFor(profile: Profile = CONTRACT_PROFILE): RegistryEntry | null {
    const other = PROFILES.find((p) => p !== profile);
    if (other === undefined) return null;
    const version = this.currentVersion(other);
    return version === null ? null : (this.byVersion.get(version) ?? null);
  }

  /**
   * EVERY registered schema as {@link SchemaProvenance} — both lineages, contract
   * profile first, oldest first within each. What the API serves so the dashboard
   * can state which bytes it grades against, and which it only shadows.
   *
   * Derived from the SAME entries `lookup()` validates with, so the reported
   * hash is by construction the hash of the bytes actually in force; there is no
   * second copy of the value to fall out of step. Reports the registered set
   * exactly as it is — it never asserts how many versions there ought to be,
   * which is why the dashboard survived the set growing from one entry to two
   * without a code change. Consumers that need only the contract cohort filter on
   * `profile`; they must not assume every entry here is one.
   */
  provenance(): readonly SchemaProvenance[] {
    return PROFILES.flatMap((profile) =>
      this.supportedVersions(profile).map((version) => {
        const entry = this.byVersion.get(version)!;
        return entry.draftDate === undefined
          ? { version, sha256: entry.sha256, profile }
          : { version, sha256: entry.sha256, profile, draftDate: entry.draftDate };
      }),
    );
  }

  /** Direct entry access for an already-canonical version key. */
  get(version: string): RegistryEntry | undefined {
    return this.byVersion.get(version);
  }

  /**
   * Normalize `raw` (semver, integer revision, or either lineage's `$id` form),
   * then exact-match across BOTH lineages — a supplier declaring an Annex 4
   * revision resolves here exactly as one declaring a `cce-interop` version does.
   * Unknown or unparseable versions return `{ ok: false, supported: [...] }`,
   * listing everything the registry accepts. No fuzzy fallback to a "close"
   * version, and no cross-lineage guessing.
   */
  lookup(raw: string): LookupResult {
    const requested = normalizeVersion(raw) ?? raw;
    const entry = this.byVersion.get(requested);
    if (entry) return { ok: true, entry };
    return {
      ok: false,
      reason: 'unsupported',
      requested,
      supported: this.acceptedVersions(),
    };
  }
}
