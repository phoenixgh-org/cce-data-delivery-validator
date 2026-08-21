# CCE Data Delivery Validator: Design

Status: living document. The v1 scope is locked, and §3 records the decisions that
are settled and are not reopened casually. Everything else describes the system as
built and is updated as it ships.

Last updated: August 20, 2026

## 1. Overview

WHO/PQS/E006/DS01.2, Clause 5 (Data Delivery to External Systems) obliges cold
chain equipment (CCE) data suppliers, i.e., the manufacturers and resellers of RTMDs
and EMS-compliant equipment, to deliver performance data over HTTPS to the countries
that own the equipment. The Interoperable CCE Data Delivery requirements document
(March 30, 2025) clarifies the low-level details of those transmissions. However,
PQS test labs prequalify the equipment and never test the data delivery
implementation, so suppliers grade themselves today.

This project is a public service that plays the employer (receiving) side of that
interface. It provides an HTTPS endpoint that suppliers can POST to, and a web
dashboard that gives them an independent reading of their conformance, to the extent
that conformance can be judged from the receiving end.

Three artifacts govern the design:

- `src/schemas/cce-interop-*.json` holds the transmission JSON Schemas, vendored and
  registered as described in §9. This is the only copy in the repository, so there is
  one place to verify against the published bytes; `docs/` deliberately holds no
  schemas.
- `docs/internal/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf`
  holds the prose requirements. It is local-only, because `docs/internal/` is
  gitignored.
- `docs/clause-mapping.md` records how those requirement numbers map to the DS01.3
  rewrite.

Where prose and schema disagree, the schema takes precedence. This follows §3.2 of
the 2025 requirements and is kept as a house rule now that DS01.3 drops the
precedence clause (see `CLAUDE.md`).

## 2. Goals and non-goals

Version 1 has three goals:

- Stand up a real HTTPS ingest endpoint that suppliers can POST to with no
  onboarding friction.
- Validate each transmission against the JSON Schema and against the requirements
  that can be verified passively.
- Present the results in a dashboard that clearly separates what the receiving side
  can prove from what it cannot.

Three things are deliberately out of scope: active conformance probing of the §4
error-handling requirements, guided retransmission scenarios for §5, and receiving
real production data. All three are deferred rather than rejected. §15 describes
them, and §3 locks the two that constrain the shape of v1.

## 3. Locked decisions

The following decisions are settled for v1.

| Topic | Decision |
|---|---|
| Scope | Passive validation only. |
| Data | Synthetic test data only; no real CCE data and no PII. |
| Onboarding | A capability URL, minted by the dashboard's "Create" action. There is no signup. |
| Identity | A single UUID serves as both the ingest path and the dashboard key. Possession is authority. |
| Authentication (§1.3) | An opt-in compliance layer, not a gate. The dashboard generates a credential for the supplier to configure, and the endpoint then enforces the chosen method, which makes §1.3 gradeable. The three methods are listed in §6, stage 2. |
| Retention | A session and its data are purged after 7 days without a POST. |
| Stack | Node and TypeScript end to end, with Ajv for schema validation. |
| Schema versioning | `schemaVersion` is treated as an opaque bare-semver registry key. Schemas are vendored and validated against pre-registered copies, never fetched at runtime, and each version is pinned by content hash so the service can prove which bytes it validated against. |

## 4. Architecture

The service is a single Node process (API plus static frontend) and a Postgres
container, wired together with `docker-compose`.

```
                 ┌──────────────────────────────────────────────┐
   Supplier      │                  Service                      │
   system        │                                               │
   ──POST data──▶│  /i/{uuid}   ── ingest pipeline ──▶ findings  │
                 │                                       │        │
                 │                                       ▼        │
   Supplier      │  /d/{uuid}   ◀── dashboard API ──  datastore   │
   browser ─────▶│  web UI (create endpoint, view report,        │
                 │           opt into §1.3 auth)                  │
                 └──────────────────────────────────────────────┘
```

It has six parts:

- The ingest API (`POST /i/{uuid}`) runs the pipeline described in §6, persists the
  transmission and its findings, and returns a status.
- The dashboard API mints sessions, reads transmissions, findings, and summaries,
  and manages the §1.3 authentication opt-in.
