# CCE Data Delivery Validator — Design

**Status:** Living document — **v1 scope is locked**; §3 records the decisions
that are settled and are not reopened casually. Everything else tracks the built
system and is updated as it ships.
**Last updated:** 2026-08-20

## 1. Overview

This project is a public service that plays the **employer/country (receiving)
side** of the CCE data-delivery interface, plus a web dashboard where suppliers
get an independent read on their conformance — "to the extent possible" from the
receiving vantage point. It exists because PQS test labs prequalify the
*equipment* but never test the *data delivery* implementation, so suppliers
self-grade today.

The obligation is **WHO/PQS/E006/DS01.2, Clause 5 (Data Delivery to External
Systems)**: cold chain equipment (CCE) data suppliers — manufacturers and
resellers of RTMDs and EMS-compliant equipment — must deliver performance data to
the countries that own the equipment, over HTTPS. The "Interoperable CCE Data
Delivery" requirements document (2025-03-30) clarifies the low-level details.

The governing artifacts are `src/schemas/cce-interop-*.json` (the transmission
JSON Schemas, vendored and registered per §9 — the **only** copy in the repo, so
there is one place to verify against the published bytes), the 2025 prose
requirements PDF under the gitignored `docs/internal/`, and `docs/clause-mapping.md`,
which maps those requirement numbers onto the DS01.3 rewrite.

When prose and schema disagree, **the schema wins** — from 2025 requirement §3.2,
kept as a house rule now that DS01.3 drops the precedence clause (`CLAUDE.md`).

## 2. Goals and non-goals (v1)

**Goals**
- Stand up a real HTTPS ingest endpoint suppliers can POST to with **zero onboarding friction**.
- Validate each transmission against the JSON Schema and the *passively verifiable* requirements.
- Present results in a dashboard, **clearly delineating what we can and cannot prove**.

**Non-goals** — active conformance probing of §4, guided retransmission scenarios for §5, and
receiving real production data. All three are deferred, not rejected; §15 describes them and §3
locks the two that constrain v1's shape.

## 3. Locked decisions

| # | Decision |
|---|----------|
| Scope | **Passive validation only** in v1. |
| Data | **Test/sandbox** synthetic data; no real CCE/PII. |
| Onboarding | **Capability URL**, minted via the **web dashboard** "Create" action (no signup). |
| Identity | **Single UUID** is both ingest path and dashboard key. Possession = authority. |
| Auth (§1.3) | **Opt-in compliance layer, not a gate.** The dashboard generates the credential for the supplier to copy in and the endpoint then enforces the chosen method, so §1.3 becomes gradeable. The three methods are in §6 stage 2. |
| Retention | Purge a path + its data after **7 days** of POST inactivity. |
| Stack | **Node + TypeScript** end-to-end, **Ajv** for schema validation. |
| Schema versioning | **Bare-semver `schemaVersion`** as an opaque registry key; schemas are **vendored** and validated against **pre-registered copies** (never fetched at runtime); each version is pinned by **content hash** to prove the "blessed bytes." |

## 4. Architecture

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

One Node service (API + static frontend) plus a Postgres container, wired together with
`docker-compose`. The **ingest API** runs the pipeline of §6 and persists the transmission with
its findings; the **dashboard API** mints sessions, reads transmissions/findings/summary and
manages the §1.3 auth opt-in; behind them sit the **compliance engine** (schema validator plus the
per-requirement checks), the **datastore** (§8) and the **retention worker** (§11).

### 4.1 Edge / TLS termination (proxy contract)

TLS terminates at a Caddy reverse-proxy container (any Docker host; a Digital Ocean droplet is
the intended target), whose automatic Let's Encrypt certs satisfy Attachment 2's "valid certs, no
supplier-installed intermediates" for free. The app sees plain HTTP behind it, so the proxy owes
it a **contract** that keeps the receiving-side checks accurate:

- **Scheme advertised.** Caddy sets `X-Forwarded-Proto`; the app trusts it scoped to Caddy's
  address only (Fastify `trustProxy`), and the app port is never publicly exposed. This is how
  §1.1's HTTPS aspect is known.
- **Body passed through untouched.** Caddy must not impose a `request_body max_size` below our
  1MB grading threshold — otherwise oversized POSTs get Caddy's generic `413` and we never record
  the transmission or emit the teaching finding. The app owns the §1.4 cap.
