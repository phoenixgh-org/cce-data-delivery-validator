# CCE Data Delivery Validator — Design

**Status:** Living document — **v1 scope is locked**; §3 records the decisions
that are settled and are not reopened casually. Everything else tracks the built
system and is updated as it ships.
**Last updated:** 2026-08-01

## 1. Overview

Cold chain equipment (CCE) data suppliers — manufacturers/resellers of RTMDs and
EMS-compliant equipment — are required by **WHO/PQS/E006/DS01.2, Clause 5 (Data
Delivery to External Systems)** to deliver CCE performance data to countries over
HTTPS. The "Interoperable CCE Data Delivery" requirements document (2025-03-30)
clarifies the low-level details. PQS test labs prequalify the *equipment* but do
**not** test the *data delivery* implementation, so suppliers today self-grade.

This project is a **public service that plays the employer/country (receiving)
side** of that interface, plus a **web dashboard** where suppliers get an
independent, honest read on their compliance — "to the extent possible" from the
receiving vantage point.

The governing artifacts:
- `src/schemas/cce-interop-*.json` — the transmission JSON Schemas, vendored and
  registered (§9). This is the **only** copy in the repo; `docs/` deliberately
  holds no schemas, so there is one place to verify against the published bytes.
- `docs/internal/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf` — the
  prose requirements (local-only: `docs/internal/` is gitignored, so this file is
  absent from a fresh clone).
- `docs/clause-mapping.md` — how those requirement numbers map to the DS01.3 rewrite.

When prose and schema disagree, **the schema wins**. This came from 2025
requirement §3.2; DS01.3 drops the precedence rule, and we keep it deliberately
as a house rule (see `CLAUDE.md`).

## 2. Goals and non-goals (v1)

**Goals**
- Stand up a real HTTPS ingest endpoint suppliers can POST to with **zero onboarding friction**.
- Validate each transmission against the JSON Schema and the *passively verifiable* requirements.
- Present results in a dashboard, **clearly delineating what we can and cannot prove**.

**Non-goals (deferred)**
- **Active conformance probing** of §4 (deliberately returning 429/503/5xx to measure
  retry counts, backoff shape, `Retry-After` handling, abandon-on-permanent-failure).
- **Guided retransmission scenarios** for §5 (6-month retransmit, time-range filter, all-vs-never-sent).
- Receiving **real production data** — v1 is a **test/sandbox** for synthetic data only.

## 3. Locked decisions

| # | Decision |
|---|----------|
| Scope | **Passive validation only** in v1. |
| Data | **Test/sandbox** synthetic data; no real CCE/PII. |
| Onboarding | **Capability URL**, minted via the **web dashboard** "Create" action (no signup). |
| Identity | **Single UUID** is both ingest path and dashboard key. Possession = authority. |
| Auth (§1.3) | **Opt-in compliance layer, not a gate.** On opt-in the **dashboard generates** the credential — token + configurable header name, HTTP Basic, or `Authorization: Bearer` (RFC 6750, the third method DS01.3 clause 5.1.5 adds) — for the supplier to copy in; the endpoint then enforces the chosen method so §1.3 becomes gradeable. |
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

Components:
- **Ingest API** — `POST /i/{uuid}`. Runs the pipeline (§6), persists the transmission and its findings, returns an appropriate HTTP status.
- **Dashboard API** — mint sessions, read transmissions/findings/summary, manage the §1.3 auth opt-in.
- **Web frontend** — landing page with a **Create test endpoint** button; per-session dashboard.
- **Compliance engine** — the schema validator plus the per-requirement checks; produces findings.
- **Datastore** — sessions, transmissions, findings (§8).
- **Retention worker** — purges inactive sessions (§11).

A Node service (API + static frontend) plus a Postgres container for v1, wired together with
`docker-compose`; the frontend can be split out later if needed.

### 4.1 Edge / TLS termination (proxy contract)

TLS is terminated at a **Caddy** reverse-proxy container (Digital Ocean), whose automatic
Let's Encrypt certs satisfy §12 / Attachment 2's "valid certs, no supplier-installed
intermediates" for free. Because the app sees plain HTTP behind Caddy, the proxy must honor a
small **contract** so the receiving-side checks stay accurate:

- **Scheme advertised.** Caddy sets `X-Forwarded-Proto`; the app trusts it **scoped to Caddy's
  address only** (Fastify `trustProxy`), and the app port is never publicly exposed. This is how
  §1.1's HTTPS aspect is known.
- **Body passed through untouched.** Caddy must **not** impose a `request_body max_size` below our
  1MB grading threshold — otherwise oversized POSTs get Caddy's generic `413` and we never record
  the transmission or emit the teaching finding. The **app owns** the §1.4 cap.
- **Encoding preserved.** The body reaches the app **as sent** (no request decompression, no
  re-chunking), so §1.4 wire-byte measurement and §1.6 `Content-Encoding` / double-encoding
  detection see exactly the supplier's bytes. (Caddy does not decompress request bodies by
  default — verify and lock the config.)

**Implementation.** The contract is encoded and commented in `deploy/Caddyfile` (wired as an
optional `edge` compose profile), the operator half — `TRUSTED_PROXY`, the env surface, and the
failure mode of each violation — is `docs/deployment.md`, and `deploy/smoke-proxy-contract.sh`
verifies a running deployment by POSTing an oversized and a gzipped body and asserting the *app*,
not the proxy, answered.

## 5. Onboarding flow (web-driven)

1. Supplier visits the site, clicks **Create test endpoint**.
2. Frontend calls `POST /api/sessions`; backend mints a v4 UUID, creates a session row, returns
   `{ uuid, ingestUrl: "/i/{uuid}", dashboardUrl: "/d/{uuid}" }`.
3. Supplier is taken to `/d/{uuid}`, which shows the ingest URL, copy-paste examples
   (`curl`, headers), and an empty results view that fills in as data arrives.
4. The dashboard URL is the only thing they need to bookmark. There is no account, email, or password.

> The UUID is a bearer capability. Anyone holding it can both POST and view. Acceptable for
> sandbox/test data; see §12.

## 6. Ingest pipeline and response codes

Each `POST /i/{uuid}` runs ordered stages. A stage either **produces a finding and continues**
or **short-circuits** with a response code. We follow the Country Guidance (Attachment 2) for codes.

| Stage | Check | On failure |
|-------|-------|-----------|
| — Framework | Request body ≤ 2 MiB (Fastify `bodyLimit`; see §8) | `413` **before any stage runs** — no row, and a framework error body rather than the ingest response shape |
| 1. Method/TLS | POST over HTTPS (§1.1) | TLS enforced at the edge; non-POST → `405` |
| 0. Session | UUID exists & not expired | `404` |
| 2. Auth (opt-in) | If enabled, the configured credential — token header, Basic, or Bearer — is present & correct (§1.3) | `401` |
| 3. Size | Wire body ≤ 1MB **after** content-encoding (§1.4) | `413` + finding |
| 4. Content-Type | `application/json; charset=utf-8` (§1.2) | finding; continue — `415` is optional and **we never return it** |
| 5. Content-Encoding | If `gzip`, decompress; detect illegal double-encoding e.g. base64 (§1.6) | finding; `400` if undecodable |
| 6. JSON parse | Body is valid UTF-8 JSON (§1.1) | `400` |
| 7. Schema validate | Ajv against `meta.schemaVersion` (§3.2) | `422` + per-error findings |
| 8. Semantic checks | Duplicate `transferId` (§1.8), interval regularity (§3.4), concurrency (§2.1), present-object inventory (§3.3 info), custom-data-object declaration (§3.1) | findings; `200` (data accepted) |

Stage 8 never halts: every §1.8/§2.1/§3.x concern is a *teaching* finding, not a rejection.

**Stage numbers are stable labels, not the run order.** The rows above are listed in *execution*
order, but the numbers are the identifiers used in code comments and `docs/api.md` and do not
change. `src/ingest/route.ts` deliberately runs **method (1) before session (0)** so a non-POST
short-circuits `405` without a pointless database lookup — observable as `405`, not `404`, for a
non-POST to an *unknown* UUID. Neither stage persists a row, so nothing else about the outcome
changes.