- The web frontend provides a landing page with a "Create test endpoint" button and
  a per-session dashboard.
- The compliance engine combines the schema validator with the per-requirement
  checks.
- The datastore is described in §8.
- The retention worker is described in §11.

### 4.1 Edge and TLS termination

TLS terminates at a Caddy reverse-proxy container. Any Docker host will do; a
DigitalOcean droplet is the intended target. Caddy's automatic Let's Encrypt
certificates satisfy the Country Guidance expectation (Attachment 2) that
certificates be valid and require no supplier-installed intermediates.

Because the application sees plain HTTP behind Caddy, the proxy owes the application
a contract. Without it, several receiving-side checks would be measuring the proxy
rather than the supplier:

- Scheme is advertised. Caddy sets `X-Forwarded-Proto`, and the application trusts
  that header only from Caddy's address (Fastify `trustProxy`). The application port
  is never exposed publicly. This is how the HTTPS aspect of §1.1 is known.
- The body passes through untouched. Caddy must not impose a `request_body max_size`
  below the 1 MB grading threshold; otherwise oversized POSTs receive Caddy's generic
  `413`, and the service never records the transmission or emits the teaching
  finding. The application owns the §1.4 cap.
- Encoding is preserved. The body reaches the application exactly as sent, with no
  request decompression and no re-chunking, so the §1.4 wire-byte measurement and the
  §1.6 `Content-Encoding` and double-encoding checks see the supplier's bytes. Caddy
  does not decompress request bodies by default, but the configuration should be
  verified and locked.

The contract is encoded and commented in `deploy/Caddyfile`, which is an optional
`edge` compose profile. The operator's half of the contract (`TRUSTED_PROXY`, the
environment surface, and the failure mode of each violation) is documented in
`docs/deployment.md`. `deploy/smoke-proxy-contract.sh` verifies a running deployment
by POSTing an oversized body and a gzipped body and confirming that the application,
not the proxy, answered.

## 5. Onboarding flow

Onboarding is entirely web-driven and requires no account:

1. The supplier visits the site and clicks "Create test endpoint".
2. The frontend calls `POST /api/sessions`. The backend mints a v4 UUID, creates a
   session row, and returns `{ uuid, ingestUrl: "/i/{uuid}", dashboardUrl: "/d/{uuid}" }`.
3. The supplier is taken to `/d/{uuid}`, which shows the ingest URL, copy-paste
   examples (`curl` and headers), and an empty results view that fills in as data
   arrives.
4. The dashboard URL is the only thing the supplier needs to bookmark. No email or
   password is involved.

Anyone holding the UUID can both POST data and view the results. The security
implications of that trade are discussed in §12.

## 6. Ingest pipeline and response codes

Each `POST /i/{uuid}` runs through an ordered set of stages. A stage either produces
a finding and continues, or short-circuits with a response code. The response codes
follow the Country Guidance in Attachment 2 of the 2025 requirements, which has no
DS01.3 successor; `docs/clause-mapping.md` records what that document remains the
source for.

| Stage | Check | On failure |
|---|---|---|
| Framework | Request body is at most 2 MiB (Fastify `bodyLimit`; see §12) | `413` before any stage runs. No row is written, and the body is a framework error rather than the ingest response shape. |
| 0. Session | The UUID exists and has not expired | `404` |
| 1. Method and TLS | POST over HTTPS (§1.1) | TLS is enforced at the edge. A non-POST request receives `405`. |
| 2. Authentication (opt-in) | If enabled, the configured credential is present and correct (§1.3). The credential is a token in a configurable header, HTTP Basic, or `Authorization: Bearer` (RFC 6750; the third method, added by DS01.3 clause 5.1.5). | `401` |
| 3. Size | Wire body is at most 1 MB after content encoding (§1.4) | `413` plus a finding |
| 4. Content-Type | `application/json; charset=utf-8` (§1.2) | A finding; processing continues. `415` is optional under the guidance and is never returned. |
| 5. Content-Encoding | If `gzip`, decompress; detect illegal double encoding such as base64 (§1.6) | A finding; `400` if the body cannot be decoded |
| 6. JSON parse | The body is valid UTF-8 JSON (§1.1) | `400` |
| 7. Schema validation | Ajv validation against the schema named by `meta.schemaVersion` (§3.2) | `422` plus one finding per error |
| 8. Semantic checks | Duplicate `transferId` (§1.8), interval regularity (§3.4), concurrency (§2.1), an inventory of present objects (§3.3, informational), and custom data object declaration (§3.1) | Findings only; `200`, and the data is accepted |