- **Encoding preserved.** The body reaches the app as sent (no request decompression, no
  re-chunking), so §1.4 wire-byte measurement and §1.6 `Content-Encoding` / double-encoding
  detection see exactly the supplier's bytes. (Caddy does not decompress request bodies by
  default — verify and lock the config.)

The contract is encoded and commented in `deploy/Caddyfile` (an optional `edge` compose profile),
its operator half is in `docs/deployment.md`, and `deploy/smoke-proxy-contract.sh` verifies a
running deployment by POSTing an oversized and a gzipped body and asserting the *app*, not the
proxy, answered.

## 5. Onboarding flow (web-driven)

1. Supplier visits the site, clicks **Create test endpoint**.
2. Frontend calls `POST /api/sessions`; backend mints a v4 UUID, creates a session row, returns
   `{ uuid, ingestUrl: "/i/{uuid}", dashboardUrl: "/d/{uuid}" }`.
3. Supplier is taken to `/d/{uuid}`, which shows the ingest URL, copy-paste examples
   (`curl`, headers), and an empty results view that fills in as data arrives.
4. The dashboard URL is the only thing they need to bookmark — no account, email, or password.
   Anyone holding the UUID can both POST and view it; that trade is §12's.

## 6. Ingest pipeline and response codes

Each `POST /i/{uuid}` runs ordered stages; a stage either **produces a finding and continues** or
**short-circuits** with a response code. The codes follow the Country Guidance (Attachment 2), the
2025 UNICEF-consultation document with no DS01.3 successor — `docs/clause-mapping.md` records what
it remains the source of.

| Stage | Check | On failure |
|-------|-------|-----------|
| — Framework | Request body ≤ 2 MiB (Fastify `bodyLimit`; §12) | `413` **before any stage runs** — no row, and a framework error body rather than the ingest response shape |
| 0. Session | UUID exists & not expired | `404` |
| 1. Method/TLS | POST over HTTPS (§1.1) | TLS enforced at the edge; non-POST → `405` |
| 2. Auth (opt-in) | If enabled, the configured credential — token + configurable header name, HTTP Basic, or `Authorization: Bearer` (RFC 6750, the third method DS01.3 clause 5.1.5 adds) — is present & correct (§1.3) | `401` |
| 3. Size | Wire body ≤ 1MB **after** content-encoding (§1.4) | `413` + finding |
| 4. Content-Type | `application/json; charset=utf-8` (§1.2) | finding; continue — `415` is optional and **we never return it** |
| 5. Content-Encoding | If `gzip`, decompress; detect illegal double-encoding e.g. base64 (§1.6) | finding; `400` if undecodable |
| 6. JSON parse | Body is valid UTF-8 JSON (§1.1) | `400` |
| 7. Schema validate | Ajv against `meta.schemaVersion` (§3.2) | `422` + per-error findings |
| 8. Semantic checks | Duplicate `transferId` (§1.8), interval regularity (§3.4), concurrency (§2.1), present-object inventory (§3.3 info), custom-data-object declaration (§3.1) | findings; `200` (data accepted) |

Stage 8 never halts: every §1.8/§2.1/§3.x concern is a *teaching* finding, not a rejection.

The stage **numbers are stable labels** used across code comments and `docs/api.md`, not the run
order: [`src/ingest/route.ts`](src/ingest/route.ts) runs method before session and says why.

**§3.1 vs §3.2 — the division of labour.** Ajv at stage 7 grades §3.2 only; §3.1's structural half
(the metadata block, the DS01 object shapes) is implied by a passing Ajv run, and grading it twice
would double-count the same evidence. §3.1 therefore owns the half a schema cannot express — the
**conditional** duty to declare `meta.customDataSchema` when the payload carries
manufacturer-specific data objects — and runs schema-independently at stage 8. The detection rule
and its deliberate limits are in
[`custom-schema.ts`](src/ingest/stages/semantic/custom-schema.ts).

Success is `200`, the single success status; `202` is not used. Its small JSON body is a
deliberate **teaching surface** — a supplier should understand the outcome from the HTTP response
alone, without opening the dashboard — carrying `transmissionId`, `status`, a one-line `message`
with the fail/info tally, the per-finding `findingDetails` echo, an `advisories` array (§7.1, kept
out of the tally so a conformant payload is never handed a number to explain), and a standing
`notice` that this is a synthetic-data-only sandbox (§2, §12). Rejections return the same shape,
so a 4xx is as self-explanatory as a 2xx. §1.4 is measured *after* encoding, so the size stage
reads the raw request body length rather than the decompressed size.