**§3.1 vs §3.2 (the division of labour).** Ajv at stage 7 grades §3.2 only. §3.1's structural
half — the metadata block and the DS01 object shapes — is already implied by a passing Ajv run,
so grading it again at stage 7 would double-count the same evidence. What §3.1 owns instead is
the half a schema cannot express: `meta.customDataSchema` is required **only when** the payload
carries manufacturer-specific data objects — clause 4.5 `z`-prefixed keys, plus any key that is
custom by elimination (see §7 row 3.1). That conditional runs as a
**schema-independent** stage-8 check, because `meta.customDataSchema` does not exist in 0.8.1 at
all and 0.8.1's `additionalProperties: true` lets custom objects through Ajv unexamined. See §7
row 3.1 and §9.

Success: `200` — the single success status; `202` is not used. It carries a small JSON body
summarizing what was recorded. The body is a
deliberate **teaching surface** — a supplier should understand the outcome from the HTTP response
alone, without opening the dashboard. It carries the persisted `transmissionId`, the `status`, a
one-line `message` with the fail/info tally, the per-finding `findingDetails` echo, an
`advisories` array (§7.1 — kept out of `findings`, `findingDetails` and the tally, so a
conformant payload is never handed a number to explain), and a standing
`notice` restating that this is a synthetic-data-only sandbox (§2, §12). The same shape is
returned on rejection, so a 4xx is just as self-explanatory as a 2xx.

**Size note (§1.4):** the requirement is measured *after* encoding (the bytes on the wire), so
we measure the raw request body length, not the decompressed size.

## 7. Compliance engine — verifiability matrix

The product's distinguishing honesty is classifying every requirement, not just the ones we can grade.

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
| 3.1 | Declare custom data objects via `meta.customDataSchema` | ✅ | Stage-8 semantic check, **not** the schema: fail when manufacturer-specific objects are present without the declaration — clause 4.5 `z`-prefixed keys **plus** keys that are custom by elimination (neither DS01-shaped nor a mis-cased DS01 code, e.g. `customTemp`, `zTPCM`); pass when they are declared, or when none are present. Unrecognized DS01-shaped and mis-cased codes never drive the grade. We record the declaration only — we never dereference it (§9). The custom-by-elimination keys additionally raise a separate info finding for non-conformant naming. The structural half of §3.1 is covered by §3.2's Ajv run |
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
supplier's actual traffic; 🔌 are marked "not yet exercised — available in a future test mode";
📝 are marked "self-attestation — outside what a receiver can prove." A gradeable row with zero
findings so far shows **untested**, never a false pass. A row whose only evidence came from
transmissions validated against a registered-but-*older* schema version shows
**pass-outdated** — those findings are `info` + `outdated` with no pass finding, so counting
pass/fail alone would report **untested** and claim we never checked (`cce-data-delivery-validator-2kx`).

This table is the source for `COMPLIANCE_MATRIX` in `src/api/compliance-matrix.ts`, which
encodes the same 27 rows verbatim — change them together.

### 7.1 Advisories

Some payloads are fully schema-compliant *and* fully requirement-compliant, yet obviously
unhelpful to the country receiving them — a report whose `ASER` and `AMID` are both `null`;
every DS01 property emitted with `null` where no sensor is fitted. **Advisories** are the
category for saying so (`cce-data-delivery-validator-pwd`).

An advisory **never changes a requirement's pass/fail status.** The proposition is an
independent read on conformance; the moment house opinion moves a verdict, the grade stops
being trustworthy. A supplier must be able to sit at 100 % conformant and still carry
advisories — which is why this is a separate category rather than extra findings on
existing requirements.

Mechanically it reuses the existing plumbing with **no DDL**: `severity` is always `info`
(no fourth severity, `2kx`), and the id lives in its own `adv.*` namespace — `adv.null_identity`,
`adv.null_padding` — carried in **both** `finding.requirement` and `finding.code`. Named codes
rather than numbers: unlike the §7 ids, which take their numbering from the 2025 requirements
document, an advisory catalogue has no external document to number against. The §7 matrix is
immune **by construction**, because the join iterates the 27 static rows and never looks up an
unknown id; that guarantee is invisible in the code, so it is pinned by tests in
`src/api/compliance-matrix.test.ts` and `src/api/sessions.test.ts`.