Stage 8 never halts the request. Every §1.8, §2.1, and §3.x concern is a teaching
finding rather than a rejection.

The stage numbers are stable labels used in code comments and in `docs/api.md`; they
are not the run order. [`src/ingest/route.ts`](src/ingest/route.ts) runs the method check before the session
check and explains why.

### 6.1 Division of labour between §3.1 and §3.2

Ajv at stage 7 grades §3.2 only. The structural half of §3.1 (the metadata block and
the DS01 object shapes) is implied by a passing Ajv run, and grading it a second time
would count the same evidence twice.

§3.1 therefore owns the half that a schema cannot express: the conditional duty to
declare `meta.customDataSchema` when the payload carries manufacturer-specific data
objects. It runs at stage 8 and independently of the schema, because
`meta.customDataSchema` does not exist in 0.8.1, and that schema's
`additionalProperties: true` lets custom objects pass Ajv unexamined (see §9). The
detection rule and its deliberate limits are in
[`custom-schema.ts`](src/ingest/stages/semantic/custom-schema.ts).

### 6.2 The response body

`200` is the single success status; `202` is not used. The small JSON body returned
with it is a deliberate teaching surface: a supplier should be able to understand the
outcome from the HTTP response alone, without opening the dashboard. It carries:

- `transmissionId` and `status`;
- a one-line `message` with the fail and info tally;
- `findingDetails`, echoing each finding;
- an `advisories` array (§7.1), kept out of the tally so that a conformant payload is
  never handed a number to explain;
- a standing `notice` that this is a synthetic-data-only sandbox (§2, §12).

Rejections return the same shape, so a 4xx response is as self-explanatory as a 2xx.

Note that §1.4 is measured after encoding, so the size stage reads the raw request
body length rather than the decompressed size.

## 7. Compliance engine and verifiability matrix

The product classifies every requirement, not only the ones it can grade. Each
requirement falls into one of five classes:

- Verified: passively verified from the supplier's traffic.
- Heuristic: partially verified; the evidence is suggestive but not conclusive.
- Active-only: requires an active test harness and is deferred.
- Self-attestation: not provable from the receiving side.
- Enforced: guaranteed by the endpoint itself, so it is not a test of the
  supplier's behaviour.