## 7. Compliance engine — verifiability matrix

The product classifies **every** requirement, not just the ones it can grade.

**Legend:** ✅ Passively verified · 🟡 Heuristic / partial · 🔌 Active-only (deferred) · 📝 Self-attestation (not provable from receiving side) · 🔒 Enforced by us (guaranteed by the endpoint, not a test of the supplier's choice)

| Req | Summary | Class | How |
|-----|---------|-------|-----|
| 1.1 | HTTPS POST, UTF-8 JSON | ✅ / 🔒 | **HTTPS is 🔒 enforced at the edge** — non-HTTPS never reaches us, so it always "passes" and is *not* a test of the supplier's choice; **POST method + UTF-8 JSON parse** are ✅ verified from supplier traffic |
| 1.2 | `Content-Type: application/json; charset=utf-8` | ✅ | Header inspection |
| 1.3 | Auth via token header, Basic, or Bearer | ✅ (opt-in) | Enforced once supplier enables the auth layer; the configured method is the one graded |
| 1.4 | Body ≤ 1MB post-encoding | ✅ | Measure wire bytes |
| 1.5 | Expect standard 2xx/4xx/5xx | 📝 | We *return* correct codes; supplier-side expectation isn't observable |
| 1.6 | Gzip via `Content-Encoding`, no double base64 | ✅ | Decode + detect double-encoding |
| 1.7 | Custom headers permitted | — | Permissive; nothing to grade |
| 1.8 | No duplicates except allowed conditions | 🟡 | Observe repeated `transferId`; can't judge justification |
| 2.1 | Serial delivery by default | 🟡 | Observe concurrent in-flight requests per session |
| 2.2 | Deliver within minutes of receipt | 📝 | Remote-system receipt time is unknown to us |
| 2.3 | Alarm within 15 min + include data since last tx | 📝 | Alarm origin time unknown to us |
| 3.1 | Declare custom data objects via `meta.customDataSchema` | ✅ | Stage-8 semantic check, **not** the schema — see §6. Fails when manufacturer-specific objects arrive undeclared; passes when they are declared or absent. The declaration is recorded, never dereferenced (§9) |
| 3.2 | Validates against the schema | ✅ | Ajv (the core check) |
| 3.3 | Transmit all collected objects | 📝 | We don't know what they collect; we can *inventory* what's present |
| 3.4 | Preserve logger time resolution | 🟡 | `ABST` interval regularity heuristic |
| 4.1 | Retry on non-2xx | 🔌 | Needs deliberate error injection |
| 4.2 | ≥6 retries / 24h, non-blocking | 🔌 | Active harness |
| 4.3 | Abandon on permanent failures (501/505/most 4xx) | 🔌 | Active harness |
| 4.4 | Backoff strategy (+ describe to employer) | 🔌 / 📝 | Active harness for shape; "describe" is attestation |
| 4.5 | 429 `Retry-After` honored (longer of the two) | 🔌 | Active harness |
| 4.6 | Log failed attempts | 📝 | Supplier-internal |
| 4.7 | Provide email + SLA | 📝 | Supplier-internal |
| 4.8 | Monitor transmission status | 📝 | Supplier-internal |
| 4.9 | Notify staff/employer on elevated failures | 📝 | Supplier-internal |
| 5.1 | Retransmit last 6 months on request | 🔌 | Guided scenario |
| 5.2 | Filter retransmit by time range | 🔌 | Guided scenario |
| 5.3 | Filter all vs never-sent | 🔌 | Guided scenario |

The dashboard renders this matrix per session: ✅/🟡 carry live pass/fail counts from the
supplier's traffic, 🔌 read "not yet exercised", 📝 read "self-attestation — outside what a
receiver can prove". A gradeable row with zero findings shows **untested**, never a false pass; one
whose only evidence came from a registered-but-*older* schema version shows **pass-outdated**,
because those findings are `info` + `outdated` with no pass finding and counting pass/fail alone
would claim we never checked (tracked: `cce-data-delivery-validator-2kx`).

This table is the source for `COMPLIANCE_MATRIX` in
[`src/api/compliance-matrix.ts`](src/api/compliance-matrix.ts), which encodes the same 27 rows
verbatim — change them together.

### 7.1 Advisories

**Advisories** are how the validator names a payload that is fully schema-compliant *and* fully
requirement-compliant yet obviously unhelpful to the country receiving it — a report whose `ASER`
and `AMID` are both `null`, say.

An advisory never changes a requirement's pass/fail status. The product's proposition is an
independent read on conformance, so the moment house opinion moves a verdict the grade stops being
trustworthy; a supplier must be able to sit at 100 % conformant and still carry advisories. Hence
a separate category rather than extra findings on existing requirements — one that costs no DDL,
since `severity` is always `info` and the id lives in its own `adv.*` namespace (named codes, not
numbers: an advisory catalogue has no external document to number against), carried in both
`finding.requirement` and `finding.code`. The §7 matrix is immune by construction, because the
join iterates the 27 static rows and never looks up an unknown id, and both the ingest response
and the dashboard keep advisories out of every count that grades a supplier. Wording must observe,
never conclude: a null cannot prove "no sensor fitted", because a broken sensor looks identical.

`ADVISORY_CHECKS` in [`advisory.ts`](src/ingest/stages/semantic/advisory.ts) is the registration
point and the count of record; each check's scope argument — what it reads, what it deliberately
excludes, and why — lives in its own module header, and the dashboard surface (section behaviour,
palette, cross-filter) is specified in
[`ComplianceCard.tsx`](src/web/components/ComplianceCard.tsx).

| Advisory | Observes | Module |
|---|---|---|
| `adv.null_identity` | the branch's one appliance identifier is blank — `ASER` on `ems-report`, `AMID` on `rtmd-report` | [`null-identity.ts`](src/ingest/stages/semantic/null-identity.ts) |
| `adv.null_padding` | a record property `null` in every record that carried it, over at least 12 records | [`null-padding.ts`](src/ingest/stages/semantic/null-padding.ts) |
| `adv.date_format` | a production date sent in some form other than the ISO-8601 calendar date `YYYY-MM-DD` | [`date-format.ts`](src/ingest/stages/semantic/date-format.ts) |
| `adv.time_not_increasing` | `records[].ABST` walked in array order steps back or repeats | [`time-order.ts`](src/ingest/stages/semantic/time-order.ts) |
| `adv.compressor_exceeds_supply` | a mains EMS record whose `CMPR` exceeds the same record's `SVA` | [`compressor-supply.ts`](src/ingest/stages/semantic/compressor-supply.ts) |
| `adv.cmpr_minutes` | EMS compressor runtimes that never cross 15 — a minutes-valued feed on a seconds-valued envelope | [`cmpr-minutes.ts`](src/ingest/stages/semantic/cmpr-minutes.ts) |
| `adv.sample_gap` | two consecutive readings more than 900 s (+ 60 s quantization tolerance) apart | [`sample-gap.ts`](src/ingest/stages/semantic/sample-gap.ts) |
| `adv.duplicate_records` | the same record delivered twice inside one transmission | [`duplicate-records.ts`](src/ingest/stages/semantic/duplicate-records.ts) |

## 8. Data model

**PostgreSQL**, via `node-postgres` (`pg`) behind a thin repository layer: native `jsonb` for
payloads/findings, and a path to a future production-endpoint mode with no migration. It also
converges with an experimental cold-chain **master-data system** — an MDM ingesting the same PQS
E006 DS01 data, itself "opinionated-Postgres" — whose `source_artifact` shape (content hash, byte
size, content type, channel, received-at) `transmission` mirrors, with one deliberate difference:
that system makes `content_hash` `UNIQUE` to dedup-and-drop on idempotent replay, whereas we
**record every POST** and *flag* repeats instead, because duplicate detection is the §1.8 signal
we grade and must never silently collapse.

- **session** — `uuid` (PK), `created_at`, `last_post_at`, `auth_enabled bool`, `auth_method`
  (`header` | `basic` | `bearer`), `auth_header_name`, `auth_secret_hash`.
- **transmission** — `id uuid` (PK), `session_uuid` (FK → session), `received_at timestamptz`,
  `content_hash bytea` (SHA-256 of the raw wire body, **not** unique — it detects exact replays),
  `wire_bytes bigint`, `content_type`, `content_encoding`, `http_status int`, `transfer_id`,
  `transfer_src`, `transfer_type`, `schema_version`, `body jsonb` (parsed payload, null if
  unparseable), `raw_body text` (the original bytes, kept for drill-down especially when parsing
  fails; its ceilings are in §12), `parse_ok bool`, `schema_ok bool`.
- **finding** — `id`, `transmission_id` (FK → transmission), `requirement` (e.g. `1.4`),
  `severity` (`pass` | `fail` | `info`), `detail`, `pointer` (JSON Pointer into the payload),
  `outdated bool` (set only on the §3.2 info finding raised when a transmission validates against
  a valid-but-*older* registered version — the body is accepted and the dashboard shows an amber
  OUTDATED SCHEMA tag), plus the **signature** fields that let identical defects collapse into one
  issue without keying off an English message that drifts between Ajv versions: `keyword`,
  `instance_path`, `param` for schema (§3.2) errors, `code` (e.g. `tx.missing_charset`) for
  transport/heuristic ones. All nullable, populated only where they apply.

Indexes: `transmission (session_uuid, received_at DESC)` for the dashboard's reverse-chronological
list and per-session rollups; `(session_uuid, content_hash)` and `(session_uuid, transfer_id)` for
duplicate detection (§1.8). Concurrency observation (§2.1) is in-flight request tracking per
session, not a stored artifact.

Schema is applied as ordered SQL on first boot (`db/initdb/`); a migration runner is deferred
until the schema needs to evolve in production.

## 9. Schema registry and versioning

- The registry is a **policy** about which versions we accept, so multi-version support is a
  feature rather than a complication. It holds 0.8.1 (current) and 0.8.0 (outdated-but-valid);
  0.8.0 left when 0.8.1 was published and was restored on 2026-08-04, because a single registered
  version leaves the outdated-but-valid grade (§7) unreachable by construction — with nothing
  older than current, no transmission can earn the OUTDATED SCHEMA signal — and it is the version
  a supplier is likeliest to still be sending. Registration is **per-dialect**: 0.8.0 declares
  draft-07 and 0.8.1 declares 2020-12, so each entry names its dialect and compiles under the
  matching Ajv build in its own instance. 0.7.x and earlier stay out entirely. Measured
  2026-08-20, docs.2to8.cc publishes 0.8.0, 0.8.1, 0.8.2 and 0.8.4 (0.8.3 is not published); those
  past 0.8.1 stay unregistered, so current remains 0.8.1, and an unregistered version gets `422`
  with the supported list rather than a silent fallback.
- **Never fetched at runtime.** `meta.schemaVersion` is a *lookup key*, not a locator, and we
  validate only against pre-registered copies. Runtime fetching would couple ingest to an external
  host's uptime, be an SSRF foot-gun (a URL pulled from request data), and destroy the "we
  validated against *the official* version" claim. The spec agrees — `$id` identifies, it never
  locates — and the live proof is that published schemas declare
  `$id: https://schemas.2to8.cc/schemas/cce-interop-<version>.json`, a host that does not resolve,
  while the artifact is served from a different host and path. `normalizeVersion()` already accepts
  URN-shaped values carrying a semver triple, so the expected upstream move of `$id` to a URN needs
  no code change here.
- **Normalized matching.** The standard is ambiguous about the field's form (its description
  points at `$id`, a URL, while its only example is a bare semver). Until that is clarified (§15)
  we normalize on ingest: accept either shape, extract `MAJOR.MINOR.PATCH`, look that up. An exact
  match is required — a silent fallback to a "close" version would defeat conformance — and an
  unknown version gets `422` with a finding listing the versions we do support.