The ingest response honours the same separation as the dashboard (`cce-data-delivery-validator-7rv`):
`POST /i/{uuid}` returns advisories in their own `advisories` field and counts none of them in
`findings`, `findingDetails` or the `message` tally, exactly as the dashboard's verdict cell
excludes them from both its fail count and its total.

Advisories emit **per transmission** from the stage-8 semantic check `advisoriesCheck`
(`src/ingest/stages/semantic/advisory.ts`, which is also the registration point for new
checks); the session-level view aggregates findings the dashboard already fetches, so there
is no new read path. Wording must **observe, never conclude** — a null cannot prove "no
sensor fitted", since a broken sensor looks identical — and should lead with the payload-size
argument, which is actionable self-interest rather than a judgement about the supplier's
hardware.

**The catalogue.** Two checks today, each in its own module under `stages/semantic/`:

- **`adv.null_identity`** — the report does not carry the identifier that names the appliance
  on its branch. **One identifier per branch, and the others are not substitutes** (`2km`,
  `38p`): on `ems-report` it reads **`ASER` alone**, on `rtmd-report` **`AMID` alone**. Blank
  means `null`, absent, **or an empty/whitespace string**. `ASER` is programmed at the factory
  or at commissioning and an EMS's whole proposition is that the logger and the appliance are
  integrated, so nothing else on that branch stands in — `ems-report` has no `AMID` property at
  all, and `AID` is a programme asset-tracking identifier rather than the manufacturer's serial,
  so a populated `AID` does **not** silence it. On RTMD the reverse: the device is usually added
  to an appliance already in service, so `ASER`/`AID` were often never captured and `AMID` — the
  supplier platform's own handle — is the one graded. Because `rtmd-report` makes `AMID`
  required *and* non-nullable, an empty string is that branch's **entire conformant surface**,
  which is why blank strings count at all. `ESER` and `LSER` name the monitoring device, not the
  appliance, so they never identify it.
- **`adv.null_padding`** — a record property `null` in **every** record that carried it, over
  at least **12 records** (three hours at the 15-minute period DS01's per-period objects are
  defined over — long enough to be a pattern and to be worth bytes; the repo's own conformant
  EMS baseline is 3 records, well clear of it). One finding per transmission naming every
  padded property, since the dashboard folds recurring advisories to a single detail. `ALRM`,
  `EERR` and `LERR` are excluded: there `null` is the schema's *defined* value for "no
  condition present", so a device that raised no alarm is correctly shaped that way.

**The dashboard surface.** Advisories get a surface of their own, labelled **Advisories**:
a card between the filter strip and the two verdict panes (`src/web/components/AdvisoriesCard.tsx`),
plus a separate block under each transmission's findings. It folds the advisories out of the
transmissions the dashboard already fetches, keyed `requirement|code` in the browser
(`src/web/advisories.ts`) — *not* through `computeSignatures`, which excludes them by design so
they never enter the "distinct issues" list or its headline count. Nothing it shows feeds a
pass/fail number, the conformance rollup, or that headline, and no advisory is counted in a
transmission row's findings cell or highlighted in the raw-payload inspector. It renders
nothing at all when there are none. The palette is deliberate: **accent and neutrals, never a
status colour, and never the `--mixed` amber**, which already means *warning / outdated*
everywhere else on the dashboard — borrowing it would say "a lesser defect" on the one surface
that must not say defect at all.

## 8. Data model

**PostgreSQL** is the datastore, converging with the sibling project `tremble` (which ingests
the same PQS E006 DS01 data and is itself "opinionated-Postgres"). This gives us native `jsonb`
for payloads/findings, a clean path to a future production-endpoint mode with no migration, and
lets us lift `tremble`'s content-addressed patterns directly. Accessed via `node-postgres`
(`pg`) behind a thin repository layer.

The `transmission` table mirrors `tremble`'s `source_artifact` (content hash, byte size,
content type, channel, received-at), with one deliberate difference: `tremble` makes
`content_hash` **`UNIQUE`** to *dedup-and-drop* on idempotent replay, whereas we **record every
POST** and instead *flag* repeats — duplicate detection is the §1.8 signal we're grading, so we
must never silently collapse it.