| Req | Summary | Class | How |
|---|---|---|---|
| 1.1 | HTTPS POST, UTF-8 JSON | Enforced / Verified | HTTPS is enforced at the edge, so non-HTTPS traffic never reaches the service; it always "passes" and is not a test of the supplier's choice. The POST method and the UTF-8 JSON parse are verified from supplier traffic. |
| 1.2 | `Content-Type: application/json; charset=utf-8` | Verified | Header inspection |
| 1.3 | Authentication via token header, Basic, or Bearer | Verified (opt-in) | Enforced once the supplier enables the authentication layer; the configured method is the one graded |
| 1.4 | Body at most 1 MB after encoding | Verified | Wire bytes are measured |
| 1.5 | Expect standard 2xx, 4xx, and 5xx codes | Self-attestation | The service returns correct codes; the supplier's expectation is not observable |
| 1.6 | Gzip via `Content-Encoding`, no double base64 encoding | Verified | Decode and detect double encoding |
| 1.7 | Custom headers permitted | None | Permissive; there is nothing to grade |
| 1.8 | No duplicates except under allowed conditions | Heuristic | Repeated `transferId` values are observed; the justification cannot be judged |
| 2.1 | Serial delivery by default | Heuristic | Concurrent in-flight requests per session are observed |
| 2.2 | Deliver within minutes of receipt | Self-attestation | The remote system's receipt time is unknown to the service |
| 2.3 | Alarm within 15 minutes, including data since the last transmission | Self-attestation | The alarm origin time is unknown to the service |
| 3.1 | Declare custom data objects via `meta.customDataSchema` | Verified | A stage 8 semantic check, not the schema (see §6.1). Fails when manufacturer-specific objects arrive undeclared; passes when they are declared or absent. The declaration is recorded, never dereferenced (§9). |
| 3.2 | Validates against the schema | Verified | Ajv; this is the core check |
| 3.3 | Transmit all collected objects | Self-attestation | The service cannot know what the supplier collects; it can inventory what is present |
| 3.4 | Preserve logger time resolution | Heuristic | `ABST` interval regularity |
| 4.1 | Retry on non-2xx | Active-only | Requires deliberate error injection |
| 4.2 | At least 6 retries over 24 hours, non-blocking | Active-only | Active harness |
| 4.3 | Abandon on permanent failure (501, 505, most 4xx) | Active-only | Active harness |
| 4.4 | Backoff strategy, described to the employer | Active-only / Self-attestation | Active harness for the shape; the description is attestation |
| 4.5 | Honour `Retry-After` on 429 (the longer interval) | Active-only | Active harness |
| 4.6 | Log failed attempts | Self-attestation | Supplier-internal |
| 4.7 | Provide an email address and an SLA | Self-attestation | Supplier-internal |
| 4.8 | Monitor transmission status | Self-attestation | Supplier-internal |
| 4.9 | Notify staff and employer on elevated failures | Self-attestation | Supplier-internal |
| 5.1 | Retransmit the last 6 months on request | Active-only | Guided scenario |
| 5.2 | Filter retransmission by time range | Active-only | Guided scenario |
| 5.3 | Filter all data versus never-sent data | Active-only | Guided scenario |

The dashboard renders this matrix for each session. Verified and heuristic rows carry
live pass and fail counts from the supplier's actual traffic. Active-only rows read
"not yet exercised; available in a future test mode". Self-attestation rows read
"self-attestation; outside what a receiver can prove".

Two presentation rules protect the honesty of the grade. A gradeable row with zero
findings shows "untested", never a false pass. A row whose only evidence came from a
registered but older schema version shows "pass-outdated": those findings are `info`
with the `outdated` flag and no pass finding, so counting pass and fail alone would
wrongly claim the check never ran (tracked as `cce-data-delivery-validator-2kx`).

This table is the source for `COMPLIANCE_MATRIX` in [`src/api/compliance-matrix.ts`](src/api/compliance-matrix.ts),
which encodes the same 27 rows verbatim. Change them together.

### 7.1 Advisories

An advisory names a payload that is fully schema-compliant and fully
requirement-compliant, yet plainly unhelpful to the country receiving it. A report
whose `ASER` and `AMID` are both `null` is an example.

An advisory never changes a requirement's pass or fail status. The product's
proposition is an independent reading of conformance, and the moment house opinion
moves a verdict, the grade stops being trustworthy. A supplier must be able to sit at
100% conformant and still carry advisories. For that reason advisories are a separate
category rather than additional findings on existing requirements.

Several properties follow from that decision:

- Advisories cost no DDL. `severity` is always `info`, and the identifier lives in its
  own `adv.*` namespace, carried in both `finding.requirement` and `finding.code`.
- Advisories use named codes rather than numbers, because an advisory catalogue has
  no external document to number against.
- The §7 matrix is immune by construction: the join iterates the 27 static rows and
  never looks up an unknown identifier, and both the ingest response and the
  dashboard keep advisories out of every count that grades a supplier.
- Advisory wording observes and never concludes. A `null` cannot prove "no sensor
  fitted", because a broken sensor looks identical.

`ADVISORY_CHECKS` in [`advisory.ts`](src/ingest/stages/semantic/advisory.ts) is the registration
point and the count of record. Each check's scope (what it reads, what it
deliberately excludes, and why) is documented in its own module header. The
dashboard surface (section behaviour, palette, and cross-filtering) is specified in
[`ComplianceCard.tsx`](src/web/components/ComplianceCard.tsx).