- **Content-hash provenance ("blessed bytes").** Each registered version is pinned by the SHA-256
  of its canonical bytes, so the dashboard can surface "validated against official 0.8.1
  (sha256 …)" — vendored 0.8.1 is `290290fd…`, verified 2026-07-31. The vendored file is therefore
  kept byte-identical to the published artifact: cosmetic issues (the stale `0.1.1` example, the
  `schemaVersion`→`$id` phrasing) are never patched locally but tracked as standard-revision
  proposals (§15).
- **Adding a version is a policy act, not maintenance.** A new version arrives as a *new* vendored
  file plus a registry entry; an existing schema file is never edited in place. Whether to accept
  the published 0.8.2 — the first version to define `meta.customDataSchema`, and one whose own
  `$comment` tells employers to enforce that conditional in their own validation layer, as §3.1
  does — stays open (tracked: `cce-data-delivery-validator-fvw`).
- Ajv compiles each registered schema once at startup, in its own instance, and reuses the
  compiled validator. Registration is a **boot-time gate**: bytes that cannot be read or compiled
  fail the process loudly rather than degrading silently.

## 10. Dashboard

Per session (`/d/{uuid}`):
- **Setup** — ingest URL, copy-paste `curl`/header examples, the synthetic-data-only notice, and
  the §1.3 auth opt-in: toggle, pick a method, the service generates the credential and shows a
  config snippet.