- **session** — `uuid` (PK), `created_at`, `last_post_at`, `auth_enabled bool`, `auth_method`
  (`header` | `basic` | `bearer`), `auth_header_name`, `auth_secret_hash`.
- **transmission** — `id uuid` (PK), `session_uuid` (FK → session), `received_at timestamptz`,
  `content_hash bytea` (SHA-256 of the raw wire body; **not** unique — used to detect exact
  replays), `wire_bytes bigint`, `content_type`, `content_encoding`, `http_status int`,
  `transfer_id`, `transfer_src`, `transfer_type`, `schema_version`,
  `body jsonb` (parsed payload; null if unparseable), `raw_body text` (the original bytes, kept
  for drill-down especially when parsing fails — see the size note below), `parse_ok bool`,
  `schema_ok bool`.
- **finding** — `id`, `transmission_id` (FK → transmission), `requirement` (e.g. `1.4`),
  `severity` (`pass` | `fail` | `info`), `detail`, `pointer` (JSON Pointer into the payload
  where relevant), `outdated bool` (true only for the §3.2 info finding raised when a
  transmission validates against a valid-but-**older** registered version — the body is accepted
  and the dashboard shows an amber OUTDATED SCHEMA tag), plus the structured **signature**
  fields that let identical defects collapse into one issue without keying off an English
  message that drifts between Ajv versions: `keyword`, `instance_path`, `param` for schema
  (§3.2) errors, and `code` (e.g. `tx.missing_charset`) for transport/heuristic findings. All
  are nullable and populated only where they apply.

**On `raw_body` size (honest statement of what is implemented).** There is **no write-side cap**:
the ingest path gzip-decodes, strips NUL (illegal in a Postgres `text` column), and stores the
result whole. The only ceilings that exist today are upstream of the insert:

- **Fastify `bodyLimit` — 2 MiB.** Deliberately set *above* the §1.4 1MB grading cap so an
  oversized-but-bounded POST still reaches the size stage and earns its §1.4 teaching finding and
  a persisted row. Beyond 2 MiB, Fastify's generic `413` fires and nothing is recorded.
- **gzip `maxOutputLength` — 1 MiB.** The zip-bomb guard: a gzip body whose output would exceed
  it throws, and stage 5 halts `400` as undecodable. That halt is *downstream* of the persistence
  boundary — a request that reached the body stages persists a row whether or not a body stage
  short-circuits — so a row **is** still written, and its `raw_body` is the still-**compressed**
  wire bytes read as UTF-8 (invalid sequences become U+FFFD), not a decoded payload. This ceiling
  therefore bounds only the decoded path.

So a stored `raw_body` is bounded in practice, but by the transport rather than by the write —
and loosely: U+FFFD substitution emits three bytes of text per undecodable wire byte, so the
2 MiB `bodyLimit` translates to a several-MiB worst case in the column. **Decided 2026-08-02: no
write-side cap** (`cce-data-delivery-validator-1z9`) — the two transport ceilings above are the
only bounds, and they stay as they are. Do not describe `raw_body` as "size-bounded"; the
dashboard's truncation disclosure compares against `wire_bytes` for exactly this reason.

Indexes: `transmission (session_uuid, received_at DESC)` for the dashboard's reverse-chronological
list and per-session rollups; `transmission (session_uuid, content_hash)` and
`transmission (session_uuid, transfer_id)` for duplicate detection (§1.8). Concurrency
observation (§2.1) is in-flight request tracking per session, not a stored artifact.