| Advisory | Observes | Module |
|---|---|---|
| `adv.null_identity` | The branch's one appliance identifier is blank: `ASER` on `ems-report`, `AMID` on `rtmd-report` | [`null-identity.ts`](src/ingest/stages/semantic/null-identity.ts) |
| `adv.null_padding` | A record property is `null` in every record that carried it, over at least 12 records | [`null-padding.ts`](src/ingest/stages/semantic/null-padding.ts) |
| `adv.date_format` | A production date sent in some form other than the ISO 8601 calendar date `YYYY-MM-DD` | [`date-format.ts`](src/ingest/stages/semantic/date-format.ts) |
| `adv.time_not_increasing` | `records[].ABST`, walked in array order, steps backward or repeats | [`time-order.ts`](src/ingest/stages/semantic/time-order.ts) |
| `adv.compressor_exceeds_supply` | A mains EMS record whose `CMPR` exceeds the same record's `SVA` | [`compressor-supply.ts`](src/ingest/stages/semantic/compressor-supply.ts) |
| `adv.cmpr_minutes` | EMS compressor runtimes that never exceed 15, suggesting a minutes-valued feed in a seconds-valued envelope | [`cmpr-minutes.ts`](src/ingest/stages/semantic/cmpr-minutes.ts) |
| `adv.sample_gap` | Two consecutive readings more than 900 s apart, allowing 60 s of quantization tolerance | [`sample-gap.ts`](src/ingest/stages/semantic/sample-gap.ts) |
| `adv.duplicate_records` | The same record delivered twice inside one transmission | [`duplicate-records.ts`](src/ingest/stages/semantic/duplicate-records.ts) |

All modules are under `src/ingest/stages/semantic/`.

## 8. Data model

Storage is PostgreSQL, accessed through `node-postgres` (`pg`) behind a thin
repository layer. The choice converges with an experimental cold chain master-data
system, which ingests the same PQS E006 DS01 data and is itself built on opinionated
Postgres. It also provides native `jsonb` for payloads and findings, and a path to a
future production-endpoint mode without a migration.

The `transmission` table mirrors that system's `source_artifact` table (content hash,
byte size, content type, channel, and received-at), with one deliberate difference.
The master-data system makes `content_hash` unique in order to deduplicate and drop
idempotent replays. This service records every POST and flags repeats instead,
because duplicate detection is the §1.8 signal being graded and must never be
collapsed silently.

The three tables are:

- `session`: `uuid` (primary key), `created_at`, `last_post_at`, `auth_enabled bool`,
  `auth_method` (`header`, `basic`, or `bearer`), `auth_header_name`, and
  `auth_secret_hash`.
- `transmission`: `id uuid` (primary key), `session_uuid` (foreign key to `session`),
  `received_at timestamptz`, `content_hash bytea` (SHA-256 of the raw wire body; not
  unique, because it detects exact replays), `wire_bytes bigint`, `content_type`,
  `content_encoding`, `http_status int`, `transfer_id`, `transfer_src`,
  `transfer_type`, `schema_version`, `body jsonb` (the parsed payload, or null if it
  could not be parsed), `raw_body text` (the original bytes, kept for drill-down and
  especially useful when parsing fails; its ceilings are discussed in §12),
  `parse_ok bool`, and `schema_ok bool`.
- `finding`: `id`, `transmission_id` (foreign key to `transmission`), `requirement`
  (e.g., `1.4`), `severity` (`pass`, `fail`, or `info`), `detail`, `pointer` (a JSON
  Pointer into the payload, where relevant), and `outdated bool`. The `outdated` flag
  is set only on the §3.2 informational finding raised when a transmission validates
  against a valid but older registered version; the body is accepted and the
  dashboard shows an amber "Outdated schema" tag. The table also carries structured
  signature fields that let identical defects collapse into one issue without keying
  on an English message that drifts between Ajv versions: `keyword`,
  `instance_path`, and `param` for schema (§3.2) errors, and `code` (e.g.,
  `tx.missing_charset`) for transport and heuristic findings. All are nullable and
  populated only where they apply.

Three indexes support the access patterns: `transmission (session_uuid, received_at
DESC)` for the dashboard's reverse-chronological list and per-session rollups, and
`(session_uuid, content_hash)` and `(session_uuid, transfer_id)` for duplicate
detection (§1.8). Concurrency observation (§2.1) is in-flight request tracking per
session and is not stored.