- **Compliance summary** — the §7 matrix, rendered as §7 describes. Each row drills down to the
  **verbatim** 2025-requirement text, with our own reading of it in a separate guidance field so a
  supplier can always tell the two apart.
- **Transmissions** — reverse-chronological, paginated list; drill into any one for the returned
  status, the compression/wire-byte picture, a raw-payload inspector, and the findings (with JSON
  Pointers to schema errors). The list pane is height-capped so the detail pane stays on screen.
- **Lifecycle** — shows the 7-day inactivity expiry clock.

## 11. Retention / lifecycle

A periodic worker deletes sessions (and cascades to their transmissions/findings) whose
`last_post_at` (or `created_at` if no posts) is older than **7 days**. The expiry is surfaced
in the dashboard so it's never a surprise.

## 12. Security considerations

- **Capability URL caveat.** The UUID is a bearer secret in the path, and URLs leak via logs,
  proxies and browser history — acceptable for synthetic test data, v1's only data. If real data
  is ever in scope, revisit: split ingest from view tokens, move the secret to a header.
- **HTTPS only**, with valid certs that need no supplier-installed intermediates — terminated
  at the Caddy edge under the proxy contract in §4.1.
- **Auth secrets** stored hashed, never echoed after first display.
- **Resource limits** — Fastify's `bodyLimit` bounds buffered request memory at **2 MiB**, set
  above the §1.4 1MB grading cap on purpose so oversized-but-bounded bodies still reach the size
  stage and get a teaching `413` with a persisted row instead of Fastify's opaque one; gzip
  decompression is bounded at **1 MiB** of output as a zip-bomb guard. The `raw_body` copy (§8)
  has **no write-side cap** — decided 2026-08-02 (`cce-data-delivery-validator-1z9`); those two
  transport ceilings are its only bounds, and they bound it only loosely.