Schema is applied as ordered SQL on first boot (mirroring `tremble`'s `db/initdb/` convention);
a migration runner is deferred until the schema needs to evolve in production.

## 9. Schema registry and versioning

- The service hosts a registry of **vendored** schema versions: **0.8.1** (current) and
  **0.8.0** (registered, outdated-but-valid). Multi-version support is a feature, not a
  complication — the registry is a *policy* about which versions we accept. 0.8.0 was
  dropped from that policy once 0.8.1 was published, then **restored on 2026-08-04**
  (bd 8qa.4) because a single registered version leaves the outdated-but-valid grade
  (§7) unreachable by construction: with nothing older than current, no transmission can
  earn the OUTDATED SCHEMA signal and neither the grade nor the dashboard tag can be
  exercised end to end. 0.8.0 is also the version a supplier is likeliest to still be
  sending. **Registration is per-dialect**: 0.8.0 declares draft-07 and 0.8.1 declares
  2020-12, so each entry names its dialect and compiles under the matching Ajv build in
  its own instance. 0.7.x and earlier stay out entirely; 0.8.2/0.8.3 exist upstream but
  stay out for now, so current remains 0.8.1. A payload declaring any unregistered
  version gets `422` with the supported list, never a silent fallback.
- **Never fetched at runtime.** `meta.schemaVersion` is a *lookup key*, not a locator. We validate
  only against pre-registered copies — runtime fetching would (a) couple our ingest path to an
  external host's uptime, (b) be an SSRF foot-gun (a URL pulled from request data), and (c) destroy
  the "we validated against *the official* version" claim. JSON Schema's `$id` is formally an
  identifier, not a network locator, so this is also correct per spec.
- **Normalized matching.** The standard today is ambiguous about the field's form (the description
  points at `$id` — a URL — while the only example is a bare semver, `0.1.1`). Until the standard is
  clarified (§15), we **normalize on ingest**: accept either a bare semver or a full `$id`-style URL,
  extract `MAJOR.MINOR.PATCH`, and look that up. **Exact match required**; no silent fallback to a
  "close" version (that would defeat conformance). Unknown version → `422` with an
  "unsupported schemaVersion" finding that **lists the versions we do support**.
- **Content-hash provenance ("blessed bytes").** Each registered version is pinned by the SHA-256
  of its canonical bytes; the dashboard can surface "validated against official 0.8.1 (sha256 …)".
  The vendored file is therefore kept **byte-identical** to the published artifact — cosmetic issues
  in the schema (the stale `0.1.1` example, the `schemaVersion`→`$id` phrasing) are **not** patched
  locally, but tracked as standard-revision proposals (§15), so the hash keeps matching what WHO
  published. Verified 2026-07-31: vendored 0.8.1 is `290290fd…`, identical to the live published
  artifact and to the upstream authoring folder.
- **The `$id` is not a download location.** Published schemas declare
  `$id: https://schemas.2to8.cc/schemas/cce-interop-<version>.json`, but that host does not
  resolve — the artifact is served from a different host and path. That is the live proof of the
  rule above rather than a counterexample to it: `$id` identifies, it never locates, and we never
  fetch. `normalizeVersion()` already accepts URN-shaped values carrying a semver triple, so the
  expected upstream move of `$id` to a URN needs no code change here.
- **Adding a version is a policy act, not maintenance.** A new version arrives as a *new* vendored
  file plus a registry entry; an existing schema file is never edited in place. Upstream **0.8.2**
  is published and is the first version to define `meta.customDataSchema` — and its own `$comment`
  on that definition says the conditional is deliberately *not* enforced by the schema and that
  employers wishing to enforce it should do so in their own validation layer. We are that layer
  (§7 row 3.1), which is why our §3.1 check is schema-independent and works for suppliers still
  declaring 0.8.1. Whether to accept 0.8.2 declarations is an open version-acceptance decision
  (beads `cce-data-delivery-validator-fvw`), not a promise this document makes.
- Ajv compiles each registered schema once at startup, in its own instance per version, and reuses
  the compiled validator. Registration is a boot-time gate: bytes that cannot be read or compiled
  fail the process loudly rather than degrading silently.

## 10. Dashboard

Per session (`/d/{uuid}`):
- **Setup** — ingest URL, copy-paste `curl`/header examples, the synthetic-data-only notice, and
  the §1.3 auth opt-in (toggle → pick one of the three methods → service generates the credential
  → shows a config snippet).
- **Compliance summary** — the §7 matrix with live counts and the honesty classification. Each row
  drills down to the **verbatim** 2025-requirement text; our own editorializing lives in a
  separate guidance field so a supplier can always tell the requirement from our reading of it.
- **Transmissions** — reverse-chronological, paginated list; drill into any transmission to see
  the returned status, the compression/wire-byte picture, a raw-payload inspector, and the
  findings (with JSON Pointers to schema errors). The list pane is height-capped so the detail
  pane stays on screen.