The schema is applied as ordered SQL on first boot from `db/initdb/`. A migration
runner is deferred until the schema needs to evolve in production.

## 9. Schema registry and versioning

The service hosts a registry of vendored schema versions. The registry is a policy
about which versions the service accepts, so multi-version support is a feature
rather than a complication.

### 9.1 Registered versions

Two versions are registered: 0.8.1 (current) and 0.8.0 (registered, outdated but
valid). Version 0.8.0 left the policy when 0.8.1 was published and was restored on
August 4, 2026, for two reasons. First, a single registered version leaves the
outdated-but-valid grade (§7) unreachable by construction: with nothing older than
current, no transmission can earn the "Outdated schema" signal, so neither the grade
nor the dashboard tag can be exercised end to end. Second, 0.8.0 is the version a
supplier is most likely to still be sending.

Registration is per dialect. Version 0.8.0 declares draft-07 and 0.8.1 declares
2020-12, so each entry names its dialect and compiles under the matching Ajv build in
its own instance. Versions 0.7.x and earlier are excluded entirely.

As measured on August 20, 2026, docs.2to8.cc publishes 0.8.0, 0.8.1, 0.8.2, and
0.8.4 (0.8.3 is not published, and nothing above 0.8.4 exists). The versions after
0.8.1 remain unregistered, so 0.8.1 remains current. A payload that declares an
unregistered version receives `422` with the list of supported versions; there is
never a silent fallback.

### 9.2 Schemas are never fetched at runtime

`meta.schemaVersion` is a lookup key, not a locator, and validation runs only against
pre-registered copies. Fetching at runtime would couple the ingest path to an
external host's uptime, create an SSRF risk (a URL pulled from request data), and
undermine the claim that the service validated against the official version.

The specification agrees: `$id` identifies and never locates. Published schemas
declare `$id: https://schemas.2to8.cc/schemas/cce-interop-<version>.json`, a host that
does not resolve, while the artifact is served from a different host and path.
`normalizeVersion()` already accepts URN-shaped values that carry a semver triple, so
the expected upstream move of `$id` to a URN will require no code change here.

### 9.3 Normalized matching

The standard is ambiguous about the form of the `schemaVersion` field: its
description points at `$id`, which is a URL, while its only example is a bare semver.
Until that is clarified (§15), the service normalizes on ingest. It accepts either
shape, extracts `MAJOR.MINOR.PATCH`, and looks that up. An exact match is required,
because a silent fallback to a "close" version would defeat the purpose of
conformance testing. An unknown version receives `422` with a finding that lists the
supported versions.

### 9.4 Content-hash provenance

Each registered version is pinned by the SHA-256 of its canonical bytes, so the
dashboard can report, for example, "validated against official 0.8.1 (sha256 …)".
The vendored file is therefore kept byte-identical to the published artifact.
Cosmetic issues in the schema, such as the stale `0.1.1` example and the
`schemaVersion`-versus-`$id` phrasing, are never patched locally. They are tracked as
standard-revision proposals (§15) so that the hash continues to match what WHO
published. Verified July 31, 2026: vendored 0.8.1 is `290290fd…`.

### 9.5 Adding a version

Adding a version is a policy act rather than maintenance. A new version arrives as a
new vendored file plus a registry entry; an existing schema file is never edited in
place.

Upstream 0.8.2 is the first version to define `meta.customDataSchema`. Its own
`$comment` there states that the conditional is deliberately not enforced by the
schema, and that employers who want it enforced should do so in their own validation
layer. This service is that layer (§7, row 3.1), which is why the §3.1 check is
schema-independent and works for suppliers still declaring 0.8.1. Whether to accept
0.8.2 declarations remains open (tracked as `cce-data-delivery-validator-fvw`).

Ajv compiles each registered schema once at startup, in its own instance per version,
and reuses the compiled validator. Registration is a boot-time gate: bytes that
cannot be read or compiled fail the process loudly rather than degrading silently.

## 10. Dashboard

Each session's dashboard at `/d/{uuid}` has four sections:

- Setup shows the ingest URL, copy-paste `curl` and header examples, the
  synthetic-data-only notice, and the §1.3 authentication opt-in. The supplier
  toggles it on, picks one of the three methods, and the service generates the
  credential and shows a configuration snippet.
- Compliance summary renders the §7 matrix as §7 describes. Each row drills down to
  the verbatim text of the 2025 requirement, with the service's own reading of it in
  a separate guidance field, so a supplier can always tell the two apart.
- Transmissions is a reverse-chronological, paginated list. Each transmission drills
  into the returned status, the compression and wire-byte picture, a raw payload
  inspector, and the findings, with JSON Pointers to schema errors. The list pane is
  height-capped so the detail pane stays on screen.
- Lifecycle shows the 7-day inactivity expiry clock.

## 11. Retention and lifecycle

A periodic worker deletes sessions, and cascades to their transmissions and
findings, when `last_post_at` (or `created_at`, if there have been no posts) is
older than 7 days. The expiry is shown in the dashboard so it is never a surprise.

## 12. Security considerations

Capability URLs carry a known caveat. The UUID is a bearer secret in the path, and
URLs leak through logs, proxies, and browser history. This is acceptable for
synthetic test data, which is the only data in v1. If real data is ever in scope,
the design should be revisited: split the ingest token from the view token, and move
the secret into a header.

Transport is HTTPS only, with valid certificates that require no supplier-installed
intermediates, terminated at the Caddy edge under the proxy contract in §4.1.

Authentication secrets are stored hashed and are never echoed after first display.

Resource limits are set in two places. Fastify's `bodyLimit` bounds buffered request
memory at 2 MiB. This is deliberately above the 1 MB grading cap in §1.4, so that
oversized but bounded bodies still reach the size stage and receive a teaching `413`
with a persisted row, instead of Fastify's opaque one. Gzip decompression is bounded
at 1 MiB of output as a zip-bomb guard. The `raw_body` copy (§8) has no write-side
cap of its own, a decision recorded on August 2, 2026
(`cce-data-delivery-validator-1z9`); those two transport ceilings are its only bounds,
and they bound it only loosely.

## 13. Tech stack

- Runtime and language: Node and TypeScript.
- HTTP: Fastify, chosen for speed, schema-friendliness, and first-class control over
  `Content-Type` and the raw body. Locked.
- Validation: Ajv, running the published schema directly on the build that matches
  each schema's declared dialect: 2020-12 (`ajv/dist/2020`) for 0.8.1, and draft-07
  (Ajv's default export) for the outdated 0.8.0. Neither build accepts the other's
  `$schema`, so the choice is made per registry entry.
- Storage: PostgreSQL via `node-postgres` (`pg`) behind a thin repository layer,
  adopting the master-data system's content-addressed `source_artifact` and
  `jsonb`-body patterns (§8).
- Frontend: a React and Vite SPA (`react-router-dom`), built to `dist/web` and served
  by the same Node process through `@fastify/static`, with an SPA fallback for
  non-API paths. Locked on May 30, 2026; the server-rendered alternative was dropped.
- Edge: a Caddy reverse proxy terminating TLS. The contract it owes the application
  is described in §4.1.
- Local development: `docker-compose` (application plus Postgres) with
  healthcheck-gated bring-up.

## 14. Build history

All eight v1 milestones have shipped: skeleton, ingest core, dashboard read, web UI,
semantic checks, §1.3 authentication opt-in, retention worker, and polish. The commit
log is the record. Everything above describes the built system, not a plan.

## 15. Future and deferred work

The following items are deferred from v1:

- An active conformance harness for the §4 requirements: a test-campaign mode that
  returns controlled error responses and measures retry count, backoff shape,
  `Retry-After` adherence, and abandonment on permanent failure.
- Guided retransmission scenarios for the §5 requirements.
- A production-endpoint mode for real data, which would need to address retention,
  PII, data sovereignty, and split-token authentication.
- Standard-revision proposals for the next WHO-stewarded revision: make
  `schemaVersion` an opaque bare-semver token decoupled from hosting; state that
  receivers shall not dereference the schema at validation time and should
  pre-register it; mechanically link `$id` and `schemaVersion`; publish an
  out-of-band manifest with a content hash per version; and correct the stale `0.1.1`
  example.