## 13. Tech stack

**Node + TypeScript** end-to-end (§3), and beneath that:

- **HTTP:** Fastify — fast, schema-friendly, first-class `Content-Type`/raw-body control. Locked.
- **Frontend:** React + Vite SPA (`react-router-dom`), built to `dist/web` and served by the same
  Node process via `@fastify/static` with an SPA fallback for non-API paths. **Locked 2026-05-30**;
  the server-rendered alternative was dropped.
- **Validation:** Ajv, on the build matching each schema's declared dialect — 2020-12
  (`ajv/dist/2020`) for 0.8.1, draft-07 for 0.8.0 (§9).
- **Storage:** PostgreSQL via `node-postgres` (`pg`), behind a thin repository layer (§8).
- **Edge:** Caddy, terminating TLS under the contract in §4.1.
- **Local/dev:** `docker-compose` (app + Postgres), healthcheck-gated bring-up.

## 14. Build history

All eight v1 milestones — skeleton, ingest core, dashboard read, web UI, semantic
checks, §1.3 auth opt-in, retention worker, polish — have shipped; the commit log
is the record. Everything above describes the built system, not a plan.

## 15. Future / deferred

- **Active conformance harness** (§4): a test-campaign mode returning controlled error responses
  and measuring retry count, backoff shape, `Retry-After` adherence, abandon-on-permanent-failure.
- **Guided retransmission scenarios** (§5).
- **Production-endpoint mode** (real data): retention, PII, sovereignty, and split-token auth.
- **Standard-revision proposals** for the next WHO-stewarded revision: make `schemaVersion` an
  opaque bare-semver token decoupled from hosting; state that receivers MUST NOT dereference the
  schema at validation time and SHOULD pre-register; mechanically link `$id` and `schemaVersion`;
  publish an out-of-band manifest with a content hash per version; fix the stale `0.1.1` example.