- **Lifecycle** — shows the 7-day inactivity expiry clock.

## 11. Retention / lifecycle

A periodic worker deletes sessions (and cascades to their transmissions/findings) whose
`last_post_at` (or `created_at` if no posts) is older than **7 days**. The expiry is surfaced
in the dashboard so it's never a surprise.

## 12. Security considerations

- **Capability URL caveat.** The UUID is a bearer secret in the path; URLs leak via logs,
  proxies, and browser history. Acceptable for synthetic test data (v1's only data). If real
  data is ever in scope, revisit (split ingest vs view tokens; move the secret to a header).
- **HTTPS only**, with valid certs that don't require suppliers to install intermediates
  (Country Guidance, Attachment 2).
- **Auth secrets** stored hashed, never echoed after first display.
- **Resource limits** — Fastify's `bodyLimit` bounds buffered request memory at **2 MiB**, set
  above the §1.4 1MB grading cap on purpose so oversized-but-bounded bodies still reach the size
  stage and get a teaching `413` with a persisted row instead of Fastify's opaque one; gzip
  decompression is bounded at **1 MiB** of output as a zip-bomb guard. See the `raw_body` note in
  §8 for what this does and does not bound at the storage layer.

## 13. Tech stack

- **Runtime/language:** Node + TypeScript.
- **HTTP:** Fastify (fast, schema-friendly, first-class `Content-Type`/raw-body control). Locked.
- **Validation:** Ajv running the published schema directly, using the build that
  matches each schema's declared dialect — **2020-12** (`ajv/dist/2020`) for 0.8.1,
  **draft-07** (Ajv's default export) for the registered-but-outdated 0.8.0. Neither
  build accepts the other's `$schema`, so the choice is per registry entry.
- **Storage:** PostgreSQL via `node-postgres` (`pg`), behind a thin repository layer; schema
  adopts `tremble`'s content-addressed `source_artifact` / `jsonb`-body patterns.
- **Frontend:** React + Vite SPA (with `react-router-dom`), built to `dist/web` and served by the
  same Node process via `@fastify/static` with an SPA fallback for non-API paths. Locked
  2026-05-30; the server-rendered alternative was dropped.
- **Edge:** **Caddy** reverse proxy (Digital Ocean) terminating TLS with automatic Let's Encrypt
  certs; honors the proxy contract in §4.1.
- **Local/dev:** `docker-compose` (app + Postgres), following `tremble`'s healthcheck-gated bring-up.

## 14. Build order (v1 milestones)

1. **Skeleton** — Node/TS project, Fastify server, Postgres via docker-compose with first-boot
   schema, schema registry loading the vendored versions (0.8.0 + 0.8.1 today); Ajv compiles.
2. **Ingest core** — `POST /i/{uuid}`: size/content-type/encoding/parse/schema stages → persist transmission + findings → correct status codes.
3. **Sessions + dashboard read** — `POST /api/sessions`, `GET /api/sessions/{uuid}` (transmissions, findings, summary).
4. **Web UI** — Create button, setup page with copy-paste examples, transmission list + drill-down, the §7 matrix.
5. **Semantic checks** — duplicate `transferId`, interval regularity, concurrency, object inventory.
6. **§1.3 auth opt-in** — generate credential, enforce on ingest, show config snippet.
7. **Retention worker** + lifecycle display.
8. **Polish** — examples, error messaging, fixture transmissions (valid + each conditional failure case) as tests.

## 15. Future / deferred

- **Active conformance harness** (§4): a test-campaign mode that returns controlled error
  responses and measures retry count, backoff shape, `Retry-After` adherence, and
  abandon-on-permanent-failure.
- **Guided retransmission scenarios** (§5).
- **Production-endpoint mode** (real data): retention, PII, sovereignty, and split-token auth.
- **Standard-revision proposals** (upstream, for the next WHO-stewarded revision): make
  `schemaVersion` an explicit opaque bare-semver token decoupled from hosting; state that receivers
  MUST NOT dereference the schema at validation time and SHOULD pre-register; mechanically link
  `$id` and `schemaVersion` (one version string); publish an out-of-band manifest with a content
  hash per version; fix the stale `0.1.1` example. Tracked in beads.
